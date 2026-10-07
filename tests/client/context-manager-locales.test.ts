import { describe, expect, it } from 'vitest'
import ar from '../../packages/client/src/i18n/locales/ar'
import de from '../../packages/client/src/i18n/locales/de'
import en from '../../packages/client/src/i18n/locales/en'
import es from '../../packages/client/src/i18n/locales/es'
import fr from '../../packages/client/src/i18n/locales/fr'
import ja from '../../packages/client/src/i18n/locales/ja'
import ko from '../../packages/client/src/i18n/locales/ko'
import pt from '../../packages/client/src/i18n/locales/pt'
import ru from '../../packages/client/src/i18n/locales/ru'
import zhTW from '../../packages/client/src/i18n/locales/zh-TW'
import zh from '../../packages/client/src/i18n/locales/zh'

function leaves(value: unknown, prefix = ''): Record<string, string> {
  if (!value || typeof value !== 'object') return {}
  return Object.fromEntries(Object.entries(value).flatMap(([key, child]) => {
    const path = prefix ? `${prefix}.${key}` : key
    return typeof child === 'string' ? [[path, child]] : Object.entries(leaves(child, path))
  }))
}

describe('context manager locale coverage', () => {
  it('provides settings, lifecycle and usage messages in every locale', () => {
    const locales = { ar, de, en, es, fr, ja, ko, pt, ru, zh, 'zh-TW': zhTW }
    const english = leaves((en as Record<string, unknown>).contextManager)
    expect(Object.keys(english)).toContain('actions.upgrade')
    expect(Object.keys(english)).toContain('sourceUnavailable')
    for (const [locale, messages] of Object.entries(locales)) {
      const translated = leaves((messages as Record<string, unknown>).contextManager)
      expect(Object.keys(translated).sort(), locale).toEqual(Object.keys(english).sort())
      for (const value of Object.values(translated)) expect(value.trim(), locale).not.toBe('')
    }
  })
})