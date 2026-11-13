import { onBeforeUnmount, ref, shallowRef, watch, type Ref } from 'vue'
import { fetchPluginMarket, type MarketPlugin } from '@/api/studio/plugin-market'

export function usePluginMarket(enabled: Readonly<Ref<boolean>>) {
  const entries = shallowRef<MarketPlugin[]>([]), loading = ref(false), failed = ref(false), loaded = ref(false)
  let controller: AbortController | undefined, checkedAt = 0
  async function refresh(force = false) {
    if (!enabled.value || (!force && loaded.value && Date.now() - checkedAt < 300_000)) return
    controller?.abort()
    const current = new AbortController(); controller = current
    loading.value = true; failed.value = false
    try {
      const result = await fetchPluginMarket(current.signal)
      if (!current.signal.aborted) { entries.value = result; loaded.value = true; checkedAt = Date.now() }
    } catch { if (!current.signal.aborted) failed.value = true }
    finally { if (controller === current) loading.value = false }
  }
  watch(enabled, active => {
    if (active) void refresh()
    else { controller?.abort(); loading.value = false }
  }, { immediate: true })
  onBeforeUnmount(() => controller?.abort())
  return { entries, loading, failed, loaded, refresh }
}
