export const PLUGIN_LOCALES = Object.freeze(['en', 'zh', 'zh-TW', 'ja', 'ko', 'fr', 'es', 'de', 'pt', 'ru', 'ar', 'tr']);

/** Display metadata is additive: legacy fallback strings remain valid SDK v1. */
export function validatePluginI18n(manifest, { required = false } = {}) {
  const translations = manifest.i18n;
  if (translations === undefined) {
    if (required) throw new Error(`New plugins require i18n names, descriptions and entry titles for every Studio locale: ${PLUGIN_LOCALES.join(', ')}`);
    return;
  }
  const object = value => value && typeof value === 'object' && !Array.isArray(value);
  const text = (value, label, max = 160) => {
    if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error(`Invalid plugin i18n ${label}`);
  };
  if (!object(translations) || !Object.keys(translations).length || Object.keys(translations).length > 32) throw new Error('Invalid plugin i18n locales');
  const locales = new Map();
  const views = new Set((manifest.views || []).map(view => view.id));
  for (const [locale, value] of Object.entries(translations)) {
    let canonical;
    try { canonical = Intl.getCanonicalLocales(locale)[0].toLowerCase(); } catch { throw new Error(`Invalid plugin i18n locale: ${locale}`); }
    if (locales.has(canonical)) throw new Error(`Duplicate plugin i18n locale: ${locale}`);
    if (!object(value) || Object.keys(value).some(key => !['name', 'description', 'views', 'navigation'].includes(key))) throw new Error(`Invalid plugin i18n ${locale}`);
    text(value.name, `${locale}.name`); text(value.description, `${locale}.description`, 4000);
    if (value.views !== undefined) {
      if (!object(value.views)) throw new Error(`Invalid plugin i18n ${locale}.views`);
      for (const [id, title] of Object.entries(value.views)) {
        if (!views.has(id)) throw new Error(`Unknown plugin i18n view: ${id}`);
        text(title, `${locale}.views.${id}`);
      }
    }
    if (value.navigation !== undefined) {
      if (!object(value.navigation) || Object.keys(value.navigation).some(key => !['main', 'settings'].includes(key))) throw new Error(`Invalid plugin i18n ${locale}.navigation`);
      for (const [slot, titles] of Object.entries(value.navigation)) {
        const targets = new Set((manifest.navigation?.[slot] || []).map(entry => entry.viewId));
        if (!object(titles)) throw new Error(`Invalid plugin i18n ${locale}.navigation.${slot}`);
        for (const [id, title] of Object.entries(titles)) {
          if (!targets.has(id)) throw new Error(`Unknown plugin i18n navigation entry: ${slot}/${id}`);
          text(title, `${locale}.navigation.${slot}.${id}`);
        }
      }
    }
    locales.set(canonical, value);
  }
  for (const locale of required ? PLUGIN_LOCALES : []) {
    const value = locales.get(locale.toLowerCase());
    if (!value) throw new Error(`Plugin i18n requires ${locale} translations`);
    for (const id of views) text(value.views?.[id], `${locale}.views.${id}`);
    for (const slot of ['main', 'settings'])
      for (const entry of manifest.navigation?.[slot] || [])
        if (entry.title) text(value.navigation?.[slot]?.[entry.viewId], `${locale}.navigation.${slot}.${entry.viewId}`);
  }
  if (required) { text(manifest.name, 'fallback name'); text(manifest.description, 'fallback description', 4000); }
}

/** Resolve exact locale, language, English, then the original manifest strings. */
export function localizePluginManifest(manifest, locale) {
  if (!manifest.i18n) return manifest;
  const normalized = String(locale).replaceAll('_', '-').toLowerCase();
  const locales = new Map(Object.entries(manifest.i18n).map(([key, value]) => [key.toLowerCase(), value]));
  const candidates = [...new Set([normalized, normalized.split('-')[0], 'en'])].map(key => locales.get(key)).filter(Boolean);
  const translated = read => candidates.map(read).find(value => typeof value === 'string' && value.trim());
  const views = manifest.views?.map(view => ({ ...view, title: translated(value => value.views?.[view.id]) || view.title }));
  const result = { ...manifest, name: translated(value => value.name) || manifest.name,
    description: translated(value => value.description) || manifest.description };
  if (views) result.views = views;
  if (manifest.navigation) result.navigation = Object.fromEntries(Object.entries(manifest.navigation).map(([slot, entries]) => [slot,
    entries.map(entry => {
      const title = translated(value => value.navigation?.[slot]?.[entry.viewId]) || entry.title;
      return title ? { ...entry, title } : { ...entry };
    }),
  ]));
  return result;
}

/** Match a complete locale, its base language, then English. */
export function resolvePluginLocale(locale, available = PLUGIN_LOCALES) {
  const requested = String(locale || 'en').replaceAll('_', '-').toLowerCase();
  const locales = new Map(available.map(key => [key.toLowerCase(), key]));
  return locales.get(requested) || locales.get(requested.split('-')[0]) || locales.get('en') || available[0] || 'en';
}
