import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'

const mockGetSkillUsageStatsFromDb = vi.hoisted(() => vi.fn())
const mockGetActiveProfileName = vi.hoisted(() => vi.fn())
const mockGetProfileDir = vi.hoisted(() => vi.fn())
const mockReadConfigYamlForProfile = vi.hoisted(() => vi.fn())
const mockSafeReadFile = vi.hoisted(() => vi.fn())
const mockExtractDescription = vi.hoisted(() => vi.fn())

vi.mock('../../packages/server/src/db/hermes/sessions-db', () => ({
  getSkillUsageStatsFromDb: mockGetSkillUsageStatsFromDb,
}))

vi.mock('../../packages/server/src/modules/hermes/services/profiles/profile', () => ({
  getActiveProfileName: mockGetActiveProfileName,
  getProfileDir: mockGetProfileDir,
}))

vi.mock('../../packages/server/src/modules/studio/public/profile-config', () => ({
  readConfigYamlForProfile: mockReadConfigYamlForProfile,
  updateConfigYamlForProfile: vi.fn(async () => undefined),
  safeReadFile: mockSafeReadFile,
  extractDescription: mockExtractDescription,
  listFilesRecursive: vi.fn(async () => []),
}))

async function loadController() {
  vi.resetModules()
  return import('../../packages/server/src/modules/hermes/controllers/skills')
}

function practiceSkillMd(name: string, description: string, hermesPractice: string): string {
  return [
    '---',
    `name: ${name}`,
    `description: ${description}`,
    'hermes_practice:',
    hermesPractice,
    '---',
    `# ${name}`,
    `${description} 的人类可读说明`,
  ].join('\n')
}

const BASIC_PRACTICE = `  schema: 1
  targetLanguages: [en]
  entry:
    label: 雅思考官
  evaluation:
    scale: { min: 1, max: 10 }
    dimensions:
      - id: fluency
        label: 流利度
`

describe('listPracticeSkills (口语对练技能)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGetActiveProfileName.mockReturnValue('default')
    mockSafeReadFile.mockImplementation(async (path: string) => {
      try {
        const fs = await import('fs/promises')
        return await fs.readFile(path, 'utf-8')
      } catch {
        return null
      }
    })
    mockExtractDescription.mockImplementation((content: string) => {
      return content.split('\n').find(line => line.trim() && !line.startsWith('#'))?.trim() || ''
    })
  })

  it('列出本地练习技能（含契约），非练习技能与非法 schema 被过滤', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hermes-web-ui-practice-skills-'))
    const profileDir = join(root, 'profile')
    const skillsDir = join(profileDir, 'skills')
    await mkdir(join(skillsDir, 'practice', 'ielts-part2'), { recursive: true })
    await mkdir(join(skillsDir, 'free-talk'), { recursive: true })
    await mkdir(join(skillsDir, 'practice', 'plain-skill'), { recursive: true })
    await writeFile(
      join(skillsDir, 'practice', 'ielts-part2', 'SKILL.md'),
      practiceSkillMd('ielts-part2', '雅思 Part 2 对练', BASIC_PRACTICE),
      'utf-8',
    )
    // 扁平技能（misc 目录）+ 契约
    await writeFile(
      join(skillsDir, 'free-talk', 'SKILL.md'),
      practiceSkillMd('free-talk', '自由对话教练', '  schema: 1\n'),
      'utf-8',
    )
    // 没有 hermes_practice → 不是练习技能
    await writeFile(
      join(skillsDir, 'practice', 'plain-skill', 'SKILL.md'),
      '# Plain Skill\n不是练习技能\n',
      'utf-8',
    )
    // 非法 schema → 不是练习技能
    await mkdir(join(skillsDir, 'bad-schema'), { recursive: true })
    await writeFile(
      join(skillsDir, 'bad-schema', 'SKILL.md'),
      practiceSkillMd('bad-schema', '坏 schema', '  schema: 2\n'),
      'utf-8',
    )

    mockGetProfileDir.mockReturnValue(profileDir)
    mockReadConfigYamlForProfile.mockResolvedValue({})

    try {
      const { listPracticeSkills } = await loadController()
      const ctx: any = { state: { profile: { name: 'default' } }, body: null }
      await listPracticeSkills(ctx)

      const skills: any[] = ctx.body.skills
      expect(skills.length).toBe(2)
      const ielts = skills.find((skill: any) => skill.name === 'ielts-part2')
      expect(ielts).toMatchObject({ category: 'practice', source: 'local', enabled: true })
      expect(ielts.manifest.schema).toBe(1)
      expect(ielts.manifest.evaluation.dimensions[0]).toMatchObject({ id: 'fluency', label: '流利度' })
      const freeTalk = skills.find((skill: any) => skill.name === 'free-talk')
      expect(freeTalk).toMatchObject({ category: 'misc' })
      expect(skills.some((skill: any) => skill.name === 'plain-skill')).toBe(false)
      expect(skills.some((skill: any) => skill.name === 'bad-schema')).toBe(false)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('禁用列表中的练习技能 enabled=false；外部目录技能 source=external', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hermes-web-ui-practice-external-'))
    const profileDir = join(root, 'profile')
    const skillsDir = join(profileDir, 'skills')
    const externalDir = join(root, 'external-skills')
    await mkdir(join(skillsDir, 'sales', 'local-sales'), { recursive: true })
    await mkdir(join(externalDir, 'sales', 'ext-sales'), { recursive: true })
    await writeFile(
      join(skillsDir, 'sales', 'local-sales', 'SKILL.md'),
      practiceSkillMd('local-sales', '本地销售', '  schema: 1\n'),
      'utf-8',
    )
    await writeFile(
      join(externalDir, 'sales', 'ext-sales', 'SKILL.md'),
      practiceSkillMd('ext-sales', '外部销售', '  schema: 1\n'),
      'utf-8',
    )

    mockGetProfileDir.mockReturnValue(profileDir)
    mockReadConfigYamlForProfile.mockResolvedValue({
      skills: { disabled: ['local-sales'], external_dirs: [externalDir] },
    })

    try {
      const { listPracticeSkills } = await loadController()
      const ctx: any = { state: { profile: { name: 'default' } }, body: null }
      await listPracticeSkills(ctx)

      const skills: any[] = ctx.body.skills
      expect(skills.find((skill: any) => skill.name === 'local-sales')).toMatchObject({
        enabled: false,
        source: 'local',
      })
      expect(skills.find((skill: any) => skill.name === 'ext-sales')).toMatchObject({
        category: 'sales',
        source: 'external',
        enabled: true,
      })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('非 hermes target 返回空列表', async () => {
    const { listPracticeSkills } = await loadController()
    const ctx: any = { state: { profile: { name: 'default' } }, query: { target: 'codex' }, body: null }
    await listPracticeSkills(ctx)
    expect(ctx.body).toEqual({ skills: [] })
  })

  it('ensurePracticeSampleSkills 把缺失的内置示例技能装到 skills/practice/，已有则跳过', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hermes-web-ui-practice-ensure-'))
    const sourceRoot = join(root, 'source')
    const targetRoot = join(root, 'profile', 'skills')
    await mkdir(join(sourceRoot, 'practice-ielts-part2'), { recursive: true })
    await mkdir(join(sourceRoot, 'practice-sales-pitch'), { recursive: true })
    // 目标里已存在同名的用户自建技能 → 不改写
    await mkdir(join(targetRoot, 'practice', 'practice-ielts-part2'), { recursive: true })
    await writeFile(
      join(targetRoot, 'practice', 'practice-ielts-part2', 'SKILL.md'),
      '# user version\n保持用户内容\n',
      'utf-8',
    )
    await writeFile(
      join(sourceRoot, 'practice-ielts-part2', 'SKILL.md'),
      '# source version\n',
      'utf-8',
    )
    await writeFile(
      join(sourceRoot, 'practice-sales-pitch', 'SKILL.md'),
      '---\nname: practice-sales-pitch\nhermes_practice:\n  schema: 1\n---\n# sales\n',
      'utf-8',
    )

    try {
      const { ensurePracticeSampleSkills, BUNDLED_PRACTICE_SKILLS } = await loadController()
      // 只提供两个源（其余源目录缺失自动跳过）
      const installed = await ensurePracticeSampleSkills(targetRoot, sourceRoot)
      expect(installed).toEqual(['practice-sales-pitch'])
      const keptUser = await (await import('fs/promises')).readFile(
        join(targetRoot, 'practice', 'practice-ielts-part2', 'SKILL.md'),
        'utf-8',
      )
      expect(keptUser).toContain('user version')
      expect(BUNDLED_PRACTICE_SKILLS).toContain('practice-knowledge-quiz')
      const installedSkill = await (await import('fs/promises')).readFile(
        join(targetRoot, 'practice', 'practice-sales-pitch', 'SKILL.md'),
        'utf-8',
      )
      expect(installedSkill).toContain('schema: 1')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
