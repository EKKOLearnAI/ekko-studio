import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const mocks = vi.hoisted(() => ({ exec: vi.fn(), fetch: vi.fn() }))
vi.mock('node:child_process', async original => ({ ...await original<typeof import('node:child_process')>(), execFile: mocks.exec }))
import { installPackage } from '../../packages/server/src/modules/studio/services/plugins/installer'
import { PluginManager } from '../../packages/server/src/modules/studio/services/plugins/manager'

const commit = 'a'.repeat(40), pinned = `github:example/notes#${commit}`
const definition = { id: 'notes', name: 'Notes', version: '1.2.3', apiVersion: 1, permissions: [], server: 'server.mjs' }
const directories: string[] = [], managers: PluginManager[] = []
async function home() {
  const directory = await mkdtemp(join(tmpdir(), 'plugin-github-install-')); directories.push(directory)
  return directory
}
async function npmPackage(stage: string, options: { manifest?: boolean; version?: string; entry?: string } = {}) {
  const directory = join(stage, 'node_modules', 'notes'); await mkdir(directory, { recursive: true })
  await writeFile(join(stage, 'package.json'), JSON.stringify({ dependencies: { notes: pinned } }))
  await writeFile(join(directory, 'package.json'), JSON.stringify({ name: 'notes', version: options.version || '1.2.3', type: 'module' }))
  if (options.manifest !== false) await writeFile(join(directory, 'plugin.json'), JSON.stringify({ ...definition, server: options.entry || 'server.mjs' }))
  await writeFile(join(directory, 'server.mjs'), 'throw new Error("Fixture must not be enabled"); export function apply() {}')
}
beforeEach(() => {
  vi.stubGlobal('fetch', mocks.fetch)
  mocks.fetch.mockResolvedValue(new Response(JSON.stringify([{ sha: commit }]), { status: 200 }))
  mocks.exec.mockImplementation((_command: string, args: string[], _options: object, callback: (error: Error | null) => void) => {
    void npmPackage(args[args.indexOf('--prefix') + 1]).then(() => callback(null), callback)
  })
})
afterEach(async () => {
  for (const manager of managers.splice(0)) await manager.close()
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true })
  vi.unstubAllGlobals(); vi.resetAllMocks()
})

it.each(['https://github.com/example/notes', 'https://github.com/example/notes/', 'https://github.com/example/notes.git', ' https://github.com/example/notes.git/\n'])('pins the default branch before installing %s', async url => {
  const installed = await installPackage(await home(), url)
  expect(installed).toMatchObject({ source: pinned, manifest: definition })
  expect(mocks.fetch).toHaveBeenCalledTimes(1)
  expect(mocks.fetch).toHaveBeenCalledWith('https://api.github.com/repos/example/notes/commits?per_page=1', expect.objectContaining({
    redirect: 'error', credentials: 'omit', signal: expect.any(AbortSignal),
  }))
  expect(mocks.exec).toHaveBeenCalledWith(expect.any(String), expect.arrayContaining(['--ignore-scripts', '--omit=dev', '--', pinned]),
    expect.objectContaining({ timeout: 120_000 }), expect.any(Function))
  await installed.dispose()
})

it('persists the resolved commit, keeps a new plugin disabled and retains it after a failed replacement', async () => {
  const directory = await home()
  const manager = new PluginManager(directory, { authorize() {}, api: async () => null, emit() {}, log() {} }); managers.push(manager)
  const who = { userId: 1, profile: 'default' }
  await manager.install(who, 'https://github.com/example/notes', 0)
  expect(manager.snapshot().plugins[0]).toMatchObject({ source: pinned, status: 'disabled', manifest: definition })
  expect(manager.store.read().records.notes.source).toBe(pinned)
  mocks.fetch.mockResolvedValueOnce(new Response(JSON.stringify([{ sha: 'b'.repeat(40) }])))
  mocks.exec.mockImplementationOnce((_command: string, args: string[], _options: object, callback: (error: Error | null) => void) => {
    void npmPackage(args[args.indexOf('--prefix') + 1], { manifest: false }).then(() => callback(null), callback)
  })
  await expect(manager.install(who, 'https://github.com/example/notes', 1, 'notes')).rejects.toThrow('Plugin package must include plugin.json')
  expect(manager.snapshot().plugins[0]).toMatchObject({ source: pinned, manifest: definition })
  expect(await readdir(join(manager.store.directory(), 'versions'))).toHaveLength(1)
})

it.each([
  'http://github.com/example/notes', 'https://github.com.evil.test/example/notes', 'https://user:pass@github.com/example/notes',
  'https://github.com:443/example/notes', 'https://github.com/example/notes?ref=main', 'https://github.com/example/notes#main',
  'https://github.com/example/notes/tree/main', 'https://github.com/example/../notes/repo', 'https://github.com/example/%2e%2e',
  'https://github.com/example/..', 'https://github.com/example', 'https://127.0.0.1/example/notes',
])('rejects non-root, credentialed or unsupported URL %s before network or npm', async source => {
  const directory = await home()
  await expect(installPackage(directory, source)).rejects.toMatchObject({ status: 400, code: 'PLUGIN_INVALID' })
  expect(mocks.fetch).not.toHaveBeenCalled(); expect(mocks.exec).not.toHaveBeenCalled()
  expect(await readdir(join(directory, 'versions'))).toEqual([])
})

it.each([
  [404, 'not found'], [403, 'rate limit'], [429, 'rate limit'], [409, 'no commits'], [500, 'resolve GitHub'],
])('reports GitHub status %s without attempting npm', async (status, message) => {
  mocks.fetch.mockResolvedValueOnce(new Response('{}', { status: Number(status) }))
  const directory = await home()
  await expect(installPackage(directory, 'https://github.com/example/notes')).rejects.toMatchObject({ status: 422, code: 'PLUGIN_SOURCE_RESOLVE', message: expect.stringContaining(String(message)) })
  expect(mocks.exec).not.toHaveBeenCalled(); expect(await readdir(join(directory, 'versions'))).toEqual([])
})

it.each([[], [{ sha: 'main' }], [{ sha: 'a'.repeat(7) }], [{ sha: 'A'.repeat(40) }], { sha: commit }].map(response => ({ response })))('rejects an invalid resolved commit response $response', async ({ response }) => {
  mocks.fetch.mockResolvedValueOnce(new Response(JSON.stringify(response)))
  await expect(installPackage(await home(), 'https://github.com/example/notes')).rejects.toMatchObject({ code: 'PLUGIN_SOURCE_RESOLVE', status: 422 })
  expect(mocks.exec).not.toHaveBeenCalled()
})

it.each([new Error('network unavailable'), new DOMException('timed out', 'TimeoutError'), new TypeError('redirect rejected')])('handles failed lookup without falling back to a mutable install', async error => {
  mocks.fetch.mockRejectedValueOnce(error)
  await expect(installPackage(await home(), 'https://github.com/example/notes')).rejects.toMatchObject({ code: 'PLUGIN_SOURCE_RESOLVE', status: 422 })
  expect(mocks.exec).not.toHaveBeenCalled()
})

it.each([{ version: '2.0.0' }, { entry: '../outside.mjs' }])('keeps plugin version and entry validation after URL resolution: %j', async options => {
  mocks.exec.mockImplementationOnce((_command: string, args: string[], _options: object, callback: (error: Error | null) => void) => {
    void npmPackage(args[args.indexOf('--prefix') + 1], options).then(() => callback(null), callback)
  })
  const directory = await home()
  await expect(installPackage(directory, 'https://github.com/example/notes')).rejects.toMatchObject({ code: 'PLUGIN_INVALID' })
  expect(await readdir(join(directory, 'versions'))).toEqual([])
})

it('reports npm failure after resolution and cleans its staging directory', async () => {
  mocks.exec.mockImplementationOnce((_command: string, _args: string[], _options: object, callback: (error: Error) => void) => callback(new Error('npm unavailable')))
  const directory = await home()
  await expect(installPackage(directory, 'https://github.com/example/notes')).rejects.toMatchObject({ code: 'PLUGIN_INSTALL', status: 422 })
  expect(await readdir(join(directory, 'versions'))).toEqual([])
})

it.each([pinned, 'notes@1.2.3', '@example/notes@1.2.3-rc.1', `git+https://gitlab.com/team/notes.git#${commit}`, `git+https://gitee.com/team/notes.git#${commit}`])('keeps existing source %s without a GitHub lookup', async source => {
  const installed = await installPackage(await home(), source)
  expect(installed.source).toBe(source)
  expect(mocks.fetch).not.toHaveBeenCalled()
  expect(mocks.exec.mock.calls[0][1].at(-1)).toBe(source)
  await installed.dispose()
})

it.each(['notes', 'notes@latest', 'notes@^1.2.3', 'github:example/notes#main', `git+https://evil.test/team/notes.git#${commit}`])('retains the remote source whitelist for %s', async source => {
  await expect(installPackage(await home(), source)).rejects.toMatchObject({ status: 400 })
  expect(mocks.fetch).not.toHaveBeenCalled(); expect(mocks.exec).not.toHaveBeenCalled()
})

it('handles invalid GitHub JSON without attempting npm', async () => {
  mocks.fetch.mockResolvedValueOnce(new Response('not JSON'))
  await expect(installPackage(await home(), 'https://github.com/example/notes')).rejects.toMatchObject({ code: 'PLUGIN_SOURCE_RESOLVE', status: 422 })
  expect(mocks.exec).not.toHaveBeenCalled()
})
