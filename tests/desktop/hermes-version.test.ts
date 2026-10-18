import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  hermesInstalledVersionScript,
  needsHermesInstallStamp,
} from '../../packages/desktop/scripts/hermes-version.mjs'

const source = { version: '0.22.2', ref: 'v0.22.2' }

describe('Hermes release identity', () => {
  it('keeps validating releases that declare their version in package metadata', () => {
    expect(needsHermesInstallStamp('0.22.2', source, false)).toBe(false)
    expect(() => needsHermesInstallStamp('0.22.1', source, true)).toThrow(/version mismatch/)
  })

  it('only stamps placeholder metadata from an exact pinned release tag with an upstream writer', () => {
    expect(needsHermesInstallStamp('0.0.0', source, true)).toBe(true)
    expect(() => needsHermesInstallStamp('0.0.0', { ...source, ref: 'main' }, true)).toThrow(/version mismatch/)
    expect(() => needsHermesInstallStamp('0.0.0', source, false)).toThrow(/version mismatch/)
  })

  it.each(['0.20.6', '0.0.0'])('reads the installed identity when metadata is %s', (metadataVersion) => {
    const root = mkdtempSync(join(tmpdir(), 'hermes-identity-'))
    try {
      const metadata = join(root, `hermes_agent-${metadataVersion}.dist-info`)
      mkdirSync(metadata)
      writeFileSync(join(metadata, 'METADATA'), `Name: hermes-agent\nVersion: ${metadataVersion}\n`)
      if (metadataVersion === '0.0.0') {
        mkdirSync(join(root, 'hermes_cli'))
        writeFileSync(join(root, 'hermes_cli', '__init__.py'), '')
        writeFileSync(join(root, 'hermes_cli', 'version_info.py'), [
          'from types import SimpleNamespace',
          'def get_version_info():',
          '    return SimpleNamespace(base_version="0.22.2")',
        ].join('\n'))
      }
      const result = execFileSync(process.platform === 'win32' ? 'python' : 'python3', [
        '-S', '-c', hermesInstalledVersionScript,
      ], { cwd: root, encoding: 'utf-8', env: { ...process.env, PYTHONPATH: root } })
      expect(result.trim()).toBe(metadataVersion === '0.0.0' ? '0.22.2' : metadataVersion)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
