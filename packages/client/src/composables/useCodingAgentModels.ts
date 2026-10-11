import { computed, ref, shallowRef, watch } from 'vue'
import { fetchCodingAgentModels, type CodingAgentId, type CodingAgentModelCatalog } from '@/api/coding-agents'
import { getBaseUrl, getStoredUserId } from '@/api/client'
import { onAuthInvalidated } from '@/api/auth-invalidation'

const CACHE_PREFIX = 'studio_native_models_v1:'
const MAX_CACHE_AGE = 24 * 60 * 60 * 1000
const entries = new Map<string, ReturnType<typeof createEntry>>()
const usable = (catalog?: CodingAgentModelCatalog) => catalog?.status === 'ready' || catalog?.status === 'empty'

function createEntry(key: string, agent: CodingAgentId) {
  const catalog = shallowRef<CodingAgentModelCatalog>()
  const loading = ref(false)
  const refreshFailed = ref(false)
  let pending: Promise<void> | undefined
  try {
    const saved = JSON.parse(localStorage.getItem(key) || 'null')
    if (saved?.catalog?.agentId === agent && usable(saved.catalog)
      && Array.isArray(saved.catalog.models) && saved.catalog.models.every((model: any) =>
        typeof model?.id === 'string' && typeof model?.name === 'string'
        && ['modelFamily', 'modelFamilyName', 'reasoningEffort'].every(key => model[key] === undefined || typeof model[key] === 'string')
        && (model.reasoningEfforts === undefined || (Array.isArray(model.reasoningEfforts)
          && model.reasoningEfforts.every((value: unknown) => typeof value === 'string'))))
      && typeof saved.savedAt === 'number' && saved.savedAt <= Date.now()
      && Date.now() - saved.savedAt < MAX_CACHE_AGE) {
      catalog.value = saved.catalog
    }
  } catch { /* Storage is optional; discovery still works in memory. */ }

  function reload(refresh = false): Promise<void> {
    if (pending) return pending
    loading.value = true
    refreshFailed.value = false
    pending = (async () => {
      try {
        const result = await fetchCodingAgentModels({ agent, refresh })
        const next = result.agents.find(entry => entry.agentId === agent)
        if (!next || !usable(next)) {
          refreshFailed.value = true
          if (!usable(catalog.value)) catalog.value = next
          return
        }
        catalog.value = next
        try { localStorage.setItem(key, JSON.stringify({ catalog: next, savedAt: Date.now() })) }
        catch { /* Keep the successful in-memory result. */ }
      } catch {
        refreshFailed.value = true
      } finally {
        loading.value = false
        pending = undefined
      }
    })()
    return pending
  }
  return { catalog, loading, refreshFailed, reload }
}

function cachedEntry(agent: CodingAgentId) {
  let identity = ['local', 'authenticated'] as Array<string | number | null>
  try { identity = [getBaseUrl(), getStoredUserId()] } catch { /* Non-browser environments. */ }
  const key = `${CACHE_PREFIX}${JSON.stringify([...identity, agent])}`
  let entry = entries.get(key)
  if (!entry) {
    if (entries.size >= 64) entries.delete(entries.keys().next().value!)
    entry = createEntry(key, agent)
    entries.set(key, entry)
  }
  return entry
}
onAuthInvalidated(() => entries.clear())

/** Native catalogs belong to the selected CLI, independently of Hermes Profiles. */
export function useCodingAgentModels(agent: () => CodingAgentId, enabled: () => boolean) {
  const entry = shallowRef<ReturnType<typeof createEntry>>()
  watch([agent, enabled], () => {
    entry.value = enabled() ? cachedEntry(agent()) : undefined
    void entry.value?.reload()
  }, { immediate: true })
  return {
    catalog: computed(() => entry.value?.catalog.value),
    loading: computed(() => entry.value?.loading.value ?? false),
    refreshFailed: computed(() => entry.value?.refreshFailed.value ?? false),
    reload: (refresh = false) => entry.value?.reload(refresh),
  }
}
