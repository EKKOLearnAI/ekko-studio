import { computed, shallowReactive, shallowRef, watch } from 'vue'
import { fetchModelMetadata, type ModelMetadataSelection, type ModelReasoningMetadata, type AvailableModelGroup } from '@/api/hermes/system'
import { getBaseUrl, getStoredUserId, hasApiKey } from '@/api/client'
import { onAuthInvalidated } from '@/api/auth-invalidation'

const entries = shallowReactive(new Map<string, { metadata: ReturnType<typeof shallowRef<ModelReasoningMetadata | undefined>>; requestedAt: number; pending?: Promise<void> }>())
const TTL = 30_000
onAuthInvalidated(() => entries.clear())

/** Hydrate only selections in use; provider lists and display metadata stay intact. */
export function useSelectedModelMetadata(
  groups: () => AvailableModelGroup[],
  selections: () => ModelMetadataSelection[],
  enabled: () => boolean = () => true,
) {
  const queries = computed(() => {
    if (!enabled()) return []
    return selections().filter(item => item.provider && item.model && item.provider !== 'moa').map(item => {
      const group = groups().find(group => group.provider === item.provider)
      const query = { ...item, baseUrl: item.baseUrl === undefined ? group?.base_url : item.baseUrl }
      const key = JSON.stringify([getBaseUrl(), getStoredUserId(), query.profile || 'default', query.provider, query.baseUrl || '', query.model])
      return { query, key }
    })
  })
  watch([queries, groups], () => {
    if (!hasApiKey()) return
    for (const { query, key } of queries.value) {
      const meta = groups().find(group => group.provider === query.provider)?.model_meta?.[query.model]
      if (meta?.reasoning === false || meta?.reasoning_efforts !== undefined) continue
      let entry = entries.get(key)
      if (!entry) {
        if (entries.size >= 512) entries.delete(entries.keys().next().value!)
        entry = { metadata: shallowRef(), requestedAt: -Infinity }
        entries.set(key, entry)
      }
      if (entry.pending || Date.now() - entry.requestedAt < TTL) continue
      entry.requestedAt = Date.now()
      const current = entry
      current.pending = fetchModelMetadata(query).then(metadata => { current.metadata.value = metadata })
        .catch(() => { /* Missing/offline metadata keeps saved settings and the existing fallback. */ })
        .finally(() => { current.pending = undefined })
    }
  }, { immediate: true })

  return computed(() => groups().map(group => {
    const selected = queries.value.filter(item => item.query.provider === group.provider)
    const meta = { ...group.model_meta }
    let changed = false
    for (const { query, key } of selected) {
      const metadata = entries.get(key)?.metadata.value
      if (metadata) { meta[query.model] = { ...meta[query.model], ...metadata }; changed = true }
    }
    return changed ? { ...group, model_meta: meta } : group
  }))
}
