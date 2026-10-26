import { createApp } from 'vue'
import { createPinia } from 'pinia'
import router from './router'
import { i18nReady } from './i18n'
import App from './App.vue'
import './styles/global.scss'
import { desktopBridge } from '@/utils/desktop-bridge'
import { useTheme } from '@/composables/useTheme'

// Apply theme classes before mount to prevent FOUC (Flash of Unstyled Content)
function storedPreference(key: string, fallback: string): string {
  try {
    return localStorage.getItem(key) || fallback
  } catch {
    return fallback
  }
}

const savedBrightness = storedPreference('hermes_brightness', 'system')
const themeStyle = useTheme().style.value

// Resolve dark mode
const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches
const isDark = savedBrightness === 'dark' || (savedBrightness === 'system' && prefersDark)

// Resolve style
const isComic = themeStyle === 'comic'
const bridge = desktopBridge()
const isDesktopShell = bridge?.isDesktop === true
const isDesktopPetWindow = bridge?.windowKind === 'pet' || window.location.hash.startsWith('#/desktop-pet')

// Apply classes to prevent FOUC
if (isDark) {
  document.documentElement.classList.add('dark')
}
if (isComic) {
  document.documentElement.classList.add('comic')
}
if (isDesktopShell) {
  document.documentElement.classList.add('hermes-desktop-shell')
}
if (isDesktopShell && bridge?.platform === 'win32') {
  document.documentElement.classList.add('hermes-desktop-windows')
}
if (isDesktopPetWindow) {
  document.documentElement.classList.add('hermes-desktop-pet-window')
}

// Read token from URL BEFORE router initializes (hash router strips params)
const urlParams = new URLSearchParams(window.location.search)
const hashQuery = window.location.hash.split('?')[1]
const urlToken = urlParams.get('token') || (hashQuery ? new URLSearchParams(hashQuery).get('token') : null)
if (urlToken) {
  ;(window as any).__LOGIN_TOKEN__ = urlToken
}

async function mountApp(): Promise<void> {
  const i18n = await i18nReady
  const app = createApp(App)
  app.config.errorHandler = (error, _instance, info) => {
    console.error(`[client] uncaught Vue error (${info})`, error)
  }
  app.use(createPinia())
  app.use(i18n)
  app.use(router)
  await router.isReady().catch(() => undefined)
  app.mount('#app')
}

function renderFatalError(error: unknown): void {
  const root = document.getElementById('app')
  if (!root || root.dataset.fatalError === 'true') return
  root.dataset.fatalError = 'true'
  root.replaceChildren()

  const container = document.createElement('main')
  container.style.cssText = 'min-height:100vh;box-sizing:border-box;padding:32px;background:#1a1a1a;color:#eee;font-family:system-ui'
  const title = document.createElement('h2')
  title.textContent = 'Ekko Studio encountered an unexpected interface error'
  const details = document.createElement('pre')
  details.style.cssText = 'white-space:pre-wrap;color:#f88'
  details.textContent = error instanceof Error ? error.message : String(error)
  const retry = document.createElement('button')
  retry.type = 'button'
  retry.textContent = 'Reload'
  retry.style.cssText = 'padding:8px 14px;cursor:pointer'
  retry.addEventListener('click', () => window.location.reload())
  container.append(title, details, retry)
  root.append(container)
}

void mountApp().catch(error => {
  console.error('[client] failed to mount application', error)
  renderFatalError(error)
})
