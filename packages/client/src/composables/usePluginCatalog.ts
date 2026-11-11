import { computed, onBeforeUnmount, ref, shallowRef, watch, type Ref } from 'vue'
import { useProfilesStore } from '@/stores/hermes/profiles'
import { pluginCatalog, pluginList, type PluginSnapshot } from '@/api/studio/plugins'

export { pluginPages, pluginPageLocation, pluginNavigation } from '@/plugins/navigation'

/** Installations are global. Only mounted views carry the current execution profile. */
export function usePluginCatalog(enabled: Readonly<Ref<boolean>> = ref(true)) {
  const profiles = useProfilesStore()
  const profile = computed(() => profiles.activeProfileName || 'default')
  const snapshot = shallowRef<PluginSnapshot>({ revision: 0, plugins: [] })
  const loading = ref(true), error = ref('')
  let sequence = 0, alive = true
  async function refresh(force = false) {
    if (!enabled.value) return
    const current = ++sequence
    loading.value = true
    try {
      const value = await (force ? pluginList() : pluginCatalog())
      if (!alive || current !== sequence) return
      // Focusing a native dialog can focus the parent window. An unchanged
      // catalog must not remount its iframe and dispose that open dialog.
      if (JSON.stringify(snapshot.value) !== JSON.stringify(value)) {
        const previous = new Map(snapshot.value.plugins.map(plugin => [plugin.manifest.id, plugin]))
        snapshot.value = { ...value, plugins: value.plugins.map(plugin => {
          const existing = previous.get(plugin.manifest.id)
          return existing && JSON.stringify(existing) === JSON.stringify(plugin) ? existing : plugin
        }) }
      }
      error.value = ''
    } catch (cause) {
      if (alive && current === sequence) error.value = cause instanceof Error ? cause.message : String(cause)
    } finally { if (alive && current === sequence) loading.value = false }
  }
  watch(enabled, active => {
    if (active) void refresh()
    else { sequence++; snapshot.value = { revision: 0, plugins: [] }; loading.value = false; error.value = '' }
  }, { immediate: true })
  const changed = () => { void refresh() }
  const focused = () => { void refresh(true) }
  window.addEventListener('studio.plugins.changed', changed)
  window.addEventListener('focus', focused)
  onBeforeUnmount(() => { alive = false; sequence++; window.removeEventListener('studio.plugins.changed', changed); window.removeEventListener('focus', focused) })
  return { profile, snapshot, loading, error, refresh }
}
