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
import tr from '../../packages/client/src/i18n/locales/tr'
import zhTW from '../../packages/client/src/i18n/locales/zh-TW'
import zh from '../../packages/client/src/i18n/locales/zh'

const locales = { ar, de, en, es, fr, ja, ko, pt, ru, zh, 'zh-TW': zhTW }

function placeholders(value: string): string[] {
  return [...value.matchAll(/\{([^}]+)\}/g)].map(match => match[1]).sort()
}

describe('Ekko configuration locale coverage', () => {
  it('includes Computer Use strings in the partial Turkish locale', () => {
    const keys = Object.keys(en.ekkoConfig).filter(key => key.startsWith('computerUse'))
    expect(Object.keys(tr.ekkoConfig)).toEqual(expect.arrayContaining(keys))
    for (const value of Object.values(tr.ekkoConfig)) expect(value.trim()).not.toBe('')
  })

  it('defines every Ekko message and interpolation in every supported locale', () => {
    const englishKeys = Object.keys(en.ekkoConfig).sort()

    for (const [locale, messages] of Object.entries(locales)) {
      expect(Object.keys(messages.ekkoConfig).sort(), `${locale} Ekko config keys`).toEqual(englishKeys)

      for (const key of englishKeys) {
        const messageKey = key as keyof typeof en.ekkoConfig
        expect(String(messages.ekkoConfig[messageKey]).trim(), `${locale} ekkoConfig.${key}`).not.toBe('')
        expect(placeholders(String(messages.ekkoConfig[messageKey])), `${locale} ekkoConfig.${key} placeholders`)
          .toEqual(placeholders(en.ekkoConfig[messageKey]))
      }
    }
  })

  it('does not use the English Ekko bundle as a fallback for other languages', () => {
    for (const [locale, messages] of Object.entries(locales)) {
      if (locale === 'en') continue

      expect(messages.ekkoConfig, `${locale} Ekko bundle identity`).not.toBe(en.ekkoConfig)
      expect(messages.ekkoConfig.memoryDescription, `${locale} memory description`).not.toBe(en.ekkoConfig.memoryDescription)
      expect(messages.ekkoConfig.mcpDescription, `${locale} MCP description`).not.toBe(en.ekkoConfig.mcpDescription)
    }
  })
})
