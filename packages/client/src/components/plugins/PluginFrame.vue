<script setup lang="ts">
import { ref, watch, onBeforeUnmount, h } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { NAlert, NInput, useDialog, useMessage } from 'naive-ui'
import { getStoredUserId } from '@/api/client'
import { pluginApi, pluginInvoke, pluginRequest, type InstalledPlugin, type Json, type PluginEvent } from '@/api/studio/plugins'
import { pluginFrameDocument } from '@/plugins/frame'

const props = defineProps<{ plugin: InstalledPlugin; profile: string; view: string; slot: string; sessionId?: string; data?: Json; expanded?: boolean; sidebar?: boolean }>()
const frame = ref<HTMLIFrameElement>()
const height = ref(180)
const error = ref('')
const router = useRouter(), dialog = useDialog(), message = useMessage(), { t } = useI18n()
const route = useRoute()
const documentSource = pluginFrameDocument()
let release: (() => void) | undefined

watch(() => [frame.value, props.plugin, props.profile, props.view, props.sessionId, props.data, route.fullPath] as const, async () => {
  release?.(); error.value = ''
  if (!frame.value) return
  const element = frame.value, controller = new AbortController(), channel = crypto.randomUUID()
  const profile = props.profile, plugin = props.plugin, sessionId = props.sessionId
  let source: string | undefined, ready = false, started = false, timer: ReturnType<typeof setTimeout> | undefined
  let cursor = 0, generation = ''
  const send = (value: object) => element.contentWindow?.postMessage(JSON.parse(JSON.stringify({ ...value, channel })), '*')
  const dialogs = new Set<ReturnType<typeof dialog.create>>()
  const prompt = (text: string, input: boolean): Promise<string | boolean | null> => new Promise(resolve => {
    let value = ''
    const done = (result: string | boolean | null) => { dialogs.delete(instance); resolve(result) }
    const instance = dialog.create({ title: `${plugin.manifest.name} · ${t('studioPlugins.request')}`, content: () => h('div', [h('p', text), ...(input ? [h(NInput, { onUpdateValue: (text: string) => { value = text } })] : [])]),
      positiveText: t('common.confirm'), negativeText: t('common.cancel'),
      onPositiveClick: () => done(input ? value : true), onNegativeClick: () => done(input ? null : false),
      onClose: () => done(input ? null : false), onMaskClick: () => done(input ? null : false),
    }); dialogs.add(instance)
    controller.signal.addEventListener('abort', () => { instance.destroy(); done(input ? null : false) }, { once: true })
  })
  async function poll() {
    try {
      const result = await pluginRequest<{ cursor: number; generation: string; events: PluginEvent[] }>(profile,
        `/events?pluginId=${encodeURIComponent(plugin.manifest.id)}&cursor=${cursor}${sessionId ? `&sessionId=${encodeURIComponent(sessionId)}` : ''}`, undefined, 'GET', controller.signal)
      if (generation && generation !== result.generation) { cursor = 0; generation = result.generation }
      else { cursor = result.cursor; generation = result.generation; for (const event of result.events) send({ type: 'event', event }) }
    } catch (cause) { if (!controller.signal.aborted) error.value = String(cause) }
    if (!controller.signal.aborted) timer = setTimeout(poll, 1500)
  }
  function themeSnapshot() {
    const computed = getComputedStyle(element), theme: Record<string, string> = {}
    for (const key of ['--text-primary', '--text-secondary', '--text-muted', '--bg-card', '--bg-secondary', '--border-color', '--accent-primary']) theme[key] = computed.getPropertyValue(key)
    return theme
  }
  const appearance = new MutationObserver(() => { if (started) send({ type: 'theme', theme: themeSnapshot() }) })
  appearance.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'style'] })
  appearance.observe(document.body, { attributes: true, attributeFilter: ['class', 'style'] })
  function initialize() {
    if (!ready || source === undefined || started || controller.signal.aborted) return
    started = true
    const theme = themeSnapshot()
    const query = Object.fromEntries(Object.entries(route.query).map(([key, value]) => [key, Array.isArray(value) ? value.map(item => item ?? '') : value ?? '']))
    send({ type: 'studio.plugin.init', source, theme, context: { plugin: plugin.manifest, config: plugin.config, identity: { userId: getStoredUserId(), profile, sessionId, surface: props.slot }, view: props.view, slot: props.slot, data: props.data ?? null, location: { path: route.path, query } } })
    void poll()
  }
  async function receive(event: MessageEvent) {
    if (event.source !== element.contentWindow || controller.signal.aborted) return
    if (event.data?.type === 'studio.plugin.ready') { ready = true; initialize(); return }
    const data = event.data
    if (!data || data.channel !== channel) return
    if (data.type === 'error') { error.value = String(data.message); return }
    if (data.type === 'height') { if (Number.isFinite(data.value)) height.value = Math.max(100, Math.min(1200, data.value)); return }
    if (data.type !== 'request' || !Number.isSafeInteger(data.id)) return
    const args = data.args || {}
    try {
      let value: unknown
      switch (data.method) {
        case 'api': value = await pluginApi(profile, plugin.manifest.id, args.path, args.options || {}, sessionId, controller.signal); break
        case 'rpc': value = await pluginInvoke(profile, plugin.manifest.id, 'rpc', args.name, args.input ?? null, sessionId, controller.signal); break
        case 'storage': value = await pluginRequest(profile, `/${plugin.manifest.id}/storage`, { action: args.action, key: args.key, value: args.value, namespace: args.namespace, sessionId }, 'POST', controller.signal); break
        case 'notify': message[['info', 'success', 'error'].includes(args.level) ? args.level as 'info' : 'info'](`${plugin.manifest.name}: ${String(args.message).slice(0, 2000)}`); value = null; break
        case 'confirm': value = await prompt(String(args.message).slice(0, 2000), false); break
        case 'prompt': value = await prompt(String(args.message).slice(0, 2000), true); break
        case 'navigate':
          if (typeof args.path !== 'string' || !/^\/(?:hermes|studio|ekko)\//.test(args.path) || args.path.includes('\\')) throw new Error('Invalid Studio route')
          await router.push(args.path); window.dispatchEvent(new Event('studio.plugin.navigate')); value = null; break
        default: throw new Error('Unknown plugin bridge operation')
      }
      if (!controller.signal.aborted) send({ type: 'response', id: data.id, value })
    } catch (cause) { send({ type: 'response', id: data.id, error: cause instanceof Error ? cause.message : String(cause) }) }
  }
  window.addEventListener('message', receive)
  release = () => { send({ type: 'dispose' }); controller.abort(); appearance.disconnect(); if (timer) clearTimeout(timer); window.removeEventListener('message', receive); for (const instance of dialogs) instance.destroy() }
  element.srcdoc = documentSource
  try { source = (await pluginRequest<{ source: string }>(profile, `/${plugin.manifest.id}/client`, undefined, 'GET', controller.signal)).source; initialize() }
  catch (cause) { if (!controller.signal.aborted) error.value = String(cause) }
}, { flush: 'post', immediate: true })
onBeforeUnmount(() => release?.())
</script>

<template>
  <section class="plugin-frame" :class="{ 'plugin-frame--expanded': expanded, 'plugin-frame--sidebar': sidebar }" data-theme-surface="card">
    <NAlert v-if="error" type="error">{{ error }}</NAlert>
    <iframe ref="frame" :title="`${plugin.manifest.name}: ${view}`" sandbox="allow-scripts" referrerpolicy="no-referrer" :style="expanded ? undefined : { height: `${height}px` }" />
  </section>
</template>
<style scoped lang="scss">
@use '@/styles/variables' as *;
.plugin-frame { overflow: hidden; min-width: 0; border: 1px solid $border-light; border-radius: $radius-lg; }
.plugin-frame--sidebar { border: 0; border-radius: 0; }
.plugin-frame--expanded { flex: 1; display: flex; flex-direction: column; min-height: 360px; }
.plugin-frame--expanded iframe { flex: 1; min-height: 0; height: 100%; }
iframe { display: block; width: 100%; border: 0; }
</style>
