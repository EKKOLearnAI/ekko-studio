import { getSkillFileProvider } from '../../studio/public/skill-files'
import { assertCodingAgentSkillWritable, isSharedCodingAgentSkill } from '../../studio/public/shared-skills'
import { mkdir, readdir, readFile, realpath, rm, stat, writeFile, cp } from 'fs/promises'
import { homedir, tmpdir } from 'os'
import { dirname, join, resolve } from 'path'
import { createHash, randomBytes } from 'crypto'
import AdmZip from 'adm-zip'
import {
  readConfigYamlForProfile, updateConfigYamlForProfile,
} from '../../studio/public/profile-config'
import { safeReadFile, extractDescription, listFilesRecursive } from '../../studio/public/files'
import type { SkillSource } from '../../studio/contracts/skills'
import { isPathWithin } from '../services/runtime/path'
import { getActiveProfileName, getProfileDir } from '../services/profiles/profile'
import { listSkillUsageEventsAfterMessageId } from '../services/history/sessions-db'
import { isHermesAgentAvailable } from '../../studio/public/agent-status-registry'
import {
  getLocalSkillUsageStats,
  getSkillUsageSyncCursor,
  syncExternalSkillUsageEvents,
} from '../../studio/public/skill-usage'
import { getCodingAgentGlobalHome } from '../../studio/public/coding-agent-global-home'

function requestedProfile(ctx: any): string {
  return ctx.state?.profile?.name || getActiveProfileName() || 'default'
}

function requestProfileDir(ctx: any): string {
  return getProfileDir(requestedProfile(ctx))
}

function requestSkillsDir(ctx: any): string {
  return join(requestProfileDir(ctx), 'skills')
}

type SkillTarget = 'hermes' | 'claude' | 'codex' | 'pi' | 'grok' | 'opencode' | 'dsh' | 'cursor' | 'antigravity'

function requestSkillTarget(ctx: any): SkillTarget {
  const target = String(ctx.query?.target || 'hermes').trim().toLowerCase()
  return target === 'claude' || target === 'codex' || target === 'pi' || target === 'grok' || target === 'opencode' || target === 'dsh' || (target === 'cursor' || target === 'antigravity') ? target : 'hermes'
}

function globalSkillsDir(target: Exclude<SkillTarget, 'hermes'>): string {
  const globalHome = getCodingAgentGlobalHome()
  return target === 'antigravity' ? join(globalHome, '.gemini', 'config', 'skills') : target === 'cursor' ? join(globalHome, '.cursor', 'skills') : target === 'dsh' ? join(globalHome, '.dsh', 'skills') : target === 'claude'
    ? join(globalHome, '.claude', 'skills')
    : target === 'grok'
      ? join(globalHome, '.grok', 'skills')
      : target === 'opencode'
        ? join(globalHome, '.config', 'opencode', 'skills')
      : join(globalHome, '.agents', 'skills')
}

function codexSystemSkillsDir(): string {
  return join(getCodingAgentGlobalHome(), '.codex', 'skills', '.system')
}

function sharedAgentSkillsDir(): string {
  return join(getCodingAgentGlobalHome(), '.agents', 'skills')
}

function requestTargetSkillsDir(ctx: any): string {
  const target = requestSkillTarget(ctx)
  return target === 'hermes' ? requestSkillsDir(ctx) : globalSkillsDir(target)
}

async function resolveSkillDirForTarget(ctx: any, category: string, skillName: string): Promise<string | null> {
  const target = requestSkillTarget(ctx)
  const skillsDir = requestTargetSkillsDir(ctx)
  if (target === 'hermes') {
    const config = await readConfigYamlForProfile(requestedProfile(ctx))
    return resolveSkillDirFromConfig(config, skillsDir, category, skillName)
  }

  if (target === 'dsh') {
    if (category !== 'misc') return null
    const file = await getSkillFileProvider('dsh').findFile([skillsDir, sharedAgentSkillsDir()], skillName)
    return file && !file.flat ? file.directory : null
  }
  const localSkillDir = await findSkillDirInRoot(skillsDir, category, skillName)
  if (localSkillDir) return localSkillDir

  if (target === 'codex') {
    return findSkillDirInRoot(codexSystemSkillsDir(), category, skillName)
  }
  if (target === 'grok' || target === 'opencode' || (target === 'cursor' || target === 'antigravity')) {
    return findSkillDirInRoot(sharedAgentSkillsDir(), category, skillName)
  }

  return null
}

function expandConfiguredPath(value: string): string {
  const expandedEnv = value.replace(/\$\{([^}]+)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, (_match, braced, bare) => {
    return process.env[braced || bare] || ''
  })
  if (expandedEnv === '~') return homedir()
  if (expandedEnv.startsWith('~/')) return join(homedir(), expandedEnv.slice(2))
  return expandedEnv
}

/** Read `config.skills.external_dirs` verbatim (after trim, dropping empties),
 *  preserving `~`/`$VAR` so the UI can show what the user typed. */
function readRawExternalDirs(config: Record<string, any>): string[] {
  const rawDirs = config.skills?.external_dirs
  const entries = typeof rawDirs === 'string'
    ? [rawDirs]
    : Array.isArray(rawDirs)
      ? rawDirs
      : []
  const out: string[] = []
  for (const entry of entries) {
    const trimmed = String(entry || '').trim()
    if (trimmed) out.push(trimmed)
  }
  return out
}

interface ExternalDirEntryDto {
  raw: string
  expanded: string
  exists: boolean
  isDir: boolean
}

/** Read raw entries and stat each one. Order preserved. */
async function describeRawExternalDirs(config: Record<string, any>): Promise<ExternalDirEntryDto[]> {
  const rawEntries = readRawExternalDirs(config)
  return Promise.all(rawEntries.map(async (raw) => {
    const expanded = resolve(expandConfiguredPath(raw))
    let exists = false
    let isDir = false
    try {
      const info = await stat(expanded)
      exists = true
      isDir = info.isDirectory()
    } catch { /* missing → exists=false */ }
    return { raw, expanded, exists, isDir }
  }))
}

async function resolveExternalSkillsDirs(config: Record<string, any>, localSkillsDir: string): Promise<string[]> {
  const rawDirs = config.skills?.external_dirs
  const entries = typeof rawDirs === 'string'
    ? [rawDirs]
    : Array.isArray(rawDirs)
      ? rawDirs
      : []
  const localResolved = resolve(localSkillsDir)
  const seen = new Set<string>()
  const dirs: string[] = []

  for (const rawEntry of entries) {
    const entry = String(rawEntry || '').trim()
    if (!entry) continue
    const expanded = expandConfiguredPath(entry)
    const resolved = resolve(expanded)
    if (resolved === localResolved || seen.has(resolved)) continue
    try {
      const info = await stat(resolved)
      if (!info.isDirectory()) continue
    } catch {
      continue
    }
    seen.add(resolved)
    dirs.push(resolved)
  }

  return dirs
}

/** Read bundled manifest as a name→hash map from ~/.hermes/skills/.bundled_manifest */
function readBundledManifest(manifestContent: string | null): Map<string, string> {
  const map = new Map<string, string>()
  if (!manifestContent) return map
  for (const line of manifestContent.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    const idx = trimmed.indexOf(':')
    if (idx === -1) continue
    const name = trimmed.slice(0, idx).trim()
    const hash = trimmed.slice(idx + 1).trim()
    if (name && hash) map.set(name, hash)
  }
  return map
}

/** Read hub-installed skill names from ~/.hermes/skills/.hub/lock.json */
function readHubInstalledNames(lockContent: string | null): Set<string> {
  if (!lockContent) return new Set()
  try {
    const data = JSON.parse(lockContent)
    if (data?.installed && typeof data.installed === 'object') {
      return new Set(Object.keys(data.installed))
    }
  } catch { /* ignore */ }
  return new Set()
}

/** Compute md5 hash of all files in a directory (mirrors Hermes _dir_hash), with in-memory cache */
const hashCache = new Map<string, { hash: string; mtime: number }>()
const HASH_CACHE_TTL = 60_000 // 1 minute

async function dirHash(directory: string): Promise<string> {
  const cached = hashCache.get(directory)
  if (cached && Date.now() - cached.mtime < HASH_CACHE_TTL) return cached.hash

  const hasher = createHash('md5')
  const files = await listFilesRecursive(directory, '')
  files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)
  for (const f of files) {
    hasher.update(f.path)
    const content = await readFile(join(directory, f.path))
    hasher.update(content)
  }
  const hash = hasher.digest('hex')
  hashCache.set(directory, { hash, mtime: Date.now() })
  return hash
}

/** Determine the source type of a skill */
function getSkillSource(
  dirName: string,
  bundledManifest: Map<string, string>,
  hubNames: Set<string>,
): SkillSource {
  if (bundledManifest.has(dirName)) return 'builtin'
  if (hubNames.has(dirName)) return 'hub'
  return 'local'
}

/** Read .usage.json as a name→stats map */
interface UsageStats { patch_count: number; use_count: number; view_count: number; pinned: boolean }
function readUsageStats(usageContent: string | null): Map<string, UsageStats> {
  const map = new Map<string, UsageStats>()
  if (!usageContent) return map
  try {
    const data = JSON.parse(usageContent)
    for (const [name, stats] of Object.entries(data)) {
      const s = stats as any
      map.set(name, { patch_count: s.patch_count ?? 0, use_count: s.use_count ?? 0, view_count: s.view_count ?? 0, pinned: !!s.pinned })
    }
  } catch { /* ignore */ }
  return map
}

async function findSkillDirByName(rootDir: string, skillName: string, visited = new Set<string>()): Promise<string | null> {
  const currentRealPath = await realpath(rootDir).catch(() => resolve(rootDir))
  if (visited.has(currentRealPath)) return null
  visited.add(currentRealPath)

  let entries: VisibleDirectoryEntry[]
  try {
    entries = await listVisibleDirectoryEntries(rootDir)
  } catch {
    return null
  }

  for (const entry of entries) {
    const entryPath = entry.path
    const skillMd = await safeReadFile(join(entryPath, 'SKILL.md'))
    if (skillMd !== null) {
      if (entry.name === skillName) return entryPath
      // This is another skill root. Do not search inside its references/scripts.
      continue
    }

    const found = await findSkillDirByName(entryPath, skillName, visited)
    if (found) return found
  }

  return null
}

async function findSkillDirInRoot(rootDir: string, category: string, skillName: string): Promise<string | null> {
  if (category === 'misc') {
    const skillDir = join(rootDir, skillName)
    const skillMd = await safeReadFile(join(skillDir, 'SKILL.md'))
    return skillMd !== null ? skillDir : null
  }
  return findSkillDirByName(join(rootDir, category), skillName)
}

async function resolveSkillDirFromConfig(
  config: Record<string, any>,
  localSkillsDir: string,
  category: string,
  skillName: string,
): Promise<string | null> {
  const localSkillDir = await findSkillDirInRoot(localSkillsDir, category, skillName)
  if (localSkillDir) return localSkillDir

  for (const externalDir of await resolveExternalSkillsDirs(config, localSkillsDir)) {
    const externalSkillDir = await findSkillDirInRoot(externalDir, category, skillName)
    if (externalSkillDir) return externalSkillDir
  }
  return null
}

interface VisibleDirectoryEntry {
  name: string
  path: string
}

async function listVisibleDirectoryEntries(dir: string): Promise<VisibleDirectoryEntry[]> {
  const entries = await readdir(dir, { withFileTypes: true })
  const directories: VisibleDirectoryEntry[] = []

  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue

    const entryPath = join(dir, entry.name)
    try {
      const info = await stat(entryPath)
      if (!info.isDirectory()) continue
      directories.push({
        name: entry.name,
        path: entryPath,
      })
    } catch {
      continue
    }
  }

  return directories
}

/**
 * Scan for skills at different directory depths.
 *
 * Supports both:
 *   - Three-level: skills/<category>/<skill-name>/SKILL.md  (category is a container)
 *   - Two-level:   skills/<skill-name>/SKILL.md            (flat skill under "misc" category)
 *
 * Categories are identified by having a DESCRIPTION.md at the category level
 * or by containing subdirectories with SKILL.md (three-level pattern).
 * Skills without a parent category (flat skills) are grouped under the "misc" category.
 */
async function scanSkillsDir(skillsDir: string, bundledManifest: Map<string, string>, hubNames: Set<string>, disabledList: string[], usageStats: Map<string, UsageStats>) {
  const rootRealPath = await realpath(skillsDir).catch(() => resolve(skillsDir))
  const dirEntries = await listVisibleDirectoryEntries(skillsDir)

  // Classify directories: categories vs. flat skills
  const categoryDirs: { name: string; description: string; path: string }[] = []
  const flatSkills: { name: string; skillMd: string; source: string }[] = []

  for (const entry of dirEntries) {
    const catDir = entry.path
    const hasDesc = await safeReadFile(join(catDir, 'DESCRIPTION.md'))
    const hasSkillMd = await safeReadFile(join(catDir, 'SKILL.md'))
    const subDirs = await listVisibleDirectoryEntries(catDir)

    // Priority: SKILL.md at top level → flat skill
    //           DESCRIPTION.md or subdirs (without SKILL.md) → category
    if (hasSkillMd) {
      // Flat skill: has SKILL.md at the top level (two-level pattern)
      // Could also have subdirectories (references/, scripts/, etc.)
      flatSkills.push({
        name: entry.name,
        skillMd: hasSkillMd,
        source: getSkillSource(entry.name, bundledManifest, hubNames),
      })
    } else if (!!hasDesc || subDirs.length > 0) {
      // True category: has DESCRIPTION.md or subdirs, but no SKILL.md at top level
      const catDescription = hasDesc ? hasDesc.trim().split('\n')[0].replace(/^#+\s*/, '').slice(0, 100) : ''
      categoryDirs.push({ name: entry.name, description: catDescription, path: catDir })
    }
  }

  // Build categories with their nested skills
  const categories: any[] = []

  for (const cat of categoryDirs) {
    const catDir = cat.path
    const skills: any[] = []
    // Recursively collect skills from subdirectories (supports nested sub-categories)
    async function collectSkills(dir: string, visited = new Set<string>([rootRealPath])): Promise<any[]> {
      const currentRealPath = await realpath(dir).catch(() => resolve(dir))
      if (visited.has(currentRealPath)) return []
      visited.add(currentRealPath)

      const entries = await listVisibleDirectoryEntries(dir)
      const results: any[] = []
      for (const entry of entries) {
        const entryPath = entry.path
        const skillMd = await safeReadFile(join(entryPath, 'SKILL.md'))
        if (skillMd) {
          const source = getSkillSource(entry.name, bundledManifest, hubNames)
          let modified = false
          if (source === 'builtin') {
            const manifestHash = bundledManifest.get(entry.name)
            if (manifestHash) {
              const currentHash = await dirHash(entryPath)
              modified = currentHash !== manifestHash
            }
          }
          const usage = usageStats.get(entry.name)
          results.push({
            name: entry.name,
            description: extractDescription(skillMd),
            enabled: !disabledList.includes(entry.name),
            source,
            modified: modified || undefined,
            patchCount: usage?.patch_count,
            useCount: usage?.use_count,
            viewCount: usage?.view_count,
            pinned: usage?.pinned || undefined,
          })
        } else {
          // No SKILL.md — might be a sub-category container, recurse deeper
          const subResults = await collectSkills(entryPath, visited)
          results.push(...subResults)
        }
      }
      return results
    }
    skills.push(...await collectSkills(catDir))
    if (skills.length > 0) {
      categories.push({ name: cat.name, description: cat.description, skills })
    }
  }

  // Group flat skills into a "misc" (雜項) category
  if (flatSkills.length > 0) {
    const miscSkills: any[] = []
    for (const fs of flatSkills) {
      const usage = usageStats.get(fs.name)
      miscSkills.push({
        name: fs.name,
        description: extractDescription(fs.skillMd),
        enabled: !disabledList.includes(fs.name),
        source: fs.source,
        modified: undefined,
        patchCount: usage?.patch_count,
        useCount: usage?.use_count,
        viewCount: usage?.view_count,
        pinned: usage?.pinned || undefined,
      })
    }
    miscSkills.sort((a: any, b: any) => a.name.localeCompare(b.name))
    categories.push({
      name: 'misc',
      description: '雜項',
      skills: miscSkills,
    })
  }

  categories.sort((a, b) => a.name.localeCompare(b.name))
  for (const cat of categories) { cat.skills.sort((a: any, b: any) => a.name.localeCompare(b.name)) }
  return categories
}

async function scanSkillsDirIfExists(skillsDir: string, bundledManifest: Map<string, string>, hubNames: Set<string>, disabledList: string[], usageStats: Map<string, UsageStats>) {
  try {
    const info = await stat(skillsDir)
    if (!info.isDirectory()) return []
  } catch {
    return []
  }
  return scanSkillsDir(skillsDir, bundledManifest, hubNames, disabledList, usageStats)
}

function withSkillSource(categories: any[], source: SkillSource): any[] {
  return categories.map(category => ({
    ...category,
    skills: (category.skills || []).map((skill: any) => ({
      ...skill,
      source,
    })),
  }))
}

async function scanExternalSkillsDir(
  skillsDir: string,
  disabledList: string[],
  usageStats: Map<string, UsageStats>,
  sourcePath: string,
) {
  return scanSkillsDir(skillsDir, new Map(), new Set(), disabledList, usageStats).then(categories =>
    categories.map(category => ({
      ...category,
      skills: category.skills.map((skill: any) => ({
        ...skill,
        source: 'external' as SkillSource,
        modified: undefined,
        sourcePath,
      })),
    })),
  )
}

function collectSkillNames(categories: any[]): Set<string> {
  const names = new Set<string>()
  for (const category of categories) {
    for (const skill of category.skills || []) {
      if (skill?.name) names.add(skill.name)
    }
  }
  return names
}

function mergeExternalCategories(categories: any[], externalCategories: any[]): any[] {
  const byName = new Map<string, any>()
  for (const category of categories) {
    byName.set(category.name, { ...category, skills: [...category.skills] })
  }

  const seenSkills = collectSkillNames(categories)
  for (const externalCategory of externalCategories) {
    const target = byName.get(externalCategory.name) || {
      name: externalCategory.name,
      description: externalCategory.description,
      skills: [],
    }
    for (const skill of externalCategory.skills || []) {
      if (seenSkills.has(skill.name)) continue
      seenSkills.add(skill.name)
      target.skills.push(skill)
    }
    if (target.skills.length > 0) byName.set(target.name, target)
  }

  const merged = [...byName.values()]
    .filter(category => category.skills.length > 0)
    .sort((a, b) => a.name.localeCompare(b.name))
  for (const category of merged) {
    category.skills.sort((a: any, b: any) => a.name.localeCompare(b.name))
  }
  return merged
}

export async function list(ctx: any) {
  const target = requestSkillTarget(ctx)
  const skillsDir = requestTargetSkillsDir(ctx)
  try {
    if (target === 'dsh') {
      const roots = [skillsDir, sharedAgentSkillsDir()]
      ctx.body = { categories: await getSkillFileProvider('dsh').list(roots), archived: [], paths: { local: skillsDir, external: roots.slice(1) } }
      return
    }
    if (target !== 'hermes') {
      let categories = await scanSkillsDirIfExists(skillsDir, new Map(), new Set(), [], new Map())
      const extraDirs: string[] = []
      if (target === 'codex') {
        const systemDir = codexSystemSkillsDir()
        extraDirs.push(systemDir)
        const systemCategories = withSkillSource(
          await scanSkillsDirIfExists(systemDir, new Map(), new Set(), [], new Map()),
          'builtin',
        )
        categories = mergeExternalCategories(categories, systemCategories)
      } else if (target === 'grok' || target === 'opencode' || (target === 'cursor' || target === 'antigravity')) {
        const sharedDir = sharedAgentSkillsDir()
        extraDirs.push(sharedDir)
        const sharedCategories = withSkillSource(
          await scanSkillsDirIfExists(sharedDir, new Map(), new Set(), [], new Map()),
          'local',
        )
        categories = mergeExternalCategories(categories, sharedCategories)
      }
      ctx.body = {
        categories: await Promise.all(categories.map(async category => ({
          ...category,
          skills: await Promise.all(category.skills.map(async (skill: { name: string }) => {
            const directory = await resolveSkillDirForTarget(ctx, category.name, skill.name)
            return { ...skill, readonly: directory ? await isSharedCodingAgentSkill(join(directory, 'SKILL.md')) : true }
          })),
        }))),
        archived: [],
        paths: { local: skillsDir, external: extraDirs },
      }
      return
    }

    const config = await readConfigYamlForProfile(requestedProfile(ctx))
    const disabledList: string[] = config.skills?.disabled || []

    // Read provenance sources
    const bundledManifest = readBundledManifest(await safeReadFile(join(skillsDir, '.bundled_manifest')))
    const hubNames = readHubInstalledNames(await safeReadFile(join(skillsDir, '.hub', 'lock.json')))
    const usageStats = readUsageStats(await safeReadFile(join(skillsDir, '.usage.json')))

    // Scan all skills (supports both two-level and three-level directory structures)
    let categories = await scanSkillsDirIfExists(skillsDir, bundledManifest, hubNames, disabledList, usageStats)
    // Map resolved → raw so we can attach the user-written path (e.g. ~/...) to
    // each external skill — the SkillsView groups by this when the external
    // filter is active.
    const rawByResolved = new Map<string, string>()
    for (const entry of await describeRawExternalDirs(config)) {
      if (!rawByResolved.has(entry.expanded)) rawByResolved.set(entry.expanded, entry.raw)
    }
    for (const externalDir of await resolveExternalSkillsDirs(config, skillsDir)) {
      const sourcePath = rawByResolved.get(externalDir) || externalDir
      const externalCategories = await scanExternalSkillsDir(externalDir, disabledList, usageStats, sourcePath)
      categories = mergeExternalCategories(categories, externalCategories)
    }

    // Read archived skills from .archive/
    const archived: any[] = []
    const archiveDir = join(skillsDir, '.archive')
    const archiveEntries = await readdir(archiveDir, { withFileTypes: true }).catch(() => [] as import('fs').Dirent[])
    for (const entry of archiveEntries) {
      if (!entry.isDirectory()) continue
      const skillMd = await safeReadFile(join(archiveDir, entry.name, 'SKILL.md'))
      if (skillMd) {
        const usage = usageStats.get(entry.name)
        archived.push({
          name: entry.name,
          description: extractDescription(skillMd),
          source: getSkillSource(entry.name, bundledManifest, hubNames),
          patchCount: usage?.patch_count,
          useCount: usage?.use_count,
          viewCount: usage?.view_count,
          pinned: usage?.pinned || undefined,
        })
      }
    }
    archived.sort((a: any, b: any) => a.name.localeCompare(b.name))

    const externalDirs = await resolveExternalSkillsDirs(config, skillsDir)
    const externalRaw = await describeRawExternalDirs(config)
    ctx.body = {
      categories,
      archived,
      paths: { local: skillsDir, external: externalDirs, externalRaw },
    }
  } catch (err: any) {
    ctx.status = 500
    ctx.body = { error: `Failed to read skills directory: ${err.message}` }
  }
}

export async function usageStats(ctx: any) {
  const rawDays = parseInt(String(ctx.query?.days ?? '7'), 10)
  const days = Number.isFinite(rawDays) && rawDays > 0 ? Math.min(rawDays, 365) : 7
  const profile = requestedProfile(ctx)
  const local = getLocalSkillUsageStats(days, undefined, profile, false)

  if (!isHermesAgentAvailable()) {
    ctx.body = local.stats
    return
  }

  try {
    const cursorKey = `hermes:${profile}`
    const cursor = getSkillUsageSyncCursor(cursorKey)
    const page = await listSkillUsageEventsAfterMessageId(cursor, profile)
    syncExternalSkillUsageEvents('hermes', profile, page.events, page.cursor, page.reset)
    ctx.body = getLocalSkillUsageStats(days, undefined, profile, true).stats
  } catch {
    // Studio-local events remain authoritative and useful even if the optional
    // Hermes history database is unreadable.
    ctx.body = local.stats
  }
}

const MAX_EXTERNAL_DIR_LEN = 2048

/** GET /api/hermes/skills/external-dirs — return the raw list with existence flags */
export async function listExternalDirs(ctx: any) {
  try {
    const config = await readConfigYamlForProfile(requestedProfile(ctx))
    ctx.body = { dirs: await describeRawExternalDirs(config) }
  } catch (err: any) {
    ctx.status = 500
    ctx.body = { error: err.message }
  }
}

/** PUT /api/hermes/skills/external-dirs — replace the list verbatim. */
export async function updateExternalDirs(ctx: any) {
  const body = (ctx.request.body || {}) as { dirs?: unknown }
  if (!Array.isArray(body.dirs)) {
    ctx.status = 400
    ctx.body = { error: 'dirs must be an array of strings' }
    return
  }
  const cleaned: string[] = []
  for (const entry of body.dirs) {
    if (typeof entry !== 'string') {
      ctx.status = 400
      ctx.body = { error: 'dirs entries must be strings' }
      return
    }
    if (entry.length > MAX_EXTERNAL_DIR_LEN) {
      ctx.status = 400
      ctx.body = { error: `Path too long (max ${MAX_EXTERNAL_DIR_LEN} chars)` }
      return
    }
    // eslint-disable-next-line no-control-regex
    if (/[\x00-\x1f]/.test(entry)) {
      ctx.status = 400
      ctx.body = { error: 'Path contains control characters' }
      return
    }
    const trimmed = entry.trim()
    if (trimmed) cleaned.push(trimmed)
  }

  // Dedupe verbatim (case-sensitive). Two different `~`/`$VAR` strings that
  // resolve to the same dir are kept — the user wrote both intentionally.
  const seen = new Set<string>()
  const deduped: string[] = []
  for (const entry of cleaned) {
    if (seen.has(entry)) continue
    seen.add(entry)
    deduped.push(entry)
  }

  try {
    await updateConfigYamlForProfile(requestedProfile(ctx), (config) => {
      if (!config.skills) config.skills = {}
      if (deduped.length === 0) {
        delete config.skills.external_dirs
      } else {
        // Always normalise to array form even if the previous value was a string.
        config.skills.external_dirs = deduped
      }
      return config
    })
    ctx.body = { success: true, dirs: deduped }
  } catch (err: any) {
    ctx.status = 500
    ctx.body = { error: err.message }
  }
}

export async function toggle(ctx: any) {
  const { name, enabled } = ctx.request.body as { name?: string; enabled?: boolean }
  if (!name || typeof enabled !== 'boolean') {
    ctx.status = 400
    ctx.body = { error: 'Missing name or enabled flag' }
    return
  }
  try {
    await updateConfigYamlForProfile(requestedProfile(ctx), (config) => {
      if (!config.skills) config.skills = {}
      if (!Array.isArray(config.skills.disabled)) config.skills.disabled = []
      const disabled = config.skills.disabled as string[]
      const idx = disabled.indexOf(name)
      if (enabled) { if (idx !== -1) disabled.splice(idx, 1) }
      else { if (idx === -1) disabled.push(name) }
      return config
    })
    ctx.body = { success: true }
  } catch (err: any) {
    ctx.status = 500
    ctx.body = { error: err.message }
  }
}

export async function listFiles(ctx: any) {
  const { category, skill } = ctx.params
  try {
    if (requestSkillTarget(ctx) === 'dsh' && category === 'misc') {
      const file = await getSkillFileProvider('dsh').findFile([requestTargetSkillsDir(ctx), sharedAgentSkillsDir()], skill)
      if (file?.flat) { ctx.body = { files: [] }; return }
    }
    const skillDir = await resolveSkillDirForTarget(ctx, category, skill)
    if (!skillDir) {
      ctx.status = 404
      ctx.body = { error: 'Skill not found' }
      return
    }
    const allFiles = await listFilesRecursive(skillDir, '')
    const files = allFiles.filter((f: any) => f.path !== 'SKILL.md')
    ctx.body = { files }
  } catch (err: any) {
    ctx.status = 500
    ctx.body = { error: err.message }
  }
}

export async function readFile_(ctx: any) {
  const filePath = (ctx.params as any).path
  const profileSkillsDir = requestTargetSkillsDir(ctx)
  if (requestSkillTarget(ctx) === 'dsh') {
    const parts = String(filePath).split('/')
    if (parts[0] !== 'misc' || parts.length < 3) { ctx.status = 404; ctx.body = { error: 'File not found' }; return }
    const file = await getSkillFileProvider('dsh').findFile([profileSkillsDir, sharedAgentSkillsDir()], parts[1])
    const suffix = parts.slice(2).join('/')
    const path = file ? (suffix === 'SKILL.md' ? file.path : !file.flat ? resolve(file.directory, suffix) : '') : ''
    if (!file || !path || !isPathWithin(path, file.directory)) { ctx.status = 404; ctx.body = { error: 'File not found' }; return }
    const content = await safeReadFile(path)
    if (content === null) { ctx.status = 404; ctx.body = { error: 'File not found' }; return }
    ctx.body = { content }; return
  }
  // Handle 'misc' category: real skill dir is skills/<skill>, not skills/misc/<skill>
  let realPath = filePath
  if (filePath.startsWith('misc/')) {
    realPath = filePath.slice(5)
  }
  const fullPath = resolve(join(profileSkillsDir, realPath))
  if (!isPathWithin(fullPath, profileSkillsDir)) {
    ctx.status = 403
    ctx.body = { error: 'Access denied' }
    return
  }
  let content = await safeReadFile(fullPath)
  if (content === null) {
    // Fallback: recursive search for nested skills (e.g., mlops/lm-evaluation-harness/SKILL.md
    // where actual path is mlops/evaluation/lm-evaluation-harness/SKILL.md)
    const parts = filePath.split('/')
    if (parts.length >= 2) {
      const category = parts[0]
      const skillName = parts[1]
      const restPath = parts.slice(2).join('/')
      const skillDir = await resolveSkillDirForTarget(ctx, category, skillName)
      if (skillDir) {
        const resolvedPath = resolve(join(skillDir, restPath))
        if (isPathWithin(resolvedPath, skillDir)) {
          const nestedContent = await safeReadFile(resolvedPath)
          if (nestedContent !== null) {
            ctx.body = { content: nestedContent }
            return
          }
        }
      }
    }
    ctx.status = 404
    ctx.body = { error: 'File not found' }
    return
  }
  ctx.body = { content }
}

async function updatePinnedSkill(skillsDir: string, name: string, pinned: boolean): Promise<void> {
  await mkdir(skillsDir, { recursive: true })
  const usagePath = join(skillsDir, '.usage.json')
  let usage: Record<string, any> = {}
  const raw = await safeReadFile(usagePath)
  if (raw) {
    try {
      const parsed = JSON.parse(raw)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) usage = parsed
    } catch { /* rewrite malformed usage file with the requested pin state */ }
  }
  const current = usage[name]
  usage[name] = current && typeof current === 'object' && !Array.isArray(current)
    ? { ...current, pinned }
    : { patch_count: 0, use_count: 0, view_count: 0, pinned }
  await writeFile(usagePath, `${JSON.stringify(usage, null, 2)}\n`, 'utf-8')
}

export async function pin_(ctx: any) {
  const { name, pinned } = ctx.request.body as { name?: string; pinned?: boolean }
  if (!name || typeof pinned !== 'boolean') {
    ctx.status = 400
    ctx.body = { error: 'Missing name or pinned flag' }
    return
  }
  try {
    await updatePinnedSkill(requestSkillsDir(ctx), name, pinned)
    ctx.body = { success: true }
  } catch (err: any) {
    ctx.status = 500
    ctx.body = { error: err.message }
  }
}

const MAX_SKILL_UPLOAD_SIZE = 50 * 1024 * 1024 // 50MB
const MAX_SKILL_CONTENT_SIZE = 1024 * 1024 // 1MB

function isValidSkillName(name: string): boolean {
  // Reject empty / path traversal / absolute paths
  if (!name) return false
  if (name === '.' || name === '..') return false
  if (name.includes('/') || name.includes('\\') || name.includes('\0')) return false
  return true
}

export async function updateSkill(ctx: any) {
  const category = String((ctx.params as any)?.category || '')
  const name = String((ctx.params as any)?.skill || '')
  const content = (ctx.request.body as { content?: unknown } | undefined)?.content

  if (!isValidSkillName(category) || !isValidSkillName(name)) {
    ctx.status = 400
    ctx.body = { error: 'Invalid category or skill name' }
    return
  }
  if (typeof content !== 'string') {
    ctx.status = 400
    ctx.body = { error: 'content must be a string' }
    return
  }
  if (Buffer.byteLength(content, 'utf-8') > MAX_SKILL_CONTENT_SIZE) {
    ctx.status = 413
    ctx.body = { error: `Skill content too large (max ${MAX_SKILL_CONTENT_SIZE / 1024 / 1024}MB)` }
    return
  }

  const target = requestSkillTarget(ctx)
  const skillsDir = requestTargetSkillsDir(ctx)
  try {
    if (target === 'hermes') {
      const bundledManifest = readBundledManifest(await safeReadFile(join(skillsDir, '.bundled_manifest')))
      const hubNames = readHubInstalledNames(await safeReadFile(join(skillsDir, '.hub', 'lock.json')))
      const source = getSkillSource(name, bundledManifest, hubNames)
      if (source !== 'local') {
        ctx.status = 403
        ctx.body = { error: `Only local skills can be edited (this skill is ${source})` }
        return
      }
    }

    if (target === 'dsh') {
      getSkillFileProvider('dsh').validate(content)
      const file = category === 'misc' ? await getSkillFileProvider('dsh').findFile([skillsDir, sharedAgentSkillsDir()], name) : null
      if (!file) { ctx.status = 404; ctx.body = { error: 'Skill not found' }; return }
      await assertCodingAgentSkillWritable(file.path)
      await writeFile(file.path, content, 'utf-8')
      ctx.body = { success: true }; return
    }
    const usesSharedAgentSkills = target === 'grok' || target === 'opencode' || (target === 'cursor' || target === 'antigravity')
    const localSkillDir = usesSharedAgentSkills
      ? await resolveSkillDirForTarget(ctx, category, name)
      : await findSkillDirInRoot(skillsDir, category, name)
    if (!localSkillDir) {
      ctx.status = 404
      ctx.body = { error: 'Skill not found' }
      return
    }
    const writableRoots = usesSharedAgentSkills
      ? [skillsDir, sharedAgentSkillsDir()]
      : [skillsDir]
    if (!writableRoots.some(root => isPathWithin(localSkillDir, root))) {
      ctx.status = 403
      ctx.body = { error: 'Access denied' }
      return
    }

    await assertCodingAgentSkillWritable(join(localSkillDir, 'SKILL.md'))
    await writeFile(join(localSkillDir, 'SKILL.md'), content, 'utf-8')
    hashCache.delete(localSkillDir)
    ctx.body = { success: true }
  } catch (err: any) {
    ctx.status = err.status || 500
    ctx.body = { error: err.message }
  }
}

function splitMultipart(raw: Buffer, boundary: Buffer): Buffer[] {
  const parts: Buffer[] = []
  let start = 0
  while (true) {
    const idx = raw.indexOf(boundary, start)
    if (idx === -1) break
    if (start > 0) { parts.push(raw.subarray(start + 2, idx)) }
    start = idx + boundary.length
  }
  return parts
}

interface ParsedPart {
  fieldName: string
  filename: string | null
  data: Buffer
}

function parsePart(part: Buffer): ParsedPart | null {
  const headerEnd = part.indexOf(Buffer.from('\r\n\r\n'))
  if (headerEnd === -1) return null
  const headerBuf = part.subarray(0, headerEnd)
  const header = headerBuf.toString('utf-8')
  const data = part.subarray(headerEnd + 4, part.length - 2)

  const dispMatch = header.match(/Content-Disposition:\s*form-data;([^\r\n]*)/i)
  if (!dispMatch) return null
  const disp = dispMatch[1]
  const nameMatch = disp.match(/\bname="([^"]+)"/)
  if (!nameMatch) return null
  const fieldName = nameMatch[1]

  let filename: string | null = null
  const fnStarMatch = disp.match(/filename\*=UTF-8''([^;]+)/i)
  if (fnStarMatch) {
    filename = decodeURIComponent(fnStarMatch[1].trim().replace(/^"|"$/g, ''))
  } else {
    const fnMatch = disp.match(/\bfilename="([^"]*)"/)
    if (fnMatch) filename = fnMatch[1]
  }
  return { fieldName, filename, data }
}

export async function deleteSkill(ctx: any) {
  const category = String((ctx.params as any)?.category || '')
  const name = String((ctx.params as any)?.skill || '')
  if (!isValidSkillName(category) || !isValidSkillName(name)) {
    ctx.status = 400
    ctx.body = { error: 'Invalid category or skill name' }
    return
  }

  if (requestSkillTarget(ctx) === 'dsh') {
    const file = category === 'misc' ? await getSkillFileProvider('dsh').findFile([requestTargetSkillsDir(ctx), sharedAgentSkillsDir()], name) : null
    if (!file) { ctx.status = 404; ctx.body = { error: 'Skill not found' }; return }
    try { await assertCodingAgentSkillWritable(file.path) } catch (error: any) {
      ctx.status = error.status || 500; ctx.body = { error: error.message }; return
    }
    await rm(file.flat ? file.path : file.directory, { recursive: !file.flat, force: true })
    ctx.body = { success: true }; return
  }
  if (requestSkillTarget(ctx) === 'cursor' || requestSkillTarget(ctx) === 'antigravity') {
    try {
      const directory = await resolveSkillDirForTarget(ctx, category, name)
      if (!directory) { ctx.status = 404; ctx.body = { error: 'Skill not found' }; return }
      await assertCodingAgentSkillWritable(join(directory, 'SKILL.md'))
      if (!isPathWithin(directory, requestTargetSkillsDir(ctx))) {
        ctx.status = 403; ctx.body = { error: 'Access denied' }; return
      }
      await rm(directory, { recursive: true, force: true })
      ctx.body = { success: true }
    } catch (error: any) {
      ctx.status = error.status || 500; ctx.body = { error: error.message }
    }
    return
  }
  if (requestSkillTarget(ctx) !== 'hermes') {
    ctx.status = 403; ctx.body = { error: 'Skill deletion is not supported for this Coding Agent target' }; return
  }
  const skillsDir = requestSkillsDir(ctx)
  try {
    // Determine source — only allow deleting `local` skills
    const bundledManifest = readBundledManifest(await safeReadFile(join(skillsDir, '.bundled_manifest')))
    const hubNames = readHubInstalledNames(await safeReadFile(join(skillsDir, '.hub', 'lock.json')))
    const source = getSkillSource(name, bundledManifest, hubNames)
    if (source !== 'local') {
      ctx.status = 403
      ctx.body = { error: `Only local skills can be deleted (this skill is ${source})` }
      return
    }

    // Resolve via the same category-aware path used by list/listFiles/readFile_
    // so two skills sharing a name in different categories don't collide.
    // Skip `external_dirs` here — only the local profile dir is deletable.
    const localSkillDir = await findSkillDirInRoot(skillsDir, category, name)
    if (!localSkillDir) {
      ctx.status = 404
      ctx.body = { error: 'Skill not found' }
      return
    }
    if (!isPathWithin(localSkillDir, skillsDir)) {
      ctx.status = 403
      ctx.body = { error: 'Access denied' }
      return
    }

    await assertCodingAgentSkillWritable(join(localSkillDir, 'SKILL.md'))
    await rm(localSkillDir, { recursive: true, force: true })

    // Cleanup `disabled` list in profile config so the deleted name doesn't linger
    try {
      await updateConfigYamlForProfile(requestedProfile(ctx), (config) => {
        const list = config?.skills?.disabled
        if (Array.isArray(list)) {
          const idx = list.indexOf(name)
          if (idx !== -1) list.splice(idx, 1)
        }
        return config
      })
    } catch { /* config cleanup is best-effort */ }

    ctx.body = { success: true }
  } catch (err: any) {
    ctx.status = 500
    ctx.body = { error: err.message }
  }
}

async function readMultipartBody(ctx: any): Promise<{ parts: ParsedPart[] } | { error: string; status: number }> {
  const contentType = ctx.get('content-type') || ''
  if (!contentType.startsWith('multipart/form-data')) {
    return { error: 'Expected multipart/form-data', status: 400 }
  }
  const boundaryStr = contentType.split('boundary=')[1]
  if (!boundaryStr) return { error: 'Missing boundary', status: 400 }
  const boundary = '--' + boundaryStr.split(';')[0].trim()

  const chunks: Buffer[] = []
  let totalSize = 0
  for await (const chunk of ctx.req) {
    totalSize += chunk.length
    if (totalSize > MAX_SKILL_UPLOAD_SIZE) {
      return { error: `Upload too large (max ${MAX_SKILL_UPLOAD_SIZE / 1024 / 1024}MB)`, status: 413 }
    }
    chunks.push(chunk)
  }
  const raw = Buffer.concat(chunks)
  const rawParts = splitMultipart(raw, Buffer.from(boundary))
  const parts: ParsedPart[] = []
  for (const p of rawParts) {
    let parsed: ParsedPart | null
    try {
      parsed = parsePart(p)
    } catch (err) {
      if (err instanceof URIError) {
        return { error: 'Invalid multipart filename encoding', status: 400 }
      }
      throw err
    }
    if (parsed) parts.push(parsed)
  }
  return { parts }
}

async function pathExists(p: string): Promise<boolean> {
  try { await stat(p); return true } catch { return false }
}

export async function importSkill(ctx: any) {
  const parsed = await readMultipartBody(ctx)
  if ('error' in parsed) {
    ctx.status = parsed.status
    ctx.body = { error: parsed.error }
    return
  }

  const filePartsAll = parsed.parts.filter(p => p.fieldName === 'file' && p.filename !== null)
  const categoryPart = parsed.parts.find(p => p.fieldName === 'category' && p.filename === null)
  const category = categoryPart ? categoryPart.data.toString('utf-8').trim() : ''

  if (filePartsAll.length === 0) {
    ctx.status = 400
    ctx.body = { error: 'No files received' }
    return
  }

  // Sanity-check optional category — must be a single safe segment if provided
  if (category && !isValidSkillName(category)) {
    ctx.status = 400
    ctx.body = { error: 'Invalid category name' }
    return
  }

  const target = requestSkillTarget(ctx)
  if (target !== 'hermes' && target !== 'dsh' && (target !== 'cursor' && target !== 'antigravity')) { ctx.status = 400; ctx.body = { error: 'Skill import is not supported for this target' }; return }
  if (target === 'dsh' && category) { ctx.status = 400; ctx.body = { error: 'DSH skills must be imported without a category' }; return }
  const skillsDir = requestTargetSkillsDir(ctx)
  try { await assertCodingAgentSkillWritable(category ? join(skillsDir, category) : skillsDir) } catch (error: any) {
    ctx.status = error.status || 500; ctx.body = { error: error.message }; return
  }
  await mkdir(skillsDir, { recursive: true })
  const targetRoot = category ? join(skillsDir, category) : skillsDir

  // Provenance for conflict detection (cannot shadow builtin/hub)
  const bundledManifest = readBundledManifest(await safeReadFile(join(skillsDir, '.bundled_manifest')))
  const hubNames = readHubInstalledNames(await safeReadFile(join(skillsDir, '.hub', 'lock.json')))

  // Decide between "zip" and "folder" mode
  const isSingleZip = filePartsAll.length === 1 &&
    (filePartsAll[0].filename || '').toLowerCase().endsWith('.zip') &&
    !(filePartsAll[0].filename || '').includes('/')

  let skillName = ''
  let stagingDir = ''

  try {
    if (isSingleZip) {
      // ============ ZIP MODE ============
      // Extract in pure Node (adm-zip) so the server doesn't depend on a system
      // `unzip` binary — which is missing on Windows and on slim Linux images.
      const zipPart = filePartsAll[0]
      stagingDir = join(tmpdir(), `hermes-skill-import-${randomBytes(6).toString('hex')}`)
      const extractDir = join(stagingDir, 'extracted')
      await mkdir(extractDir, { recursive: true })

      let zip: AdmZip
      try {
        zip = new AdmZip(zipPart.data)
      } catch (err: any) {
        ctx.status = 400
        ctx.body = { error: `Failed to read zip archive: ${err?.message || err}` }
        return
      }

      try {
        for (const entry of zip.getEntries()) {
          // Normalise to forward slashes; adm-zip uses POSIX separators internally
          // but be defensive.
          const rel = entry.entryName.replace(/\\/g, '/')
          if (!rel || rel.startsWith('/')) continue
          // Skip macOS metadata and dotfile noise at the top level
          const top = rel.split('/')[0]
          if (top === '__MACOSX' || top.startsWith('.')) continue

          const dest = resolve(join(extractDir, rel))
          if (!isPathWithin(dest, extractDir)) {
            ctx.status = 400
            ctx.body = { error: `Path traversal detected in zip entry: ${rel}` }
            return
          }

          if (entry.isDirectory) {
            await mkdir(dest, { recursive: true })
            continue
          }
          await mkdir(dirname(dest), { recursive: true })
          await writeFile(dest, entry.getData())
        }
      } catch (err: any) {
        ctx.status = 400
        ctx.body = { error: `Failed to unzip archive: ${err?.message || err}` }
        return
      }

      // Locate the skill root inside the extracted tree
      const topEntries = (await readdir(extractDir, { withFileTypes: true })).filter(e => !e.name.startsWith('.') && !e.name.startsWith('__MACOSX'))
      let skillSrcDir: string
      const zipBaseName = (zipPart.filename || 'skill').replace(/\.zip$/i, '')
      const rootSkillMd = await safeReadFile(join(extractDir, 'SKILL.md'))
      if (rootSkillMd !== null) {
        // Zip extracted directly with SKILL.md at root → use zip basename
        skillName = zipBaseName
        skillSrcDir = extractDir
      } else {
        const dirs = topEntries.filter(e => e.isDirectory())
        if (dirs.length !== 1) {
          ctx.status = 400
          ctx.body = { error: 'Zip must contain a single top-level skill directory with SKILL.md (or SKILL.md at root)' }
          return
        }
        skillName = dirs[0].name
        skillSrcDir = join(extractDir, skillName)
        const innerSkillMd = await safeReadFile(join(skillSrcDir, 'SKILL.md'))
        if (innerSkillMd === null) {
          ctx.status = 400
          ctx.body = { error: `Skill directory "${skillName}" must contain a SKILL.md file` }
          return
        }
      }

      if (!isValidSkillName(skillName)) {
        ctx.status = 400
        ctx.body = { error: `Invalid skill name "${skillName}"` }
        return
      }
      if (bundledManifest.has(skillName) || hubNames.has(skillName)) {
        ctx.status = 409
        ctx.body = { error: `Skill "${skillName}" conflicts with a builtin or hub-managed skill` }
        return
      }

      if (target === 'dsh') getSkillFileProvider('dsh').validate((await safeReadFile(join(skillSrcDir, 'SKILL.md'))) || '')
      const targetDir = join(targetRoot, skillName)
      if (!isPathWithin(targetDir, skillsDir)) {
        ctx.status = 400
        ctx.body = { error: 'Resolved target path escapes skills directory' }
        return
      }
      if (await pathExists(targetDir) || (target === 'dsh' && await getSkillFileProvider('dsh').findFile([skillsDir], skillName))) {
        ctx.status = 409
        ctx.body = { error: `Skill "${skillName}" already exists` }
        return
      }
      await mkdir(targetRoot, { recursive: true })
      await cp(skillSrcDir, targetDir, { recursive: true })
    } else {
      // ============ FOLDER MODE (multiple files with relative paths) ============
      // Determine top-level dir name from the first segment of every relative path
      const tops = new Set<string>()
      for (const part of filePartsAll) {
        const rel = (part.filename || '').replace(/\\/g, '/').replace(/^\.?\//, '')
        const seg = rel.split('/')[0]
        if (seg) tops.add(seg)
      }
      if (tops.size === 0) {
        ctx.status = 400
        ctx.body = { error: 'No valid file paths in upload' }
        return
      }
      if (tops.size > 1) {
        ctx.status = 400
        ctx.body = { error: 'All files must share a common top-level directory (the skill folder)' }
        return
      }
      skillName = [...tops][0]
      if (!isValidSkillName(skillName)) {
        ctx.status = 400
        ctx.body = { error: `Invalid skill name "${skillName}"` }
        return
      }
      if (target === 'dsh') {
        const definition = filePartsAll.find(p => (p.filename || '').replace(/\\/g, '/') === `${skillName}/SKILL.md`)
        getSkillFileProvider('dsh').validate(definition?.data.toString('utf-8') || '')
      }
      // Must include SKILL.md
      const hasSkillMd = filePartsAll.some(p => {
        const rel = (p.filename || '').replace(/\\/g, '/')
        return rel === `${skillName}/SKILL.md`
      })
      if (!hasSkillMd) {
        ctx.status = 400
        ctx.body = { error: `Skill folder "${skillName}" must contain a SKILL.md file at its root` }
        return
      }
      if (bundledManifest.has(skillName) || hubNames.has(skillName)) {
        ctx.status = 409
        ctx.body = { error: `Skill "${skillName}" conflicts with a builtin or hub-managed skill` }
        return
      }

      const targetDir = join(targetRoot, skillName)
      if (!isPathWithin(targetDir, skillsDir)) {
        ctx.status = 400
        ctx.body = { error: 'Resolved target path escapes skills directory' }
        return
      }
      if (await pathExists(targetDir) || (target === 'dsh' && await getSkillFileProvider('dsh').findFile([skillsDir], skillName))) {
        ctx.status = 409
        ctx.body = { error: `Skill "${skillName}" already exists` }
        return
      }
      await mkdir(targetRoot, { recursive: true })

      // Stage to a temp dir first, then move/copy atomically (ish) so a failed
      // partial write doesn't leave half a skill in the live directory.
      stagingDir = join(tmpdir(), `hermes-skill-import-${randomBytes(6).toString('hex')}`)
      const stagingSkillDir = join(stagingDir, skillName)
      await mkdir(stagingSkillDir, { recursive: true })

      for (const part of filePartsAll) {
        const rel = (part.filename || '').replace(/\\/g, '/').replace(/^\.?\//, '')
        const relInsideSkill = rel.slice(skillName.length + 1) // strip "<skillName>/"
        if (!relInsideSkill) continue // the bare folder marker
        const dest = resolve(join(stagingSkillDir, relInsideSkill))
        if (!isPathWithin(dest, stagingSkillDir)) {
          ctx.status = 400
          ctx.body = { error: `Path traversal detected in: ${rel}` }
          return
        }
        await mkdir(dirname(dest), { recursive: true })
        await writeFile(dest, part.data)
      }

      await cp(stagingSkillDir, targetDir, { recursive: true })
    }

    ctx.body = { success: true, name: skillName }
  } catch (err: any) {
    ctx.status = err.status || 500
    ctx.body = { error: err.message }
  } finally {
    if (stagingDir) {
      try { await rm(stagingDir, { recursive: true, force: true }) } catch { /* best-effort */ }
    }
  }
}
