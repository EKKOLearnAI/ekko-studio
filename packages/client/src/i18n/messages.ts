export type LocaleMessages = Record<string, any>

export const supportedLocales = ['en', 'zh', 'zh-TW', 'ja', 'ko', 'fr', 'es', 'de', 'pt', 'ru', 'ar', 'tr'] as const
export type SupportedLocale = (typeof supportedLocales)[number]

function isPlainObject(value: unknown): value is LocaleMessages {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

export function mergeMessagesWithFallback(
  fallback: LocaleMessages,
  locale: LocaleMessages,
): LocaleMessages {
  const merged: LocaleMessages = { ...fallback }

  for (const [key, value] of Object.entries(locale)) {
    const fallbackValue = fallback[key]
    merged[key] = isPlainObject(fallbackValue) && isPlainObject(value)
      ? mergeMessagesWithFallback(fallbackValue, value)
      : value
  }

  return merged
}

const localeLoaders: Record<SupportedLocale, () => Promise<{ default: LocaleMessages }>> = {
  en: () => import('./locales/en'),
  zh: () => import('./locales/zh'),
  'zh-TW': () => import('./locales/zh-TW'),
  ja: () => import('./locales/ja'),
  ko: () => import('./locales/ko'),
  fr: () => import('./locales/fr'),
  es: () => import('./locales/es'),
  de: () => import('./locales/de'),
  pt: () => import('./locales/pt'),
  ru: () => import('./locales/ru'),
  ar: () => import('./locales/ar'),
  tr: () => import('./locales/tr'),
}

const localeMessagePromises = new Map<SupportedLocale, Promise<LocaleMessages>>()

export function loadLocaleMessages(locale: SupportedLocale): Promise<LocaleMessages> {
  const existing = localeMessagePromises.get(locale)
  if (existing) return existing

  const pending = localeLoaders[locale]()
    .then(module => module.default)
    .catch((error) => {
      localeMessagePromises.delete(locale)
      throw error
    })
  localeMessagePromises.set(locale, pending)
  return pending
}
