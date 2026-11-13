import { computed, onBeforeUnmount, ref, shallowRef, watch, type Ref } from 'vue'
import type { InstalledPlugin } from '@/api/studio/plugins'
import { fetchPluginRelease, type PluginRelease } from '@/api/studio/plugin-releases'
import { availablePluginUpdate, installedPluginRepository, pluginRepository } from '@/plugins/updates'

export function usePluginUpdates(plugins: Readonly<Ref<InstalledPlugin[]>>) {
  const releases = shallowRef<Record<string, PluginRelease>>({}), failed = ref(false), checking = ref(false)
  const unavailable = shallowRef<string[]>([])
  let controller: AbortController | undefined, lastChecked = 0
  const repositories = computed(() => [...new Set(plugins.value.map(pluginRepository).filter((value): value is string => !!value))])
  const updates = computed(() => Object.fromEntries(plugins.value.flatMap(plugin => {
    const repository = installedPluginRepository(plugin)
    const release = availablePluginUpdate(plugin, repository ? releases.value[repository] : undefined)
    return release ? [[plugin.manifest.id, release]] : []
  })))
  async function refresh(force = false) {
    if (!force && Date.now() - lastChecked < 300_000) return
    controller?.abort()
    const current = new AbortController(); controller = current
    checking.value = true
    const next: Record<string, PluginRelease> = {}, targets = [...repositories.value]
    const errors: string[] = []
    for (let offset = 0; offset < targets.length && !current.signal.aborted; offset += 4) {
      await Promise.all(targets.slice(offset, offset + 4).map(async repository => {
        try {
          const release = await fetchPluginRelease(repository, current.signal)
          if (release) next[repository] = release
        } catch { errors.push(repository); if (releases.value[repository]) next[repository] = releases.value[repository] }
      }))
    }
    if (current.signal.aborted) return
    releases.value = next; unavailable.value = errors; failed.value = errors.length > 0; checking.value = false; lastChecked = Date.now()
  }
  watch(repositories, () => { void refresh(true) }, { immediate: true })
  const focused = () => { void refresh() }
  window.addEventListener('focus', focused)
  const timer = setInterval(focused, 300_000)
  onBeforeUnmount(() => { controller?.abort(); clearInterval(timer); window.removeEventListener('focus', focused) })
  return { updates, releases, unavailable, failed, checking, refresh }
}
