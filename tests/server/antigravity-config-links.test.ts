import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { prepareAntigravityRuntime } from '../../packages/server/src/modules/coding-agents/services/antigravity/config'
const link = vi.hoisted(() => vi.fn())
vi.mock('node:fs/promises', async original => ({ ...await original<typeof import('node:fs/promises')>(), symlink: link }))
let base: string
let home: string
let rootDir: string
beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'antigravity-links-')); home = join(base, 'native'); rootDir = join(base, 'run')
  for (const path of ['.gemini/config/skills/native', '.gemini/antigravity-cli', '.gemini/antigravity', '.agents/skills/shared']) await mkdir(join(home, path), { recursive: true })
  for (const [path, text] of Object.entries({
    '.gemini/google_accounts.json': '{"synthetic":"credential"}', '.gemini/config/state.json': '{"state":1}',
    '.gemini/antigravity-cli/auth.json': '{"synthetic":"auth"}', '.gemini/config/skills/native/SKILL.md': 'native skill',
    '.agents/skills/shared/SKILL.md': 'shared skill', '.gemini/antigravity-cli/settings.json': '{"toolPermission":"request-review"}',
    '.gemini/config/mcp_config.json': '{"mcpServers":{"user":{"command":"echo"}}}',
  })) await writeFile(join(home, path), text, { mode: 0o600 })
  const native = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
  link.mockReset().mockImplementation(native.symlink)
})
afterEach(async () => { await rm(base, { recursive: true, force: true }) })
const prepare = (externalModel?: { baseUrl: string; token: string }) => prepareAntigravityRuntime({ home, rootDir, systemPrompt: 'managed prompt', managedMcp: { studio: { command: 'synthetic', env: { ELECTRON_RUN_AS_NODE: '1' } } }, externalModel })

it.each(['EPERM', 'ENOTSUP', 'EINVAL'])('%s falls back for top-level auth, both config loops, directories and skills', async code => {
  link.mockRejectedValue(Object.assign(new Error('links unavailable'), { code }))
  await prepare()
  for (const [path, text] of Object.entries({ 'google_accounts.json': '{"synthetic":"credential"}', 'config/state.json': '{"state":1}',
    'antigravity-cli/auth.json': '{"synthetic":"auth"}', 'config/skills/native/SKILL.md': 'native skill', 'config/skills/shared/SKILL.md': 'shared skill' })) {
    expect(await readFile(join(rootDir, '.gemini', path), 'utf8')).toBe(text)
    expect((await lstat(join(rootDir, '.gemini', path))).isSymbolicLink()).toBe(false)
  }
  expect(await readFile(join(home, '.gemini/antigravity-cli/settings.json'), 'utf8')).toBe('{"toolPermission":"request-review"}')
  expect(JSON.parse(await readFile(join(rootDir, '.gemini/config/mcp_config.json'), 'utf8')).mcpServers).toHaveProperty('studio')
  expect(JSON.parse(await readFile(join(home, '.gemini/config/mcp_config.json'), 'utf8')).mcpServers).not.toHaveProperty('studio')
  await writeFile(join(rootDir, '.gemini/google_accounts.json'), 'run-owned update')
  await prepare()
  expect(await readFile(join(rootDir, '.gemini/google_accounts.json'), 'utf8')).toBe('run-owned update')
  expect(await readFile(join(home, '.gemini/google_accounts.json'), 'utf8')).toBe('{"synthetic":"credential"}')
})
it('keeps native links when supported and tolerates repeat preparation', async () => {
  await prepare(); await prepare()
  expect((await lstat(join(rootDir, '.gemini/google_accounts.json'))).isSymbolicLink()).toBe(true)
})
it('does not share native credentials for an external model', async () => {
  link.mockRejectedValue(Object.assign(new Error('links unavailable'), { code: 'EPERM' }))
  await prepare({ baseUrl: 'http://example.invalid', token: 'synthetic' })
  await expect(lstat(join(rootDir, '.gemini/google_accounts.json'))).rejects.toMatchObject({ code: 'ENOENT' })
  await expect(lstat(join(rootDir, '.gemini/antigravity-cli/auth.json'))).rejects.toMatchObject({ code: 'ENOENT' })
})
it('propagates unexpected errors instead of hiding access failures', async () => {
  link.mockRejectedValue(Object.assign(new Error('denied'), { code: 'EACCES' }))
  await expect(prepare()).rejects.toMatchObject({ code: 'EACCES' })
})

it('follows native directory links when a snapshot fallback is needed', async () => {
  const native = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
  await native.symlink(join(home, '.agents/skills/shared'), join(home, '.gemini/linked-state'), 'dir')
  link.mockRejectedValue(Object.assign(new Error('links unavailable'), { code: 'EPERM' }))
  await prepare()
  expect(await readFile(join(rootDir, '.gemini/linked-state/SKILL.md'), 'utf8')).toBe('shared skill')
})
