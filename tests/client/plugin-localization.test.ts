import { expect, it } from 'vitest'
import { localizePluginManifest, validatePluginI18n, PLUGIN_LOCALES, type PluginManifest } from '../../packages/plugin-sdk/src'
const plugin: PluginManifest = { id: 'preview', name: 'Fallback', description: 'Fallback description', apiVersion: 1, version: '1.0.0', permissions: ['ui'], client: 'client.mjs',
  views: [{ id: 'preview', title: 'Fallback view', slot: 'settings' }], navigation: { settings: [{ viewId: 'preview', icon: 'code' }] },
  i18n: { en: { name: 'Version Preview', description: 'Preview Studio versions.', views: { preview: 'Version Preview' } },
    zh: { name: '版本预览', description: '预览 Studio 版本。', views: { preview: '版本预览' } },
    'zh-TW': { name: '版本預覽', description: '預覽 Studio 版本。' } } }
it('localizes exact and base languages with English fallback without changing ids, icons or source metadata', () => {
  validatePluginI18n(plugin)
  expect(localizePluginManifest(plugin, 'zh-CN')).toMatchObject({ name: '版本预览', description: '预览 Studio 版本。', views: [{ title: '版本预览', id: 'preview' }] })
  expect(localizePluginManifest(plugin, 'zh-TW').name).toBe('版本預覽')
  expect(localizePluginManifest(plugin, 'zh-TW').views?.[0].title).toBe('版本预览')
  expect(localizePluginManifest(plugin, 'de').name).toBe('Version Preview')
  expect(localizePluginManifest(plugin, 'en-US').navigation).toEqual(plugin.navigation)
  expect(plugin.name).toBe('Fallback')
  expect(plugin.views?.[0].title).toBe('Fallback view')
})
it('keeps legacy packages loadable while new project checks require all entry translations', () => {
  const { i18n: _, ...legacy } = plugin
  expect(localizePluginManifest(legacy, 'en')).toBe(legacy)
  expect(() => validatePluginI18n(legacy)).not.toThrow()
  expect(() => validatePluginI18n(legacy, { required: true })).toThrow(/i18n/)
  const incomplete = structuredClone(plugin)
  delete incomplete.i18n!.en.views
  expect(() => validatePluginI18n(incomplete)).not.toThrow()
  const independent = structuredClone(plugin)
  independent.navigation!.settings![0].title = 'Separate label'
  expect(() => validatePluginI18n(independent)).not.toThrow()
  independent.i18n!.en.navigation = { settings: { preview: 'Preview settings' } }
  independent.i18n!.zh.navigation = { settings: { preview: '预览设置' } }
  validatePluginI18n(independent)
  expect(localizePluginManifest(independent, 'zh').navigation?.settings?.[0].title).toBe('预览设置')
})
it('rejects invalid locales, duplicate locales and references to unknown entry ids', () => {
  for (const invalid of [
    { ...plugin.i18n, '../zh': plugin.i18n!.zh },
    { ...plugin.i18n, EN: plugin.i18n!.en },
    { ...plugin.i18n, en: { ...plugin.i18n!.en, views: { unknown: 'Unknown' } } },
    { ...plugin.i18n, en: { ...plugin.i18n!.en, description: '' } },
  ]) expect(() => validatePluginI18n({ ...plugin, i18n: invalid })).toThrow()
})

it('requires every Studio language and each entry title for projects on the new SDK', () => {
  const full: PluginManifest = { ...plugin, i18n: Object.fromEntries(PLUGIN_LOCALES.map(locale => [locale, { name: locale + ' name', description: locale + ' description', views: { preview: locale + ' preview' } }])) }
  validatePluginI18n(full, { required: true })
  for (const locale of PLUGIN_LOCALES) {
    const missingLanguage = structuredClone(full)
    delete missingLanguage.i18n![locale]
    expect(() => validatePluginI18n(missingLanguage, { required: true })).toThrow(locale)
    const missingTitle = structuredClone(full)
    delete missingTitle.i18n![locale].views!.preview
    expect(() => validatePluginI18n(missingTitle, { required: true })).toThrow(locale + '.views.preview')
  }
  const nav = structuredClone(full)
  nav.navigation!.settings![0].title = 'Distinct navigation title'
  expect(() => validatePluginI18n(nav, { required: true })).toThrow(/navigation/)
  for (const locale of PLUGIN_LOCALES) nav.i18n![locale].navigation = { settings: { preview: locale + ' navigation' } }
  validatePluginI18n(nav, { required: true })
})
