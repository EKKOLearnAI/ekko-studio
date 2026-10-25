import { mkdtemp, mkdir, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { AgentCliInstallations } from '../../packages/server/src/modules/studio/services/agents/cli-installations'
import { parseAgentCliInstall } from '../../packages/server/src/modules/studio/services/agents/cli-install-contract'
import { nativeAgentLaunch, StudioError, type AgentCliInstallPlan, type AgentProviderRef } from '../../packages/studio-plugin-sdk/src'

const roots: string[] = [], instance = { id: 'instance', ownerId: 'owner', profileId: 'profile' }
const provider: AgentProviderRef = { kind: 'plugin', pluginId: 'test.native', version: '1.0.0', generation: 'one' }
const plan: AgentCliInstallPlan = { kind: 'npm', packageName: '@fixture/cli', version: '1.2.3', bin: 'fixture', runner: 'node' }
afterEach(async () => { for (const path of roots.splice(0)) await rm(path, { recursive: true, force: true }) })
async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'studio-cli-')); roots.push(root)
  const cache = new AgentCliInstallations(root, () => ({ command: process.execPath, args: ['/host/npm-cli.js'] }))
  const stage = await cache.stage(instance, provider, plan, () => {})
  const prefix = stage.launch.args[stage.launch.args.indexOf('--prefix') + 1], packageRoot = join(prefix, 'node_modules', '@fixture', 'cli')
  const installed = async (patch: object = {}) => {
    await mkdir(packageRoot, { recursive: true })
    await writeFile(join(packageRoot, 'package.json'), JSON.stringify({ name: plan.packageName, version: plan.version, bin: { fixture: 'cli.js' }, ...patch }))
    await writeFile(join(packageRoot, 'cli.js'), 'console.log("1.2.3")')
  }
  return { root, cache, stage, prefix, packageRoot, installed }
}

it('isolates npm configuration and publishes only a verified package without changing instance config', async () => {
  const f = await setup()
  expect(f.cache.load(instance, provider)).toBeUndefined()
  expect(f.stage.launch.args.slice(-2)).toEqual(['--', '@fixture/cli@1.2.3'])
  expect(f.stage.launch.args).toContain('--registry=https://registry.npmjs.org/')
  expect(f.stage.launch.env?.HOME).toBe(f.stage.launch.cwd)
  expect(f.stage.launch.env?.NPM_CONFIG_PREFIX).toBe(f.prefix)
  expect(f.stage.launch.env?.NPM_CONFIG_GLOBAL).toBe('false')
  expect(await readFile(f.stage.launch.env!.NPM_CONFIG_USERCONFIG, 'utf8')).toBe('')
  expect(() => f.stage.publish()).toThrow()
  expect(f.cache.load(instance, provider)).toBeUndefined()
  await f.installed(); f.stage.publish(); await f.stage.discard()
  const selected = f.cache.load(instance, provider)
  expect(selected).toEqual({ state: 'ready', command: process.execPath, args: [await realpath(join(f.packageRoot, 'cli.js'))] })
  expect(new AgentCliInstallations(f.root).load(instance, { ...provider, generation: 'restarted' })).toEqual(selected)
  expect(f.cache.load({ ...instance, profileId: 'foreign' }, provider)).toBeUndefined()
  expect(f.cache.load(instance, { ...provider, version: '2.0.0' })).toEqual({ state: 'unavailable' })
})

it.each([{ name: 'other' }, { version: 'latest' }, { bin: { fixture: '../../../outside' } }])('does not select mismatching installed metadata %j', async patch => {
  const f = await setup(); await f.installed(patch)
  expect(() => f.stage.publish()).toThrow()
  await f.stage.discard()
  expect(f.cache.load(instance, provider)).toBeUndefined()
  await expect(readFile(join(f.packageRoot, 'package.json'))).rejects.toMatchObject({ code: 'ENOENT' })
})

it('rejects executable links outside the package and detects later corruption without PATH fallback', async () => {
  const f = await setup(); await f.installed()
  f.stage.publish()
  await rm(join(f.packageRoot, 'cli.js')); await writeFile(join(f.root, 'outside.js'), '')
  await symlink(join(f.root, 'outside.js'), join(f.packageRoot, 'cli.js'))
  expect(f.cache.load(instance, provider)).toEqual({ state: 'unavailable' })
  const unavailable = f.cache.load(instance, provider)
  expect(() => nativeAgentLaunch('fixture', {}, { nativeCli: unavailable })).toThrow(expect.objectContaining({ code: 'RUNTIME_UNAVAILABLE' }))
  expect(nativeAgentLaunch('fixture', { command: '/custom', args: ['literal argument'] }, { nativeCli: unavailable })).toEqual({ command: '/custom', args: ['literal argument'] })
})

it('checks fresh authority before committing and removes unselected staging', async () => {
  const f = await setup(); await f.installed(); f.stage.publish()
  const previous = f.cache.load(instance, provider), authorize = vi.fn()
  const next = await f.cache.stage(instance, provider, plan, authorize)
  authorize.mockImplementation(() => { throw new StudioError('FORBIDDEN', 'Revoked') })
  expect(() => next.publish()).toThrow(expect.objectContaining({ code: 'FORBIDDEN' }))
  await next.discard()
  expect(f.cache.load(instance, provider)).toEqual(previous)
  expect((await readdir(join(f.prefix, '..'))).filter(name => /^[0-9a-f-]{36}$/.test(name))).toHaveLength(1)
})

it.each([
  { version: 'latest' }, { version: '^1.2.3' }, { version: '1.2.3-alpha.01' }, { packageName: 'https://example.test/cli.tgz' },
  { packageName: '../local' }, { bin: '--eval' }, { runner: 'shell' }, { command: 'npm' }, { env: { TOKEN: 'secret' } },
  { preferDedupe: 'true' }, { preferDedupe: 1 }, { preferDedupe: null }, { args: ['--ignore-scripts'] },
  { nativeHomeEnv: ['NODE_OPTIONS'] }, { nativeHomeEnv: ['HOME'] }, { nativeHomeEnv: ['PATH'] },
  { nativeHomeEnv: ['GROK_HOME', 'GROK_HOME'] }, { nativeHomeEnv: 'GROK_HOME' }, { nativeHomeEnv: { GROK_HOME: '/outside' } },
])('rejects nonliteral or expanded installation descriptors %j', patch => {
  expect(() => parseAgentCliInstall({ ...plan, ...patch })).toThrow(expect.objectContaining({ code: 'INVALID_ARGUMENT' }))
})

it('applies the bounded dependency deduplication option without accepting arbitrary npm flags', async () => {
  const f = await setup()
  expect(f.stage.launch.args).not.toContain('--prefer-dedupe')
  await f.stage.discard()
  const deduped = await f.cache.stage(instance, provider, { ...plan, preferDedupe: true }, () => {})
  try {
    expect(deduped.launch.args.slice(-3)).toEqual(['--prefer-dedupe', '--', '@fixture/cli@1.2.3'])
    expect(deduped.launch.env?.NPM_CONFIG_USERCONFIG).not.toBe(process.env.NPM_CONFIG_USERCONFIG)
  } finally { await deduped.discard() }
})

it('isolates declared native home variables during postinstall and version probing', async () => {
  const f = await setup()
  await f.stage.discard()
  const stage = await f.cache.stage(instance, provider, { ...plan, nativeHomeEnv: ['GROK_HOME', 'PI_CODING_AGENT_DIR'] }, () => {})
  try {
    const home = stage.launch.env!.HOME
    expect(stage.launch.env).toMatchObject({ GROK_HOME: join(home, 'native'), PI_CODING_AGENT_DIR: join(home, 'native') })
    expect(await readdir(home)).toContain('native')
  } finally { await stage.discard() }
})

it('prefixes host CLI arguments while preserving explicit custom launch precedence', () => {
  const nativeCli = { state: 'ready' as const, command: '/node', args: ['/private/cli.js'] }
  expect(nativeAgentLaunch('fixture', { args: ['--flag'] }, { nativeCli })).toEqual({ command: '/node', args: ['/private/cli.js', '--flag'] })
  expect(nativeAgentLaunch('fixture', { command: '/custom', args: ['--flag'] }, { nativeCli })).toEqual({ command: '/custom', args: ['--flag'] })
  expect(nativeAgentLaunch('fixture', { args: ['--flag'] }, {})).toEqual({ command: 'fixture', args: ['--flag'] })
})
