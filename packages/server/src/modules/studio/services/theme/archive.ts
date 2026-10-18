import AdmZip from 'adm-zip'
import { crc32, inflateRawSync } from 'node:zlib'
import {
  MAX_THEME_ARCHIVE_BYTES, MAX_THEME_BACKGROUND_BYTES, MAX_THEME_MANIFEST_BYTES, THEME_ARCHIVE_FORMAT, THEME_ARCHIVE_VERSION,
  type ThemeArchiveManifest,
} from '../../../../../../shared/theme-archive'
import {
  getThemePreset, importThemePreset, listThemePresets, normalizeImportedTheme, UserThemeValidationError,
} from '../../repositories/user-theme-store'
import { readThemeBackground, stageThemeBackground } from './user-theme'

type Preferences = { brightness?: unknown; style?: unknown }
const invalid = (message = 'Invalid theme ZIP archive') => new UserThemeValidationError(message)

function readEntry(entry: AdmZip.IZipEntry, limit: number): Buffer {
  if (entry.header.size > limit) throw invalid('Theme archive entry is too large')
  const compressed = entry.getCompressedData()
  // Do not trust the declared size when inflating an uploaded ZIP.
  const data = entry.header.method === 0 ? compressed : inflateRawSync(compressed, { maxOutputLength: limit })
  if (data.length > limit || data.length !== entry.header.size || crc32(data) !== entry.header.crc) throw invalid()
  return data
}

function parseArchive(data: Buffer) {
  if (data.length > MAX_THEME_ARCHIVE_BYTES) throw new UserThemeValidationError('Theme ZIP exceeds the 32 MB limit', 413)
  try {
    if (data.length < 22 || data.readUInt32LE(0) !== 0x04034b50) throw invalid()
    const entries = new AdmZip(data).getEntries()
    if (entries.length < 1 || entries.length > 2) throw invalid('Expected theme.json and an optional background image')
    const names = new Set<string>()
    for (const entry of entries) {
      const fileType = (entry.attr >>> 16) & 0o170000
      if (entry.isDirectory || (fileType !== 0 && fileType !== 0o100000)
        || (entry.header.flags & 1) || ![0, 8].includes(entry.header.method)
        || !/^(?:theme\.json|background\.(?:png|jpg|webp|gif))$/.test(entry.entryName)
        || names.has(entry.entryName)) throw invalid('Unsupported theme archive entry')
      names.add(entry.entryName)
    }
    const manifestEntry = entries.find(entry => entry.entryName === 'theme.json')
    if (!manifestEntry) throw invalid('Missing theme.json')
    const manifest = JSON.parse(readEntry(manifestEntry, MAX_THEME_MANIFEST_BYTES).toString('utf8'))
    if (!manifest || manifest.format !== THEME_ARCHIVE_FORMAT || manifest.version !== THEME_ARCHIVE_VERSION) {
      throw invalid('Unsupported theme archive format or version')
    }
    if (typeof manifest.name !== 'string' || !manifest.name.trim() || manifest.name.trim().length > 80) throw invalid('Invalid theme name')
    const settings = normalizeImportedTheme(manifest.settings)
    let background: { name: string; data: Buffer } | null = null
    if (manifest.background !== null) {
      const image = manifest.background
      if (!image || typeof image.file !== 'string' || !/^background\.(?:png|jpg|webp|gif)$/.test(image.file)
        || typeof image.name !== 'string' || !image.name.trim() || image.name.length > 255) throw invalid('Invalid theme background')
      const entry = entries.find(item => item.entryName === image.file)
      if (!entry) throw invalid('Missing theme background image')
      background = { name: image.name, data: readEntry(entry, MAX_THEME_BACKGROUND_BYTES) }
    }
    if (entries.length !== (background ? 2 : 1)) throw invalid('Unexpected theme archive files')
    return { name: manifest.name.trim(), settings, background }
  } catch (error) {
    if (error instanceof UserThemeValidationError) throw error
    throw invalid()
  }
}

export async function importThemeArchive(userId: number, data: Buffer, preferences: Preferences = {}) {
  const imported = parseArchive(data)
  const staged = imported.background
    ? await stageThemeBackground(userId, imported.background.name, imported.background.data)
    : null
  try {
    return importThemePreset(userId, imported, staged?.background || null, preferences)
  } catch (error) {
    await staged?.discard()
    throw error
  }
}

export async function exportThemeArchive(userId: number, id: string, preferences: Preferences = {}) {
  const theme = getThemePreset(userId, id)
  const name = listThemePresets(userId).themes.find(item => item.id === id)!.name || 'Theme'
  const manifest: ThemeArchiveManifest = {
    format: THEME_ARCHIVE_FORMAT, version: THEME_ARCHIVE_VERSION, name,
    settings: normalizeImportedTheme({
      brightness: theme.brightness || preferences.brightness || 'system',
      style: theme.style || preferences.style || 'ink',
      fontSize: theme.fontSize, textColor: theme.textColor, accentColor: theme.accentColor, appearance: theme.appearance,
    }),
    background: null,
  }
  const zip = new AdmZip()
  if (theme.backgroundFilename) {
    const image = await readThemeBackground(userId, id)
    if (!image) throw new UserThemeValidationError('Theme background is missing; restore or remove it before exporting', 409)
    if (image.data.length > MAX_THEME_BACKGROUND_BYTES) throw invalid('Theme background is too large')
    const file = `background.${theme.backgroundFilename.split('.').at(-1)}`
    manifest.background = { file, name: theme.backgroundOriginalName || file }
    zip.addFile(file, image.data)
  }
  zip.addFile('theme.json', Buffer.from(JSON.stringify(manifest, null, 2)))
  return { data: await zip.toBufferPromise(), name }
}
