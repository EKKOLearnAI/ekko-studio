// @vitest-environment jsdom
import { mount, flushPromises } from '@vue/test-utils'
import { defineComponent, reactive, ref } from 'vue'
import { beforeEach, expect, it, vi } from 'vitest'
const api = vi.hoisted(() => ({ list: vi.fn(), catalog: vi.fn(), read: vi.fn(), write: vi.fn(), review: vi.fn(), remove: vi.fn(), importSkill: vi.fn() }))
vi.mock('@/api/studio/agent-resources', () => ({ fetchResourceInstances: api.list, fetchResourceCatalog: api.catalog, readAgentResource: api.read, writeAgentResource: api.write,
  reviewAgentResourceSkill: api.review, removeAgentResourceSkill: api.remove, importAgentResourceSkill: api.importSkill }))
vi.mock('vue-i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }))
const profiles = reactive({ activeProfileName: 'one', fetchProfiles: vi.fn() })
vi.mock('@/stores/hermes/profiles', () => ({ useProfilesStore: () => profiles }))
import { useAgentResourceEditor } from '@/composables/useAgentResourceEditor'
import { resourceSkillsAdapter } from '@/utils/agent-resource-skills'
const instance = { id: 'first', revision: 1, mode: 'scoped' as const, agentTypeId: 'qwen' }
const file = { kind: 'configs' as const, locationId: 'config', path: '', absolutePath: '/fixture/config.json', exists: true, readOnly: false, content: '{}', etag: 'one' }
const catalog = { instanceId: 'first', configRevision: 1, snapshot: 'snapshot', configs: [], files: [file] }
beforeEach(() => {
  vi.resetAllMocks(); profiles.activeProfileName = 'one'
  api.list.mockResolvedValue([instance, { ...instance, id: 'second' }]); api.catalog.mockResolvedValue(catalog); api.read.mockResolvedValue(file)
})
function setup(instanceId = 'first') {
  const id = ref(instanceId), section = ref('settings')
  let editor!: ReturnType<typeof useAgentResourceEditor>
  const wrapper = mount(defineComponent({ setup() { editor = useAgentResourceEditor(id, section); return () => null } }))
  return { wrapper, id, editor: () => editor }
}
it('keeps the default configuration independent of instance discovery', async () => {
  const f = setup(''); await flushPromises()
  expect(api.list).not.toHaveBeenCalled()
  expect(api.catalog).not.toHaveBeenCalled()
  expect(f.editor().loading.value).toBe(false)
  f.id.value = 'first'; await flushPromises()
  expect(api.catalog).toHaveBeenCalledWith(instance, 'one')
  f.id.value = ''; await flushPromises()
  expect(f.editor().instance.value).toBeNull()
  expect(f.editor().catalog.value).toBeNull()
  f.wrapper.unmount()
})
it('does not apply a delayed file read to a different instance or profile', async () => {
  let release!: (value: typeof file) => void
  api.read.mockImplementationOnce(() => new Promise(resolve => { release = resolve }))
  const f = setup(); await flushPromises()
  f.id.value = 'second'; await flushPromises()
  expect(f.editor().instance.value?.id).toBe('second')
  release({ ...file, content: 'old instance' }); await flushPromises()
  expect(f.editor().draft.value).toBe('{}')
  profiles.activeProfileName = 'two'; await flushPromises()
  expect(api.catalog).toHaveBeenLastCalledWith(expect.objectContaining({ id: 'second' }), 'two')
  f.wrapper.unmount()
})
it('preserves drafts on save conflict and blocks writes after an instance revision changes', async () => {
  const f = setup(); await flushPromises()
  f.editor().draft.value = '{"draft":true}'
  api.write.mockRejectedValue(new Error('conflict'))
  await expect(f.editor().save()).rejects.toThrow('conflict')
  expect(f.editor().draft.value).toBe('{"draft":true}')
  api.list.mockResolvedValue([{ ...instance, revision: 2 }])
  window.dispatchEvent(new Event('focus')); await flushPromises()
  expect(f.editor().error.value).toBe('codingAgents.resourcesChanged')
  await f.editor().save()
  expect(api.write).toHaveBeenCalledTimes(1)
  expect(f.editor().draft.value).toBe('{"draft":true}')
  f.wrapper.unmount()
})
it('clears resources after loss of instance access without falling back to legacy files', async () => {
  const f = setup(); await flushPromises()
  api.list.mockResolvedValue([])
  await f.editor().refresh()
  expect(f.editor().catalog.value).toBeNull()
  expect(f.editor().file.value).toBeNull()
  expect(f.editor().error.value).toBe('codingAgents.resourcesUnavailable')
  f.wrapper.unmount()
})
it('keeps skill source identity and the read version when saving duplicate names', async () => {
  const source = (id: string, readOnly: boolean) => ({ id, name: 'Skills', path: `/fixture/${id}`, scope: 'global' as const, readOnly })
  const adapter = resourceSkillsAdapter(instance, 'one', { ...catalog, skills: [source('native', false), source('shared', true)], files: ['native', 'shared'].map(id => ({ ...file, kind: 'skills', locationId: id, path: 'same/SKILL.md', readOnly: id === 'shared' })) })
  const list = await adapter.loadSkills()
  expect(list.categories.map(item => [item.name, item.skills[0].name, item.skills[0].readonly])).toEqual([['native', 'same', false], ['shared', 'same', true]])
  await adapter.loadContent('native', 'same')
  api.write.mockResolvedValue({ ...file, etag: 'next', content: 'edited' })
  await adapter.saveContent('native', 'same', 'edited')
  expect(api.read).toHaveBeenCalledWith(instance, 'one', 'snapshot', { kind: 'skills', locationId: 'native', path: 'same/SKILL.md' })
  expect(api.write).toHaveBeenCalledWith(instance, 'one', 'snapshot', file, 'edited')
})

it('prepares a versioned deletion without mutating and rejects stale confirmation callbacks', async () => {
  let current = true
  const data = { ...catalog, skills: [{ id: 'native', name: 'Native', path: '/fixture/native', scope: 'scoped' as const, readOnly: false }],
    files: [{ ...file, kind: 'skills' as const, locationId: 'native', path: 'same/SKILL.md' }] }
  const adapter = resourceSkillsAdapter(instance, 'one', data, () => current)
  const review = { locationId: 'native', path: 'same', name: 'same', etag: 'tree-version', files: 1, bytes: 10 }
  api.review.mockResolvedValue(review)
  const confirm = await adapter.prepareDeleteSkill!('native', 'same')
  expect(api.remove).not.toHaveBeenCalled()
  current = false
  await expect(confirm()).rejects.toThrow('selection changed')
  expect(api.remove).not.toHaveBeenCalled()
  current = true
  api.catalog.mockResolvedValue({ ...data, files: [] })
  await (await adapter.prepareDeleteSkill!('native', 'same'))()
  expect(api.remove).toHaveBeenCalledWith(instance, 'one', 'snapshot', review)
  expect((await adapter.loadSkills()).categories[0].skills).toEqual([])
  expect(adapter.canDeleteSkill!('native', '.')).toBe(false)
})

it('imports only into a displayed writable source and refreshes the instance catalog', async () => {
  const data = { ...catalog, skills: [{ id: 'native', name: 'Native', path: '/fixture/native', scope: 'scoped' as const, readOnly: false },
    { id: 'shared', name: 'Shared', path: '/fixture/shared', scope: 'shared' as const, readOnly: true }], files: [] }
  const adapter = resourceSkillsAdapter(instance, 'one', data), uploads = [new File(['# Skill'], 'skill.zip')]
  expect(adapter.importOptions?.map(option => option.value)).toEqual(['native'])
  await expect(adapter.importSkill!(uploads, 'shared')).rejects.toThrow('writable')
  expect(api.importSkill).not.toHaveBeenCalled()
  api.importSkill.mockResolvedValue({ name: 'new' })
  api.catalog.mockResolvedValue({ ...data, files: [{ ...file, kind: 'skills', locationId: 'native', path: 'new/SKILL.md' }] })
  expect(await adapter.importSkill!(uploads)).toEqual({ name: 'new' })
  expect(api.importSkill).toHaveBeenCalledWith(instance, 'one', 'snapshot', 'native', uploads)
  expect((await adapter.loadSkills()).categories[0].skills[0].name).toBe('new')
})
