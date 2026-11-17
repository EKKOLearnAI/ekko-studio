export const PLUGIN_LOCALES: readonly ['en', 'zh', 'zh-TW', 'ja', 'ko', 'fr', 'es', 'de', 'pt', 'ru', 'ar', 'tr']
import type { PluginManifest } from './core'
/** Legacy manifests are accepted unless required is true (new SDK project checks). */
export function validatePluginI18n(manifest: Pick<PluginManifest, 'name' | 'description' | 'i18n' | 'views' | 'navigation'>, options?: { required?: boolean }): void
/** Returns display metadata without mutating the original manifest or its identifiers. */
export function localizePluginManifest<T extends Pick<PluginManifest, 'name' | 'description' | 'i18n'>>(manifest: T, locale: string): T

export function resolvePluginLocale(locale?: string, available?: readonly string[]): string
