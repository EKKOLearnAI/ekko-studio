import { afterEach, expect, it } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, readFile, writeFile, rm, access } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { scaffoldPlugin } from '../../bin/plugin-development.mjs'
import { checkProject, updateProject } from '../../packages/plugin-sdk/harness/project.mjs'
import { checkSdk, updateSdk } from '../../packages/plugin-sdk/harness/sdk.mjs'
import { assertContracts, assertSchema, assertValue, registerRpc } from '../../packages/plugin-sdk/harness/contracts.mjs'
import { registerPlugin } from '../../bin/plugin-development.mjs'
import { PluginManager } from '../../packages/server/src/modules/studio/services/plugins/manager'
import { PluginDevelopment } from '../../packages/server/src/modules/studio/services/plugins/development'

const dispose: Array<() => Promise<void>> = []
afterEach(async () => { for (const clean of dispose.splice(0).reverse()) await clean() })
const options = { summary: 'Add optional settings theme with a documented default.', compatibility: 'Old records omit theme; readers use the default. No data rewrite is needed.' }
async function fixture() {
  const home = await mkdtemp(join(tmpdir(), 'studio-plugin-harness-')); dispose.push(() => rm(home, { recursive: true, force: true }))
  const project = await scaffoldPlugin(join(home, 'source'), 'harness-demo')
  const contract = JSON.parse(await readFile(join(project, 'contracts/plugin.json'), 'utf8'))
  const write = () => writeFile(join(project, 'contracts/plugin.json'), JSON.stringify(contract, null, 2))
  return { home, project, contract, write }
}

it('generates self-contained documentation, working runtime contract tests and checks without npm dependencies', async () => {
  const { project } = await fixture()
  await checkProject(project)
  for (const file of ['AGENTS.md', 'docs/ARCHITECTURE.md', 'docs/STUDIO_CTX.md', 'docs/STUDIO_RETURNS.md', 'docs/DEVELOPMENT.md', 'docs/CONTRACTS.md', 'sdk/docs/SDK_REFERENCE.md', '.github/workflows/check.yml']) await access(join(project, file))
  const check = await promisify(execFile)(process.execPath, ['scripts/plugin-harness.mjs', 'check'], { cwd: project })
  expect(check.stdout).toContain('current')
  const tests = await promisify(execFile)(process.execPath, ['--test', 'tests/contracts.test.mjs'], { cwd: project })
  expect(tests.stdout).toMatch(/pass 2/)
  const history = JSON.parse(await readFile(join(project, 'contracts/changes.json'), 'utf8'))
  expect(history).toHaveLength(1)
})

it('blocks undocumented nested changes, missing descriptions and empty change explanations', async () => {
  const { project, contract, write } = await fixture()
  contract.models.settings.properties.theme = { type: 'string' }
  await write()
  await expect(checkProject(project)).rejects.toThrow(/description/)
  await expect(updateProject(project, options)).rejects.toThrow(/description/)
  contract.models.settings.properties.theme.description = 'Optional theme name; defaults to system.'
  await write()
  await expect(checkProject(project)).rejects.toThrow(/changed without documentation/)
  await expect(updateProject(project)).rejects.toThrow(/--summary and --compatibility/)
  await updateProject(project, options); await checkProject(project)
  expect(await readFile(join(project, 'docs/CONTRACTS.md'), 'utf8')).toContain('Optional theme name')
  expect(JSON.parse(await readFile(join(project, 'contracts/changes.json'), 'utf8'))).toHaveLength(2)
  contract.models.settings.required.push('theme'); await write()
  await expect(checkProject(project)).rejects.toThrow(/changed without documentation/)
  await updateProject(project, { ...options, summary: 'Require the existing theme field in settings.' })
  await writeFile(join(project, 'docs/CONTRACTS.md'), '# Handwritten placeholder\n')
  await expect(checkProject(project)).rejects.toThrow(/stale or missing/)
})

it('requires documented SDK changes and a separate plugin compatibility entry when upgrading the bundled SDK', async () => {
  const { project } = await fixture(), sdk = join(project, 'sdk')
  const file = join(sdk, 'src/agents.ts'), source = await readFile(file, 'utf8')
  await writeFile(file, source.replace('installed: boolean;', 'installed: boolean; unavailableReason?: string;'))
  await expect(checkSdk(sdk)).rejects.toThrow(/SDK contract changed/)
  await expect(checkProject(project)).rejects.toThrow(/SDK contract changed/)
  await updateSdk(sdk, { summary: 'Add an optional unavailable reason to AgentStatus.', compatibility: 'Optional additive field; existing runtime return values remain valid.' })
  await checkSdk(sdk)
  await expect(checkProject(project)).rejects.toThrow(/changed without documentation/)
  await updateProject(project, { summary: 'Update the bundled SDK to the new status shape.', compatibility: 'Plugin ignores the new optional field; no stored data changes.' })
  await checkProject(project)
  // A Windows checkout's newline conversion must not create a false SDK mismatch.
  await writeFile(file, (await readFile(file, 'utf8')).replaceAll('\n', '\r\n'))
  await checkProject(project)
})

it('validates declared references and real handler input/output instead of only storing fingerprints', async () => {
  const { contract } = await fixture()
  const handlers = new Map<string, Function>()
  registerRpc({ rpc: { register(name: string, fn: Function) { handlers.set(name, fn) } } }, contract, 'save-settings', async () => ({ ok: 'not boolean' }))
  await expect(handlers.get('save-settings')!({ greeting: 'hello', compact: false }, {})).rejects.toThrow(/not in enum/)
  await expect(handlers.get('save-settings')!({ greeting: 123, compact: false }, {})).rejects.toThrow(/expected string/)
  contract.storage.settings.model = 'unknown'
  expect(() => assertContracts(contract)).toThrow(/unknown model/)
  expect(() => assertSchema({ type: 'string', description: 'text', pattern: '.*' })).toThrow(/unsupported keyword/)
  expect(() => assertValue({ type: 'number' }, NaN)).toThrow(/expected number/)
  expect(() => assertValue({ type: 'object', properties: {}, required: [], additionalProperties: true }, { secret: undefined })).toThrow(/JSON/)
})

it('keeps the installed runtime when development harness fails, then reloads after documentation is updated', async () => {
  const { home, project, contract, write } = await fixture()
  await registerPlugin(project, home)
  const manager = new PluginManager(join(home, 'plugins'), { authorize() {}, api: async () => null, emit() {}, log() {} })
  dispose.push(() => manager.close())
  const development = new PluginDevelopment(manager, () => {}); dispose.push(() => development.close())
  const identity = { userId: 1, profile: 'default' }
  await development.start(identity, 'harness-demo', 0)
  const revision = manager.snapshot().revision
  contract.models.settings.properties.theme = { type: 'string', description: 'Optional theme; defaults to system.' }; await write()
  await development.tick(); await development.tick()
  expect(manager.snapshot().revision).toBe(revision)
  expect((await development.list()).projects[0]).toMatchObject({ status: 'error', error: expect.stringContaining('changed without documentation') })
  expect(await manager.runtime(identity, 'harness-demo').invoke('rpc', 'get-settings', null, identity)).toEqual({ greeting: 'Hello', compact: false })
  await updateProject(project, options); await development.tick(); await development.tick()
  expect(manager.snapshot().revision).toBe(revision + 1)
  const pkg = JSON.parse(await readFile(join(project, 'package.json'), 'utf8'))
  delete pkg.scripts['harness:check']; await writeFile(join(project, 'package.json'), JSON.stringify(pkg))
  await development.tick(); await development.tick()
  expect(manager.snapshot().revision).toBe(revision + 1)
  expect((await development.list()).projects[0].error).toContain('harness:check')
})

it('checks contracts again after a build so build-generated shape changes cannot be silently activated', async () => {
  const { home, project } = await fixture()
  await registerPlugin(project, home)
  const manager = new PluginManager(join(home, 'plugins'), { authorize() {}, api: async () => null, emit() {}, log() {} })
  dispose.push(() => manager.close())
  const development = new PluginDevelopment(manager, () => {}); dispose.push(() => development.close())
  const identity = { userId: 1, profile: 'default' }
  await development.start(identity, 'harness-demo', 0)
  const revision = manager.snapshot().revision
  const pkg = JSON.parse(await readFile(join(project, 'package.json'), 'utf8')); pkg.scripts.build = 'node compile.mjs'
  await writeFile(join(project, 'package.json'), JSON.stringify(pkg))
  await writeFile(join(project, 'compile.mjs'), `import { readFileSync, writeFileSync } from 'node:fs'; const contract = JSON.parse(readFileSync('contracts/plugin.json', 'utf8')); contract.models.settings.properties.addedByBuild = { type: 'boolean', description: 'Generated optional field' }; writeFileSync('contracts/plugin.json', JSON.stringify(contract));`)
  await expect(development.start(identity, 'harness-demo', revision)).rejects.toThrow(/changed without documentation/)
  expect(manager.snapshot().revision).toBe(revision)
  expect(manager.snapshot().plugins[0].status).toBe('active')
})
