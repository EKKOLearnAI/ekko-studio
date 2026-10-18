import { execFileSync, spawn } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { resolveWebUiNodeExecutable } from '../../packages/desktop/src/main/webui-node-executable'

const roots: string[] = []
function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'studio helper regression '))
  roots.push(root)
  return root
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('Web UI Node executable', () => {
  it.each([
    ['win32', 'C:\\Program Files\\Ekko Studio\\Ekko Studio.exe', true],
    ['linux', '/opt/Ekko Studio/ekko-studio', true],
    ['darwin', '/usr/local/bin/node', false],
  ] as const)('preserves the %s executable %s', (platform, executable, electron) => {
    expect(resolveWebUiNodeExecutable({ platform, executable, electron })).toBe(executable)
  })

  it.each(['Ekko Studio', 'Electron', 'Ekko Studio 测试'])('uses the generic Helper in the %s app bundle', name => {
    const contents = join(temporaryRoot(), `${name}.app`, 'Contents')
    const executable = join(contents, 'MacOS', name)
    const helper = join(contents, 'Frameworks', `${name} Helper.app`, 'Contents', 'MacOS', `${name} Helper`)
    mkdirSync(dirname(helper), { recursive: true })
    writeFileSync(helper, '', { mode: 0o755 })

    expect(resolveWebUiNodeExecutable({ platform: 'darwin', executable, electron: true })).toBe(helper)
    expect(resolveWebUiNodeExecutable({ platform: 'darwin', executable: helper, electron: true })).toBe(helper)
  })

  it('reports a missing Helper instead of falling back to the GUI executable', () => {
    const executable = join(temporaryRoot(), 'Ekko Studio.app', 'Contents', 'MacOS', 'Ekko Studio')
    expect(() => resolveWebUiNodeExecutable({ platform: 'darwin', executable, electron: true }))
      .toThrow(/macOS Web UI Helper is missing or not executable: .*Ekko Studio Helper/)
  })

  it.skipIf(process.platform === 'win32')('rejects a Helper without executable permission', () => {
    const contents = join(temporaryRoot(), 'Ekko Studio.app', 'Contents')
    const executable = join(contents, 'MacOS', 'Ekko Studio')
    const helper = join(contents, 'Frameworks', 'Ekko Studio Helper.app', 'Contents', 'MacOS', 'Ekko Studio Helper')
    mkdirSync(dirname(helper), { recursive: true })
    writeFileSync(helper, '')
    chmodSync(helper, 0o644)
    expect(() => resolveWebUiNodeExecutable({ platform: 'darwin', executable, electron: true })).toThrow('not executable')
  })
})

const electronExecutable = process.env.EKKO_TEST_ELECTRON_EXECUTABLE || resolve(
  'packages/desktop/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron',
)

it.runIf(process.platform === 'darwin' && existsSync(electronExecutable))(
  'runs the real macOS Helper with Node, IPC, SQLite and a nested Node subprocess',
  async () => {
    const executable = resolveWebUiNodeExecutable({ platform: 'darwin', executable: electronExecutable, electron: true })
    expect(execFileSync('/usr/bin/plutil', [
      '-extract', 'LSUIElement', 'raw', '-o', '-', join(dirname(dirname(executable)), 'Info.plist'),
    ], { encoding: 'utf8' }).trim()).toBe('true')
    const cwd = temporaryRoot()
    const source = `
      process.once('message', message => {
        const { DatabaseSync } = require('node:sqlite')
        const db = new DatabaseSync(':memory:')
        const row = db.prepare('SELECT 42 AS answer').get()
        db.close()
        const nested = require('node:child_process').spawnSync(process.execPath,
          ['-e', 'process.stdout.write("nested-node-ok")'], { env: process.env, encoding: 'utf8' })
        process.send({ echo: message, cwd: process.cwd(), executable: process.execPath,
          nodeMode: process.env.ELECTRON_RUN_AS_NODE, electron: process.versions.electron,
          answer: row.answer, nested: nested.stdout, nestedExit: nested.status }, () => process.disconnect())
      })
    `
    const child = spawn(executable, ['-e', source], {
      cwd,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    })
    let message: unknown
    let stderr = ''
    child.stderr!.on('data', chunk => { stderr += chunk })
    child.on('message', value => { message = value })
    const timeout = setTimeout(() => child.kill('SIGKILL'), 10_000)
    try {
      const closed = new Promise<number | null>((resolveClose, reject) => {
        child.once('error', reject)
        child.once('close', resolveClose)
      })
      child.send({ probe: 'parent-to-helper' })
      expect(await closed, stderr).toBe(0)
      expect(message).toMatchObject({
        echo: { probe: 'parent-to-helper' }, executable,
        nodeMode: '1', electron: expect.any(String), answer: 42,
        nested: 'nested-node-ok', nestedExit: 0,
      })
      // macOS may canonicalize /var to /private/var for process.cwd().
      expect((message as { cwd: string }).cwd.endsWith(cwd.replace(/^\/private/, ''))).toBe(true)
    } finally {
      clearTimeout(timeout)
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    }
  },
  15_000,
)
