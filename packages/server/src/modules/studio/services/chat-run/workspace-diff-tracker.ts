import { execFileSync } from 'child_process'
import { randomUUID } from 'crypto'
import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'fs'
import { homedir, tmpdir } from 'os'
import { basename, extname, isAbsolute, join, relative, resolve, sep } from 'path'
import { logger } from '../../public/logging'
import { saveWorkspaceRunChange, type SaveWorkspaceRunChangeInput, type WorkspaceRunChangeSummary } from '../../repositories/workspace-run-changes-store'

const MAX_TRACKED_STATUS_PATHS = 20_000
const MAX_CHANGED_FILES = 80
const MAX_SNAPSHOT_BYTES = 512 * 1024
const MAX_TOTAL_SNAPSHOT_BYTES = 64 * 1024 * 1024
const MAX_PATCH_BYTES_PER_FILE = 256 * 1024
const MAX_TOTAL_PATCH_BYTES = 1024 * 1024
const MAX_SCAN_DIRS = 5_000
const MAX_SCAN_DEPTH = 16
const MAX_SCAN_MS = 1_000

const DEFAULT_IGNORED_DIRS = new Set([
  '.git',
  '.hg',
  '.svn',
  'node_modules',
  'bower_components',
  '.pnpm-store',
  '.yarn',
  'dist',
  'build',
  'out',
  'target',
  '.gradle',
  '.mvn',
  '.venv',
  'venv',
  '__pycache__',
  '.pytest_cache',
  '.mypy_cache',
  '.ruff_cache',
  '.tox',
  '.nox',
  'htmlcov',
  'site-packages',
  '.cache',
  'coverage',
  '.nyc_output',
  '.next',
  '.nuxt',
  '.turbo',
  '.parcel-cache',
  '.svelte-kit',
  '.angular',
  'vendor',
  '.bundle',
  'bin',
  'obj',
  'TestResults',
  '.build',
  'DerivedData',
  'CMakeFiles',
  '.terraform',
  '.dart_tool',
  '_build',
  'deps',
  'tmp',
  'log',
])

const DEFAULT_IGNORED_DIR_PATHS = new Set([
  '.yarn/cache',
  'vendor/bundle',
])

const DEFAULT_IGNORED_DIR_PREFIXES = [
  'cmake-build-',
]

const DEFAULT_IGNORED_DIR_SUFFIXES = [
  '.egg-info',
  '.dist-info',
  '.dSYM',
]

const DEFAULT_SKIPPED_FILE_NAMES = new Set([
  '.DS_Store',
  'Thumbs.db',
  'npm-debug.log',
  'yarn-error.log',
  'pnpm-debug.log',
  '.eslintcache',
  '.stylelintcache',
  '.coverage',
  'coverage.xml',
])

const DEFAULT_SKIPPED_FILE_EXTENSIONS = new Set([
  '.pyc',
  '.pyo',
  '.class',
  '.o',
  '.obj',
  '.a',
  '.lib',
  '.lo',
  '.la',
  '.so',
  '.dylib',
  '.dll',
  '.exe',
  '.wasm',
  '.rlib',
  '.beam',
  '.jar',
  '.war',
  '.ear',
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.ico',
  '.bmp',
  '.tiff',
  '.woff',
  '.woff2',
  '.ttf',
  '.otf',
  '.mp3',
  '.wav',
  '.flac',
  '.mp4',
  '.mov',
  '.avi',
  '.mkv',
  '.zip',
  '.tar',
  '.gz',
  '.tgz',
  '.bz2',
  '.xz',
  '.7z',
  '.rar',
  '.sqlite',
  '.db',
  '.pdf',
  '.docx',
  '.xlsx',
  '.pptx',
  '.tsbuildinfo',
  '.map',
  '.log',
  '.tmp',
  '.swp',
])

interface SnapshotFile {
  exists: boolean
  size: number | null
  mtimeMs: number | null
  binary: boolean
  content: Buffer | null
}

interface WorkspaceRunCheckpoint {
  sessionId: string
  runId: string
  changeId: string
  workspace: string
  root: string
  kind: 'git' | 'filesystem'
  startedAt: number
  files: Map<string, SnapshotFile>
  truncated: boolean
  sharedDuringRun?: boolean
}

interface WorkspacePathScan {
  paths: string[]
  truncated: boolean
}

interface SnapshotComparison {
  changed: boolean
  changeType: 'added' | 'modified' | 'deleted'
  binary: boolean
  sizeBefore: number | null
  sizeAfter: number | null
  patch: string | null
  additions: number
  deletions: number
  truncated: boolean
  patchBytes: number
}

const checkpoints = new Map<string, WorkspaceRunCheckpoint>()

function registerCheckpoint(key: string, checkpoint: WorkspaceRunCheckpoint): void {
  for (const other of checkpoints.values()) {
    if (other.sessionId !== checkpoint.sessionId
      && (isPathInside(other.root, checkpoint.root) || isPathInside(checkpoint.root, other.root))) {
      other.sharedDuringRun = true
      checkpoint.sharedDuringRun = true
    }
  }
  checkpoints.set(key, checkpoint)
}

function createRunChangeId(runId: string): string {
  return `run:${runId || 'unknown'}:${Date.now().toString(36)}:${randomUUID()}`
}

function checkpointKey(sessionId: string, runId: string): string {
  return `${sessionId}\u0000${runId || 'unknown'}`
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000)
}

function isPathInside(parent: string, candidate: string): boolean {
  const rel = relative(parent, candidate)
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}

function isBroadWorkspaceRoot(root: string): boolean {
  // Home is a valid execution directory, but never a project snapshot boundary.
  // System/private/cloud directories can block a synchronous filesystem call;
  // MAX_SCAN_MS cannot interrupt that call once it has started.
  return isPathInside(root, resolve(homedir())) || root === resolve(root, '..')
}

function runGit(cwd: string, args: string[], maxBuffer = 1024 * 1024): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    maxBuffer,
    stdio: ['ignore', 'pipe', 'ignore'],
    windowsHide: true,
  })
}

function resolveGitRoot(workspace: string): string | null {
  try {
    const root = runGit(workspace, ['rev-parse', '--show-toplevel']).trim()
    if (!root) return null
    const resolvedWorkspace = realpathSync(resolve(workspace))
    const resolvedRoot = realpathSync(resolve(root))
    return isPathInside(resolvedRoot, resolvedWorkspace) ? resolvedRoot : null
  } catch {
    return null
  }
}

function resolveFilesystemRoot(workspace: string): string | null {
  try {
    const root = realpathSync(resolve(workspace))
    return statSync(root).isDirectory() ? root : null
  } catch {
    return null
  }
}

function parseGitStatusPaths(output: string): string[] {
  const parts = output.split('\0').filter(Boolean)
  const paths = new Set<string>()
  for (let i = 0; i < parts.length; i += 1) {
    const entry = parts[i]
    if (entry.length < 4) continue
    const status = entry.slice(0, 2)
    const path = entry.slice(3)
    if (!path) continue
    if (status.includes('R') || status.includes('C')) {
      const nextPath = parts[i + 1]
      if (nextPath) {
        paths.add(path)
        paths.add(nextPath)
        i += 1
        continue
      }
    }
    paths.add(path)
  }
  return [...paths]
}

function getGitStatusPaths(gitRoot: string): { paths: string[]; truncated: boolean } {
  try {
    const output = runGit(gitRoot, ['status', '--porcelain=v1', '-z', '--untracked-files=normal'], 4 * 1024 * 1024)
    const paths = parseGitStatusPaths(output).filter(path => !shouldSkipWorkspaceFile(path))
    return {
      paths: paths.slice(0, MAX_TRACKED_STATUS_PATHS),
      truncated: paths.length > MAX_TRACKED_STATUS_PATHS,
    }
  } catch (err) {
    logger.warn({ err, gitRoot }, '[workspace-diff] failed to inspect git status')
    return { paths: [], truncated: true }
  }
}

function isBinaryBuffer(buffer: Buffer): boolean {
  const limit = Math.min(buffer.length, 8000)
  for (let i = 0; i < limit; i += 1) {
    if (buffer[i] === 0) return true
  }
  return false
}

function shouldSkipFilesystemDir(name: string, relPath: string): boolean {
  return DEFAULT_IGNORED_DIRS.has(name) ||
    DEFAULT_IGNORED_DIR_PATHS.has(relPath) ||
    DEFAULT_IGNORED_DIR_PREFIXES.some(prefix => name.startsWith(prefix)) ||
    DEFAULT_IGNORED_DIR_SUFFIXES.some(suffix => name.endsWith(suffix))
}

function shouldSkipWorkspaceFile(relPath: string): boolean {
  return DEFAULT_SKIPPED_FILE_NAMES.has(basename(relPath)) ||
    DEFAULT_SKIPPED_FILE_EXTENSIONS.has(extname(relPath).toLowerCase())
}

function scanFilesystemPaths(root: string): WorkspacePathScan {
  const startedAt = Date.now()
  const paths: string[] = []
  const queue: Array<{ absPath: string; relPath: string; depth: number }> = [{ absPath: root, relPath: '', depth: 0 }]
  let dirsScanned = 0
  let truncated = false

  while (queue.length > 0) {
    if (Date.now() - startedAt > MAX_SCAN_MS) {
      truncated = true
      break
    }
    if (dirsScanned >= MAX_SCAN_DIRS) {
      truncated = true
      break
    }

    const current = queue.shift()!
    if (current.depth > MAX_SCAN_DEPTH) {
      truncated = true
      continue
    }
    dirsScanned += 1

    let entries
    try {
      entries = readdirSync(current.absPath, { withFileTypes: true })
    } catch {
      truncated = true
      continue
    }

    entries.sort((left, right) => left.name.localeCompare(right.name))
    for (const entry of entries) {
      if (Date.now() - startedAt > MAX_SCAN_MS) {
        truncated = true
        break
      }
      if (entry.isSymbolicLink()) continue

      const childRelPath = current.relPath ? `${current.relPath}/${entry.name}` : entry.name
      const childAbsPath = join(current.absPath, entry.name)
      if (entry.isDirectory()) {
        if (shouldSkipFilesystemDir(entry.name, childRelPath)) continue
        if (current.depth + 1 > MAX_SCAN_DEPTH) {
          truncated = true
          continue
        }
        queue.push({ absPath: childAbsPath, relPath: childRelPath, depth: current.depth + 1 })
        continue
      }

      if (!entry.isFile() || shouldSkipWorkspaceFile(childRelPath)) continue
      paths.push(childRelPath)
      if (paths.length >= MAX_TRACKED_STATUS_PATHS) {
        truncated = true
        break
      }
    }

    if (truncated && (Date.now() - startedAt > MAX_SCAN_MS || paths.length >= MAX_TRACKED_STATUS_PATHS)) {
      break
    }
  }

  return { paths, truncated }
}

function snapshotPath(root: string, relPath: string, maxContentBytes = MAX_SNAPSHOT_BYTES): SnapshotFile {
  const absPath = resolve(root, relPath)
  if (!isPathInside(root, absPath) || !existsSync(absPath)) {
    return { exists: false, size: null, mtimeMs: null, binary: false, content: null }
  }
  try {
    const stat = statSync(absPath)
    if (!stat.isFile()) {
      return { exists: true, size: stat.size, mtimeMs: stat.mtimeMs, binary: false, content: null }
    }
    const contentLimit = Math.min(MAX_SNAPSHOT_BYTES, Math.max(0, maxContentBytes))
    if (contentLimit <= 0 || stat.size > contentLimit) {
      return { exists: true, size: stat.size, mtimeMs: stat.mtimeMs, binary: false, content: null }
    }
    const content = readFileSync(absPath)
    return {
      exists: true,
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      binary: isBinaryBuffer(content),
      content,
    }
  } catch {
    return { exists: false, size: null, mtimeMs: null, binary: false, content: null }
  }
}

function snapshotPaths(root: string, paths: string[], totalContentBytes = Number.POSITIVE_INFINITY): {
  files: Map<string, SnapshotFile>
  truncated: boolean
} {
  const files = new Map<string, SnapshotFile>()
  let remainingContentBytes = totalContentBytes
  let truncated = false
  for (const relPath of paths) {
    const snapshot = snapshotPath(root, relPath, remainingContentBytes)
    if (snapshot.content) {
      remainingContentBytes -= snapshot.content.length
    } else if (remainingContentBytes <= 0 && snapshot.exists) {
      truncated = true
    }
    files.set(relPath, snapshot)
  }
  return { files, truncated }
}

function snapshotGitHeadPath(gitRoot: string, relPath: string): SnapshotFile {
  try {
    execFileSync('git', ['cat-file', '-e', `HEAD:${relPath}`], {
      cwd: gitRoot,
      stdio: ['ignore', 'ignore', 'ignore'],
      windowsHide: true,
    })
  } catch {
    return { exists: false, size: null, mtimeMs: null, binary: false, content: null }
  }

  try {
    const sizeText = runGit(gitRoot, ['cat-file', '-s', `HEAD:${relPath}`]).trim()
    const size = Number.parseInt(sizeText, 10)
    if (!Number.isFinite(size) || size > MAX_SNAPSHOT_BYTES) {
      return { exists: true, size: Number.isFinite(size) ? size : null, mtimeMs: null, binary: false, content: null }
    }
    const content = execFileSync('git', ['show', `HEAD:${relPath}`], {
      cwd: gitRoot,
      encoding: 'buffer',
      maxBuffer: MAX_SNAPSHOT_BYTES + 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    }) as Buffer
    return {
      exists: true,
      size: content.length,
      mtimeMs: null,
      binary: isBinaryBuffer(content),
      content,
    }
  } catch {
    return { exists: true, size: null, mtimeMs: null, binary: false, content: null }
  }
}

function normalizePatchHeader(patch: string, relPath: string): string {
  const escapedName = relPath || basename(relPath)
  return patch
    .replace(/^diff --git .*\n/m, `diff --git a/${escapedName} b/${escapedName}\n`)
    .replace(/^--- .*/m, `--- a/${escapedName}`)
    .replace(/^\+\+\+ .*/m, `+++ b/${escapedName}`)
}

function countPatchLines(patch: string): { additions: number; deletions: number } {
  let additions = 0
  let deletions = 0
  for (const line of patch.split('\n')) {
    if (line.startsWith('+++') || line.startsWith('---')) continue
    if (line.startsWith('+')) additions += 1
    else if (line.startsWith('-')) deletions += 1
  }
  return { additions, deletions }
}

function makeNoIndexPatch(before: Buffer, after: Buffer, relPath: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'hermes-workspace-diff-'))
  const beforePath = join(dir, 'before')
  const afterPath = join(dir, 'after')
  try {
    writeFileSync(beforePath, before)
    writeFileSync(afterPath, after)
    try {
      const patch = execFileSync('git', ['diff', '--no-index', '--no-color', '--unified=3', beforePath, afterPath], {
        encoding: 'utf8',
        maxBuffer: MAX_PATCH_BYTES_PER_FILE + 64 * 1024,
        stdio: ['ignore', 'pipe', 'ignore'],
        windowsHide: true,
      })
      return normalizePatchHeader(patch, relPath)
    } catch (err: any) {
      const stdout = typeof err?.stdout === 'string' ? err.stdout : ''
      if (stdout) return normalizePatchHeader(stdout, relPath)
      return ''
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

function compareSnapshots(before: SnapshotFile | undefined, after: SnapshotFile, relPath: string, patchBudget: number): SnapshotComparison {
  const safeBefore = before || { exists: false, size: null, mtimeMs: null, binary: false, content: null }
  const contentChanged = safeBefore.content != null && after.content != null
    ? !safeBefore.content.equals(after.content)
    : safeBefore.mtimeMs !== after.mtimeMs
  const changed = safeBefore.exists !== after.exists ||
    safeBefore.size !== after.size ||
    contentChanged
  if (!changed) {
    return {
      changed: false,
      changeType: 'modified',
      binary: false,
      sizeBefore: safeBefore.size,
      sizeAfter: after.size,
      patch: null,
      additions: 0,
      deletions: 0,
      truncated: false,
      patchBytes: 0,
    }
  }

  const changeType = !safeBefore.exists && after.exists
    ? 'added'
    : safeBefore.exists && !after.exists
      ? 'deleted'
      : 'modified'
  const binary = safeBefore.binary || after.binary
  let patch: string | null = null
  let additions = 0
  let deletions = 0
  let truncated = false
  let patchBytes = 0

  const beforeContent = safeBefore.exists ? safeBefore.content : Buffer.alloc(0)
  const afterContent = after.exists ? after.content : Buffer.alloc(0)

  if (!binary && beforeContent != null && afterContent != null && patchBudget > 0) {
    const generated = makeNoIndexPatch(beforeContent, afterContent, relPath)
    const generatedBytes = Buffer.byteLength(generated, 'utf8')
    if (generatedBytes > Math.min(MAX_PATCH_BYTES_PER_FILE, patchBudget)) {
      patch = generated.slice(0, Math.min(MAX_PATCH_BYTES_PER_FILE, patchBudget))
      truncated = true
    } else {
      patch = generated
    }
    patchBytes = Buffer.byteLength(patch || '', 'utf8')
    const counts = countPatchLines(patch || '')
    additions = counts.additions
    deletions = counts.deletions
  } else {
    truncated = !binary
    if (!binary && changeType === 'added') additions = after.content ? after.content.toString('utf8').split('\n').length : 0
    if (!binary && changeType === 'deleted') deletions = safeBefore.content ? safeBefore.content.toString('utf8').split('\n').length : 0
  }

  return {
    changed: true,
    changeType,
    binary,
    sizeBefore: safeBefore.size,
    sizeAfter: after.size,
    patch,
    additions,
    deletions,
    truncated,
    patchBytes,
  }
}

function isZeroLineDiff(comparison: SnapshotComparison): boolean {
  return comparison.changed && comparison.additions === 0 && comparison.deletions === 0
}

export function startWorkspaceRunCheckpoint(args: {
  sessionId: string
  runId?: string | null
  workspace?: string | null
}): void {
  const workspace = args.workspace ? resolve(args.workspace) : ''
  const runId = args.runId || ''
  if (!workspace || !runId) return
  if (isBroadWorkspaceRoot(workspace)) return
  const key = checkpointKey(args.sessionId, runId)
  if (checkpoints.has(key)) return
  const changeId = createRunChangeId(runId)
  const gitRoot = resolveGitRoot(workspace)
  if (gitRoot) {
    if (isBroadWorkspaceRoot(gitRoot)) return
    const status = getGitStatusPaths(gitRoot)
    const files = new Map<string, SnapshotFile>()
    for (const relPath of status.paths) {
      files.set(relPath, snapshotPath(gitRoot, relPath))
    }
    registerCheckpoint(key, {
      sessionId: args.sessionId,
      runId,
      changeId,
      workspace,
      root: gitRoot,
      kind: 'git',
      startedAt: nowSeconds(),
      files,
      truncated: status.truncated,
    })
    return
  }

  const filesystemRoot = resolveFilesystemRoot(workspace)
  if (!filesystemRoot || isBroadWorkspaceRoot(filesystemRoot)) return
  const scan = scanFilesystemPaths(filesystemRoot)
  const snapshot = snapshotPaths(filesystemRoot, scan.paths, MAX_TOTAL_SNAPSHOT_BYTES)
  registerCheckpoint(key, {
    sessionId: args.sessionId,
    runId,
    changeId,
    workspace,
    root: filesystemRoot,
    kind: 'filesystem',
    startedAt: nowSeconds(),
    files: snapshot.files,
    truncated: scan.truncated || snapshot.truncated,
  })
}

export function discardWorkspaceRunCheckpoint(args: {
  sessionId: string
  runId?: string | null
}): void {
  const runId = args.runId || ''
  if (!runId) return
  const key = checkpointKey(args.sessionId, runId)
  checkpoints.delete(key)
}

export function completeWorkspaceRunCheckpointDraft(args: {
  sessionId: string
  runId?: string | null
  workspace?: string | null
  assistantMessageId?: string | null
}): SaveWorkspaceRunChangeInput | null {
  const runId = args.runId || ''
  if (!runId) return null
  const key = checkpointKey(args.sessionId, runId)
  const checkpoint = checkpoints.get(key)
  checkpoints.delete(key)
  if (!checkpoint) return null
  // A directory snapshot contains no writer identity. Even the first run to
  // finish can see another session's edits. Do not present an ambiguous shared
  // workspace diff as this session's changes (or provide its undo controls).
  if (checkpoint.sharedDuringRun) return null

  const status = checkpoint.kind === 'git'
    ? getGitStatusPaths(checkpoint.root)
    : scanFilesystemPaths(checkpoint.root)
  const relPaths = new Set<string>([...checkpoint.files.keys(), ...status.paths])
  const files = []
  let totalPatchBytes = 0
  let totalAdditions = 0
  let totalDeletions = 0
  let truncated = checkpoint.truncated || status.truncated
  let remainingSnapshotBytes = checkpoint.kind === 'filesystem' ? MAX_TOTAL_SNAPSHOT_BYTES : Number.POSITIVE_INFINITY

  for (const relPath of relPaths) {
    const after = snapshotPath(checkpoint.root, relPath, remainingSnapshotBytes)
    if (after.content) {
      remainingSnapshotBytes -= after.content.length
    } else if (remainingSnapshotBytes <= 0 && after.exists) {
      truncated = true
    }
    const before = checkpoint.files.get(relPath) ?? (
      checkpoint.kind === 'git'
        ? snapshotGitHeadPath(checkpoint.root, relPath)
        : undefined
    )
    const comparison = compareSnapshots(
      before,
      after,
      relPath,
      Math.max(0, MAX_TOTAL_PATCH_BYTES - totalPatchBytes),
    )
    if (!comparison.changed) continue
    if (isZeroLineDiff(comparison)) continue
    if (files.length >= MAX_CHANGED_FILES) {
      truncated = true
      break
    }
    totalPatchBytes += comparison.patchBytes
    totalAdditions += comparison.additions
    totalDeletions += comparison.deletions
    truncated = truncated || comparison.truncated || totalPatchBytes >= MAX_TOTAL_PATCH_BYTES
    files.push({
      path: relPath,
      change_type: comparison.changeType,
      additions: comparison.additions,
      deletions: comparison.deletions,
      size_before: comparison.sizeBefore,
      size_after: comparison.sizeAfter,
      patch: comparison.patch,
      patch_bytes: comparison.patchBytes,
      truncated: comparison.truncated,
      binary: comparison.binary,
    })
  }

  if (files.length === 0) return null
  return {
    change_id: checkpoint.changeId,
    session_id: checkpoint.sessionId,
    run_id: runId || checkpoint.runId,
    assistant_message_id: args.assistantMessageId || '',
    source: 'run',
    workspace: args.workspace || checkpoint.workspace,
    workspace_kind: checkpoint.kind,
    started_at: checkpoint.startedAt,
    finished_at: nowSeconds(),
    files_changed: files.length,
    additions: totalAdditions,
    deletions: totalDeletions,
    truncated,
    total_patch_bytes: totalPatchBytes,
    files,
  }
}

export function completeWorkspaceRunCheckpoint(args: {
  sessionId: string
  runId?: string | null
  workspace?: string | null
  assistantMessageId?: string | null
}): WorkspaceRunChangeSummary | null {
  const draft = completeWorkspaceRunCheckpointDraft(args)
  return draft ? saveWorkspaceRunChange(draft) : null
}
