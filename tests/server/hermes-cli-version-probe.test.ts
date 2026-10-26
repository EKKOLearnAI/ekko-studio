import { execFileSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { discoverHermesCliInstallations, probeHermesCliVersion } from '../../packages/server/src/modules/hermes/services/runtime/discovery'

const temporaryDirectories: string[] = []

function fixture(versionInfo?: string, legacyVersion = '0.0.0') {
  const root = mkdtempSync(join(tmpdir(), 'hermes-cli-version-'))
  temporaryDirectories.push(root)
  const python = execFileSync('python3', ['-c', 'import sys; print(sys.executable)'], { encoding: 'utf8' }).trim()
  const bin = join(root, 'bin')
  const modules = join(root, 'modules')
  const cli = join(bin, 'hermes')
  mkdirSync(bin)
  mkdirSync(join(modules, 'hermes_cli'), { recursive: true })
  writeFileSync(cli, `#!${python}\n`)
  chmodSync(cli, 0o755)
  writeFileSync(join(modules, 'hermes_cli', '__init__.py'), `__version__ = ${JSON.stringify(legacyVersion)}\n`)
  writeFileSync(join(modules, 'hermes_cli', 'main.py'), '')
  if (versionInfo !== undefined) writeFileSync(join(modules, 'hermes_cli', 'version_info.py'), versionInfo)
  const env = {
    HOME: root,
    HERMES_HOME: join(root, 'home'),
    HERMES_BIN: cli,
    PATH: [bin, '/usr/bin', '/bin'].join(delimiter),
    PYTHONPATH: modules,
    PYTHONNOUSERSITE: '1',
  }
  return { root, cli, env }
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe.skipIf(process.platform === 'win32')('Hermes CLI version probe with real Python', () => {
  it.each(['0.22.2', '0.22.2+1', 'git.abcdef0'])('uses canonical display version %s instead of the compatibility placeholder', async version => {
    const { cli, env } = fixture(`from types import SimpleNamespace\ndef get_version_info():\n    return SimpleNamespace(display_version=${JSON.stringify(version)})\n`)
    expect(await probeHermesCliVersion(cli, env)).toEqual({ version, error: '' })
  })

  it('retains the legacy version when version_info is absent', async () => {
    const { cli, env } = fixture(undefined, '0.21.0')
    expect(await probeHermesCliVersion(cli, env)).toEqual({ version: '0.21.0', error: '' })
  })

  it.each(['unknown', '0.0.0', ''])('does not expose unavailable identity %j as a real version', async version => {
    const { cli, env } = fixture(`from types import SimpleNamespace\ndef get_version_info():\n    return SimpleNamespace(display_version=${JSON.stringify(version)})\n`)
    expect(await probeHermesCliVersion(cli, env)).toEqual({ version: '', error: expect.any(String) })
  })

  it.each([
    'def get_version_info():\n    raise RuntimeError("synthetic version failure")\n',
    'import missing_synthetic_version_dependency\n',
  ])('does not hide canonical API failures behind the legacy version', async versionInfo => {
    const { cli, env } = fixture(versionInfo, '0.21.0')
    const result = await probeHermesCliVersion(cli, env)
    expect(result.version).toBe('')
    expect(result.error).toContain('Hermes CLI import probe failed')
  })

  it('preserves managed runtime classification while discovering canonical versions', async () => {
    const { root, cli, env } = fixture('from types import SimpleNamespace\ndef get_version_info():\n    return SimpleNamespace(display_version="0.22.2")\n')
    expect(await discoverHermesCliInstallations([{ directory: root, version: '0.22.2' }], env)).toEqual([
      { path: cli, version: '0.22.2', source: 'managed-runtime', selected: true, managedRuntimeVersion: '0.22.2' },
    ])
  })
})
