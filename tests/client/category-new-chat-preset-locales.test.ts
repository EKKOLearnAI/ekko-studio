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

const locales: Record<string, any> = { ar, de, en, es, fr, ja, ko, pt, ru, zh, 'zh-TW': zhTW }

const keys = [
  'newChatInCategory', 'newCategory', 'newCategoryTitle', 'categoryName', 'categoryNameRequired',
  'categoryNameTooLong', 'categoryNameDuplicate', 'setCategoryPreset', 'categoryPresetTitle',
  'clearCategoryPreset', 'categoryPresetHint', 'categoryPresetDefault', 'categoryPresetSaved',
  'categoryPresetCleared', 'categoryPresetSaveFailed', 'categoryPresetApplied',
  'confirmDeleteCategoryWithPreset', 'presetWarningAgent', 'presetWarningProfile',
  'presetWarningModelKind', 'presetWarningProvider', 'presetWarningModel', 'presetWarningAgentPreset',
  'presetWarningWorkspace', 'presetValueUnavailable', 'presetBaseUrlKeyRequired', 'categoryPresetForbidden',
  'categoryPresetWorkspaceAbsolute',
]

const placeholders: Record<string, string> = {
  newChatInCategory: '{name}',
  categoryPresetTitle: '{name}',
  categoryPresetApplied: '{name}',
  confirmDeleteCategoryWithPreset: '{name}',
  presetWarningAgent: '{value}',
  presetWarningProfile: '{value}',
  presetWarningProvider: '{value}',
  presetWarningModel: '{value}',
  presetWarningAgentPreset: '{value}',
  presetWarningWorkspace: '{value}',
  presetValueUnavailable: '{value}',
}

describe('category New Chat preset locales', () => {
  it('drops the reasoning effort field that was removed from presets', () => {
    for (const locale of Object.keys(locales)) expect(locales[locale].chat.reasoningEffortField, locale).toBeUndefined()
  })

  it.each(Object.keys(locales))('%s has every category preset string with its placeholders', (locale) => {
    for (const key of keys) {
      const value = locales[locale].chat[key]
      expect(typeof value, `${locale}.chat.${key}`).toBe('string')
      expect(value.trim(), `${locale}.chat.${key}`).not.toBe('')
      if (placeholders[key]) expect(value, `${locale}.chat.${key}`).toContain(placeholders[key])
    }
  })
})
