import { cp, mkdir, readdir, stat } from 'fs/promises'
import { existsSync } from 'fs'
import { join } from 'path'
import yaml from 'js-yaml'
import { logger } from '../../public/logging'
import { safeReadFile, readConfigYamlForProfile } from '../../public/profile-config'
import { getProfileDir, getActiveProfileName } from '../../public/profile-config'
import { resolveBundledMeetingSkillsDirectory } from '../../public/meeting-runtime'

/**
 * 会议分析技能解析器。
 *
 * 会议分析（实时分析 + 报告生成）走的是服务端直接调用 LLM 的轻量路径，
 * 不经过 Hermes Agent，因此不会自动加载 profile 的技能。本模块负责：
 *
 * 1. 自动安装：若目标 profile 缺少内置的 `meeting-analysis` 技能，从内置
 *    技能源目录复制一份（开箱即用，无需用户手动安装）。
 * 2. 动态加载：读取该 profile 下所有带 `meeting` 标签（或名称含 meeting）
 *    且未被禁用的技能，解析其 SKILL.md 正文。
 * 3. 注入提示词：把技能内容拼成一段 system prompt 片段，供 LLM 调用时追加。
 *
 * 技能内容带 60s 缓存，避免每轮实时分析（18s 一次）都重复读盘。
 */

/** 内置的会议分析技能名（缺失时自动安装）。 */
export const MEETING_SKILL_NAME = 'meeting-analysis'
/** 演讲评分场景专属技能（仅 speech 场景注入，其他会议场景排除）。 */
export const MEETING_SPEECH_COACH_NAME = 'meeting-speech-coach'
/** 法律沟通场景专属技能（仅 legal 场景注入）。 */
export const MEETING_LEGAL_REVIEW_NAME = 'meeting-legal-review'
/** 全部内置会议技能（按 profile 自动安装）。 */
export const MEETING_INTERVIEW_REVIEW_NAME = 'meeting-interview-review'
export const BUNDLED_MEETING_SKILLS = [
  MEETING_SKILL_NAME,
  MEETING_SPEECH_COACH_NAME,
  MEETING_LEGAL_REVIEW_NAME,
  MEETING_INTERVIEW_REVIEW_NAME,
]

/**
 * 场景专属技能前缀映射：带这些前缀的技能仅注入对应场景，
 * meeting-analysis（无前缀）全场景注入。
 */
const SCENE_SKILL_PREFIXES: Record<string, string[]> = {
  speech: ['meeting-speech'],
  legal: ['meeting-legal'],
  interview: ['meeting-interview'],
}

/** 场景过滤：非本场景的专属技能排除（通用技能保留）。 */
function filterSkillsForScene<T extends { name: string }>(skills: T[], sceneId?: string): T[] {
  if (!sceneId) return skills
  const own = SCENE_SKILL_PREFIXES[sceneId]
  return skills.filter(s => {
    for (const [scene, prefixes] of Object.entries(SCENE_SKILL_PREFIXES)) {
      if (scene === sceneId) continue
      if (prefixes.some(prefix => s.name.startsWith(prefix))) return false
    }
    return true
  })
}

/** 判定一个技能是否适用于会议分析的标签关键词。 */
const MEETING_TAG_KEYWORDS = ['meeting', '会议']

const SKILL_CACHE_TTL_MS = 60_000

interface ParsedSkill {
  name: string
  description: string
  instructions: string
  tags: string[]
}

interface SkillSectionCacheEntry {
  section: string
  at: number
}

/** profile -> 拼装好的技能提示词片段（含空串，表示该 profile 无可用会议技能）。 */
const skillSectionCache = new Map<string, SkillSectionCacheEntry>()

/** profile -> 是否已确认安装过 meeting-analysis（进程内只检查/安装一次）。 */
const ensuredProfiles = new Set<string>()

/**
 * 解析 SKILL.md：拆出 YAML frontmatter 与 Markdown 正文。
 */
function parseSkillMd(content: string): { attributes: Record<string, any>; body: string } {
  const lines = content.split('\n')
  if (lines[0]?.trim() !== '---') {
    return { attributes: {}, body: content }
  }
  let end = -1
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === '---') {
      end = i
      break
    }
  }
  if (end === -1) {
    return { attributes: {}, body: content }
  }
  const frontmatter = lines.slice(1, end).join('\n')
  const body = lines.slice(end + 1).join('\n').trim()
  try {
    // 显式使用 DEFAULT_SCHEMA（安全 schema，仅解析 map/list/标量，
    // 不构造任意应用对象），并对结果做结构校验后才使用。
    const parsed = yaml.load(frontmatter, { schema: yaml.DEFAULT_SCHEMA })
    const attributes = parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, any>
      : {}
    return { attributes, body }
  } catch {
    return { attributes: {}, body }
  }
}

/** 从 frontmatter 中提取标签列表（兼容顶层 tags 与 metadata.hermes.tags）。 */
function extractTags(attributes: Record<string, any>): string[] {
  const candidates: unknown[] = []
  if (Array.isArray(attributes.tags)) candidates.push(...attributes.tags)
  const hermesTags = attributes?.metadata?.hermes?.tags
  if (Array.isArray(hermesTags)) candidates.push(...hermesTags)
  return candidates.map(t => String(t).trim().toLowerCase()).filter(Boolean)
}

/** 判断技能是否适用于会议分析。 */
function isMeetingRelated(name: string, attributes: Record<string, any>, tags: string[]): boolean {
  if (tags.some(tag => MEETING_TAG_KEYWORDS.some(k => tag.includes(k)))) return true
  const lowerName = name.toLowerCase()
  return MEETING_TAG_KEYWORDS.some(k => lowerName.includes(k))
}

/** profile 对应的技能目录。 */
function profileSkillsDir(profile: string): string {
  return join(getProfileDir(profile), 'skills')
}

/**
 * 递归收集目录下所有含 SKILL.md 的技能目录。
 * 兼容两级结构（skills/<name>/SKILL.md）与三级结构（skills/<category>/<name>/SKILL.md）。
 */
async function collectSkillDirs(dir: string, visited: Set<string>): Promise<{ name: string; path: string }[]> {
  const results: { name: string; path: string }[] = []
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return results
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue
    const entryPath = join(dir, entry.name)
    let isDir = false
    try {
      isDir = (await stat(entryPath)).isDirectory()
    } catch {
      continue
    }
    if (!isDir) continue

    const skillMd = await safeReadFile(join(entryPath, 'SKILL.md'))
    if (skillMd !== null) {
      results.push({ name: entry.name, path: entryPath })
      continue
    }
    // 无 SKILL.md → 可能是分类容器，继续向下找（限制深度，避免无限递归）。
    if (visited.size < 8 && !visited.has(entryPath)) {
      visited.add(entryPath)
      results.push(...await collectSkillDirs(entryPath, visited))
    }
  }
  return results
}

/**
 * 确保目标 profile 安装了内置的 meeting-analysis 技能。
 * 已安装（或已确认过）则直接返回；缺失则从内置技能源复制。
 */
export async function ensureMeetingAnalysisSkill(profile: string): Promise<void> {
  if (ensuredProfiles.has(profile)) return
  ensuredProfiles.add(profile)

  for (const skillName of BUNDLED_MEETING_SKILLS) {
    const targetDir = join(profileSkillsDir(profile), skillName)
    if (existsSync(join(targetDir, 'SKILL.md'))) {
      continue
    }

    const sourceDir = join(resolveBundledMeetingSkillsDirectory(), skillName)
    if (!existsSync(join(sourceDir, 'SKILL.md'))) {
      // meeting-speech-coach 缺源属可降级场景（scene-templates 仍保留骨架提示词）
      logger.warn('[meeting-skill] bundled skill source not found: %s', sourceDir)
      continue
    }

    try {
      await mkdir(targetDir, { recursive: true })
      await cp(sourceDir, targetDir, { recursive: true })
      logger.info('[meeting-skill] auto-installed %s into profile %s', skillName, profile)
    } catch (err) {
      logger.warn({ err }, '[meeting-skill] failed to auto-install %s for profile %s', skillName, profile)
    }
  }
}

/**
 * 读取 profile 下所有适用于会议分析且未被禁用的技能。
 */
export async function loadAnalysisSkills(profile: string): Promise<ParsedSkill[]> {
  const skillsDir = profileSkillsDir(profile)
  const skillDirs = await collectSkillDirs(skillsDir, new Set([skillsDir]))

  let disabled: string[] = []
  try {
    const config = await readConfigYamlForProfile(profile)
    disabled = Array.isArray(config?.skills?.disabled) ? config.skills.disabled : []
  } catch {
    disabled = []
  }

  const skills: ParsedSkill[] = []
  for (const { name, path } of skillDirs) {
    if (disabled.includes(name)) continue
    const content = await safeReadFile(join(path, 'SKILL.md'))
    if (content === null) continue

    const { attributes, body } = parseSkillMd(content)
    const tags = extractTags(attributes)
    if (!isMeetingRelated(name, attributes, tags)) continue
    if (!body.trim()) continue

    skills.push({
      name,
      description: typeof attributes.description === 'string' ? attributes.description : '',
      instructions: body,
      tags,
    })
  }

  skills.sort((a, b) => a.name.localeCompare(b.name))
  return skills
}

/**
 * 把技能列表拼成一段可追加到 system prompt 的文本。
 */
export function buildSkillInstructionsSection(skills: ParsedSkill[]): string {
  if (skills.length === 0) return ''
  const parts = skills.map(skill => {
    const header = `### 技能：${skill.name}`
    return `${header}\n\n${skill.instructions}`
  })
  return [
    '## 分析技能（请遵循以下方法论进行分析）',
    '',
    ...parts,
  ].join('\n')
}

/**
 * 顶层入口：返回用于追加到 system prompt 的技能片段。
 * 自动安装缺失的内置技能，并带 60s 缓存。
 */
export async function prepareAnalysisSkillSection(profile?: string, sceneId?: string): Promise<string> {
  const resolvedProfile = (profile || getActiveProfileName() || 'default').trim() || 'default'
  // 缓存键带场景：speech 场景会额外注入 speech-coach 技能
  const cacheKey = `${resolvedProfile}:${sceneId || 'all'}`

  const cached = skillSectionCache.get(cacheKey)
  if (cached && Date.now() - cached.at < SKILL_CACHE_TTL_MS) {
    return cached.section
  }

  try {
    await ensureMeetingAnalysisSkill(resolvedProfile)
    const skills = await loadAnalysisSkills(resolvedProfile)
    // 场景过滤：场景专属技能（speech-coach/legal-review）仅注入对应场景
    const applicable = filterSkillsForScene(skills, sceneId)
    const section = buildSkillInstructionsSection(applicable)
    logger.info(
      '[meeting-skill] profile %s (scene %s) → %d meeting skill(s): %s',
      resolvedProfile, sceneId || '(all)', applicable.length, applicable.map(s => s.name).join(', ') || '(none)',
    )
    skillSectionCache.set(cacheKey, { section, at: Date.now() })
    return section
  } catch (err) {
    logger.warn({ err }, '[meeting-skill] failed to prepare skills for profile %s', resolvedProfile)
    return cached?.section ?? ''
  }
}
