import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { pickWebUiServerHost } from '../../packages/desktop/src/main/webui-server'

function withFakeNode(binary: string, run: (path: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'hermes-webui-host-'))
  const node = join(dir, binary)

  try {
    writeFileSync(node, '#!/bin/sh\n')
    run(node)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

describe('Web UI server host selection', () => {
  it('hosts the server on a real Node binary on Linux instead of the Electron runtime', () => {
    withFakeNode('node', node => {
      expect(pickWebUiServerHost([node], '/opt/electron', 'linux')).toEqual({
        command: node,
        electronRunAsNode: false,
      })
    })
  })

  it('skips Node candidates that are not installed yet', () => {
    withFakeNode('node', node => {
      expect(pickWebUiServerHost(['/missing/node', undefined, node], '/opt/electron', 'linux')).toEqual({
        command: node,
        electronRunAsNode: false,
      })
    })
  })

  it('falls back to the Electron runtime in run-as-Node mode when no Node binary is installed', () => {
    expect(pickWebUiServerHost(['/missing/node', undefined], '/opt/electron', 'linux')).toEqual({
      command: '/opt/electron',
      electronRunAsNode: true,
    })
  })

  // The sharp/libvips clash is documented as "Electron and Linux", so macOS and
  // Windows keep the host they ship with today even when a Node binary is installed.
  it.each(['darwin', 'win32'] as const)('keeps the Electron host on %s', platform => {
    withFakeNode(platform === 'win32' ? 'node.exe' : 'node', node => {
      expect(pickWebUiServerHost([node], '/opt/electron', platform)).toEqual({
        command: '/opt/electron',
        electronRunAsNode: true,
      })
    })
  })
})
