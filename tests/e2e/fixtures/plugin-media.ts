import { createApp, h } from 'vue'
import { createPinia } from 'pinia'
import { createI18n } from 'vue-i18n'
import { createRouter, createWebHashHistory } from 'vue-router'
import { NDialogProvider, NMessageProvider } from 'naive-ui'
import PluginFrame from '../../../packages/client/src/components/plugins/PluginFrame.vue'
import type { InstalledPlugin } from '../../../packages/client/src/api/studio/plugins'

localStorage.setItem('hermes_api_key', `test.${btoa(JSON.stringify({ sub: '1', role: 'super_admin' }))}.fixture`)
localStorage.setItem('plugin-media-sentinel', 'host-only')
const slot = new URLSearchParams(location.search).get('slot') || 'page'
const plugin: InstalledPlugin = {
  manifest: { id: 'media', name: 'Media', version: '1.0.0', apiVersion: 1,
    client: 'client.mjs', permissions: ['ui'], views: [{ id: 'audio', title: 'Audio', slot: 'page' }] },
  source: 'fixture', installedAt: 0, enabled: true, status: 'active', config: {}, tools: [], commands: [], actions: [],
}
const router = createRouter({ history: createWebHashHistory(), routes: [{ path: '/:pathMatch(.*)*', component: { render: () => null } }] })
createApp({ render: () => h(NDialogProvider, null, () => h(NMessageProvider, null,
  () => h(PluginFrame, { plugin, profile: 'default', view: 'audio', slot }))) })
  .use(createPinia()).use(router).use(createI18n({ legacy: false, locale: 'en', messages: { en: {} } })).mount('#app')
