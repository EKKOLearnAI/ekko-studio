import { execFile } from 'child_process'
import { readFile, readdir, realpath, stat } from 'fs/promises'
import { dirname, relative, resolve, sep } from 'path'
import { promisify } from 'util'

const execFileAsync = promisify(execFile)
const MAX_GIT_STATUS_BUFFER = 4 * 1024 * 1024
const GIT_STATUS_TIMEOUT_MS = 5_000
const MAX_FILE_DIFF_BUFFER = 2 * 1024 * 1024
const MAX_REPOSITORY_SCAN_DEPTH = 4
const MAX_REPOSITORY_SCAN_DIRS = 500
const REPOSITORY_SCAN_SKIP_DIRS = new Set([
  'node_modules',
  'dist',
  'build',
  'out',
  'target',
  'vendor',
  '.cache',
  '.venv',
  'venv',
])

export type WorkspaceGitStatus = 'modified' | 'added' | 'untracked' | 'deleted' | 'renamed' | 'conflicted'

export interface WorkspaceGitDecoration {
  gitStatus: WorkspaceGitStatus
  gitStatusCount: number
}

export interface WorkspaceFileEntry {
  path: string
  isDir: boolean
}

export interface WorkspaceFileGitDiff {
  path: string
  gitStatus?: WorkspaceGitStatus
  patch: string
  additions: number
  deletions: number
  binary: boolean
  truncated: boolean
}

interface ParsedGitStatus {
  path: string
  status: WorkspaceGitStatus
}

const STATUS_PRIORITY: Record<WorkspaceGitStatus, number> = {
  conflicted: 6,
  modified: 5,
  renamed: 4,
  deleted: 3,
  added: 2,
  untracked: 1,
}

function normalizeGitPath(value: string): string {
  return value.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/$/, '')
}

function isPathInside(parent: string, candidate: string): boolean {
  const rel = relative(parent, candidate)
  return rel === '' || (!!rel && !rel.startsWith('..') && rel !== '..' && !rel.split(sep).includes('..'))
}

function statusFromCode(code: string): WorkspaceGitStatus | null {
  if (code === '??') return 'untracked'
  const index = code[0] || ' '
  const worktree = code[1] || ' '
  if (index === 'U' || worktree === 'U' || ['DD', 'AU', 'UD', 'UA', 'DU', 'AA'].includes(code)) return 'conflicted'
  if (index === 'R' || worktree === 'R') return 'renamed'
  if (index === 'A' || worktree === 'A' || index === 'C' || worktree === 'C') return 'added'
  if (index === 'D' || worktree === 'D') return 'deleted'
  if (index === 'M' || worktree === 'M' || index === 'T' || worktree === 'T') return 'modified'
  return null
}

export function parseWorkspaceGitStatus(output: string): ParsedGitStatus[] {
  const fields = output.split('\0')
  const parsed: ParsedGitStatus[] = []

  for (let index = 0; index < fields.length; index += 1) {
    const field = fields[index]
    if (!field || field.length < 4) continue
    const code = field.slice(0, 2)
    const status = statusFromCode(code)
    const path = normalizeGitPath(field.slice(3))
    if (!status || !path) continue

    parsed.push({ path, status })
    if (code.includes('R') || code.includes('C')) {
      const originalPath = normalizeGitPath(fields[index + 1] || '')
      if (originalPath) parsed.push({ path: originalPath, status: 'deleted' })
      index += 1
    }
  }

  return parsed
}

function strongestDecoration(statuses: ParsedGitStatus[]): WorkspaceGitDecoration | undefined {
  if (!statuses.length) return undefined
  let status = statuses[0].status
  for (const item of statuses.slice(1)) {
    if (STATUS_PRIORITY[item.status] > STATUS_PRIORITY[status]) status = item.status
  }
  return { gitStatus: status, gitStatusCount: statuses.length }
}

function relativeStatuses(statuses: ParsedGitStatus[], workspacePrefix: string): ParsedGitStatus[] {
  if (!workspacePrefix) return statuses
  const prefix = `${workspacePrefix}/`
  return statuses.flatMap(item => {
    if (item.path === workspacePrefix) return [{ ...item, path: '' }]
    if (!item.path.startsWith(prefix)) return []
    return [{ ...item, path: item.path.slice(prefix.length) }]
  })
}

async function resolveContainingGitRoot(directory: string): Promise<string | null> {
  try {
    const { stdout: rootOutput } = await execFileAsync('git', ['rev-parse', '--show-toplevel'], {
      cwd: directory,
      encoding: 'utf8',
      timeout: GIT_STATUS_TIMEOUT_MS,
      windowsHide: true,
    })
    return await realpath(resolve(String(rootOutput).trim()))
  } catch {
    return null
  }
}

async function discoverNestedGitRoots(workspace: string): Promise<string[]> {
  const roots = new Set<string>()
  const queue: Array<{ directory: string; depth: number }> = [{ directory: workspace, depth: 0 }]
  let scannedDirectories = 0

  while (queue.length && scannedDirectories < MAX_REPOSITORY_SCAN_DIRS) {
    const current = queue.shift()!
    scannedDirectories += 1
    let entries
    try {
      entries = await readdir(current.directory, { withFileTypes: true })
    } catch {
      continue
    }

    if (entries.some(entry => entry.name === '.git')) roots.add(current.directory)
    if (current.depth >= MAX_REPOSITORY_SCAN_DEPTH) continue

    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue
      if (entry.name === '.git' || entry.name.startsWith('.') || REPOSITORY_SCAN_SKIP_DIRS.has(entry.name)) continue
      queue.push({ directory: resolve(current.directory, entry.name), depth: current.depth + 1 })
      if (queue.length + scannedDirectories >= MAX_REPOSITORY_SCAN_DIRS) break
    }
  }

  return [...roots]
}

async function discoverWorkspaceGitRoots(workspace: string): Promise<string[]> {
  const roots = new Set<string>()
  const containingRoot = await resolveContainingGitRoot(workspace)
  if (containingRoot && isPathInside(containingRoot, workspace)) roots.add(containingRoot)
  for (const nestedRoot of await discoverNestedGitRoots(workspace)) {
    try {
      const resolvedRoot = await realpath(nestedRoot)
      if (isPathInside(workspace, resolvedRoot)) roots.add(resolvedRoot)
    } catch {
      // Ignore repositories that disappear while the workspace is being read.
    }
  }
  return [...roots]
}

async function readGitRootStatuses(gitRoot: string, workspace: string): Promise<ParsedGitStatus[]> {
  try {
    const workspaceInsideRoot = isPathInside(gitRoot, workspace)
    const rootInsideWorkspace = isPathInside(workspace, gitRoot)
    if (!workspaceInsideRoot && !rootInsideWorkspace) return []

    const workspacePrefix = workspaceInsideRoot ? normalizeGitPath(relative(gitRoot, workspace)) : ''
    const repositoryPrefix = rootInsideWorkspace ? normalizeGitPath(relative(workspace, gitRoot)) : ''
    const pathspec = workspacePrefix || '.'
    const { stdout } = await execFileAsync(
      'git',
      ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--', pathspec],
      {
        cwd: gitRoot,
        encoding: 'utf8',
        maxBuffer: MAX_GIT_STATUS_BUFFER,
        timeout: GIT_STATUS_TIMEOUT_MS,
        windowsHide: true,
      },
    )
    const parsed = relativeStatuses(parseWorkspaceGitStatus(String(stdout)), workspacePrefix)
    if (!repositoryPrefix) return parsed
    return parsed.map(item => ({
      ...item,
      path: item.path ? `${repositoryPrefix}/${item.path}` : repositoryPrefix,
    }))
  } catch {
    return []
  }
}

async function readWorkspaceGitStatuses(workspace: string): Promise<ParsedGitStatus[]> {
  try {
    const resolvedWorkspace = await realpath(resolve(workspace))
    const roots = await discoverWorkspaceGitRoots(resolvedWorkspace)
    const statuses = (await Promise.all(
      roots.map(root => readGitRootStatuses(root, resolvedWorkspace)),
    )).flat()
    const seen = new Set<string>()
    return statuses.filter(item => {
      const key = `${item.status}\0${item.path}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
  } catch {
    return []
  }
}

function patchStats(patch: string): { additions: number; deletions: number } {
  let additions = 0
  let deletions = 0
  for (const line of patch.split('\n')) {
    if (line.startsWith('+') && !line.startsWith('+++')) additions += 1
    else if (line.startsWith('-') && !line.startsWith('---')) deletions += 1
  }
  return { additions, deletions }
}

function untrackedFilePatch(path: string, content: string): string {
  const normalizedPath = normalizeGitPath(path)
  const lines = content.split('\n')
  if (lines.at(-1) === '') lines.pop()
  const body = lines.map(line => `+${line}`).join('\n')
  return [
    `diff --git a/${normalizedPath} b/${normalizedPath}`,
    'new file mode 100644',
    '--- /dev/null',
    `+++ b/${normalizedPath}`,
    `@@ -0,0 +1,${lines.length} @@`,
    body,
    '',
  ].join('\n')
}

export async function getWorkspaceFileGitDiff(
  workspace: string,
  relativePath: string,
): Promise<WorkspaceFileGitDiff> {
  const normalizedPath = normalizeGitPath(relativePath)
  const emptyResult: WorkspaceFileGitDiff = {
    path: normalizedPath,
    patch: '',
    additions: 0,
    deletions: 0,
    binary: false,
    truncated: false,
  }

  try {
    const resolvedWorkspace = await realpath(resolve(workspace))
    const resolvedFile = await realpath(resolve(resolvedWorkspace, normalizedPath))
    if (!isPathInside(resolvedWorkspace, resolvedFile)) return emptyResult
    const fileStat = await stat(resolvedFile)
    if (!fileStat.isFile()) return emptyResult

    const gitRoot = await resolveContainingGitRoot(dirname(resolvedFile))
    if (!gitRoot || (!isPathInside(gitRoot, resolvedWorkspace) && !isPathInside(resolvedWorkspace, gitRoot))) {
      return emptyResult
    }
    const repositoryPath = normalizeGitPath(relative(gitRoot, resolvedFile))
    const { stdout: statusOutput } = await execFileAsync(
      'git',
      ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--', repositoryPath],
      {
        cwd: gitRoot,
        encoding: 'utf8',
        maxBuffer: MAX_GIT_STATUS_BUFFER,
        timeout: GIT_STATUS_TIMEOUT_MS,
        windowsHide: true,
      },
    )
    const fileStatus = parseWorkspaceGitStatus(String(statusOutput))
      .find(item => item.path === repositoryPath)?.status
    if (!fileStatus) return emptyResult

    let patch = ''
    if (fileStatus !== 'untracked') {
      try {
        const result = await execFileAsync(
          'git',
          ['diff', '--no-ext-diff', '--no-color', '--find-renames', '--unified=3', 'HEAD', '--', repositoryPath],
          {
            cwd: gitRoot,
            encoding: 'utf8',
            maxBuffer: MAX_FILE_DIFF_BUFFER,
            timeout: GIT_STATUS_TIMEOUT_MS,
            windowsHide: true,
          },
        )
        patch = String(result.stdout)
      } catch {
        patch = ''
      }
    }

    if (!patch && (fileStatus === 'untracked' || fileStatus === 'added')) {
      if (fileStat.size > MAX_FILE_DIFF_BUFFER) {
        return { ...emptyResult, gitStatus: fileStatus, binary: true, truncated: true }
      }
      const content = await readFile(resolvedFile)
      if (content.subarray(0, Math.min(content.length, 8_000)).includes(0)) {
        return { ...emptyResult, gitStatus: fileStatus, binary: true }
      }
      patch = untrackedFilePatch(repositoryPath, content.toString('utf8'))
    }

    const binary = /(?:GIT binary patch|Binary files .* differ)/.test(patch)
    const counts = binary ? { additions: 0, deletions: 0 } : patchStats(patch)
    return {
      path: normalizedPath,
      gitStatus: fileStatus,
      patch,
      ...counts,
      binary,
      truncated: false,
    }
  } catch (error: any) {
    if (error?.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
      return { ...emptyResult, truncated: true }
    }
    return emptyResult
  }
}

function statusesWithin(statuses: ParsedGitStatus[], path: string, isDir: boolean): ParsedGitStatus[] {
  const normalizedPath = normalizeGitPath(path)
  if (!normalizedPath) return statuses
  if (!isDir) return statuses.filter(item => item.path === normalizedPath)
  const prefix = `${normalizedPath}/`
  return statuses.filter(item => item.path === normalizedPath || item.path.startsWith(prefix))
}

export async function decorateWorkspaceEntries<T extends WorkspaceFileEntry>(
  workspace: string,
  currentPath: string,
  entries: T[],
): Promise<{ entries: Array<T & Partial<WorkspaceGitDecoration>>; directoryDecoration?: WorkspaceGitDecoration }> {
  const statuses = await readWorkspaceGitStatuses(workspace)
  const decoratedEntries = entries.map(entry => ({
    ...entry,
    ...strongestDecoration(statusesWithin(statuses, entry.path, entry.isDir)),
  }))
  return {
    entries: decoratedEntries,
    directoryDecoration: strongestDecoration(statusesWithin(statuses, currentPath, true)),
  }
}
