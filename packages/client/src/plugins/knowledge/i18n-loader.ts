import type { SupportedLocale } from '../types'

/**
 * Knowledge plugin — i18n locale loader.
 * All 11 SupportedLocale entries covered; missing locales fall back to English.
 */
const LOADERS: Record<SupportedLocale, () => Promise<Record<string, unknown>>> = {
  en: () => import('./locales/en'),
  tr: () => import('./locales/en'),
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
}

const FALLBACK_LOADER = LOADERS.en

export async function loadPluginMessages(locale: SupportedLocale): Promise<Record<string, unknown>> {
  const loader = LOADERS[locale] ?? FALLBACK_LOADER
  try {
    const mod = await loader()
    return (mod.default || mod) as Record<string, unknown>
  } catch (error) {
    // eslint-disable-next-line no-console
    console.warn(`[plugins/knowledge] failed to load locale "${locale}":`, error)
    if (loader !== FALLBACK_LOADER) {
      try {
        const fallback = await FALLBACK_LOADER()
        return (fallback.default || fallback) as Record<string, unknown>
      } catch {
        return {}
      }
    }
    return {}
  }
}

export const SUPPORTED_LOCALES: readonly SupportedLocale[] = Object.keys(LOADERS) as SupportedLocale[]
