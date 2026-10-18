import { mkdtempSync, mkdirSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { canOpenTerminal, resolveTerminalCwd } from '../../packages/server/src/modules/hermes/services/terminal/runtime'

const tmpRoots: string[] = []

function makeTmpRoot() {
  const root = mkdtempSync(join(tmpdir(), 'wui-terminal-cwd-'))
  tmpRoots.push(root)
  return root
}

afterEach(() => {
  for (const root of tmpRoots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('terminal cwd resolution', () => {
  it('defaults terminal sessions to the active Hermes profile directory', () => {
    const profileDir = makeTmpRoot()
    expect(resolveTerminalCwd({}, profileDir)).toBe(profileDir)
  })

  it('resolves relative configured cwd from the Hermes profile directory', () => {
    const profileDir = makeTmpRoot()
    mkdirSync(join(profileDir, 'workspace'))
    expect(resolveTerminalCwd({ cwd: 'workspace' }, profileDir)).toBe(join(profileDir, 'workspace'))
  })

  it('uses absolute configured cwd when it exists', () => {
    const profileDir = makeTmpRoot()
    const cwd = makeTmpRoot()
    expect(resolveTerminalCwd({ cwd }, profileDir)).toBe(cwd)
  })

  it('falls back to the profile directory when configured cwd is missing', () => {
    const profileDir = makeTmpRoot()
    expect(resolveTerminalCwd({ cwd: 'missing' }, profileDir)).toBe(profileDir)
  })
})

describe('terminal authorization', () => {
  it('only allows super administrators to open terminal websocket sessions', () => {
    expect(canOpenTerminal({ role: 'super_admin' })).toBe(true)
    expect(canOpenTerminal({ role: 'admin' })).toBe(false)
    expect(canOpenTerminal(null)).toBe(false)
  })
})
