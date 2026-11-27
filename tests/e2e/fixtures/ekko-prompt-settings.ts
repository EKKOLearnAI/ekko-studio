import { createApp, h } from 'vue'
import { createRouter, createWebHashHistory, RouterView } from 'vue-router'
import { createI18n } from 'vue-i18n'
import { NConfigProvider, NMessageProvider } from 'naive-ui'
import SettingsView from '../../../packages/client/src/views/ekko/SettingsView.vue'
import en from '../../../packages/client/src/i18n/locales/en'
import '../../../packages/client/src/styles/global.scss'
localStorage.setItem('hermes_api_key', 'fixture')
const router = createRouter({ history: createWebHashHistory(), routes: [{ path: '/settings', component: SettingsView }] })
createApp({ render: () => h(NConfigProvider, null, { default: () => h(NMessageProvider, null, { default: () => h('div', { style: 'height:100vh;min-width:0' }, [h(RouterView)]) }) }) })
  .use(router).use(createI18n({ legacy: false, locale: 'en', messages: { en } })).mount('#app')
