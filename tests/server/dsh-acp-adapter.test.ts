import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, expect, it, vi } from 'vitest'
import { writeDshAcpAdapter } from '../../packages/server/src/modules/coding-agents/services/dsh/acp-adapter'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
async function fixture(version: string, transform = (source: string) => source, layout: 'hoisted' | 'nested' | 'profile' = 'hoisted') {
  const root = await mkdtemp(join(tmpdir(), 'dsh-adapter-compat-')); roots.push(root)
  const acpAppDirectory = join(root, layout === 'profile' ? 'native/profiles/web' : '', 'node_modules/@deepseek-ai/dsh-acp-app')
  await mkdir(acpAppDirectory, { recursive: true })
  await writeFile(join(acpAppDirectory, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-acp-app', version }))
  const dependencyRoot = layout === 'hoisted' ? root : acpAppDirectory
  const pkg = join(dependencyRoot, 'node_modules/@deepseek-ai/dsh-acp')
  await mkdir(join(pkg, 'lib'), { recursive: true })
  await writeFile(join(pkg, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-acp', version }))
  const source = transform(await readFile(new URL('../fixtures/dsh-acp-compatible.mjs', import.meta.url), 'utf8'))
  await writeFile(join(pkg, 'lib/index.js'), source)
  await writeFile(join(pkg, 'LICENSE'), 'Fixture license')
  for (const [name, method, property] of [
    ['dsh-sandbox-policy', 'setSandboxMode', 'sandbox'], ['dsh-user-approval', 'setApprovalPolicy', 'approval'],
  ]) {
    const path = join(dependencyRoot, 'node_modules/@deepseek-ai', name)
    await mkdir(path, { recursive: true })
    await writeFile(join(path, 'package.json'), JSON.stringify({ type: 'module', main: 'index.js' }))
    await writeFile(join(path, 'index.js'), `export function ${method}(session, value) { session.${property} = value }`)
  }
  return { root, pkg, source, acpAppDirectory, installation: join(root, 'package.json'), destination: join(root, 'adapter.mjs') }
}

it.each(['0.1.5-rc.2', '0.2.0', '9.0.0-beta.1'])('adapts compatible ACP %s without a version or whole-file hash allowlist', async version => {
  const input = await fixture(version, source => source + '\nexport const unrelatedNewFeature = true;\n')
  await writeDshAcpAdapter(input.installation, input.destination, input.acpAppDirectory)
  const adapter = await import(pathToFileURL(input.destination).href)
  const mount = vi.fn(), flush = vi.fn()
  const ctx = { llm: {}, agentPresets: { defaultId: 'standard', mount }, sessions: { flush } }
  const options = adapter.newOptions({}, { _meta: { agentPreset: 'custom' } })
  expect(options.agentPreset).toBe('custom')
  const created = await adapter.create(ctx, { ...options, cwd: '/workspace' })
  expect(created.metadata.meta).toEqual({ cwd: '/workspace', agentPreset: 'custom' })
  expect(mount).toHaveBeenCalledWith(expect.anything(), 'custom')
  const resumed = adapter.resumeOptions(ctx, {}, { agentPreset: 'saved' }, 'native-1')
  await adapter.restore(ctx, resumed)
  expect(mount).toHaveBeenLastCalledWith(expect.anything(), 'saved')
  const agent = { session: {}, whenIdle: vi.fn() }
  const session = new adapter.Session(ctx, agent, {})
  await session.settle({ messageQueued: true })
  expect(flush).toHaveBeenCalledWith(agent.session)
  expect(agent.session).toEqual({ sandbox: 'danger-full-access', approval: 'never' })
  expect(adapter.unrelatedNewFeature).toBe(true)
  expect(await readFile(join(input.pkg, 'lib/index.js'), 'utf8')).toBe(input.source)
  expect(await readFile(input.destination, 'utf8')).toContain(`upstream ${version} (MIT); source sha256`)
})

it.each([
  ['preset mounting', (source: string) => source.replaceAll('await mountAcpMcpServers(agentCtx, options.mcpServers, options.cwd);', '')],
  ['session permission policy', (source: string) => source + '\nfunction ambiguous() { this.modelControl = modelControl; }\n'],
] as const)('reports incompatible %s before replacing the private copy', async (capability, transform) => {
  const input = await fixture('0.2.0', transform)
  await writeFile(input.destination, 'previous adapter')
  await expect(writeDshAcpAdapter(input.installation, input.destination, input.acpAppDirectory)).rejects.toMatchObject({
    code: 'DSH_CAPABILITY_UNSUPPORTED', message: expect.stringContaining(capability),
  })
  expect(await readFile(input.destination, 'utf8')).toBe('previous adapter')
  expect(await readFile(join(input.pkg, 'lib/index.js'), 'utf8')).toBe(input.source)
})

it.each(['nested', 'profile'] as const)('resolves ACP and its imports from the selected %s bundle', async layout => {
  const input = await fixture('0.1.5-rc.3', source => source, layout)
  await writeDshAcpAdapter(input.installation, input.destination, input.acpAppDirectory)
  const adapter = await import(pathToFileURL(input.destination).href)
  const agent = { session: {} }
  new adapter.Session({}, agent, {})
  expect(agent.session).toEqual({ sandbox: 'danger-full-access', approval: 'never' })
  expect(await readFile(input.destination, 'utf8')).toContain('upstream 0.1.5-rc.3 (MIT)')
  expect(await readFile(join(input.pkg, 'lib/index.js'), 'utf8')).toBe(input.source)
})

it('prefers the bundle-owned ACP over another copy visible to the CLI', async () => {
  const input = await fixture('0.1.5-rc.3', source => source, 'nested')
  const other = join(input.root, 'node_modules/@deepseek-ai/dsh-acp')
  await mkdir(join(other, 'lib'), { recursive: true })
  await writeFile(join(other, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-acp', version: '0.1.5-rc.2' }))
  await writeFile(join(other, 'lib/index.js'), 'incompatible ACP copy')
  await writeDshAcpAdapter(input.installation, input.destination, input.acpAppDirectory)
  expect(await readFile(input.destination, 'utf8')).toContain('upstream 0.1.5-rc.3 (MIT)')
  expect(await readFile(join(other, 'lib/index.js'), 'utf8')).toBe('incompatible ACP copy')
})

it('still reports a missing ACP dependency before replacing the private adapter', async () => {
  const input = await fixture('0.1.5-rc.3', source => source, 'nested')
  await rm(input.pkg, { recursive: true })
  await writeFile(input.destination, 'previous adapter')
  await expect(writeDshAcpAdapter(input.installation, input.destination, input.acpAppDirectory)).rejects.toMatchObject({
    code: 'DSH_DEPENDENCY_UNAVAILABLE', message: expect.stringContaining('@deepseek-ai/dsh-acp'),
  })
  expect(await readFile(input.destination, 'utf8')).toBe('previous adapter')
})
