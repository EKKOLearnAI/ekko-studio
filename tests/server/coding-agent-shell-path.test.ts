import { afterAll, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  SHELL_PATH_MARKER_END,
  SHELL_PATH_MARKER_START,
  createLoginShellPathResolver,
  extractMarkedPath,
  probeShellPath,
  scanNodeVersionBins,
  stripAnsiCodes,
  type ShellPathExec,
} from '../../packages/server/src/modules/coding-agents/services/shell-path'

function marked(path: string): string {
  return `rc noise before\n\x1b[32mwelcome!\x1b[0m\n${SHELL_PATH_MARKER_START}${path}${SHELL_PATH_MARKER_END}\n`
}

describe('stripAnsiCodes', () => {
  it('removes color escapes and OSC sequences', () => {
    expect(stripAnsiCodes('\x1b[32mok\x1b[0m')).toBe('ok')
    expect(stripAnsiCodes('\x1b]0;title\x07plain')).toBe('plain')
    expect(stripAnsiCodes('/usr/bin:/bin')).toBe('/usr/bin:/bin')
  })
})

describe('extractMarkedPath', () => {
  it('extracts the value between markers', () => {
    expect(extractMarkedPath(marked('/a:/b'))).toBe('/a:/b')
  })

  it('prefers the last occurrence when markers repeat', () => {
    const output = `${SHELL_PATH_MARKER_START}/stale${SHELL_PATH_MARKER_END}${marked('/real')}`
    expect(extractMarkedPath(output)).toBe('/real')
  })

  it('returns null for missing or unordered markers', () => {
    expect(extractMarkedPath('/usr/bin:/bin')).toBeNull()
    expect(extractMarkedPath(`${SHELL_PATH_MARKER_END}${SHELL_PATH_MARKER_START}`)).toBeNull()
    expect(extractMarkedPath(`${SHELL_PATH_MARKER_START}${SHELL_PATH_MARKER_END}`)).toBeNull()
  })
})

describe('probeShellPath', () => {
  it('uses interactive flags and marker-protected output', async () => {
    const exec = vi.fn(async (_cmd: string, args: string[]) => ({
      stdout: args.includes('-ilc') ? marked('/interactive/bin:/usr/bin') : marked('/login/bin:/usr/bin'),
    })) as unknown as ShellPathExec
    await expect(probeShellPath({ execFileAsync: exec, shell: '/bin/zsh', interactive: true })).resolves.toBe('/interactive/bin:/usr/bin')
    expect(exec).toHaveBeenCalledWith('/bin/zsh', ['-ilc', expect.any(String)], expect.objectContaining({
      encoding: 'utf-8',
      timeout: 8000,
      windowsHide: true,
    }))
  })

  it('rejects polluted extractions that do not look like a PATH list', async () => {
    const exec = vi.fn(async () => ({
      stdout: `${SHELL_PATH_MARKER_START}echo hello world${SHELL_PATH_MARKER_END}`,
    })) as unknown as ShellPathExec
    await expect(probeShellPath({ execFileAsync: exec, shell: '/bin/zsh', interactive: true })).resolves.toBeNull()
  })

  it('returns null when the probe fails', async () => {
    const exec = vi.fn(async () => { throw new Error('timed out') }) as unknown as ShellPathExec
    await expect(probeShellPath({ execFileAsync: exec, shell: '/bin/zsh', interactive: false })).resolves.toBeNull()
  })
})

describe('createLoginShellPathResolver', () => {
  function resolverWith(exec: ShellPathExec, options: { isDesktop?: boolean; platform?: NodeJS.Platform } = {}) {
    return createLoginShellPathResolver({
      execFileAsync: exec,
      getLoginShell: () => '/bin/zsh',
      isDesktop: options.isDesktop ?? true,
      platform: options.platform ?? 'darwin',
    })
  }

  it('resolves null without probing outside desktop mode or on windows', async () => {
    const exec = vi.fn() as unknown as ShellPathExec
    await expect(resolverWith(exec, { isDesktop: false }).getPath()).resolves.toBeNull()
    await expect(resolverWith(exec, { platform: 'win32' }).getPath()).resolves.toBeNull()
    expect(exec).not.toHaveBeenCalled()
  })

  it('falls back to the login shell when the interactive probe yields nothing', async () => {
    const exec = vi.fn(async (_cmd: string, args: string[]) => {
      if (args.includes('-ilc')) return { stdout: 'no markers here' }
      return { stdout: marked('/login/bin:/usr/bin') }
    }) as unknown as ShellPathExec
    await expect(resolverWith(exec).getPath()).resolves.toBe('/login/bin:/usr/bin')
    expect(exec).toHaveBeenCalledTimes(2)
  })

  it('resolves null when both probes fail', async () => {
    const exec = vi.fn(async () => { throw new Error('boom') }) as unknown as ShellPathExec
    await expect(resolverWith(exec).getPath()).resolves.toBeNull()
  })

  it('memoizes the probe across concurrent and sequential callers', async () => {
    let pending = 0
    let maxConcurrent = 0
    const exec = vi.fn(async () => {
      pending += 1
      maxConcurrent = Math.max(maxConcurrent, pending)
      await Promise.resolve()
      pending -= 1
      return { stdout: marked('/one/bin:/usr/bin') }
    }) as unknown as ShellPathExec
    const resolver = resolverWith(exec)
    const [first, second, third] = await Promise.all([resolver.getPath(), resolver.getPath(), resolver.getPath()])
    expect(first).toBe('/one/bin:/usr/bin')
    expect(second).toBe(first)
    expect(third).toBe(first)
    expect(exec).toHaveBeenCalledTimes(1)
    expect(maxConcurrent).toBe(1)
    await expect(resolver.getPath()).resolves.toBe(first)
    expect(exec).toHaveBeenCalledTimes(1)
  })
})

describe('scanNodeVersionBins (nvm/fnm layouts)', () => {
  const root = mkdtempSync(join(tmpdir(), 'ekko-node-bins-'))

  afterAll(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('lists nvm-style <v>/bin dirs newest first', () => {
    const versionsDir = join(root, 'nvm', 'versions', 'node')
    mkdirSync(join(versionsDir, 'v20.1.0', 'bin'), { recursive: true })
    mkdirSync(join(versionsDir, 'v24.2.0', 'bin'), { recursive: true })
    mkdirSync(join(versionsDir, 'v19.9.3', 'bin'), { recursive: true })
    mkdirSync(join(versionsDir, 'v22.0.0', 'not-a-bin'), { recursive: true }) // wrong layout: filtered out

    expect(scanNodeVersionBins(versionsDir, versionDir => join(versionDir, 'bin'))).toEqual([
      join(versionsDir, 'v24.2.0', 'bin'),
      join(versionsDir, 'v20.1.0', 'bin'),
      join(versionsDir, 'v19.9.3', 'bin'),
    ])
  })

  it('lists fnm-style <v>/installation/bin dirs', () => {
    const versionsDir = join(root, 'fnm', 'node-versions')
    mkdirSync(join(versionsDir, 'v24.18.0', 'installation', 'bin'), { recursive: true })
    mkdirSync(join(versionsDir, 'v23.0.0', 'installation', 'bin'), { recursive: true })

    expect(scanNodeVersionBins(versionsDir, versionDir => join(versionDir, 'installation', 'bin'))).toEqual([
      join(versionsDir, 'v24.18.0', 'installation', 'bin'),
      join(versionsDir, 'v23.0.0', 'installation', 'bin'),
    ])
  })

  it('returns empty for missing directories and ignores non-directory entries', () => {
    expect(scanNodeVersionBins(join(root, 'does-not-exist'), versionDir => versionDir)).toEqual([])
    const onlyFiles = join(root, 'only-files')
    mkdirSync(onlyFiles, { recursive: true })
    writeFileSync(join(onlyFiles, 'stray-file'), 'x')
    expect(scanNodeVersionBins(onlyFiles, versionDir => versionDir)).toEqual([])
  })
})
