import { describe, expect, it, vi } from 'vitest'

const system = vi.hoisted(() => ({ locale: 'zh-CN' }))
vi.mock('electron', () => ({ app: { getLocale: () => system.locale } }))
import { defaultNativeDeviceLocale, nativeDeviceLabels, nativeDeviceLocales, normalizeNativeDeviceLocale } from '../../packages/desktop/src/main/native-device-messages'
import { supportedLocales } from '../../packages/client/src/i18n/messages'

describe('desktop device UI language', () => {
  it('covers every Studio language with complete copy and matching placeholders', () => {
    expect([...nativeDeviceLocales].sort()).toEqual([...supportedLocales].sort())
    const english = nativeDeviceLabels('en')
    const placeholders = (value: string) => [...value.matchAll(/\{([a-zA-Z]+)\}/g)].map(match => match[1]).sort()
    for (const locale of supportedLocales) {
      const labels = nativeDeviceLabels(locale)
      expect(Object.keys(labels).sort()).toEqual(Object.keys(english).sort())
      for (const [key, value] of Object.entries(labels)) {
        expect(value.trim(), `${locale}.${key}`).not.toBe('')
        expect(placeholders(value), `${locale}.${key}`).toEqual(placeholders(english[key as keyof typeof english]))
      }
      expect(labels.local).toBe('localhost')
      if (locale !== 'en') for (const key of ['title', 'switch', 'busy', 'restarting'] as const) expect(labels[key], `${locale}.${key}`).not.toBe(english[key])
    }
  })

  it.each([
    ['en-US', 'en'], ['EN_gb', 'en'], ['zh_CN', 'zh'], ['zh-Hans', 'zh'], ['zh-Hant-HK', 'zh-TW'],
    ['zh-TW', 'zh-TW'], ['ru-RU', 'ru'], ['ar-SA', 'ar'], ['tr-TR', 'tr'], ['es-MX', 'es'],
  ])('normalizes the app language %s to %s', (input, expected) => {
    expect(normalizeNativeDeviceLocale(input)).toBe(expected)
  })

  it('rejects unsupported or malformed page languages instead of treating them as a system override', () => {
    for (const value of [null, {}, '', 'xx', '__proto__', '<script>en</script>', 'a'.repeat(65)]) expect(normalizeNativeDeviceLocale(value)).toBeNull()
  })

  it('prefers an explicit app language over the Chinese OS locale', () => {
    system.locale = 'zh-CN'
    expect(defaultNativeDeviceLocale()).toBe('zh')
    expect(nativeDeviceLabels('en').confirm).toBe('Switch and restart')
    expect(nativeDeviceLabels('es').confirm).toBe('Cambiar y reiniciar')
    expect(nativeDeviceLabels().confirm).toBe('切换并重启')
  })

  it('supports all twelve system fallbacks before an app language is available', () => {
    system.locale = 'ar-SA';expect(defaultNativeDeviceLocale()).toBe('ar')
    system.locale = 'ru-RU';expect(defaultNativeDeviceLocale()).toBe('ru')
    system.locale = 'unknown';expect(defaultNativeDeviceLocale()).toBe('en')
  })
})
