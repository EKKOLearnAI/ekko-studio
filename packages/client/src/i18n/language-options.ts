import { supportedLocales, type SupportedLocale } from './messages'

export const languageOptions: Array<{ label: string; value: SupportedLocale }> = [
  { label: '简体中文', value: 'zh' },
  { label: '繁體中文', value: 'zh-TW' },
  { label: 'English', value: 'en' },
  { label: '日本語', value: 'ja' },
  { label: '한국어', value: 'ko' },
  { label: 'Français', value: 'fr' },
  { label: 'Español', value: 'es' },
  { label: 'Deutsch', value: 'de' },
  { label: 'Português', value: 'pt' },
  { label: 'Русский', value: 'ru' },
  { label: 'العربية', value: 'ar' },
  { label: 'Türkçe', value: 'tr' },
]

export function normalizeSupportedLocale(value: unknown): SupportedLocale {
  const locale = typeof value === 'string' ? value : ''
  return (supportedLocales as readonly string[]).includes(locale)
    ? locale as SupportedLocale
    : 'en'
}
