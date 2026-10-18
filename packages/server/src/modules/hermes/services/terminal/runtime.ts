import { accessSync, chmodSync, constants as fsConstants, existsSync } from 'fs'
import { dirname, join, isAbsolute, resolve as resolvePath } from 'path'
import { homedir } from 'os'
import { getActiveProfileDir } from '../profiles/profile'
import { getTerminalConfig, type TerminalConfig } from '../../../studio/public/workspace-files'
import { logger } from '../../../studio/public/logging'

export let pty: any = null

export function canOpenTerminal(user: { role?: string } | null | undefined): boolean {
  return user?.role === 'super_admin'
}

function ensureNodePtySpawnHelperExecutable() {
  if (process.platform !== 'darwin') return

  try {
    const nodePtyRoot = dirname(require.resolve('node-pty/package.json'))
    const helperCandidates = [
      join(nodePtyRoot, 'build', 'Release', 'spawn-helper'),
      join(nodePtyRoot, 'build', 'Debug', 'spawn-helper'),
      join(nodePtyRoot, 'prebuilds', `${process.platform}-${process.arch}`, 'spawn-helper'),
    ]

    for (const helperPath of helperCandidates) {
      if (!existsSync(helperPath)) continue
      try {
        accessSync(helperPath, fsConstants.X_OK)
      } catch {
        chmodSync(helperPath, 0o755)
        logger.debug('Restored execute bit for node-pty helper: %s', helperPath)
      }
    }
  } catch (err: any) {
    logger.warn(err, 'Could not normalize node-pty helper permissions')
  }
}

try {
  ensureNodePtySpawnHelperExecutable()
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  pty = require('node-pty')
} catch (err: any) {
  logger.warn(err, 'node-pty failed to load, terminal feature disabled')
}

// ─── Shell detection ────────────────────────────────────────────

export function findShell(): string {
  // Windows 平台：使用 PowerShell
  if (process.platform === 'win32') {
    return 'powershell.exe'
  }

  // Unix 平台：使用 SHELL 环境变量，或回退到常用 shells
  const candidates = [
    process.env.SHELL,
    '/bin/zsh',
    '/bin/bash',
  ].filter(Boolean) as string[]

  for (const shell of candidates) {
    if (existsSync(shell)) return shell
  }
  return '/bin/bash'
}

export function resolveTerminalCwd(
  cfg: Pick<TerminalConfig, 'cwd'> = getTerminalConfig(),
  profileDir = getActiveProfileDir(),
): string {
  const configured = cfg.cwd?.trim()
  const fallback = existsSync(profileDir) ? profileDir : homedir()
  if (!configured) return fallback

  const cwd = isAbsolute(configured) ? configured : resolvePath(profileDir, configured)
  if (!existsSync(cwd)) {
    logger.warn({ cwd }, 'Configured terminal cwd does not exist; falling back to Hermes profile directory')
    return fallback
  }
  return cwd
}
