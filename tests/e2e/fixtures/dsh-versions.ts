import { createApp, h, ref } from 'vue'
import { createI18n } from 'vue-i18n'
import { NConfigProvider, darkTheme } from 'naive-ui'
import DshVersions from '../../../packages/client/src/components/coding-agents/dsh/DshVersions.vue'
import { installCodingAgent, type CodingAgentToolStatus } from '../../../packages/client/src/api/coding-agents'
import { useTheme } from '../../../packages/client/src/composables/useTheme'
import { getThemeOverrides } from '../../../packages/client/src/styles/theme'
import zh from '../../../packages/client/src/i18n/locales/zh'
import '../../../packages/client/src/styles/global.scss'
const info = ref<CodingAgentToolStatus['compatibility']>({ adapterRevision: 5, pinnedVersion: '', previousVersion: '0.2.1-rc.5', verifiedVersion: '0.2.2-rc.1' })
const busy = ref(false)
const error = ref('')
const theme = useTheme()
await theme.setBrightness('light')
;(window as any).dshFixture = { async theme(dark: boolean, wallpaper = false) {
  await theme.setBrightness(dark ? 'dark' : 'light')
  theme.previewThemeSettings({ brightness: dark ? 'dark' : 'light', appearance: { global: wallpaper ? { gradientColor: '#4267a8', opacity: 0.6 } : {}, regions: {} } })
} }
async function install(options: { version?: string; rollback?: boolean }) {
  busy.value = true; error.value = ''
  try {
    const result = await installCodingAgent('dsh', options)
    if (!result.success) throw new Error(result.message)
    info.value = result.tools.find(tool => tool.id === 'dsh')?.compatibility
  } catch (e: any) { error.value = e.message }
  finally { busy.value = false }
}
createApp({ setup: () => () => h(NConfigProvider, { theme: theme.isDark.value ? darkTheme : null,
  themeOverrides: getThemeOverrides(theme.isDark.value, theme.isComic.value, theme.customization.value, theme.hasCustomBackground.value) }, () =>
  h('section', { 'data-theme-surface': 'card' }, [h(DshVersions, { info: info.value, busy: busy.value, onInstall: install }), error.value && h('p', { role: 'alert' }, error.value)])) })
  .use(createI18n({ legacy: false, locale: 'zh', messages: { zh } })).mount('#app')
