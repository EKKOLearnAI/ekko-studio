import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, resolve } from 'node:path'
import { getActiveProfileDir } from '../../public/profile-config'
import { getTerminalConfig } from '../files/file-provider'

/** One bounded, non-interactive process; no shell interpolation or agent startup. */
export function runRealtimeCommand(command: string, args: string[], signal?: AbortSignal): Promise<Record<string, unknown>> {
  const profile = getActiveProfileDir()
  const configured = getTerminalConfig().cwd?.trim()
  const candidate = configured ? (isAbsolute(configured) ? configured : resolve(profile, configured)) : profile
  const cwd = existsSync(candidate) ? candidate : homedir()
  return new Promise(resolveResult => {
    execFile(command, args, { cwd, timeout: 15_000, killSignal: 'SIGKILL', maxBuffer: 64 * 1024, encoding: 'utf8', shell: false, signal }, (error, stdout, stderr) => {
      resolveResult({ ok: !error, stdout: stdout.slice(0, 3000), stderr: stderr.slice(0, 1000),
        ...(error ? { error: error.message.slice(0, 500) } : {}) })
    })
  })
}
