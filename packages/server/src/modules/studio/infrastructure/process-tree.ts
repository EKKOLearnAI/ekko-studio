import { execFileSync } from 'child_process'

type TaskkillProcessTree = (pid: number) => void

function taskkillProcessTree(pid: number): void {
  execFileSync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], {
    timeout: 5000,
    windowsHide: true,
    stdio: 'ignore',
  })
}

/**
 * Kill a process owned by Studio.
 *
 * Node's child.kill() only terminates the immediate process on Windows. CLI
 * shims, Python workers, MCP servers, and PTY shells commonly survive it, so
 * Windows must use taskkill /T /F and wait for the tree operation to finish.
 * Other platforms retain the caller's existing signal behavior.
 */
export function killOwnedProcessTree(
  pid: number | null | undefined,
  fallback: () => void,
  options: {
    platform?: NodeJS.Platform
    taskkill?: TaskkillProcessTree
  } = {},
): void {
  const platform = options.platform ?? process.platform
  if (platform === 'win32' && Number.isInteger(pid) && Number(pid) > 0) {
    try {
      const taskkill = options.taskkill ?? taskkillProcessTree
      taskkill(Number(pid))
      return
    } catch {
      // The process may have already exited, or taskkill may be unavailable.
      // Fall back to the native child/PTY kill operation in either case.
    }
  }

  fallback()
}
