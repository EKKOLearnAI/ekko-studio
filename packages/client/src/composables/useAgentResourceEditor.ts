import { computed, onMounted, onUnmounted, ref, shallowRef, watch, type Ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useProfilesStore } from '@/stores/hermes/profiles'
import { fetchResourceInstances, fetchResourceCatalog, readAgentResource, writeAgentResource,
  type AgentResourceInstance, type AgentResourceCatalog, type AgentResourceContent, type AgentResourceFile } from '@/api/studio/agent-resources'
import { resourceSkillsAdapter } from '@/utils/agent-resource-skills'

export function useAgentResourceEditor(instanceId: Ref<string>, section: Ref<string>) {
  const { t } = useI18n(), profiles = useProfilesStore()
  const instances = ref<AgentResourceInstance[]>([]), instance = ref<AgentResourceInstance | null>(null)
  const catalog = shallowRef<AgentResourceCatalog | null>(null), loading = ref(false), error = ref(''), discoveryError = ref('')
  const file = ref<AgentResourceContent | null>(null), draft = ref(''), saving = ref(false), reading = ref(false), selectedFile = ref('')
  let version = 0, fileVersion = 0
  const fileKey = (value: AgentResourceFile) => JSON.stringify([value.locationId, value.path])
  const configFiles = computed(() => catalog.value?.files.filter(item => item.kind === 'configs') || [])
  const fileOptions = computed(() => configFiles.value.map(item => {
    const location = catalog.value?.configs?.find(source => source.id === item.locationId)
    return { value: fileKey(item), label: `${location?.name || item.locationId} · ${item.absolutePath}` }
  }))
  const skills = computed(() => {
    const current = version
    return instance.value && catalog.value?.skills && profiles.activeProfileName
      ? resourceSkillsAdapter(instance.value, profiles.activeProfileName, catalog.value, () => current === version && !error.value) : undefined
  })
  const dirty = computed(() => file.value !== null && draft.value !== file.value.content)

  async function refresh() {
    const current = ++version
    ++fileVersion
    loading.value = true; reading.value = false; error.value = ''; discoveryError.value = ''; catalog.value = null; instance.value = null; file.value = null; draft.value = ''; selectedFile.value = ''
    try {
      instances.value = []
      if (!instanceId.value) return
      if (!profiles.activeProfileName) await profiles.fetchProfiles()
      if (current !== version) return
      const profile = profiles.activeProfileName
      if (!profile) throw new Error(t('codingAgents.resourcesUnavailable'))
      const list = await fetchResourceInstances(profile)
      if (current !== version) return
      instances.value = list
      const selected = list.find(item => item.id === instanceId.value)
      if (!selected) throw new Error(t('codingAgents.resourcesUnavailable'))
      instance.value = selected
      const result = await fetchResourceCatalog(selected, profile)
      if (current !== version) return
      catalog.value = result
      if (section.value === 'settings' && configFiles.value[0]) await selectFile(fileKey(configFiles.value[0]))
    } catch (err: any) {
      if (current === version) { if (instanceId.value) error.value = err.message || String(err); else discoveryError.value = err.message || String(err) }
    } finally { if (current === version) loading.value = false }
  }
  async function selectFile(key: string) {
    const item = configFiles.value.find(value => fileKey(value) === key), selected = instance.value, data = catalog.value, profile = profiles.activeProfileName
    const current = ++fileVersion, generation = version
    selectedFile.value = key; error.value = ''; file.value = null; draft.value = ''; reading.value = true
    try {
      if (!item || !selected || !data || !profile) return
      const result = await readAgentResource(selected, profile, data.snapshot, item)
      if (generation === version && current === fileVersion) { file.value = result; draft.value = result.content }
    } catch (err: any) { if (generation === version && current === fileVersion) error.value = err.message || String(err) }
    finally { if (generation === version && current === fileVersion) reading.value = false }
  }
  async function save() {
    const selected = instance.value, data = catalog.value, original = file.value, profile = profiles.activeProfileName, current = version, selection = fileVersion
    if (!selected || !data || !original || !profile || saving.value || original.readOnly || error.value) return
    saving.value = true
    try {
      const result = await writeAgentResource(selected, profile, data.snapshot, original, draft.value)
      if (current === version && selection === fileVersion) { file.value = result; draft.value = result.content }
    } finally { saving.value = false }
  }
  async function checkRevision() {
    if (!instanceId.value || loading.value || saving.value) return
    const current = version, profile = profiles.activeProfileName
    if (!profile) return
    try {
      const list = await fetchResourceInstances(profile)
      if (current !== version) return
      instances.value = list
      if (list.find(item => item.id === instanceId.value)?.revision !== instance.value?.revision) {
        // Keep an unsaved draft visible; disable writes until the user explicitly reloads.
        if (dirty.value || section.value === 'skills') error.value = t('codingAgents.resourcesChanged')
        else await refresh()
      }
    } catch (err: any) { if (current === version) error.value = err.message || String(err) }
  }
  watch([instanceId, section, () => profiles.activeProfileName], refresh, { immediate: true })
  onMounted(() => window.addEventListener('focus', checkRevision))
  onUnmounted(() => { ++version; ++fileVersion; window.removeEventListener('focus', checkRevision) })
  return { instances, instance, catalog, loading, error, discoveryError, file, draft, saving, reading, selectedFile, fileOptions, skills, dirty, refresh, selectFile, save }
}
