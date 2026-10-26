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
  ['turn persistence', (source: string) => source.replace('await this.agent.whenIdle();', '')],
  ['turn persistence', (source: string) => source + '\nif (isCancelled() || idleAt(idleSeq)) break;\n\t\t\t\t}\n\t\t\t\tif (isCancelled()) await cancelled;\n'],
] as const)('reports incompatible %s before replacing the private copy', async (capability, transform) => {
  const input = await fixture('0.2.0', transform)
  await writeFile(input.destination, 'previous adapter')
  await expect(writeDshAcpAdapter(input.installation, input.destination, input.acpAppDirectory)).rejects.toMatchObject({
    code: 'DSH_CAPABILITY_UNSUPPORTED', message: expect.stringContaining(capability),
  })
  expect(await readFile(input.destination, 'utf8')).toBe('previous adapter')
  expect(await readFile(join(input.pkg, 'lib/index.js'), 'utf8')).toBe(input.source)
})

async function quiescentFixture(transform = (source: string) => source) {
  const session = await readFile(new URL('../fixtures/dsh-acp-quiescent.mjs', import.meta.url), 'utf8')
  return fixture('0.2.1-rc.2', source => transform(source.replace(/export class Session \{[\s\S]*?\n\}/, session)))
}

async function quiescentSession(flush = vi.fn()) {
  const input = await quiescentFixture()
  await writeDshAcpAdapter(input.installation, input.destination, input.acpAppDirectory)
  const adapter = await import(pathToFileURL(input.destination).href)
  const waitForChildren = vi.fn().mockResolvedValue(false)
  const agent = { session: { seq: 1 }, status: 'idle', whenIdle: vi.fn().mockResolvedValue(undefined) }
  const ctx = { get: vi.fn().mockReturnValue({ waitForChildren }), sessions: { flush } }
  const session = new adapter.Session(ctx, agent, {})
  const completion = Promise.withResolvers<string>()
  const inflight = { messageQueued: true, admissionDone: Promise.resolve(), admissionController: new AbortController(),
    cancellationDone: Promise.withResolvers(), endReason: { kind: 'end_turn' }, resolve: completion.resolve, reject: completion.reject }
  session.inflight = inflight
  return { input, session, agent, inflight, completion, flush, waitForChildren }
}

it('flushes ACP 0.2.1-rc.2 only after descendants and output drain, and before completing the prompt', async () => {
  const flushDone = Promise.withResolvers()
  const state = await quiescentSession(vi.fn().mockReturnValue(flushDone.promise))
  const childrenDone = Promise.withResolvers<boolean>(), outputDone = Promise.withResolvers()
  state.waitForChildren.mockReturnValueOnce(childrenDone.promise)
  state.session.outputTail = outputDone.promise
  state.session.settleAfterQuiescence(state.inflight)
  state.session.settleAfterQuiescence(state.inflight)
  await vi.waitFor(() => expect(state.waitForChildren).toHaveBeenCalledTimes(1))
  expect(state.flush).not.toHaveBeenCalled()
  childrenDone.resolve(true)
  await vi.waitFor(() => expect(state.waitForChildren).toHaveBeenCalledTimes(2))
  expect(state.flush).not.toHaveBeenCalled()
  outputDone.resolve()
  await vi.waitFor(() => expect(state.flush).toHaveBeenCalledTimes(1))
  expect(state.flush).toHaveBeenCalledWith(state.agent.session)
  expect(state.session.inflight).toBe(state.inflight)
  flushDone.resolve()
  await expect(state.completion.promise).resolves.toBe('end_turn')
  expect(state.session.inflight).toBeUndefined()
  expect(await readFile(join(state.input.pkg, 'lib/index.js'), 'utf8')).toBe(state.input.source)
})

it('flushes a cancelled queued prompt after cancellation drains', async () => {
  const state = await quiescentSession()
  state.inflight.admissionController.abort()
  state.session.settleAfterQuiescence(state.inflight)
  await vi.waitFor(() => expect(state.agent.whenIdle).toHaveBeenCalled())
  expect(state.flush).not.toHaveBeenCalled()
  state.inflight.cancellationDone.resolve()
  await expect(state.completion.promise).resolves.toBe('cancelled')
  expect(state.flush).toHaveBeenCalledExactlyOnceWith(state.agent.session)
})

it('does not flush a prompt that never queued a message', async () => {
  const state = await quiescentSession()
  state.inflight.messageQueued = false
  state.inflight.admissionController.abort()
  state.session.settleAfterQuiescence(state.inflight)
  await expect(state.completion.promise).resolves.toBe('cancelled')
  expect(state.agent.whenIdle).not.toHaveBeenCalled()
  expect(state.flush).not.toHaveBeenCalled()
})

it('rejects prompt completion when persistence fails', async () => {
  const state = await quiescentSession(vi.fn().mockRejectedValue(new Error('disk full')))
  state.session.settleAfterQuiescence(state.inflight)
  await expect(state.completion.promise).rejects.toThrow('prompt settlement failed: disk full')
  expect(state.session.inflight).toBeUndefined()
})

it.each([
  (source: string) => source.replace('if (isCancelled()) await cancelled;', ''),
  (source: string) => source + '\nif (isCancelled() || idleAt(idleSeq)) break;\n\t\t\t\t}\n\t\t\t\tif (isCancelled()) await cancelled;\n',
])('rejects a missing or ambiguous quiescent persistence point without replacing the adapter', async transform => {
  const input = await quiescentFixture(transform)
  await writeFile(input.destination, 'previous adapter')
  await expect(writeDshAcpAdapter(input.installation, input.destination, input.acpAppDirectory)).rejects.toMatchObject({
    code: 'DSH_CAPABILITY_UNSUPPORTED', message: expect.stringContaining('turn persistence'),
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
