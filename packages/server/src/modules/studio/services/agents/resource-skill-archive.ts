import AdmZip from 'adm-zip'
import { crc32, inflateRawSync } from 'node:zlib'
import { StudioError } from '../../contracts/plugins'

export interface ResourceSkillUpload { filename: string; data: Buffer }
export interface ResourceSkillArchive { name: string; files: Array<{ path: string; data: Buffer; executable?: boolean }> }
export const MAX_SKILL_IMPORT_BYTES = 16 * 1024 * 1024
export const MAX_SKILL_FILE_BYTES = 4 * 1024 * 1024
const MAX_FILES = 256

export function skillUploadPath(value: string): string {
  if (typeof value !== 'string' || !value || value.length > 4096 || value.includes('\\') || /[\x00-\x1f\x7f]/.test(value)) throw new StudioError('INVALID_ARGUMENT', 'Invalid Skill upload path')
  const parts = value.split('/')
  if (parts.length > 12 || parts.some(part => !part || part === '.' || part === '..' || /[:*?"<>|]/.test(part) || /[. ]$/.test(part)
    || /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(part) || part.startsWith('.studio-resource-'))) throw new StudioError('INVALID_ARGUMENT', 'Invalid Skill upload path')
  return value
}

/** Copies caller buffers before any asynchronous authorization or filesystem work. */
export function copySkillUploads(values: ResourceSkillUpload[]): ResourceSkillUpload[] {
  if (!Array.isArray(values) || !values.length || values.length > MAX_FILES) throw new StudioError('RESOURCE_EXHAUSTED', 'Skill upload file count is invalid')
  let bytes = 0
  return values.map(value => {
    if (!value || Object.keys(value).some(key => !['filename', 'data'].includes(key)) || !Buffer.isBuffer(value.data)) throw new StudioError('INVALID_ARGUMENT', 'Invalid Skill upload')
    skillUploadPath(value.filename)
    bytes += value.data.length
    if (bytes > MAX_SKILL_IMPORT_BYTES) throw new StudioError('RESOURCE_EXHAUSTED', 'Skill upload exceeds 16 MiB')
    return { filename: value.filename, data: Buffer.from(value.data) }
  })
}

/** Bounded extraction in memory; archive paths never become filesystem destinations. */
export function parseSkillArchive(uploads: ResourceSkillUpload[]): ResourceSkillArchive {
  let files: ResourceSkillArchive['files'], zipName: string | undefined
  if (uploads.length === 1 && !uploads[0]!.filename.includes('/') && /\.zip$/i.test(uploads[0]!.filename)) {
    zipName = uploads[0]!.filename.slice(0, -4)
    try {
      const zip = new AdmZip(uploads[0]!.data, { readEntries: false }), count = zip.getEntryCount()
      // Check the parser's effective count (including ZIP64) before it allocates
      // entry objects; inspecting only the ordinary end record is insufficient.
      if (!Number.isSafeInteger(count) || count < 0 || count > MAX_FILES * 2) throw new StudioError('RESOURCE_EXHAUSTED', 'Skill archive directory limit exceeded')
      const entries = zip.getEntries()
      if (entries.length !== count) throw new StudioError('INVALID_ARGUMENT', 'Skill archive directory is inconsistent')
      let total = 0
      files = []
      for (const entry of entries) {
        const path = skillUploadPath(entry.entryName.replace(/\/$/, ''))
        const mode = (entry.attr >>> 16) & 0xf000
        if (mode && mode !== 0x8000 && mode !== 0x4000) throw new StudioError('FORBIDDEN', 'Skill archives cannot contain links or special files')
        if (entry.header.flags & 1) throw new StudioError('CAPABILITY_UNSUPPORTED', 'Encrypted Skill archives are unsupported')
        if (path.split('/')[0] === '__MACOSX' || entry.isDirectory) continue
        if (files.length >= MAX_FILES || entry.header.size > MAX_SKILL_FILE_BYTES || total + entry.header.size > MAX_SKILL_IMPORT_BYTES) throw new StudioError('RESOURCE_EXHAUSTED', 'Skill archive exceeds its extraction limit')
        const compressed = entry.getCompressedData()
        const data = entry.header.method === 0 ? Buffer.from(compressed) : entry.header.method === 8
          ? inflateRawSync(compressed, { maxOutputLength: MAX_SKILL_FILE_BYTES }) : undefined
        if (!data) throw new StudioError('CAPABILITY_UNSUPPORTED', 'Unsupported Skill archive compression')
        if (data.length !== entry.header.size || crc32(data) !== (entry.header.crc >>> 0)) throw new StudioError('INVALID_ARGUMENT', 'Skill archive entry failed validation')
        total += data.length
        if (total > MAX_SKILL_IMPORT_BYTES) throw new StudioError('RESOURCE_EXHAUSTED', 'Skill archive exceeds 16 MiB')
        files.push({ path, data, ...((entry.attr >>> 16) & 0o100 ? { executable: true } : {}) })
      }
    } catch (error) {
      if (error instanceof StudioError) throw error
      throw new StudioError('INVALID_ARGUMENT', 'Skill archive is invalid or exceeds its extraction limit')
    }
  } else files = uploads.map(upload => ({ path: skillUploadPath(upload.filename), data: upload.data }))
  if (!files.length) throw new StudioError('INVALID_ARGUMENT', 'Skill upload has no files')
  const rootSkill = files.some(file => file.path === 'SKILL.md')
  const roots = new Set(files.map(file => file.path.split('/')[0]!))
  if (!rootSkill && (roots.size !== 1 || files.some(file => !file.path.includes('/')))) throw new StudioError('INVALID_ARGUMENT', 'Upload exactly one Skill folder containing SKILL.md')
  const name = rootSkill ? zipName : [...roots][0]
  if (!name || name.startsWith('.') || name.includes('/')) throw new StudioError('INVALID_ARGUMENT', 'Skill folder name is invalid')
  skillUploadPath(name)
  const normalized = files.map(file => ({ path: rootSkill ? file.path : file.path.slice(name.length + 1), data: file.data, ...(file.executable ? { executable: true } : {}) }))
  const names = new Set<string>()
  let bytes = 0
  for (const file of normalized) {
    skillUploadPath(file.path)
    const portable = file.path.normalize('NFC').toLowerCase()
    if (names.has(portable) || file.data.length > MAX_SKILL_FILE_BYTES) throw new StudioError('INVALID_ARGUMENT', 'Duplicate or oversized Skill file')
    names.add(portable); bytes += file.data.length
    if (bytes > MAX_SKILL_IMPORT_BYTES) throw new StudioError('RESOURCE_EXHAUSTED', 'Skill contents exceed 16 MiB')
  }
  for (const path of names) if ([...names].some(other => other.startsWith(`${path}/`))) throw new StudioError('INVALID_ARGUMENT', 'Skill file conflicts with a directory')
  const main = normalized.find(file => file.path === 'SKILL.md')
  if (!main || !main.data.length || main.data.length > 1024 * 1024) throw new StudioError('INVALID_ARGUMENT', 'Skill requires a nonempty SKILL.md under 1 MiB')
  try { if (new TextDecoder('utf-8', { fatal: true }).decode(main.data).includes('\0')) throw new Error() }
  catch { throw new StudioError('INVALID_ARGUMENT', 'SKILL.md must contain UTF-8 text') }
  return { name, files: normalized }
}
