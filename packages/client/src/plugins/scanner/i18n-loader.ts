import type { SupportedLocale } from '../types'

/**
 * 把插件自带的 locale 文件按需 import 进来。
 * 命名约定：`./locales/<locale>.ts`，导出形如 `{ scanner: {...} }` 的对象。
 */
const LOADERS: Record<SupportedLocale, () => Promise<Record<string, unknown>>> = {
  ar: () => import('./locales/ar'),
  de: () => import('./locales/de'),
  en: () => import('./locales/en'),
  tr: () => import('./locales/en'),
  es: () => import('./locales/es'),
  fr: () => import('./locales/fr'),
  ja: () => import('./locales/ja'),
  ko: () => import('./locales/ko'),
  pt: () => import('./locales/pt'),
  ru: () => import('./locales/ru'),
  zh: () => import('./locales/zh'),
  'zh-TW': () => import('./locales/zh-TW'),
}

/**
 * 加载插件支持的 locale；每个 loader 必须返回一个对象（可空）。
 * 加载失败时返回空对象，不影响其它 locale。
 */
export async function loadPluginMessages(locale: SupportedLocale): Promise<Record<string, unknown>> {
  const loader = LOADERS[locale]
  if (!loader) return {}
  try {
    const mod = await loader()
    return (mod.default || mod) as Record<string, unknown>
  } catch (error) {
    // eslint-disable-next-line no-console
    console.warn(`[plugins/scanner] failed to load locale "${locale}":`, error)
    return {}
  }
}

export const SUPPORTED_LOCALES: readonly SupportedLocale[] = Object.keys(LOADERS) as SupportedLocale[]
