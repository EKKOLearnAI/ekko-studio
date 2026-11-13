import type { ThemeAppearance } from './theme-appearance'

export const THEME_ARCHIVE_FORMAT = 'ekko-studio-theme'
export const THEME_ARCHIVE_VERSION = 1
export const MAX_THEME_BACKGROUND_BYTES = 30 * 1024 * 1024
export const MAX_THEME_ARCHIVE_BYTES = MAX_THEME_BACKGROUND_BYTES + 2 * 1024 * 1024
export const MAX_THEME_MANIFEST_BYTES = 64 * 1024

export interface ThemeArchiveSettings {
  brightness: 'system' | 'light' | 'dark'
  style: 'ink' | 'comic'
  fontSize: number
  textColor: string | null
  accentColor: string | null
  appearance: ThemeAppearance
}

export interface ThemeArchiveManifest {
  format: typeof THEME_ARCHIVE_FORMAT
  version: typeof THEME_ARCHIVE_VERSION
  name: string
  settings: ThemeArchiveSettings
  background: { file: string; name: string } | null
}
