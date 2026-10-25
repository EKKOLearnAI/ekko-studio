import { mkdtemp, mkdir, writeFile, readFile, symlink, link, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, expect, it, vi } from 'vitest'
import { AgentResourceFiles } from '../../packages/server/src/modules/studio/services/agents/resource-files'
import type { AgentResourceLocations } from '../../packages/studio-plugin-sdk/src'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); vi.unstubAllEnvs() })
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'studio-resource-')); roots.push(root)
  await mkdir(join(root, 'local', 'same'), { recursive: true })
  await mkdir(join(root, 'shared', 'same'), { recursive: true })
  await writeFile(join(root, 'local/same/SKILL.md'), 'local')
  await writeFile(join(root, 'shared/same/SKILL.md'), 'shared')
  const locations: AgentResourceLocations = { skills: [
    { id: 'local', name: 'Skills', path: join(root, 'local'), scope: 'global', readOnly: false },
    { id: 'shared', name: 'Skills', path: join(root, 'shared'), scope: 'shared', readOnly: true },
  ], configs: [{ id: 'config', name: 'settings.json', path: join(root, 'config/settings.json'), kind: 'file', format: 'json', scope: 'scoped', readOnly: false }] }
  const authorize = vi.fn(), files = new AgentResourceFiles(locations, authorize)
  return { root, locations, files, authorize }
}
const local = { kind: 'skills' as const, locationId: 'local', path: 'same/SKILL.md' }
it('lists each source without collapsing duplicates, creates a missing config, and round-trips UTF-8', async () => {
  const f = await fixture(), entries = await f.files.list()
  expect(entries.map(item => [item.locationId, item.path, item.exists, item.readOnly])).toEqual([
    ['local', 'same/SKILL.md', true, false], ['shared', 'same/SKILL.md', true, true], ['config', '', false, false],
  ])
  const ref = { kind: 'configs' as const, locationId: 'config', path: '' }, before = f.files.read(ref)
  const after = f.files.write(ref, '{"提示词":"Hello"}', before.etag)
  expect(after).toMatchObject({ exists: true, content: '{"提示词":"Hello"}' })
  expect(await readFile(join(f.root, 'config/settings.json'), 'utf8')).toBe(after.content)
  expect(f.files.read(ref).etag).toBe(after.etag)
})
it('rejects external edits and concurrent stale saves without losing content', async () => {
  const f = await fixture(), before = f.files.read(local)
  await writeFile(join(f.root, 'local/same/SKILL.md'), 'native edit')
  expect(() => f.files.write(local, 'overwrite', before.etag)).toThrow(expect.objectContaining({ code: 'REVISION_CONFLICT' }))
  const current = f.files.read(local); f.files.write(local, 'first save', current.etag)
  expect(() => f.files.write(local, 'second save', current.etag)).toThrow(expect.objectContaining({ code: 'REVISION_CONFLICT' }))
  expect(f.files.read(local).content).toBe('first save')
})
it.each(['../shared/same/SKILL.md', '/etc/passwd', 'same/../../x', 'same\\SKILL.md', 'C:/x', 'same//SKILL.md', 'same/./SKILL.md', 'bad\0path'])('rejects traversal %s', async path => {
  const f = await fixture()
  expect(() => f.files.read({ ...local, path })).toThrow(expect.objectContaining({ code: 'INVALID_ARGUMENT' }))
})
it('protects read-only aliases, nested roots, hardlinks and undeclared shared global roots', async () => {
  const f = await fixture()
  await symlink(join(f.root, 'shared'), join(f.root, 'alias'), 'dir')
  f.locations.skills!.push({ id: 'alias', name: 'Alias', path: join(f.root, 'alias'), scope: 'global', readOnly: false },
    { id: 'parent', name: 'Parent', path: f.root, scope: 'global', readOnly: false })
  for (const ref of [{ ...local, locationId: 'alias' }, { ...local, locationId: 'parent', path: 'shared/same/SKILL.md' }]) {
    expect(f.files.read(ref).readOnly).toBe(true)
    expect(() => f.files.write(ref, 'bad', f.files.read(ref).etag)).toThrow(expect.objectContaining({ code: 'FORBIDDEN' }))
  }
  await link(join(f.root, 'shared/same/SKILL.md'), join(f.root, 'local/hard.md'))
  const hard = { ...local, path: 'hard.md' }
  expect(() => f.files.write(hard, 'bad', f.files.read(hard).etag)).toThrow(expect.objectContaining({ code: 'FORBIDDEN' }))
  vi.stubEnv('HERMES_CODING_AGENT_GLOBAL_HOME', f.root)
  await mkdir(join(f.root, '.agents/skills'), { recursive: true })
  await writeFile(join(f.root, '.agents/skills/shared.md'), 'global shared')
  const shared = { ...local, locationId: 'parent', path: '.agents/skills/shared.md' }
  expect(() => f.files.write(shared, 'bad', f.files.read(shared).etag)).toThrow(expect.objectContaining({ code: 'FORBIDDEN' }))
})
it('rejects escaping or dangling symlinks and skips nested links during scans', async () => {
  const f = await fixture()
  await symlink(join(f.root, 'shared'), join(f.root, 'local/escape'), 'dir')
  await symlink(join(f.root, 'absent'), join(f.root, 'local/dangling'))
  await symlink(join(f.root, 'local'), join(f.root, 'local/loop'), 'dir')
  expect(() => f.files.read({ ...local, path: 'escape/same/SKILL.md' })).toThrow(expect.objectContaining({ code: 'FORBIDDEN' }))
  expect(() => f.files.read({ ...local, path: 'dangling' })).toThrow(expect.objectContaining({ code: 'FORBIDDEN' }))
  expect((await f.files.list()).filter(item => item.locationId === 'local')).toHaveLength(1)
})
it('bounds reads, rejects binary files and checks authorization before touching disk', async () => {
  const f = await fixture()
  await writeFile(join(f.root, 'local/same/SKILL.md'), Buffer.alloc(1024 * 1024 + 1))
  expect(() => f.files.read(local)).toThrow(expect.objectContaining({ code: 'RESOURCE_EXHAUSTED' }))
  await writeFile(join(f.root, 'local/same/SKILL.md'), Buffer.from([0xff, 0xff]))
  expect(() => f.files.read(local)).toThrow(expect.objectContaining({ code: 'INVALID_ARGUMENT' }))
  f.authorize.mockImplementation(() => { throw new Error('revoked') })
  await expect(f.files.list()).rejects.toThrow('revoked')
  expect(() => f.files.write(local, 'bad', 'missing')).toThrow('revoked')
})

it('validates declared JSON and TOML formats without replacing a valid file on error', async () => {
  const f = await fixture(), ref = { kind: 'configs' as const, locationId: 'config', path: '' }
  expect(() => f.files.write(ref, '{broken', 'missing')).toThrow(expect.objectContaining({ code: 'INVALID_ARGUMENT' }))
  f.locations.configs![0].format = 'toml'
  expect(() => f.files.write(ref, 'a = [', 'missing')).toThrow(expect.objectContaining({ code: 'INVALID_ARGUMENT' }))
  const saved = f.files.write(ref, 'a = 1', 'missing')
  expect(saved.content).toBe('a = 1')
})

it('does not replace a missing directory root with a file or hide an invalid declared file type', async () => {
  const f = await fixture()
  expect(() => f.files.write({ ...local, path: '' }, 'bad', 'missing')).toThrow(expect.objectContaining({ code: 'INVALID_ARGUMENT' }))
  f.locations.configs![0].path = join(f.root, 'local')
  await expect(f.files.list()).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
})
