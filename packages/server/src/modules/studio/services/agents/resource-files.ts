import { createHash, randomUUID } from 'node:crypto'
import { constants, closeSync, fstatSync, openSync, readSync, renameSync, unlinkSync, writeFileSync, realpathSync, lstatSync, mkdirSync } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { parse as parseToml } from 'smol-toml'
import { getCodingAgentGlobalHome } from '../../public/coding-agent-global-home'
import { StudioError, type AgentResourceLocations } from '../../contracts/plugins'

export interface ResourceFileRef { kind: 'skills' | 'configs'; locationId: string; path: string }
export interface ResourceFileEntry extends ResourceFileRef { absolutePath: string; exists: boolean; readOnly: boolean }
export interface ResourceFileContent extends ResourceFileEntry { content: string; etag: string }
export type ResourceFileOperation = { action: 'list' } | ({ action: 'read' } & ResourceFileRef)
  | ({ action: 'write'; content: string; etag: string } & ResourceFileRef)
  | ({ action: 'review-skill' } & ResourceFileRef) | ({ action: 'remove-skill'; etag: string } & ResourceFileRef)
const MAX_BYTES = 1024 * 1024
const hash = (content: Buffer) => createHash('sha256').update(content).digest('hex')
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT'
function within(path: string, root: string): boolean {
  const suffix = relative(root, path)
  return !suffix || (!isAbsolute(suffix) && suffix !== '..' && !suffix.startsWith(`..${sep}`))
}
function canonical(path: string): string {
  try { return realpathSync(path) } catch (error) {
    if (!missing(error)) throw error
    // A dangling link is not an absent file that the editor may replace.
    try { if (lstatSync(path).isSymbolicLink()) throw new StudioError('FORBIDDEN', 'Dangling resource link') } catch (err) { if (!missing(err)) throw err }
    const parent = dirname(path)
    return parent === path ? path : join(canonical(parent), relative(parent, path))
  }
}

/** Host-owned IO. A reference is always relative to a freshly resolved, owned instance location. */
export class AgentResourceFiles {
  constructor(private readonly locations: AgentResourceLocations, private readonly authorize: () => void) {}

  canonicalLocations() {
    return (['skills', 'configs'] as const).map(kind => (this.locations[kind] || []).map(location => [location.id, canonical(location.path)]))
  }

  /** Host-only directory authority used by whole-Skill import/removal. */
  skillDirectory(locationId: string, path: string) {
    const target = this.target({ kind: 'skills', locationId, path })
    const protectedChild = [...this.locations.skills || [], ...this.locations.configs || []]
      .some(location => location.readOnly && within(canonical(location.path), target.path))
    return { ...target, readOnly: !!target.readOnly || protectedChild }
  }

  private target(ref: ResourceFileRef) {
    this.authorize()
    if (!['skills', 'configs'].includes(ref.kind) || typeof ref.locationId !== 'string' || typeof ref.path !== 'string'
      || ref.path.length > 4096 || ref.path.includes('\\') || ref.path.includes('\0') || isAbsolute(ref.path)
      || (ref.path !== '' && ref.path.split('/').some(part => !part || part === '.' || part === '..' || part.includes(':')))) {
      throw new StudioError('INVALID_ARGUMENT', 'Invalid resource reference')
    }
    const location = this.locations[ref.kind]?.find(item => item.id === ref.locationId)
    if (!location) throw new StudioError('NOT_FOUND', 'Resource location is unavailable')
    const file = 'kind' in location && location.kind === 'file'
    if (file && ref.path !== '') throw new StudioError('INVALID_ARGUMENT', 'File locations have no relative path')
    const root = canonical(location.path), path = canonical(file ? location.path : resolve(location.path, ref.path))
    if (!within(path, root)) throw new StudioError('FORBIDDEN', 'Resource leaves its declared location')
    // Read-only declarations apply across aliases, overlapping locations and resource kinds.
    const readOnly = location.readOnly || within(path, canonical(join(getCodingAgentGlobalHome(), '.agents', 'skills'))) || [...this.locations.skills || [], ...this.locations.configs || []].some(item => {
      if (!item.readOnly) return false
      const protectedPath = canonical(item.path)
      return 'kind' in item && item.kind === 'file' ? path === protectedPath : within(path, protectedPath)
    })
    return { location, path, root, readOnly }
  }

  read(ref: ResourceFileRef): ResourceFileContent {
    const target = this.target(ref)
    if (ref.path === '' && !('kind' in target.location && target.location.kind === 'file')) throw new StudioError('INVALID_ARGUMENT', 'A directory resource requires a file path')
    let fd: number | undefined
    try {
      fd = openSync(target.path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
      const stat = fstatSync(fd)
      if (!stat.isFile()) throw new StudioError('INVALID_ARGUMENT', 'Resource must be a regular file')
      if (stat.size > MAX_BYTES) throw new StudioError('RESOURCE_EXHAUSTED', 'Resource exceeds 1 MiB')
      const buffer = Buffer.alloc(MAX_BYTES + 1)
      let length = 0, count = 0
      do { count = readSync(fd, buffer, length, buffer.length - length, null); length += count } while (count && length < buffer.length)
      const data = buffer.subarray(0, length)
      if (data.length > MAX_BYTES) throw new StudioError('RESOURCE_EXHAUSTED', 'Resource exceeds 1 MiB')
      let content: string
      try { content = new TextDecoder('utf-8', { fatal: true }).decode(data) } catch { throw new StudioError('INVALID_ARGUMENT', 'Resource is not UTF-8 text') }
      if (content.includes('\0')) throw new StudioError('INVALID_ARGUMENT', 'Resource is not text')
      this.authorize()
      return { kind: ref.kind, locationId: ref.locationId, path: ref.path, absolutePath: target.path, exists: true, readOnly: target.readOnly || stat.nlink > 1, content, etag: hash(Buffer.concat([Buffer.from(target.path + '\0'), data])) }
    } catch (error) {
      if (!missing(error)) throw error
      return { kind: ref.kind, locationId: ref.locationId, path: ref.path, absolutePath: target.path, exists: false, readOnly: target.readOnly, content: '', etag: 'missing' }
    } finally { if (fd !== undefined) closeSync(fd) }
  }

  write(ref: ResourceFileRef, content: string, etag: string): ResourceFileContent {
    if (typeof content !== 'string' || content.includes('\0') || Buffer.byteLength(content) > MAX_BYTES || typeof etag !== 'string') throw new StudioError('INVALID_ARGUMENT', 'Invalid resource content or version')
    const before = this.read(ref)
    if (before.readOnly) throw new StudioError('FORBIDDEN', 'Resource is read-only')
    if (before.etag !== etag) throw new StudioError('REVISION_CONFLICT', 'Resource changed; reload before saving')
    const target = this.target(ref)
    if ('format' in target.location) {
      try {
        if (target.location.format === 'json') JSON.parse(content)
        if (target.location.format === 'toml') parseToml(content)
      } catch { throw new StudioError('INVALID_ARGUMENT', 'Invalid native configuration syntax') }
    }
    mkdirSync(dirname(target.path), { recursive: true, mode: 0o700 })
    const temporary = join(dirname(target.path), `.studio-resource-${randomUUID()}.tmp`)
    try {
      writeFileSync(temporary, content, { flag: 'wx', mode: before.exists ? lstatSync(target.path).mode & 0o777 : 0o600 })
      // No await between final authorization/version/path checks and atomic replacement.
      const current = this.read(ref)
      if (current.readOnly || current.absolutePath !== target.path || current.etag !== etag) throw new StudioError('REVISION_CONFLICT', 'Resource changed while saving')
      this.authorize()
      renameSync(temporary, target.path)
      return this.read(ref)
    } finally { try { unlinkSync(temporary) } catch (error) { if (!missing(error)) throw error } }
  }

  async list(): Promise<ResourceFileEntry[]> {
    const files: ResourceFileEntry[] = []
    let visited = 0
    const walk = async (kind: ResourceFileRef['kind'], locationId: string, path: string, depth: number): Promise<void> => {
      if (++visited > 4096 || depth > 12) throw new StudioError('RESOURCE_EXHAUSTED', 'Resource directory exceeds scan limit')
      const ref = { kind, locationId, path }, target = this.target(ref)
      let stat
      try { stat = lstatSync(target.path) } catch (error) { if (missing(error)) return; throw error }
      if (!path && !stat.isDirectory()) throw new StudioError('INVALID_ARGUMENT', 'Resource root must be a directory')
      if (stat.isFile()) {
        if (files.length >= 2048) throw new StudioError('RESOURCE_EXHAUSTED', 'Too many resource files')
        files.push({ ...ref, absolutePath: target.path, exists: true, readOnly: target.readOnly || stat.nlink > 1 })
      } else if (stat.isDirectory()) {
        const children = await readdir(target.path, { withFileTypes: true })
        this.authorize()
        if (children.length + visited > 4096) throw new StudioError('RESOURCE_EXHAUSTED', 'Resource directory exceeds scan limit')
        for (const child of children.sort((a, b) => a.name.localeCompare(b.name))) {
          // Hidden directories (including native caches) and links are not recursively scanned.
          // Declared hidden roots, e.g. Codex .system, are scanned via their own source.
          if (child.name.startsWith('.') || child.isSymbolicLink()) continue
          await walk(kind, locationId, path ? `${path}/${child.name}` : child.name, depth + 1)
        }
      }
    }
    for (const kind of ['skills', 'configs'] as const) for (const location of this.locations[kind] || []) {
      if ('kind' in location && location.kind === 'file') {
        const ref = { kind, locationId: location.id, path: '' }, target = this.target(ref)
        if (files.length >= 2048) throw new StudioError('RESOURCE_EXHAUSTED', 'Too many resource files')
        let exists = false, linked = false
        try { const stat = lstatSync(target.path); if (!stat.isFile()) throw new StudioError('INVALID_ARGUMENT', 'Resource must be a regular file'); exists = true; linked = stat.nlink > 1 } catch (error) { if (!missing(error)) throw error }
        files.push({ ...ref, absolutePath: target.path, exists, readOnly: target.readOnly || linked })
      } else await walk(kind, location.id, '', 0)
    }
    return files
  }
}
