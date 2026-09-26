import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { repairMovedHermesRuntime } from '../../packages/desktop/src/main/runtime-relocation'

const tempDirs: string[] = []

function tempDir(): string {
  const root = mkdtempSync(join(tmpdir(), 'hermes-runtime-relocation-'))
  tempDirs.push(root)
  return root
}

afterEach(() => {
  for (const root of tempDirs.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

describe('Hermes source runtime relocation', () => {
  it('repairs editable source paths and launchers created by a later update', () => {
    const previousRuntime = tempDir()
    const stagedRuntime = tempDir()
    const finalRuntime = tempDir()
    const sitePackages = join(stagedRuntime, 'python', 'venv', 'lib', 'python3.11', 'site-packages')
    const binDir = join(stagedRuntime, 'python', 'venv', 'bin')
    const distInfo = join(sitePackages, 'hermes_agent-0.20.0.dist-info')
    const previousSource = join(previousRuntime, 'python')
    const finalSource = join(finalRuntime, 'python')

    mkdirSync(distInfo, { recursive: true })
    mkdirSync(binDir, { recursive: true })
    writeFileSync(
      join(sitePackages, '__editable___hermes_agent_0_20_0_finder.py'),
      `MAPPING = {'agent': '${previousSource}/agent'}\n`,
    )
    writeFileSync(
      join(distInfo, 'direct_url.json'),
      JSON.stringify({ url: `file://${previousSource}`, dir_info: { editable: true } }),
    )
    for (const name of ['hermes', 'hermes-agent', 'hermes-acp']) {
      writeFileSync(join(binDir, name), `#!${join(previousRuntime, 'python', 'venv', 'bin', 'python3')}\n`)
    }

    const repaired = repairMovedHermesRuntime(
      stagedRuntime,
      previousRuntime,
      finalRuntime,
      'darwin',
    )

    expect(repaired).toEqual({ editableFilesRewritten: 2, launchersRewritten: 3 })
    expect(readFileSync(
      join(sitePackages, '__editable___hermes_agent_0_20_0_finder.py'),
      'utf-8',
    )).toContain(`${finalSource}/agent`)
    expect(JSON.parse(readFileSync(join(distInfo, 'direct_url.json'), 'utf-8')).url).toContain(finalSource)
    expect(readFileSync(join(binDir, 'hermes'), 'utf-8')).toContain(
      'exec "$DIR/python3" -m hermes_cli.main "$@"',
    )
    expect(readFileSync(join(binDir, 'hermes'), 'utf-8')).toContain(
      'export UV_PROJECT_ENVIRONMENT="$VIRTUAL_ENV"',
    )
    expect(readFileSync(join(binDir, 'hermes'), 'utf-8')).toContain(
      'export UV_PYTHON="$DIR/python3"',
    )
    expect(readFileSync(join(binDir, 'hermes'), 'utf-8')).toContain(
      'export UV_SYSTEM_PYTHON=1',
    )
    expect(readFileSync(join(binDir, 'hermes-agent'), 'utf-8')).toContain(
      'exec "$DIR/python3" -m run_agent "$@"',
    )
  })

  it('replaces Windows executable launchers with relocatable cmd wrappers', () => {
    const previousRuntime = tempDir()
    const stagedRuntime = tempDir()
    const finalRuntime = tempDir()
    const scriptsDir = join(stagedRuntime, 'python', 'venv', 'Scripts')
    mkdirSync(scriptsDir, { recursive: true })
    writeFileSync(join(scriptsDir, 'hermes.exe'), '')
    const previousManagedPython = join(
      previousRuntime,
      'python',
      '.hermes-runtime',
      'python',
      'generation',
    )
    const finalManagedPython = join(
      finalRuntime,
      'python',
      '.hermes-runtime',
      'python',
      'generation',
    )
    writeFileSync(
      join(stagedRuntime, 'python', 'venv', 'pyvenv.cfg'),
      `home = ${previousManagedPython}\nexecutable = ${join(previousManagedPython, 'python.exe')}\n`,
    )

    const repaired = repairMovedHermesRuntime(
      stagedRuntime,
      previousRuntime,
      finalRuntime,
      'win32',
    )

    expect(repaired.editableFilesRewritten).toBe(1)
    expect(repaired.launchersRewritten).toBe(1)
    expect(readFileSync(
      join(stagedRuntime, 'python', 'venv', 'pyvenv.cfg'),
      'utf-8',
    )).toContain(`home = ${finalManagedPython}`)
    expect(readFileSync(
      join(stagedRuntime, 'python', 'venv', 'pyvenv.cfg'),
      'utf-8',
    )).toContain(`executable = ${join(finalManagedPython, 'python.exe')}`)
    expect(existsSync(join(scriptsDir, 'hermes.exe'))).toBe(false)
    expect(readFileSync(join(scriptsDir, 'hermes.cmd'), 'utf-8')).toContain(
      '"%PY%" -m hermes_cli.main %*',
    )
    expect(readFileSync(join(scriptsDir, 'hermes.cmd'), 'utf-8')).toContain(
      'set "PY=%~dp0python.exe"',
    )
    expect(readFileSync(join(scriptsDir, 'hermes.cmd'), 'utf-8')).toContain(
      'set "UV_PROJECT_ENVIRONMENT=%VIRTUAL_ENV%"',
    )
    expect(readFileSync(join(scriptsDir, 'hermes.cmd'), 'utf-8')).toContain(
      'set "UV_PYTHON=%PY%"',
    )
    expect(readFileSync(join(scriptsDir, 'hermes.cmd'), 'utf-8')).not.toContain(
      'UV_SYSTEM_PYTHON',
    )
  })
})
