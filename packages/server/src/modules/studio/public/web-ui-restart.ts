import { spawn } from 'child_process'
import { existsSync, utimesSync } from 'fs'
import { dirname, join, resolve } from 'path'
import { config } from './config'

let restartScheduled = false
const DESKTOP_RESTART_REQUEST = 'hermes-desktop:restart-app'

function isDesktopRuntime(): boolean {
  return String(process.env.HERMES_DESKTOP || '').trim().toLowerCase() === 'true'
}

function webUiCliPath(): string {
  const candidates = [
    process.env.HERMES_WEB_UI_CLI_BIN?.trim(),
    join(process.cwd(), 'bin', 'hermes-web-ui.mjs'),
    resolve(__dirname, '..', '..', '..', '..', '..', 'bin', 'hermes-web-ui.mjs'),
  ].filter((candidate): candidate is string => Boolean(candidate))
  const cli = candidates.find(existsSync)
  if (!cli) throw new Error('Unable to locate bin/hermes-web-ui.mjs for restart')
  return cli
}

function developmentRestartTriggerPath(): string {
  const candidates = [
    join(process.cwd(), 'packages', 'server', 'src', 'modules', 'studio', 'public', 'dev-restart-trigger.ts'),
    join(__dirname, 'dev-restart-trigger.ts'),
  ]
  const trigger = candidates.find(existsSync)
  if (!trigger) throw new Error('Unable to locate the nodemon development restart trigger')
  return trigger
}

function requestDesktopAppRestart(): void {
  if (typeof process.send !== 'function' || process.connected === false) {
    throw new Error('Desktop restart IPC channel is unavailable')
  }
  restartScheduled = true
  try {
    process.send({ type: DESKTOP_RESTART_REQUEST })
  } catch (err) {
    restartScheduled = false
    throw err
  }
}

/** Schedule a host-owned restart after the API response. */
export function scheduleWebUiRestart(): void {
  if (restartScheduled) return
  if (isDesktopRuntime()) {
    requestDesktopAppRestart()
    return
  }
  if (process.env.NODE_ENV === 'development') {
    const trigger = developmentRestartTriggerPath()
    restartScheduled = true
    setTimeout(() => {
      const now = new Date()
      utimesSync(trigger, now, now)
    }, 250).unref?.()
    return
  }
  const cli = webUiCliPath()
  restartScheduled = true
  setTimeout(() => {
    const child = spawn(process.execPath, [cli, 'restart', '--port', String(config.port), '--no-open'], {
      cwd: dirname(dirname(cli)),
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      env: process.env,
    })
    child.unref()
  }, 250).unref?.()
}

export function resetWebUiRestartForTests(): void {
  restartScheduled = false
}
