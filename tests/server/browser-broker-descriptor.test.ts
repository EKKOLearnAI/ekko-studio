import { afterEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  brokerDescriptorDir,
  brokerDescriptorPath,
  readBrokerDescriptorSync,
  removeOwnedBrokerDescriptor,
  writeBrokerDescriptor,
  type BrowserBrokerDescriptorFile,
} from '../../packages/server/src/modules/studio/services/browser/broker-descriptor'

const tempDirs: string[] = []

function tempHome(): string {
  const dir = mkdtempSync(join(tmpdir(), 'broker-descriptor-'))
  tempDirs.push(dir)
  return dir
}

function descriptor(overrides: Partial<BrowserBrokerDescriptorFile> = {}): BrowserBrokerDescriptorFile {
  return {
    schema: 1,
    protocol: 'http:',
    endpoint: 'http://127.0.0.1:43210/v1',
    token: 'token-value',
    desktopPid: process.pid,
    instanceId: 'instance-1',
    createdAt: '2026-10-16T00:00:00.000Z',
    ...overrides,
  }
}

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop() as string, { recursive: true, force: true })
  }
})

describe('broker descriptor', () => {
  it('lives at <webUiHome>/desktop-browser/broker.json (the only path the MCP reads)', () => {
    const home = tempHome()

    expect(brokerDescriptorDir({ webUiHome: home })).toBe(join(home, 'desktop-browser'))
    expect(brokerDescriptorPath({ webUiHome: home }))
      .toBe(join(home, 'desktop-browser', 'broker.json'))
  })

  it('writes the descriptor with owner-only permissions', async () => {
    const home = tempHome()

    const result = await writeBrokerDescriptor(descriptor(), { webUiHome: home })

    expect(result).toBe('written')
    const path = brokerDescriptorPath({ webUiHome: home })
    expect(existsSync(path)).toBe(true)
    expect(readBrokerDescriptorSync(path)).toMatchObject({
      schema: 1,
      protocol: 'http:',
      endpoint: 'http://127.0.0.1:43210/v1',
      desktopPid: process.pid,
      instanceId: 'instance-1',
    })

    if (process.platform !== 'win32') {
      expect(statSync(path).mode & 0o777).toBe(0o600)
      expect(statSync(brokerDescriptorDir({ webUiHome: home })).mode & 0o777).toBe(0o700)
    }
  })

  it('never writes in desktop mode (Electron owns the file)', async () => {
    const home = tempHome()

    const result = await writeBrokerDescriptor(descriptor(), { webUiHome: home, desktopMode: true })

    expect(result).toBe('desktop-mode')
    expect(existsSync(brokerDescriptorPath({ webUiHome: home }))).toBe(false)
  })

  it('refuses to overwrite a live foreign descriptor and warns', async () => {
    const home = tempHome()
    const warn = vi.fn()
    const path = brokerDescriptorPath({ webUiHome: home })
    // A pid that is definitely alive and definitely not this process.
    const foreignPid = process.ppid
    if (!foreignPid || foreignPid === process.pid) return
    mkdirSync(join(home, 'desktop-browser'), { recursive: true })
    writeFileSync(path, JSON.stringify(descriptor({ desktopPid: foreignPid, instanceId: 'electron-host' })))

    const result = await writeBrokerDescriptor(descriptor(), { webUiHome: home, warn })

    expect(result).toBe('foreign-owner')
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('another host owns'))
    expect(readBrokerDescriptorSync(path)?.instanceId).toBe('electron-host')
  })

  it('replaces a stale foreign descriptor', async () => {
    const home = tempHome()
    const path = brokerDescriptorPath({ webUiHome: home })
    mkdirSync(join(home, 'desktop-browser'), { recursive: true })
    writeFileSync(path, JSON.stringify(descriptor({ desktopPid: 999_999_999, instanceId: 'dead-host' })))

    const result = await writeBrokerDescriptor(descriptor(), { webUiHome: home })

    expect(result).toBe('written')
    expect(readBrokerDescriptorSync(path)?.instanceId).toBe('instance-1')
  })

  it('removes only its own descriptor', async () => {
    const home = tempHome()
    await writeBrokerDescriptor(descriptor(), { webUiHome: home })
    const path = brokerDescriptorPath({ webUiHome: home })

    expect(await removeOwnedBrokerDescriptor('other-instance', { webUiHome: home })).toBe(false)
    expect(existsSync(path)).toBe(true)

    expect(await removeOwnedBrokerDescriptor('instance-1', { webUiHome: home })).toBe(true)
    expect(existsSync(path)).toBe(false)
  })

  it('does not delete anything in desktop mode', async () => {
    const home = tempHome()
    mkdirSync(join(home, 'desktop-browser'), { recursive: true })
    const path = brokerDescriptorPath({ webUiHome: home })
    writeFileSync(path, JSON.stringify(descriptor({ instanceId: 'instance-1' })))

    expect(await removeOwnedBrokerDescriptor('instance-1', { webUiHome: home, desktopMode: true }))
      .toBe(false)
    expect(existsSync(path)).toBe(true)
  })

  it('treats a corrupt descriptor as absent', () => {
    const home = tempHome()
    const path = brokerDescriptorPath({ webUiHome: home })
    mkdirSync(join(home, 'desktop-browser'), { recursive: true })
    writeFileSync(path, '{ not json')

    expect(readBrokerDescriptorSync(path)).toBeNull()
  })
})
