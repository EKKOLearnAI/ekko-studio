<script setup lang="ts">
import { watch, onBeforeUnmount } from 'vue'
import { useRoute } from 'vue-router'
import { useMessage } from 'naive-ui'
import { hasApiKey } from '@/api/client'
import { useProfilesStore } from '@/stores/hermes/profiles'
import { pluginRequest, type PluginEvent } from '@/api/studio/plugins'

const route = useRoute(), profiles = useProfilesStore(), messages = useMessage()
let stop: (() => void) | undefined
watch(() => [profiles.activeProfileName, route.meta.public] as const, () => {
  stop?.()
  if (!hasApiKey() || route.meta.public) return
  const profile = profiles.activeProfileName || 'default', controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined, cursor = 0, generation = '', initialized = false
  async function poll() {
    try {
      const result = await pluginRequest<{ cursor: number; generation: string; events: Array<PluginEvent & { pluginId: string }> }>(profile, `/events?cursor=${cursor}`, undefined, 'GET', controller.signal)
      if (initialized && (generation !== result.generation || result.events.some(event => event.type === 'plugin.changed'))) window.dispatchEvent(new Event('studio.plugins.changed'))
      if (initialized && generation === result.generation) for (const event of result.events) {
        if (event.type !== 'ui.notification' || !event.data || typeof event.data !== 'object' || Array.isArray(event.data)) continue
        const level = event.data.level === 'success' || event.data.level === 'error' ? event.data.level : 'info'
        messages[level](`${event.pluginId}: ${String(event.data.message || '').slice(0, 2000)}`)
      }
      cursor = result.cursor; generation = result.generation; initialized = true
    } catch { /* Authentication and reconnect errors are handled by the shared API client. */ }
    if (!controller.signal.aborted) timer = setTimeout(poll, 2000)
  }
  stop = () => { controller.abort(); if (timer) clearTimeout(timer) }
  void poll()
}, { immediate: true })
onBeforeUnmount(() => stop?.())
</script>
<template><span hidden aria-hidden="true" /></template>
