import { readFile, readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { load } from 'js-yaml'
import { isSharedCodingAgentSkill } from '../../../studio/public/shared-skills'

function safeName(name: string): boolean {
  return Boolean(name) && !name.startsWith('.') && !/[\\/\x00-\x1f]/.test(name)
}

export function validateDshSkill(content: string): { name: string; description: string } {
  const frontmatter = /^---\s*\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(content)
  let data: any
  try { data = frontmatter ? load(frontmatter[1]) : null } catch { /* reported below */ }
  if (!data || typeof data.name !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(data.name)
    || typeof data.description !== 'string' || !data.description.trim()) {
    throw Object.assign(new Error('DSH skills require YAML frontmatter with a kebab-case name and a description'), { status: 400 })
  }
  return { name: data.name, description: data.description }
}

export interface DshSkillFile { name: string; directory: string; path: string; flat: boolean }

export async function findDshSkillFile(roots: string[], name: string): Promise<DshSkillFile | null> {
  if (!safeName(name)) return null
  for (const root of roots) {
    for (const flat of [false, true]) {
      const directory = flat ? root : join(root, name)
      const path = flat ? join(root, `${name}.md`) : join(directory, 'SKILL.md')
      try {
        if ((await stat(path)).isFile()) return { name, directory, path, flat }
      } catch (error: any) { if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error }
    }
  }
  return null
}

/** Match DSH's direct bundles and flat Markdown files; nested categories aren't discovered. */
export async function listDshSkills(roots: string[]) {
  const skills = new Map<string, { name: string; description: string; enabled: boolean; source: string; readonly: boolean }>()
  const loadedNames = new Set<string>()
  for (const root of roots) {
    let entries
    try { entries = await readdir(root) } catch (error: any) {
      if (error.code === 'ENOENT') continue
      throw error
    }
    for (const entry of entries.sort()) {
      if (!safeName(entry)) continue
      const name = entry.endsWith('.md') ? entry.slice(0, -3) : entry
      if (skills.has(name)) continue
      const file = await findDshSkillFile([root], name)
      if (!file) continue
      const content = await readFile(file.path, 'utf8')
      try {
        const metadata = validateDshSkill(content)
        if (loadedNames.has(metadata.name)) continue
        loadedNames.add(metadata.name)
        skills.set(name, { name, description: metadata.description, enabled: true, source: 'local', readonly: await isSharedCodingAgentSkill(file.path) })
      } catch { /* DSH also omits malformed skill definitions. */ }
    }
  }
  return skills.size ? [{ name: 'misc', description: '', skills: [...skills.values()].sort((a, b) => a.name.localeCompare(b.name)) }] : []
}
