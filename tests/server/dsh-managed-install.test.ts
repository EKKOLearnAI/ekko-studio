import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DshManagedInstall } from '../../packages/server/src/modules/coding-agents/services/dsh/managed-install'
let root: string
let manager: DshManagedInstall
const host = () => ({
  resolveVersion: vi.fn(async spec => spec === 'latest' ? '0.2.2-rc.1' : spec),
  install: vi.fn(async (prefix: string, version: string) => { await writeFile(join(prefix, 'graph.txt'), version) }),
  preflight: vi.fn(async () => {}),
  existing: vi.fn(async (): Promise<{ command: string; version: string } | undefined> => undefined),
})
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'dsh-update-')); manager = new DshManagedInstall(root) })
afterEach(async () => { await rm(root, { recursive: true, force: true }) })

it('resolves latest once, installs exactly and activates only after compatibility passes', async () => {
  const h = host()
  h.preflight.mockImplementation(async () => { expect((await manager.info()).command).toBeUndefined() })
  await manager.install({}, h)
  expect(h.install.mock.calls[0][1]).toBe('0.2.2-rc.1')
  expect(await manager.info()).toMatchObject({ verifiedVersion: '0.2.2-rc.1', adapterRevision: 5, pinnedVersion: '' })
})

it.each(['install', 'preflight'] as const)('keeps the exact active state and old graph on %s failure, cleans only the candidate', async failure => {
  await manager.install({ version: '0.2.1-rc.5' }, host())
  const before = await readFile(join(root, 'active.json'), 'utf8')
  const directories = await readdir(join(root, 'releases'))
  const h = host(); h[failure].mockRejectedValue(new Error('incompatible native dependency'))
  await expect(manager.install({ version: 'latest' }, h)).rejects.toMatchObject({ code: 'DSH_UPDATE_REJECTED' })
  expect(await readFile(join(root, 'active.json'), 'utf8')).toBe(before)
  expect(await readdir(join(root, 'releases'))).toEqual(directories)
  expect(await readFile(join(root, 'releases', directories[0], 'graph.txt'), 'utf8')).toBe('0.2.1-rc.5')
})

it('persists a pin across restarts and unpins only on explicit latest', async () => {
  await manager.install({ version: '0.2.1-rc.5' }, host())
  const h = host()
  manager = new DshManagedInstall(root)
  await manager.install({}, h)
  expect(h.resolveVersion).toHaveBeenCalledWith('0.2.1-rc.5')
  await manager.install({ version: 'latest' }, h)
  expect((await manager.info()).pinnedVersion).toBe('')
})

it('restores and pins the previous graph after rechecking it; failed rollback preserves active state', async () => {
  await manager.install({ version: '0.2.1-rc.5' }, host())
  const previous = (await manager.info()).command
  await manager.install({ version: 'latest' }, host())
  const before = await readFile(join(root, 'active.json'), 'utf8')
  const failed = host(); failed.preflight.mockRejectedValue(new Error('dependency removed'))
  await expect(manager.install({ rollback: true }, failed)).rejects.toThrow('dependency removed')
  expect(await readFile(join(root, 'active.json'), 'utf8')).toBe(before)
  await manager.install({ rollback: true }, host())
  expect(await manager.info()).toMatchObject({ command: previous, pinnedVersion: '0.2.1-rc.5', previousVersion: '0.2.2-rc.1' })
})

it('retains a verified external CLI as the first rollback target without changing its files', async () => {
  const h = host(); h.existing.mockResolvedValue({ command: '/external/dsh', version: '0.2.1-rc.5' })
  await manager.install({}, h)
  await manager.install({ rollback: true }, h)
  expect((await manager.info()).command).toBe('/external/dsh')
})

it('does not advertise a broken external CLI as a working rollback target', async () => {
  const h = host(); h.existing.mockResolvedValue({ command: '/broken/dsh', version: '0.2.1-rc.5' })
  h.preflight.mockImplementation(async command => { if (command === '/broken/dsh') throw new Error('incompatible') })
  await manager.install({}, h)
  expect((await manager.info()).previousVersion).toBe('')
  await expect(manager.install({ rollback: true }, h)).rejects.toMatchObject({ code: 'DSH_ROLLBACK_UNAVAILABLE' })
})

it.each(['^0.2', 'file:/tmp/cli', 'git+https://example.org', '--foo'])('rejects non-exact version %s before installing', async version => {
  const h = host()
  await expect(manager.install({ version }, h)).rejects.toMatchObject({ status: 400 })
  expect(h.install).not.toHaveBeenCalled()
})
