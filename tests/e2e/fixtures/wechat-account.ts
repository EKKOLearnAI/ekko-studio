import { createApp, h } from 'vue'
import { createPinia } from 'pinia'
import { createRouter, createWebHashHistory, RouterView } from 'vue-router'
import { createI18n } from 'vue-i18n'
import { NConfigProvider, NMessageProvider } from 'naive-ui'
import LoginView from '../../../packages/client/src/views/LoginView.vue'
import WeChatAccountSettings from '../../../packages/client/src/components/auth/WeChatAccountSettings.vue'
import en from '../../../packages/client/src/i18n/locales/en'
import { getThemeOverrides } from '../../../packages/client/src/styles/theme'
import '../../../packages/client/src/styles/global.scss'

const router = createRouter({
  history: createWebHashHistory(),
  routes: [
    { path: '/', name: 'login', component: LoginView },
    { path: '/hermes/settings', component: WeChatAccountSettings },
    { path: '/person', component: { render: () => h('h1', 'Signed in') } },
  ],
})
const app = createApp({
  render: () => h(NConfigProvider, { themeOverrides: getThemeOverrides(false) }, () =>
    h(NMessageProvider, null, () => h(RouterView))),
})
app.use(createPinia()).use(createI18n({ legacy: false, locale: 'en', messages: { en } })).use(router)
await router.isReady()
app.mount('#app')
