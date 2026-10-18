import { createI18n } from 'vue-i18n'
import { loadLocaleMessages, mergeMessagesWithFallback, supportedLocales } from './messages'
import type { SupportedLocale } from './messages'
import { applyDocumentDirection } from './direction'

const saved = localStorage.getItem('hermes_locale')

function resolveLocale(saved: string | null): SupportedLocale {
  if (saved && (supportedLocales as readonly string[]).includes(saved)) {
    return saved as SupportedLocale
  }

  function normalize(tag: string): SupportedLocale | null {
    const lower = tag.toLowerCase()
    if (lower.startsWith('zh')) {
      const isTraditional =
        lower.includes('hant') ||
        lower.includes('-tw') ||
        lower.includes('-hk') ||
        lower.includes('-mo')
      return isTraditional ? 'zh-TW' : 'zh'
    }
    const short = tag.slice(0, 2)
    if ((supportedLocales as readonly string[]).includes(tag)) return tag as SupportedLocale
    if ((supportedLocales as readonly string[]).includes(short)) return short as SupportedLocale
    return null
  }

  for (const lang of navigator.languages) {
    const resolved = normalize(lang)
    if (resolved) return resolved
  }

  return 'en'
}

function setHtmlLang(locale: SupportedLocale) {
  document.documentElement.lang = locale
  applyDocumentDirection(locale)
}

const locale = resolveLocale(saved)
setHtmlLang(locale)

async function createAppI18n() {
  const englishMessagesPromise = loadLocaleMessages('en')
  const localeMessagesPromise = locale === 'en'
    ? englishMessagesPromise
    : loadLocaleMessages(locale)
  const [englishMessages, localeMessages] = await Promise.all([
    englishMessagesPromise,
    localeMessagesPromise,
  ])
  const initialMessages = locale === 'en'
    ? { en: englishMessages }
    : {
        en: englishMessages,
        [locale]: mergeMessagesWithFallback(englishMessages, localeMessages),
      }

  return createI18n({
    legacy: false,
    locale,
    fallbackLocale: 'en',
    messages: initialMessages,
  })
}

export const i18nReady = createAppI18n()

if (import.meta.hot) {
  let messageUpdateSequence = 0
  import.meta.hot.accept('./messages', async (updatedMessages) => {
    if (!updatedMessages) return
    const sequence = ++messageUpdateSequence
    const globalI18n = (await i18nReady).global as any
    const englishMessages = await updatedMessages.loadLocaleMessages('en')
    const messages = await Promise.all(
      (globalI18n.availableLocales as SupportedLocale[]).map(async (loadedLocale) => [
        loadedLocale,
        loadedLocale === 'en'
          ? englishMessages
          : updatedMessages.mergeMessagesWithFallback(
              englishMessages,
              await updatedMessages.loadLocaleMessages(loadedLocale),
            ),
      ] as const),
    )
    if (sequence !== messageUpdateSequence) return
    for (const [loadedLocale, localeMessages] of messages) {
      globalI18n.setLocaleMessage(loadedLocale, localeMessages)
    }
  })
}

let localeSwitchSequence = 0

export async function switchLocale(newLocale: string): Promise<void> {
  if (!(supportedLocales as readonly string[]).includes(newLocale)) return

  const i18n = await i18nReady
  const globalI18n = i18n.global as any
  const nextLocale = newLocale as SupportedLocale
  const sequence = ++localeSwitchSequence
  if (!(globalI18n.availableLocales as readonly string[]).includes(nextLocale)) {
    const nextMessages = await loadLocaleMessages(nextLocale)
    if (sequence !== localeSwitchSequence) return
    globalI18n.setLocaleMessage(
      nextLocale,
      nextLocale === 'en'
        ? nextMessages
        : mergeMessagesWithFallback(globalI18n.getLocaleMessage('en'), nextMessages),
    )
  }

  if (sequence !== localeSwitchSequence) return
  globalI18n.locale.value = nextLocale
  setHtmlLang(nextLocale)
  localStorage.setItem('hermes_locale', nextLocale)
}
