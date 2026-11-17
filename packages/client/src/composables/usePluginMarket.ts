import { useI18n } from 'vue-i18n'
import { localizePluginManifest } from '../../../plugin-sdk/src'
import { computed, onBeforeUnmount, ref, shallowRef, watch, type Ref } from 'vue'
import { fetchPluginMarket, fetchPluginMarketCount, type MarketPlugin } from '@/api/studio/plugin-market'

export function usePluginMarket(enabled: Readonly<Ref<boolean>>) {
  const { locale } = useI18n()
  const entries = shallowRef<MarketPlugin[]>([]), loading = ref(false), failed = ref(false), loaded = ref(false)
  const total = ref<number | null>(null)
  let controller: AbortController | undefined, countController: AbortController | undefined, checkedAt = 0
  async function refreshCount() {
    countController?.abort()
    const current = new AbortController(); countController = current
    try {
      const result = await fetchPluginMarketCount(current.signal)
      if (!current.signal.aborted) total.value = result
    } catch { /* The installed catalog and on-demand market remain usable if the count is unavailable. */ }
  }
  async function refresh(force = false) {
    if (!enabled.value) { if (force) await refreshCount(); return }
    if (!force && loaded.value && Date.now() - checkedAt < 300_000) return
    controller?.abort()
    const current = new AbortController(); controller = current
    loading.value = true; failed.value = false
    try {
      const result = await fetchPluginMarket(current.signal)
      if (!current.signal.aborted) {
        countController?.abort()
        entries.value = result; total.value = result.length; loaded.value = true; checkedAt = Date.now()
      }
    } catch { if (!current.signal.aborted) failed.value = true }
    finally { if (controller === current) loading.value = false }
  }
  watch(enabled, active => {
    if (active) void refresh()
    else { controller?.abort(); loading.value = false }
  }, { immediate: true })
  void refreshCount()
  onBeforeUnmount(() => { controller?.abort(); countController?.abort() })
  const displayEntries = computed(() => entries.value.map(entry => localizePluginManifest(entry, locale.value)))
  return { entries: displayEntries, total, loading, failed, loaded, refresh }
}
