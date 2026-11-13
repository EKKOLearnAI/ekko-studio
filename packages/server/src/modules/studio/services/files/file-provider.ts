import { readFile, stat as fsStat, readdir, mkdir, rm, rename, copyFile as fsCopyFile, writeFile as fsWriteFile } from 'fs/promises'
import { resolve, normalize, isAbsolute, basename, join } from 'path'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { existsSync, readFileSync } from 'fs'
import YAML from 'js-yaml'
import { config } from '../../public/config'
import { getActiveProfileDir, getProfileDir } from '../../public/profile-config'
import { MAX_DOWNLOAD_SIZE, MAX_EDIT_SIZE, isSensitivePath } from './file-policy'
import { isPathWithin, relativePathFromBase } from './path'

export { MAX_DOWNLOAD_SIZE, MAX_EDIT_SIZE, isSensitivePath } from './file-policy'

const execFileAsync = promisify(execFile)
const execOpts = { windowsHide: true }

// Backend command timeout (default 30s)
const BACKEND_TIMEOUT = 30_000

export interface FileEntry {
  name: string
  path: string       // relative to hermes home
  isDir: boolean
  size: number
  modTime: string    // ISO 8601
}

export interface FileStat {
  name: string
  path: string       // relative to hermes home
  isDir: boolean
  size: number
  modTime: string    // ISO 8601
  permissions?: string
}

export type BackendType = 'local' | 'docker' | 'ssh' | 'singularity' | 'modal' | 'daytona'

export interface FileProvider {
  type: BackendType
  readFile(filePath: string): Promise<Buffer>
  exists(filePath: string): Promise<boolean>
  listDir(dirPath: string): Promise<FileEntry[]>
  stat(filePath: string): Promise<FileStat>
  writeFile(filePath: string, content: Buffer): Promise<void>
  deleteFile(filePath: string): Promise<void>
  deleteDir(dirPath: string): Promise<void>
  renameFile(oldPath: string, newPath: string): Promise<void>
  mkDir(dirPath: string): Promise<void>
  copyFile(srcPath: string, destPath: string): Promise<void>
}

export interface TerminalConfig {
  backend: BackendType
  docker_image?: string
  docker_container_name?: string
  cwd?: string
  singularity_image?: string
  ssh_port?: number
}

/**
 * Validate a file path: must be absolute and not contain '..' traversal.
 */
export function normalizePlatformPath(filePath: string, platform = process.platform): string {
  if (platform !== 'win32') return filePath
  const msysDrivePath = filePath.match(/^\/([a-zA-Z])(?:\/(.*))?$/)
  if (!msysDrivePath) return filePath
  const [, drive, rest = ''] = msysDrivePath
  return `${drive.toUpperCase()}:\\${rest.replace(/\//g, '\\')}`
}

function hasTraversalSegment(filePath: string): boolean {
  return filePath.replace(/\\/g, '/').split('/').some(part => part === '..')
}

export function validatePath(filePath: string): string {
  if (!filePath) throw Object.assign(new Error('Missing file path'), { code: 'missing_path' })
  const platformPath = normalizePlatformPath(filePath)
  if (hasTraversalSegment(platformPath)) {
    throw Object.assign(new Error('Invalid file path'), { code: 'invalid_path' })
  }
  const resolved = resolve(platformPath)
  const normalized = normalize(resolved)
  if (!isAbsolute(normalized)) {
    throw Object.assign(new Error('Path must be absolute'), { code: 'invalid_path' })
  }
  return normalized
}

/**
 * Check if a path is inside the upload directory.
 */
export function isInUploadDir(filePath: string): boolean {
  return isPathWithin(filePath, config.uploadDir)
}

function homeDirForProfile(profile?: string): string {
  return profile ? getProfileDir(profile) : getActiveProfileDir()
}

function envPathForProfile(profile?: string): string {
  return join(profile ? getProfileDir(profile) : getActiveProfileDir(), '.env')
}

/**
 * Resolve a relative path to an absolute path under the selected profile directory.
 * Validates path safety (no traversal).
 */
export function resolveProfileFilePath(relativePath: string, profile?: string): string {
  const homeDir = homeDirForProfile(profile)
  if (!relativePath || relativePath === '.' || relativePath === '/') {
    return homeDir
  }
  const normalized = normalize(relativePath).replace(/\\/g, '/')
  // Only a literal `..` segment is traversal. `..hidden` and `...` are ordinary
  // names, and validatePath already draws that line for absolute paths.
  if (hasTraversalSegment(normalized) || normalized.startsWith('/')) {
    throw Object.assign(new Error('Invalid file path'), { code: 'invalid_path' })
  }
  const resolved = resolve(homeDir, normalized)
  if (!isPathWithin(resolved, homeDir)) {
    throw Object.assign(new Error('Path traversal detected'), { code: 'invalid_path' })
  }
  return resolved
}

// --- Local ---

export class LocalFileProvider implements FileProvider {
  type: BackendType = 'local'
  constructor(private homeDir = getActiveProfileDir()) {}

  async readFile(filePath: string): Promise<Buffer> {
    const p = validatePath(filePath)
    const s = await fsStat(p)
    if (!s.isFile()) throw Object.assign(new Error('Not a file'), { code: 'not_found' })
    if (s.size > MAX_DOWNLOAD_SIZE) {
      throw Object.assign(new Error(`File too large: ${s.size} bytes`), { code: 'file_too_large' })
    }
    return readFile(p)
  }

  async exists(filePath: string): Promise<boolean> {
    try {
      const p = validatePath(filePath)
      const s = await fsStat(p)
      return s.isFile()
    } catch {
      return false
    }
  }

  async listDir(dirPath: string): Promise<FileEntry[]> {
    const p = validatePath(dirPath)
    const entries = await readdir(p, { withFileTypes: true })
    const results: FileEntry[] = []
    for (const entry of entries) {
      try {
        const fullPath = resolve(p, entry.name)
        const s = await fsStat(fullPath)
        const relPath = relativePathFromBase(fullPath, this.homeDir) ?? entry.name
        results.push({
          name: entry.name,
          path: relPath,
          isDir: s.isDirectory(),
          size: s.size,
          modTime: s.mtime.toISOString(),
        })
      } catch {
        // skip entries that fail to stat
      }
    }
    return results
  }

  async stat(filePath: string): Promise<FileStat> {
    const p = validatePath(filePath)
    const s = await fsStat(p)
    const relPath = relativePathFromBase(p, this.homeDir) ?? basename(p)
    return {
      name: basename(p),
      path: relPath || basename(p),
      isDir: s.isDirectory(),
      size: s.size,
      modTime: s.mtime.toISOString(),
    }
  }

  async writeFile(filePath: string, content: Buffer): Promise<void> {
    const p = validatePath(filePath)
    await fsWriteFile(p, content)
  }

  async deleteFile(filePath: string): Promise<void> {
    const p = validatePath(filePath)
    const s = await fsStat(p)
    if (!s.isFile()) throw Object.assign(new Error('Not a file'), { code: 'not_found' })
    await rm(p)
  }

  async deleteDir(dirPath: string): Promise<void> {
    const p = validatePath(dirPath)
    const s = await fsStat(p)
    if (!s.isDirectory()) throw Object.assign(new Error('Not a directory'), { code: 'not_found' })
    await rm(p, { recursive: true })
  }

  async renameFile(oldPath: string, newPath: string): Promise<void> {
    const op = validatePath(oldPath)
    const np = validatePath(newPath)
    await rename(op, np)
  }

  async mkDir(dirPath: string): Promise<void> {
    const p = validatePath(dirPath)
    await mkdir(p, { recursive: true })
  }

  async copyFile(srcPath: string, destPath: string): Promise<void> {
    const sp = validatePath(srcPath)
    const dp = validatePath(destPath)
    await fsCopyFile(sp, dp)
  }
}

/**
 * Parse `ls -la --time-style=+%Y-%m-%dT%H:%M:%S` output into FileEntry[].
 * Example line: `drwxr-xr-x 2 user group 4096 2025-07-20T10:30:00 dirname`
 * Skips the "total N" line and entries "." and "..".
 */
function parseLsOutput(output: string, parentRelPath: string): FileEntry[] {
  const entries: FileEntry[] = []
  for (const line of output.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('total ')) continue
    const parts = trimmed.split(/\s+/)
    if (parts.length < 7) continue
    const permissions = parts[0]
    const size = parseInt(parts[4], 10) || 0
    const modTime = parts[5]
    const name = parts.slice(6).join(' ')
    if (name === '.' || name === '..') continue
    const isDir = permissions.startsWith('d')
    const relPath = parentRelPath ? `${parentRelPath}/${name}` : name
    entries.push({ name, path: relPath, isDir, size, modTime: modTime.includes('T') ? modTime : new Date(modTime).toISOString() })
  }
  return entries
}

/**
 * Parse `stat -c '%n|%F|%s|%Y'` output.
 * Output: `/path/to/file|regular file|1234|1721500000`
 */
function parseStatOutput(output: string, relativePath: string): FileStat {
  const parts = output.trim().split('|')
  if (parts.length < 4) throw Object.assign(new Error('Failed to parse stat output'), { code: 'backend_error' })
  const name = basename(parts[0])
  const fileType = parts[1].toLowerCase()
  const size = parseInt(parts[2], 10) || 0
  const modEpoch = parseInt(parts[3], 10) || 0
  const isDir = fileType.includes('directory')
  return {
    name,
    path: relativePath,
    isDir,
    size,
    modTime: new Date(modEpoch * 1000).toISOString(),
  }
}

// --- Docker ---

export class DockerFileProvider implements FileProvider {
  type: BackendType = 'docker'
  private containerName: string
  private homeDir: string

  constructor(containerName: string, homeDir = getActiveProfileDir()) {
    this.containerName = containerName
    this.homeDir = homeDir
  }

  async readFile(filePath: string): Promise<Buffer> {
    const p = validatePath(filePath)
    try {
      // Node.js supports encoding: 'buffer' but @types/node doesn't type it correctly
      const { stdout } = await execFileAsync('docker', [
        'exec', this.containerName, 'cat', p,
      ], { maxBuffer: MAX_DOWNLOAD_SIZE, timeout: BACKEND_TIMEOUT, encoding: 'buffer' as any, ...execOpts })
      return stdout as unknown as Buffer
    } catch (err: any) {
      if (err.code === 'ETIMEDOUT' || err.killed) {
        throw Object.assign(new Error('Backend timeout'), { code: 'backend_timeout' })
      }
      if (err.stderr && /no such file/i.test(String(err.stderr))) {
        throw Object.assign(new Error('File not found in container'), { code: 'not_found' })
      }
      throw Object.assign(new Error(`Docker error: ${err.message}`), { code: 'backend_error' })
    }
  }

  async exists(filePath: string): Promise<boolean> {
    const p = validatePath(filePath)
    try {
      await execFileAsync('docker', [
        'exec', this.containerName, 'test', '-f', p,
      ], { timeout: 5000, ...execOpts })
      return true
    } catch {
      return false
    }
  }

  async listDir(dirPath: string): Promise<FileEntry[]> {
    const p = validatePath(dirPath)
    try {
      const { stdout } = await execFileAsync('docker', [
        'exec', this.containerName, 'ls', '-la', '--time-style=+%Y-%m-%dT%H:%M:%S', p,
      ], { maxBuffer: 10 * 1024 * 1024, timeout: BACKEND_TIMEOUT, ...execOpts })
      const relParent = relativePathFromBase(p, this.homeDir) ?? ''
      return parseLsOutput(stdout, relParent)
    } catch (err: any) {
      if (err.code === 'ETIMEDOUT' || err.killed) throw Object.assign(new Error('Backend timeout'), { code: 'backend_timeout' })
      if (err.stderr && /no such file|not a directory/i.test(String(err.stderr)))
        throw Object.assign(new Error('Directory not found'), { code: 'not_found' })
      throw Object.assign(new Error(`Docker error: ${err.message}`), { code: 'backend_error' })
    }
  }

  async stat(filePath: string): Promise<FileStat> {
    const p = validatePath(filePath)
    try {
      const { stdout } = await execFileAsync('docker', [
        'exec', this.containerName, 'stat', '-c', '%n|%F|%s|%Y', p,
      ], { timeout: BACKEND_TIMEOUT, ...execOpts })
      const relPath = relativePathFromBase(p, this.homeDir) ?? basename(p)
      return parseStatOutput(stdout, relPath)
    } catch (err: any) {
      if (err.code === 'ETIMEDOUT' || err.killed) throw Object.assign(new Error('Backend timeout'), { code: 'backend_timeout' })
      if (err.stderr && /no such file/i.test(String(err.stderr))) throw Object.assign(new Error('Not found'), { code: 'not_found' })
      throw Object.assign(new Error(`Docker error: ${err.message}`), { code: 'backend_error' })
    }
  }

  async writeFile(filePath: string, content: Buffer): Promise<void> {
    const p = validatePath(filePath)
    try {
      await execFileAsync('docker', [
        'exec', '-i', this.containerName, 'sh', '-c', `cat > '${p.replace(/'/g, "'\\''")}'`,
      ], { timeout: BACKEND_TIMEOUT, input: content, ...execOpts } as any)
    } catch (err: any) {
      if (err.code === 'ETIMEDOUT' || err.killed) throw Object.assign(new Error('Backend timeout'), { code: 'backend_timeout' })
      throw Object.assign(new Error(`Docker error: ${err.message}`), { code: 'backend_error' })
    }
  }

  async deleteFile(filePath: string): Promise<void> {
    const p = validatePath(filePath)
    try {
      await execFileAsync('docker', ['exec', this.containerName, 'rm', p], { timeout: BACKEND_TIMEOUT, ...execOpts })
    } catch (err: any) {
      if (err.code === 'ETIMEDOUT' || err.killed) throw Object.assign(new Error('Backend timeout'), { code: 'backend_timeout' })
      throw Object.assign(new Error(`Docker error: ${err.message}`), { code: 'backend_error' })
    }
  }

  async deleteDir(dirPath: string): Promise<void> {
    const p = validatePath(dirPath)
    try {
      await execFileAsync('docker', ['exec', this.containerName, 'rm', '-rf', p], { timeout: BACKEND_TIMEOUT, ...execOpts })
    } catch (err: any) {
      if (err.code === 'ETIMEDOUT' || err.killed) throw Object.assign(new Error('Backend timeout'), { code: 'backend_timeout' })
      throw Object.assign(new Error(`Docker error: ${err.message}`), { code: 'backend_error' })
    }
  }

  async renameFile(oldPath: string, newPath: string): Promise<void> {
    const op = validatePath(oldPath)
    const np = validatePath(newPath)
    try {
      await execFileAsync('docker', ['exec', this.containerName, 'mv', op, np], { timeout: BACKEND_TIMEOUT, ...execOpts })
    } catch (err: any) {
      if (err.code === 'ETIMEDOUT' || err.killed) throw Object.assign(new Error('Backend timeout'), { code: 'backend_timeout' })
      throw Object.assign(new Error(`Docker error: ${err.message}`), { code: 'backend_error' })
    }
  }

  async mkDir(dirPath: string): Promise<void> {
    const p = validatePath(dirPath)
    try {
      await execFileAsync('docker', ['exec', this.containerName, 'mkdir', '-p', p], { timeout: BACKEND_TIMEOUT, ...execOpts })
    } catch (err: any) {
      if (err.code === 'ETIMEDOUT' || err.killed) throw Object.assign(new Error('Backend timeout'), { code: 'backend_timeout' })
      throw Object.assign(new Error(`Docker error: ${err.message}`), { code: 'backend_error' })
    }
  }

  async copyFile(srcPath: string, destPath: string): Promise<void> {
    const sp = validatePath(srcPath)
    const dp = validatePath(destPath)
    try {
      await execFileAsync('docker', ['exec', this.containerName, 'cp', sp, dp], { timeout: BACKEND_TIMEOUT, ...execOpts })
    } catch (err: any) {
      if (err.code === 'ETIMEDOUT' || err.killed) throw Object.assign(new Error('Backend timeout'), { code: 'backend_timeout' })
      throw Object.assign(new Error(`Docker error: ${err.message}`), { code: 'backend_error' })
    }
  }
}

// --- SSH ---

export class SSHFileProvider implements FileProvider {
  type: BackendType = 'ssh'
  private host: string
  private user: string
  private keyPath?: string
  private port?: number
  private homeDir: string

  constructor(host: string, user: string, keyPath?: string, homeDir = getActiveProfileDir(), port?: number) {
    this.host = host
    this.user = user
    this.keyPath = keyPath
    this.port = port
    this.homeDir = homeDir
  }

  private sshArgs(): string[] {
    const args = ['-o', 'StrictHostKeyChecking=no', '-o', 'BatchMode=yes']
    if (this.port) args.push('-p', String(this.port))
    if (this.keyPath) args.push('-i', this.keyPath)
    args.push(`${this.user}@${this.host}`)
    return args
  }

  /**
   * Shell-escape a string for safe use in a remote SSH command.
   * Wraps in single quotes and escapes embedded single quotes.
   */
  private shellEscape(s: string): string {
    return "'" + s.replace(/'/g, "'\\''") + "'"
  }

  async readFile(filePath: string): Promise<Buffer> {
    const p = validatePath(filePath)
    try {
      // Node.js supports encoding: 'buffer' but @types/node doesn't type it correctly
      // Pass a single quoted command string to prevent shell injection on remote
      const { stdout } = await execFileAsync('ssh', [
        ...this.sshArgs(), `cat ${this.shellEscape(p)}`,
      ], { maxBuffer: MAX_DOWNLOAD_SIZE, timeout: BACKEND_TIMEOUT, encoding: 'buffer' as any, ...execOpts })
      return stdout as unknown as Buffer
    } catch (err: any) {
      if (err.code === 'ETIMEDOUT' || err.killed) {
        throw Object.assign(new Error('Backend timeout'), { code: 'backend_timeout' })
      }
      if (err.stderr && /no such file/i.test(String(err.stderr))) {
        throw Object.assign(new Error('File not found on remote'), { code: 'not_found' })
      }
      throw Object.assign(new Error(`SSH error: ${err.message}`), { code: 'backend_error' })
    }
  }

  async exists(filePath: string): Promise<boolean> {
    const p = validatePath(filePath)
    try {
      await execFileAsync('ssh', [
        ...this.sshArgs(), `test -f ${this.shellEscape(p)}`,
      ], { timeout: 5000, ...execOpts })
      return true
    } catch {
      return false
    }
  }

  async listDir(dirPath: string): Promise<FileEntry[]> {
    const p = validatePath(dirPath)
    try {
      const { stdout } = await execFileAsync('ssh', [
        ...this.sshArgs(), `ls -la --time-style=+%Y-%m-%dT%H:%M:%S ${this.shellEscape(p)}`,
      ], { maxBuffer: 10 * 1024 * 1024, timeout: BACKEND_TIMEOUT, ...execOpts })
      const relParent = relativePathFromBase(p, this.homeDir) ?? ''
      return parseLsOutput(stdout, relParent)
    } catch (err: any) {
      if (err.code === 'ETIMEDOUT' || err.killed) throw Object.assign(new Error('Backend timeout'), { code: 'backend_timeout' })
      if (err.stderr && /no such file|not a directory/i.test(String(err.stderr)))
        throw Object.assign(new Error('Directory not found'), { code: 'not_found' })
      throw Object.assign(new Error(`SSH error: ${err.message}`), { code: 'backend_error' })
    }
  }

  async stat(filePath: string): Promise<FileStat> {
    const p = validatePath(filePath)
    try {
      const { stdout } = await execFileAsync('ssh', [
        ...this.sshArgs(), `stat -c '%n|%F|%s|%Y' ${this.shellEscape(p)}`,
      ], { timeout: BACKEND_TIMEOUT, ...execOpts })
      const relPath = relativePathFromBase(p, this.homeDir) ?? basename(p)
      return parseStatOutput(stdout, relPath)
    } catch (err: any) {
      if (err.code === 'ETIMEDOUT' || err.killed) throw Object.assign(new Error('Backend timeout'), { code: 'backend_timeout' })
      if (err.stderr && /no such file/i.test(String(err.stderr))) throw Object.assign(new Error('Not found'), { code: 'not_found' })
      throw Object.assign(new Error(`SSH error: ${err.message}`), { code: 'backend_error' })
    }
  }

  async writeFile(filePath: string, content: Buffer): Promise<void> {
    const p = validatePath(filePath)
    try {
      await execFileAsync('ssh', [
        ...this.sshArgs(), `cat > ${this.shellEscape(p)}`,
      ], { timeout: BACKEND_TIMEOUT, input: content, ...execOpts } as any)
    } catch (err: any) {
      if (err.code === 'ETIMEDOUT' || err.killed) throw Object.assign(new Error('Backend timeout'), { code: 'backend_timeout' })
      throw Object.assign(new Error(`SSH error: ${err.message}`), { code: 'backend_error' })
    }
  }

  async deleteFile(filePath: string): Promise<void> {
    const p = validatePath(filePath)
    try {
      await execFileAsync('ssh', [...this.sshArgs(), `rm ${this.shellEscape(p)}`], { timeout: BACKEND_TIMEOUT, ...execOpts })
    } catch (err: any) {
      if (err.code === 'ETIMEDOUT' || err.killed) throw Object.assign(new Error('Backend timeout'), { code: 'backend_timeout' })
      throw Object.assign(new Error(`SSH error: ${err.message}`), { code: 'backend_error' })
    }
  }

  async deleteDir(dirPath: string): Promise<void> {
    const p = validatePath(dirPath)
    try {
      await execFileAsync('ssh', [...this.sshArgs(), `rm -rf ${this.shellEscape(p)}`], { timeout: BACKEND_TIMEOUT, ...execOpts })
    } catch (err: any) {
      if (err.code === 'ETIMEDOUT' || err.killed) throw Object.assign(new Error('Backend timeout'), { code: 'backend_timeout' })
      throw Object.assign(new Error(`SSH error: ${err.message}`), { code: 'backend_error' })
    }
  }

  async renameFile(oldPath: string, newPath: string): Promise<void> {
    const op = validatePath(oldPath)
    const np = validatePath(newPath)
    try {
      await execFileAsync('ssh', [...this.sshArgs(), `mv ${this.shellEscape(op)} ${this.shellEscape(np)}`], { timeout: BACKEND_TIMEOUT, ...execOpts })
    } catch (err: any) {
      if (err.code === 'ETIMEDOUT' || err.killed) throw Object.assign(new Error('Backend timeout'), { code: 'backend_timeout' })
      throw Object.assign(new Error(`SSH error: ${err.message}`), { code: 'backend_error' })
    }
  }

  async mkDir(dirPath: string): Promise<void> {
    const p = validatePath(dirPath)
    try {
      await execFileAsync('ssh', [...this.sshArgs(), `mkdir -p ${this.shellEscape(p)}`], { timeout: BACKEND_TIMEOUT, ...execOpts })
    } catch (err: any) {
      if (err.code === 'ETIMEDOUT' || err.killed) throw Object.assign(new Error('Backend timeout'), { code: 'backend_timeout' })
      throw Object.assign(new Error(`SSH error: ${err.message}`), { code: 'backend_error' })
    }
  }

  async copyFile(srcPath: string, destPath: string): Promise<void> {
    const sp = validatePath(srcPath)
    const dp = validatePath(destPath)
    try {
      await execFileAsync('ssh', [...this.sshArgs(), `cp ${this.shellEscape(sp)} ${this.shellEscape(dp)}`], { timeout: BACKEND_TIMEOUT, ...execOpts })
    } catch (err: any) {
      if (err.code === 'ETIMEDOUT' || err.killed) throw Object.assign(new Error('Backend timeout'), { code: 'backend_timeout' })
      throw Object.assign(new Error(`SSH error: ${err.message}`), { code: 'backend_error' })
    }
  }
}

// --- Singularity ---

export class SingularityFileProvider implements FileProvider {
  type: BackendType = 'singularity'
  private imagePath: string
  private homeDir: string

  constructor(imagePath: string, homeDir = getActiveProfileDir()) {
    this.imagePath = imagePath
    this.homeDir = homeDir
  }

  async readFile(filePath: string): Promise<Buffer> {
    const p = validatePath(filePath)
    try {
      // Node.js supports encoding: 'buffer' but @types/node doesn't type it correctly
      const { stdout } = await execFileAsync('singularity', [
        'exec', this.imagePath, 'cat', p,
      ], { maxBuffer: MAX_DOWNLOAD_SIZE, timeout: BACKEND_TIMEOUT, encoding: 'buffer' as any, ...execOpts })
      return stdout as unknown as Buffer
    } catch (err: any) {
      if (err.code === 'ETIMEDOUT' || err.killed) {
        throw Object.assign(new Error('Backend timeout'), { code: 'backend_timeout' })
      }
      if (err.stderr && /no such file/i.test(String(err.stderr))) {
        throw Object.assign(new Error('File not found in container'), { code: 'not_found' })
      }
      throw Object.assign(new Error(`Singularity error: ${err.message}`), { code: 'backend_error' })
    }
  }

  async exists(filePath: string): Promise<boolean> {
    const p = validatePath(filePath)
    try {
      await execFileAsync('singularity', [
        'exec', this.imagePath, 'test', '-f', p,
      ], { timeout: 5000, ...execOpts })
      return true
    } catch {
      return false
    }
  }

  async listDir(dirPath: string): Promise<FileEntry[]> {
    const p = validatePath(dirPath)
    try {
      const { stdout } = await execFileAsync('singularity', [
        'exec', this.imagePath, 'ls', '-la', '--time-style=+%Y-%m-%dT%H:%M:%S', p,
      ], { maxBuffer: 10 * 1024 * 1024, timeout: BACKEND_TIMEOUT, ...execOpts })
      const relParent = relativePathFromBase(p, this.homeDir) ?? ''
      return parseLsOutput(stdout, relParent)
    } catch (err: any) {
      if (err.code === 'ETIMEDOUT' || err.killed) throw Object.assign(new Error('Backend timeout'), { code: 'backend_timeout' })
      if (err.stderr && /no such file|not a directory/i.test(String(err.stderr)))
        throw Object.assign(new Error('Directory not found'), { code: 'not_found' })
      throw Object.assign(new Error(`Singularity error: ${err.message}`), { code: 'backend_error' })
    }
  }

  async stat(filePath: string): Promise<FileStat> {
    const p = validatePath(filePath)
    try {
      const { stdout } = await execFileAsync('singularity', [
        'exec', this.imagePath, 'stat', '-c', '%n|%F|%s|%Y', p,
      ], { timeout: BACKEND_TIMEOUT, ...execOpts })
      const relPath = relativePathFromBase(p, this.homeDir) ?? basename(p)
      return parseStatOutput(stdout, relPath)
    } catch (err: any) {
      if (err.code === 'ETIMEDOUT' || err.killed) throw Object.assign(new Error('Backend timeout'), { code: 'backend_timeout' })
      if (err.stderr && /no such file/i.test(String(err.stderr))) throw Object.assign(new Error('Not found'), { code: 'not_found' })
      throw Object.assign(new Error(`Singularity error: ${err.message}`), { code: 'backend_error' })
    }
  }

  async writeFile(filePath: string, content: Buffer): Promise<void> {
    const p = validatePath(filePath)
    try {
      await execFileAsync('singularity', [
        'exec', this.imagePath, 'sh', '-c', `cat > '${p.replace(/'/g, "'\\''")}'`,
      ], { timeout: BACKEND_TIMEOUT, input: content, ...execOpts } as any)
    } catch (err: any) {
      if (err.code === 'ETIMEDOUT' || err.killed) throw Object.assign(new Error('Backend timeout'), { code: 'backend_timeout' })
      throw Object.assign(new Error(`Singularity error: ${err.message}`), { code: 'backend_error' })
    }
  }

  async deleteFile(filePath: string): Promise<void> {
    const p = validatePath(filePath)
    try {
      await execFileAsync('singularity', ['exec', this.imagePath, 'rm', p], { timeout: BACKEND_TIMEOUT, ...execOpts })
    } catch (err: any) {
      if (err.code === 'ETIMEDOUT' || err.killed) throw Object.assign(new Error('Backend timeout'), { code: 'backend_timeout' })
      throw Object.assign(new Error(`Singularity error: ${err.message}`), { code: 'backend_error' })
    }
  }

  async deleteDir(dirPath: string): Promise<void> {
    const p = validatePath(dirPath)
    try {
      await execFileAsync('singularity', ['exec', this.imagePath, 'rm', '-rf', p], { timeout: BACKEND_TIMEOUT, ...execOpts })
    } catch (err: any) {
      if (err.code === 'ETIMEDOUT' || err.killed) throw Object.assign(new Error('Backend timeout'), { code: 'backend_timeout' })
      throw Object.assign(new Error(`Singularity error: ${err.message}`), { code: 'backend_error' })
    }
  }

  async renameFile(oldPath: string, newPath: string): Promise<void> {
    const op = validatePath(oldPath)
    const np = validatePath(newPath)
    try {
      await execFileAsync('singularity', ['exec', this.imagePath, 'mv', op, np], { timeout: BACKEND_TIMEOUT, ...execOpts })
    } catch (err: any) {
      if (err.code === 'ETIMEDOUT' || err.killed) throw Object.assign(new Error('Backend timeout'), { code: 'backend_timeout' })
      throw Object.assign(new Error(`Singularity error: ${err.message}`), { code: 'backend_error' })
    }
  }

  async mkDir(dirPath: string): Promise<void> {
    const p = validatePath(dirPath)
    try {
      await execFileAsync('singularity', ['exec', this.imagePath, 'mkdir', '-p', p], { timeout: BACKEND_TIMEOUT, ...execOpts })
    } catch (err: any) {
      if (err.code === 'ETIMEDOUT' || err.killed) throw Object.assign(new Error('Backend timeout'), { code: 'backend_timeout' })
      throw Object.assign(new Error(`Singularity error: ${err.message}`), { code: 'backend_error' })
    }
  }

  async copyFile(srcPath: string, destPath: string): Promise<void> {
    const sp = validatePath(srcPath)
    const dp = validatePath(destPath)
    try {
      await execFileAsync('singularity', ['exec', this.imagePath, 'cp', sp, dp], { timeout: BACKEND_TIMEOUT, ...execOpts })
    } catch (err: any) {
      if (err.code === 'ETIMEDOUT' || err.killed) throw Object.assign(new Error('Backend timeout'), { code: 'backend_timeout' })
      throw Object.assign(new Error(`Singularity error: ${err.message}`), { code: 'backend_error' })
    }
  }
}

// --- Config helpers ---

/**
 * Read terminal config from hermes config.yaml.
 */
export function getTerminalConfig(profile?: string): TerminalConfig {
  try {
    const configPath = join(homeDirForProfile(profile), 'config.yaml')
    if (!existsSync(configPath)) return { backend: 'local' }
    const raw = readFileSync(configPath, 'utf-8')
    const doc = YAML.load(raw, { json: true }) as any
    const t = doc?.terminal || {}
    return {
      backend: (t.backend as BackendType) || 'local',
      docker_image: t.docker_image,
      docker_container_name: t.docker_container_name,
      cwd: t.cwd,
      singularity_image: t.singularity_image,
    }
  } catch {
    return { backend: 'local' }
  }
}

/**
 * Read SSH env vars from hermes .env file.
 */
function getSSHEnvVars(profile?: string): { host?: string; user?: string; key?: string; port?: number } {
  try {
    const envPath = envPathForProfile(profile)
    if (!existsSync(envPath)) return {}
    const raw = readFileSync(envPath, 'utf-8')
    const vars: Record<string, string> = {}
    for (const line of raw.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith('#')) continue
      const eqIdx = trimmed.indexOf('=')
      if (eqIdx === -1) continue
      let value = trimmed.slice(eqIdx + 1).trim()
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1)
      }
      vars[trimmed.slice(0, eqIdx).trim()] = value
    }
    return {
      host: vars.TERMINAL_SSH_HOST,
      user: vars.TERMINAL_SSH_USER,
      key: vars.TERMINAL_SSH_KEY,
      port: vars.TERMINAL_SSH_PORT ? parseInt(vars.TERMINAL_SSH_PORT, 10) : undefined,
    }
  } catch {
    return {}
  }
}

/**
 * Resolve Docker container name. If not configured, try to find a running
 * container based on the configured image.
 */
async function resolveDockerContainer(cfg: TerminalConfig): Promise<string> {
  if (cfg.docker_container_name) return cfg.docker_container_name
  if (cfg.docker_image) {
    try {
      const { stdout } = await execFileAsync('docker', [
        'ps', '-q', '--filter', `ancestor=${cfg.docker_image}`, '--latest',
      ], { timeout: 5000, ...execOpts })
      const id = stdout.trim()
      if (id) return id
    } catch { }
  }
  throw Object.assign(
    new Error('Cannot determine Docker container. Set terminal.docker_container_name in hermes config.'),
    { code: 'backend_error' },
  )
}

// --- Factory ---

// Cache providers for a short time to avoid re-reading config on every request
const providerCache = new Map<string, { provider: FileProvider; cachedAt: number }>()
const CACHE_TTL = 10_000

/** @internal — for testing only */
export function _resetFileProviderCache() {
  providerCache.clear()
}

/**
 * Create a FileProvider based on the active hermes terminal config.
 * Defaults to LocalFileProvider if config cannot be read or backend is unknown.
 */
export async function createFileProvider(profile?: string): Promise<FileProvider> {
  const now = Date.now()
  const homeDir = homeDirForProfile(profile)
  const cacheKey = profile || homeDir
  const cached = providerCache.get(cacheKey)
  if (cached && now - cached.cachedAt < CACHE_TTL) return cached.provider

  const cfg = getTerminalConfig(profile)
  let provider: FileProvider

  switch (cfg.backend) {
    case 'docker': {
      const container = await resolveDockerContainer(cfg)
      provider = new DockerFileProvider(container, homeDir)
      break
    }
    case 'ssh': {
      const ssh = getSSHEnvVars(profile)
      if (!ssh.host || !ssh.user) {
        throw Object.assign(
          new Error('SSH backend requires TERMINAL_SSH_HOST and TERMINAL_SSH_USER in .env'),
          { code: 'backend_error' },
        )
      }
      provider = new SSHFileProvider(ssh.host, ssh.user, ssh.key, homeDir, ssh.port)
      break
    }
    case 'singularity': {
      if (!cfg.singularity_image) {
        throw Object.assign(
          new Error('Singularity backend requires terminal.singularity_image in config'),
          { code: 'backend_error' },
        )
      }
      provider = new SingularityFileProvider(cfg.singularity_image, homeDir)
      break
    }
    case 'modal':
    case 'daytona':
      throw Object.assign(
        new Error(`File download not yet supported for '${cfg.backend}' backend`),
        { code: 'unsupported_backend' },
      )
    default:
      provider = new LocalFileProvider(homeDir)
  }

  providerCache.set(cacheKey, { provider, cachedAt: now })
  return provider
}

// Always-available local provider for upload directory files
const localProvider = new LocalFileProvider(config.uploadDir)
export { localProvider }
