import { afterEach, expect, it } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, readFile, writeFile, rm, access, cp, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { scaffoldPlugin } from '../../bin/plugin-development.mjs'
import { checkProject } from '../../packages/plugin-sdk/harness/project.mjs'
import { checkPluginDocs } from '../../scripts/plugin-docs-harness.mjs'
import { assertContracts, assertSchema, assertValue, registerRpc } from '../../packages/plugin-sdk/harness/contracts.mjs'
import { registerPlugin } from '../../bin/plugin-development.mjs'
import { PluginManager } from '../../packages/server/src/modules/studio/services/plugins/manager'
import { PluginDevelopment } from '../../packages/server/src/modules/studio/services/plugins/development'

const dispose: Array<() => Promise<void>> = []
afterEach(async () => { for (const clean of dispose.splice(0).reverse()) await clean() })
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
  for (const file of ['AGENTS.md', 'docs/ARCHITECTURE.md', 'docs/STUDIO_CTX.md', 'docs/STUDIO_RETURNS.md', 'docs/DEVELOPMENT.md', 'docs/CONTRACTS.md', 'docs/FIELD_REFERENCE.md', 'docs/HOST_API.md', 'sdk/src/index.ts', 'sdk/src/json.ts', '.github/workflows/check.yml']) await access(join(project, file))
  const check = await promisify(execFile)(process.execPath, ['scripts/plugin-harness.mjs', 'check'], { cwd: project })
  expect(check.stdout).toContain('checked')
  const tests = await promisify(execFile)(process.execPath, ['--test', 'tests/contracts.test.mjs'], { cwd: project })
  expect(tests.stdout).toMatch(/pass 2/)
  const pkg = JSON.parse(await readFile(join(project, 'package.json'), 'utf8'))
  expect(pkg.scripts['docs:update']).toBeUndefined()
  await expect(access(join(project, 'contracts/changes.json'))).rejects.toThrow()
})

it('fails fast when a shipped public SDK module or field guide is missing', async () => {
  const { project } = await fixture()
  const file = join(project, 'sdk/src/host.ts')
  const source = await readFile(file, 'utf8')
  await rm(file)
  await expect(checkProject(project)).rejects.toThrow()
  await writeFile(file, source)
  await rm(join(project, 'docs/FIELD_REFERENCE.md'))
  await expect(checkProject(project)).rejects.toThrow()
})

it('accepts directly edited Markdown and field descriptions without a generation step or history file', async () => {
  const { project, contract, write } = await fixture()
  contract.models.settings.properties.theme = { type: 'string' }
  await write()
  await expect(checkProject(project)).rejects.toThrow(/description/)
  contract.models.settings.properties.theme.description = 'Optional theme name; defaults to system.'
  await write()
  const file = join(project, 'docs/CONTRACTS.md')
  const notes = await readFile(file, 'utf8') + '\nTheme is optional; old records use the system theme.\n'
  await writeFile(file, notes)
  await checkProject(project)
  expect(await readFile(file, 'utf8')).toBe(notes)
  // Project authors can annotate their guides; checking never overwrites Markdown.
  await writeFile(join(project, 'docs/ARCHITECTURE.md'), '# Project architecture\nLocal business details.\n')
  await checkProject(project)
})

async function repository() {
  const { home, project } = await fixture(), root = join(home, 'repository')
  await mkdir(join(root, 'packages'), { recursive: true })
  await cp(join(project, 'sdk'), join(root, 'packages/plugin-sdk'), { recursive: true })
  const git = async (...args: string[]) => (await promisify(execFile)('git', args, { cwd: root })).stdout.trim()
  const commit = async () => { await git('add', '.'); await git('-c', 'user.email=fixture@example.invalid', '-c', 'user.name=Fixture', 'commit', '-m', 'fixture') }
  await git('init'); await commit()
  const base = await git('rev-parse', 'HEAD')
  const sdk = join(root, 'packages/plugin-sdk')
  const changeSdk = async () => {
    const file = join(sdk, 'src/agents.ts')
    await writeFile(file, (await readFile(file, 'utf8')).replace('installed: boolean;', 'installed: boolean; unavailableReason?: string;'))
  }
  const explain = async () => {
    const file = join(sdk, 'docs/STUDIO_RETURNS.md')
    await writeFile(file, await readFile(file, 'utf8') + '\nAgentStatus.unavailableReason is optional; existing results remain valid.\n')
  }
  return { root, sdk, git, commit, base, changeSdk, explain }
}

it('requires an accompanying guide edit for working SDK changes, including staged and new source files', async () => {
  const { root, sdk, git, changeSdk, explain } = await repository()
  await checkPluginDocs(root, { base: '' })
  await changeSdk()
  await expect(checkPluginDocs(root, { base: '' })).rejects.toThrow(/Edit the relevant guide/)
  await git('add', 'packages/plugin-sdk/src')
  await expect(checkPluginDocs(root, { base: '' })).rejects.toThrow(/working tree/)
  await explain(); await checkPluginDocs(root, { base: '' })
  await git('reset', '--hard', 'HEAD') // Disposable fixture only.
  await writeFile(join(sdk, 'src/new.ts'), 'export type Extra = { label: string }\n')
  await expect(checkPluginDocs(root, { base: '' })).rejects.toThrow(/working tree/)
  await explain(); await checkPluginDocs(root, { base: '' })
})

it('checks committed PR changes and fails if the configured CI base is unavailable', async () => {
  const { root, base, changeSdk, explain, commit } = await repository()
  await changeSdk(); await commit()
  await expect(checkPluginDocs(root, { base })).rejects.toThrow(/PR\/push/)
  await explain(); await commit()
  await checkPluginDocs(root, { base })
  await expect(checkPluginDocs(root, { base: 'f'.repeat(40) })).rejects.toThrow()
})

it('validates declared references and real handler input/output', async () => {
  const { contract } = await fixture()
  const handlers = new Map<string, Function>()
  registerRpc({ extensions: { rpc: { register(name: string, fn: Function) { handlers.set(name, fn) } } } }, contract, 'save-settings', async () => ({ ok: 'not boolean' }))
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
  contract.models.settings.properties.theme = { type: 'string' }; await write()
  await development.tick(); await development.tick()
  expect(manager.snapshot().revision).toBe(revision)
  expect((await development.list()).projects[0]).toMatchObject({ status: 'error', error: expect.stringContaining('description') })
  expect(await manager.runtime(identity, 'harness-demo').invoke('rpc', 'get-settings', null, identity)).toEqual({ greeting: 'Hello', compact: false })
  contract.models.settings.properties.theme.description = 'Optional theme; defaults to system.'; await write()
  await writeFile(join(project, 'docs/CONTRACTS.md'), await readFile(join(project, 'docs/CONTRACTS.md'), 'utf8') + '\nOptional theme defaults to system.\n')
  await development.tick(); await development.tick()
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
  await writeFile(join(project, 'compile.mjs'), `import { readFileSync, writeFileSync } from 'node:fs'; const contract = JSON.parse(readFileSync('contracts/plugin.json', 'utf8')); contract.models.settings.properties.addedByBuild = { type: 'boolean' }; writeFileSync('contracts/plugin.json', JSON.stringify(contract));`)
  await expect(development.start(identity, 'harness-demo', revision)).rejects.toThrow(/description/)
  expect(manager.snapshot().revision).toBe(revision)
  expect(manager.snapshot().plugins[0].status).toBe('active')
})
