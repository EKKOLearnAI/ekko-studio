import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const spawn = vi.hoisted(() => vi.fn())
const existsSync = vi.hoisted(() => vi.fn(() => true))
const utimesSync = vi.hoisted(() => vi.fn())
const originalProcessSend = process.send

function setProcessSend(send: typeof process.send): void {
  Object.defineProperty(process, 'send', {
    configurable: true,
    value: send,
    writable: true,
  })
}

vi.mock('child_process', () => ({ spawn }))
vi.mock('fs', () => ({ existsSync, utimesSync }))

import {
  resetWebUiRestartForTests,
  scheduleWebUiRestart,
} from '../../packages/server/src/modules/studio/public/web-ui-restart'

describe('Web UI restart routing', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.stubEnv('HERMES_DESKTOP', '')
    vi.stubEnv('NODE_ENV', 'test')
    spawn.mockReset()
    existsSync.mockReset()
    existsSync.mockReturnValue(true)
    utimesSync.mockReset()
    resetWebUiRestartForTests()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllEnvs()
    setProcessSend(originalProcessSend)
  })

  it('touches the nodemon restart trigger in development', () => {
    vi.stubEnv('NODE_ENV', 'development')

    scheduleWebUiRestart()
    vi.advanceTimersByTime(250)

    expect(utimesSync).toHaveBeenCalledWith(
      join(process.cwd(), 'packages', 'server', 'src', 'modules', 'studio', 'public', 'dev-restart-trigger.ts'),
      expect.any(Date),
      expect.any(Date),
    )
    expect(spawn).not.toHaveBeenCalled()
  })

  it('forwards Desktop restart requests to the Electron shell over IPC', () => {
    vi.stubEnv('HERMES_DESKTOP', 'true')
    const send = vi.fn(() => true)
    setProcessSend(send as unknown as typeof process.send)

    scheduleWebUiRestart()
    scheduleWebUiRestart()

    expect(send).toHaveBeenCalledTimes(1)
    expect(send).toHaveBeenCalledWith({ type: 'hermes-desktop:restart-app' })
    expect(spawn).not.toHaveBeenCalled()
  })

  it('rejects Desktop restart requests when the parent IPC channel is unavailable', () => {
    vi.stubEnv('HERMES_DESKTOP', 'true')
    setProcessSend(undefined)

    expect(() => scheduleWebUiRestart()).toThrow('Desktop restart IPC channel is unavailable')
    expect(spawn).not.toHaveBeenCalled()
  })

  it('uses the standalone CLI supervisor outside development', () => {
    const unref = vi.fn()
    spawn.mockReturnValue({ unref })
    vi.stubEnv('NODE_ENV', 'production')

    scheduleWebUiRestart()
    vi.advanceTimersByTime(250)

    expect(spawn).toHaveBeenCalledWith(
      process.execPath,
      expect.arrayContaining(['restart', '--port', '--no-open']),
      expect.objectContaining({ detached: true }),
    )
    expect(unref).toHaveBeenCalled()
  })
})
