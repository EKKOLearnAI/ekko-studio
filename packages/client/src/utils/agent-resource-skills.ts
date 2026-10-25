import type { SkillFileEntry, SkillsData } from '@/api/hermes/skills'
import { fetchResourceCatalog, readAgentResource, writeAgentResource, reviewAgentResourceSkill, removeAgentResourceSkill, importAgentResourceSkill,
  type AgentResourceCatalog, type AgentResourceContent, type AgentResourceInstance } from '@/api/studio/agent-resources'

export interface ResourceSkillsAdapter {
  loadSkills(): Promise<SkillsData>
  loadContent(category: string, skill: string, path?: string): Promise<string>
  loadFiles(category: string, skill: string): Promise<SkillFileEntry[]>
  saveContent(category: string, skill: string, content: string, path?: string): Promise<void>
  canEditFile(category: string, skill: string, path: string): boolean
  managementKey?: string
  importOptions?: Array<{ label: string; value: string }>
  importSkill?(files: File[], category?: string): Promise<{ name?: string }>
  prepareDeleteSkill?(category: string, skill: string): Promise<() => Promise<void>>
  canDeleteSkill?(category: string, skill: string): boolean
}
export function resourceSkillsAdapter(instance: AgentResourceInstance, profile: string, initial: AgentResourceCatalog,
  isCurrent: () => boolean = () => true): ResourceSkillsAdapter {
  let catalog = initial
  const loaded = new Map<string, AgentResourceContent>()
  const skillPath = (skill: string, path = 'SKILL.md') => skill === '.' ? path : `${skill}/${path}`
  const key = (category: string, skill: string, path = 'SKILL.md') => JSON.stringify([category, skill, path])
  const check = () => { if (!isCurrent()) throw new Error('Resource selection changed; reload before managing Skills') }
  const refresh = async () => {
    const next = await fetchResourceCatalog(instance, profile)
    check()
    if (next.snapshot !== catalog.snapshot) throw new Error('Resource locations changed; reload before managing Skills')
    catalog = next; loaded.clear()
  }
  const importOptions = (catalog.skills || []).filter(location => !location.readOnly && location.scope !== 'builtin')
    .map(location => ({ value: location.id, label: `${location.name} · ${location.path}` }))
  return {
    managementKey: JSON.stringify([profile, instance.id, instance.revision, catalog.snapshot]), importOptions,
    ...(importOptions.length ? { async importSkill(files: File[], category?: string) {
      check()
      const locationId = category || (importOptions.length === 1 ? importOptions[0]!.value : '')
      if (!importOptions.some(option => option.value === locationId)) throw new Error('Select a writable Skill source')
      const result = await importAgentResourceSkill(instance, profile, catalog.snapshot, locationId, files)
      await refresh()
      return result
    } } : {}),
    canDeleteSkill(category, skill) {
      return skill !== '.' && catalog.files.some(file => file.kind === 'skills' && file.locationId === category && file.path === `${skill}/SKILL.md` && !file.readOnly)
    },
    async prepareDeleteSkill(category, skill) {
      check()
      if (skill === '.') throw new Error('A declared Skill root cannot be deleted')
      const snapshot = catalog.snapshot, review = await reviewAgentResourceSkill(instance, profile, snapshot, category, skill)
      check()
      return async () => { check(); await removeAgentResourceSkill(instance, profile, snapshot, review); await refresh() }
    },
    async loadSkills() {
      check()
      return { archived: [], categories: (catalog.skills || []).map(location => ({
        name: location.id, description: `${location.name} · ${location.path}`,
        skills: catalog.files.filter(file => file.kind === 'skills' && file.locationId === location.id && (file.path === 'SKILL.md' || file.path.endsWith('/SKILL.md'))).map(file => ({
          name: file.path === 'SKILL.md' ? '.' : file.path.slice(0, -'/SKILL.md'.length),
          description: file.absolutePath, enabled: true, readonly: file.readOnly,
          source: location.scope === 'builtin' ? 'builtin' as const : 'local' as const,
          sourcePath: location.path,
        })),
      })) }
    },
    async loadContent(category, skill, path) {
      check()
      const result = await readAgentResource(instance, profile, catalog.snapshot, { kind: 'skills', locationId: category, path: skillPath(skill, path) })
      loaded.set(key(category, skill, path), result)
      return result.content
    },
    async loadFiles(category, skill) {
      check()
      const prefix = skill === '.' ? '' : `${skill}/`
      return catalog.files.filter(file => file.kind === 'skills' && file.locationId === category && file.path.startsWith(prefix))
        .map(file => ({ path: file.path.slice(prefix.length), name: file.path.slice(prefix.length), isDir: false }))
    },
    canEditFile(category, skill, path) {
      return catalog.files.some(file => file.kind === 'skills' && file.locationId === category && file.path === skillPath(skill, path) && !file.readOnly)
    },
    async saveContent(category, skill, content, path) {
      check()
      const file = loaded.get(key(category, skill, path))
      if (!file) throw new Error('Reload the skill before saving')
      loaded.set(key(category, skill, path), await writeAgentResource(instance, profile, catalog.snapshot, file, content))
    },
  }
}
