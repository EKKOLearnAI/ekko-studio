import { createHash, randomUUID } from 'node:crypto'
import { constants, closeSync, fstatSync, lstatSync, mkdirSync, openSync, readdirSync, readSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { StudioError } from '../../contracts/plugins'
import { AgentResourceFiles } from './resource-files'
import { MAX_SKILL_FILE_BYTES, MAX_SKILL_IMPORT_BYTES, skillUploadPath, type ResourceSkillArchive } from './resource-skill-archive'

export interface ResourceSkillRef { locationId: string; path: string }
export interface ResourceSkillReview extends ResourceSkillRef { name: string; etag: string; files: number; bytes: number }
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT'

/** Complete Skill directories share the same owned location authority as the editor. */
export class AgentResourceSkills {
  constructor(private readonly files: AgentResourceFiles, private readonly authorize: () => void) {}

  private target(ref: ResourceSkillRef) {
    if (!ref.path || ref.path === '.') throw new StudioError('FORBIDDEN', 'A declared Skill root cannot be removed or replaced')
    skillUploadPath(ref.path)
    const target = this.files.skillDirectory(ref.locationId, ref.path)
    if (target.readOnly) throw new StudioError('FORBIDDEN', 'Skill source is read-only')
    let path = target.root
    for (const segment of ref.path.split('/')) {
      path = join(path, segment)
      try { if (lstatSync(path).isSymbolicLink()) throw new StudioError('FORBIDDEN', 'Skill directory cannot traverse links') }
      catch (error) { if (missing(error)) break; throw error }
    }
    return target
  }

  validateImport(locationId: string, name: string): void {
    const target = this.target({ locationId, path: name })
    try { lstatSync(target.path) } catch (error) { if (missing(error)) return; throw error }
    throw new StudioError('REVISION_CONFLICT', 'Skill already exists; no files were replaced')
  }

  review(ref: ResourceSkillRef): ResourceSkillReview {
    const target = this.target(ref), digest = createHash('sha256').update(`${target.path}\0`)
    let files = 0, bytes = 0, visited = 0, main = false
    const walk = (path: string, suffix: string, depth: number) => {
      if (++visited > 512 || depth > 12) throw new StudioError('RESOURCE_EXHAUSTED', 'Skill directory exceeds its inspection limit')
      this.authorize()
      const stat = lstatSync(path)
      if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile()) || stat.nlink > 1 && stat.isFile()) throw new StudioError('FORBIDDEN', 'Skill contains links or special files')
      if (this.files.skillDirectory(ref.locationId, suffix ? `${ref.path}/${suffix}` : ref.path).readOnly) throw new StudioError('FORBIDDEN', 'Skill contains a protected resource')
      digest.update(JSON.stringify([suffix, stat.isDirectory() ? 'directory' : 'file', stat.mode & 0o777, stat.isFile() ? stat.size : null]))
      if (stat.isDirectory()) {
        const entries = readdirSync(path).sort()
        if (entries.length + visited > 512) throw new StudioError('RESOURCE_EXHAUSTED', 'Skill directory exceeds its inspection limit')
        for (const entry of entries) walk(join(path, entry), suffix ? `${suffix}/${entry}` : entry, depth + 1)
        return
      }
      if (++files > 256 || stat.size > MAX_SKILL_FILE_BYTES) throw new StudioError('RESOURCE_EXHAUSTED', 'Skill contains too many or oversized files')
      const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
      try {
        const opened = fstatSync(fd)
        if (!opened.isFile() || opened.nlink > 1 || opened.ino !== stat.ino || opened.dev !== stat.dev) throw new StudioError('REVISION_CONFLICT', 'Skill changed during inspection')
        const buffer = Buffer.alloc(65_536)
        let count: number, length = 0
        do {
          count = readSync(fd, buffer, 0, buffer.length, null); length += count; bytes += count
          if (length > MAX_SKILL_FILE_BYTES || bytes > MAX_SKILL_IMPORT_BYTES) throw new StudioError('RESOURCE_EXHAUSTED', 'Skill contents exceed their inspection limit')
          digest.update(buffer.subarray(0, count))
        } while (count)
        const after = fstatSync(fd)
        if (after.size !== opened.size || after.mtimeMs !== opened.mtimeMs || length !== opened.size) throw new StudioError('REVISION_CONFLICT', 'Skill changed during inspection')
        digest.update(`\0${length}\0`)
        if (suffix === 'SKILL.md') main = true
      } finally { closeSync(fd) }
    }
    try { walk(target.path, '', 0) }
    catch (error) { if (missing(error)) throw new StudioError('NOT_FOUND', 'Skill is unavailable'); throw error }
    if (!main) throw new StudioError('INVALID_ARGUMENT', 'Directory does not contain SKILL.md')
    this.authorize()
    return { ...ref, name: ref.path.split('/').at(-1)!, etag: digest.digest('hex'), files, bytes }
  }

  import(locationId: string, archive: ResourceSkillArchive): { name: string; path: string; locationId: string } {
    const ref = { locationId, path: archive.name }, target = this.target(ref)
    this.validateImport(locationId, archive.name)
    mkdirSync(target.root, { recursive: true, mode: 0o700 })
    const staging = join(target.root, `.studio-resource-skill-${randomUUID()}.tmp`)
    mkdirSync(staging, { mode: 0o700 })
    try {
      for (const file of archive.files) {
        const path = join(staging, skillUploadPath(file.path))
        mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
        writeFileSync(path, file.data, { flag: 'wx', mode: file.executable ? 0o700 : 0o600 })
      }
      const current = this.target(ref)
      if (current.path !== target.path || current.root !== target.root) throw new StudioError('REVISION_CONFLICT', 'Skill destination changed while importing')
      this.validateImport(locationId, archive.name); this.authorize()
      renameSync(staging, target.path)
      return { ...ref, name: archive.name }
    } finally { rmSync(staging, { recursive: true, force: true }) }
  }

  validateRemoval(ref: ResourceSkillRef, etag: string): void {
    if (typeof etag !== 'string' || !/^[a-f0-9]{64}$/.test(etag)) throw new StudioError('INVALID_ARGUMENT', 'Skill directory version is required')
    const review = this.review(ref)
    if (review.etag !== etag) throw new StudioError('REVISION_CONFLICT', 'Skill changed; review it again before deleting')
  }

  remove(ref: ResourceSkillRef, etag: string): { removed: true } {
    this.validateRemoval(ref, etag)
    const target = this.target(ref)
    this.authorize()
    // No await between the complete content/version check and filesystem removal.
    rmSync(target.path, { recursive: true })
    return { removed: true }
  }
}
