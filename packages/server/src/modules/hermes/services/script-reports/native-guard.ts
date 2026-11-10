import { execFile } from 'child_process'
import { existsSync } from 'fs'
import { resolve } from 'path'
import { resolveAgentBridgeCommand } from '../bridge/manager'

const GUARD_SCRIPT = 'ekko_native_guard_check.py'
const GUARD_TIMEOUT_MS = 60_000

export type NativeGuardVerdict = { ok: true } | { ok: false; refused: boolean; reason: string }
/** Hermes' create-time lifecycle guard applied to `script` (relative to `<hermesHome>/scripts`). */
export type NativeLifecycleGuard = (hermesHome: string, script: string) => Promise<NativeGuardVerdict>

function guardScriptPath(): string {
  const candidates = [
    resolve(__dirname, 'assets', 'script-reports', GUARD_SCRIPT),
    resolve(__dirname, '..', '..', '..', '..', 'assets', 'script-reports', GUARD_SCRIPT),
    resolve(process.cwd(), 'packages/server/src/assets/script-reports', GUARD_SCRIPT),
  ]
  const found = candidates.find(candidate => existsSync(candidate))
  if (!found) throw new Error('native guard check script not found')
  return found
}

/**
 * Runs the installed Hermes `cron.lifecycle_guard.check_gateway_lifecycle` in a child of the Hermes
 * interpreter. The child gets a minimal environment (no inherited credentials) and writes nothing;
 * any failure to run the guard refuses, it never allows.
 */
export const defaultNativeLifecycleGuard: NativeLifecycleGuard = (hermesHome, script) => new Promise(done => {
  let command: ReturnType<typeof resolveAgentBridgeCommand>
  let guard: string
  try {
    command = resolveAgentBridgeCommand({ hermesHome })
    guard = guardScriptPath()
  } catch (error: any) {
    done({ ok: false, refused: false, reason: String(error?.message || error) })
    return
  }
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH || '/usr/bin:/bin',
    HOME: process.env.HOME || '',
    HERMES_HOME: hermesHome,
    PYTHONDONTWRITEBYTECODE: '1',
    PYTHONNOUSERSITE: '1',
    ...(command.agentRoot ? { PYTHONPATH: command.agentRoot } : {}),
  }
  execFile(command.command, [...command.argsPrefix, guard, script], {
    cwd: command.agentRoot || hermesHome, env, timeout: GUARD_TIMEOUT_MS, maxBuffer: 256 * 1024, windowsHide: true,
  }, (error, stdout, stderr) => {
    if (!error) { done({ ok: true }); return }
    const code = (error as any).code
    const reason = (String(stdout || '').trim() || String(stderr || '').trim() || error.message).slice(0, 500)
    done({ ok: false, refused: code === 3, reason })
  })
})
