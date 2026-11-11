import { computed, onBeforeUnmount, ref, shallowRef } from 'vue'
import { useProfilesStore } from '@/stores/hermes/profiles'
import { pluginCatalog, pluginList, type InstalledPlugin, type PluginSnapshot } from '@/api/studio/plugins'

export const pluginPages = (plugin: InstalledPlugin) => (plugin.manifest.views || []).filter(view => view.slot === 'page')
export const pluginPageLocation = (plugin: InstalledPlugin, viewId = pluginPages(plugin)[0]?.id) => ({
  name: 'studio.pluginPage', params: { pluginId: plugin.manifest.id, viewId },
})

/** Installations are global. Only mounted views carry the current execution profile. */
export function usePluginCatalog() {
  const profiles = useProfilesStore()
  const profile = computed(() => profiles.activeProfileName || 'default')
  const snapshot = shallowRef<PluginSnapshot>({ revision: 0, plugins: [] })
  const loading = ref(true), error = ref('')
  let sequence = 0, alive = true
  async function refresh(force = false) {
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
  void refresh()
  const changed = () => { void refresh() }
  const focused = () => { void refresh(true) }
  window.addEventListener('studio.plugins.changed', changed)
  window.addEventListener('focus', focused)
  onBeforeUnmount(() => { alive = false; sequence++; window.removeEventListener('studio.plugins.changed', changed); window.removeEventListener('focus', focused) })
  return { profile, snapshot, loading, error, refresh }
}
