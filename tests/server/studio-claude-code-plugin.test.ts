import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest'
import { buildClaudeFixture, claudeCaller as caller, claudeProtocolFixture, setupClaude } from '../fixtures/claude-plugin-harness'
import { StudioError, type AgentRunContext, type AgentRuntimeContext, type ModelGatewayHandle, type ProcessSpawnInput } from '../../packages/studio-plugin-sdk/src'
import { PluginCommands } from '../../packages/server/src/modules/studio/services/commands/plugin'
import { PluginCommandStore } from '../../packages/server/src/modules/studio/repositories/plugin-command-store'
import { createNativeAgentContext } from '../../packages/server/src/modules/studio/services/agents/native-context'
import { runMcpCredentials } from '../../packages/server/src/modules/studio/services/auth/run-mcp-credentials'
import { ManagedProcessScope } from '../../packages/server/src/modules/studio/services/processes/managed'
import { createClaudeRuntime } from '../../plugins/claude-code/src/runtime'

let root: string, runner: string
const cleanups: Array<() => Promise<void>> = []
beforeAll(async () => { root = await mkdtemp(join(tmpdir(), 'studio-claude-worker-中文 ')); vi.stubEnv('HERMES_WEB_UI_HOME', join(root, 'studio-home')); runner = await buildClaudeFixture(root) })
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })
afterAll(async () => { await rm(root, { recursive: true, force: true }); vi.unstubAllEnvs() })

it.each(['global', 'scoped'] as const)('runs, restores and compacts Claude through its independent worker (%s)', async mode => {
  const f = await setupClaude(root, runner, cleanups, mode)
  for (const text of ['hello', 'continue', '/compact preserve this detail']) {
    const run = f.start(text); await f.coordinator.wait(run.id)
    expect(f.coordinator.get(caller, run.id).status).toBe('completed')
    const output = f.coordinator.output(caller, run.id, -1)
    expect(output).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'message.delta', messageId: 'answer', text: 'Claude answer' }),
      expect.objectContaining({ type: 'message.snapshot', messageId: 'answer', text: 'Claude answer' }), expect.objectContaining({ type: 'reasoning.delta', text: 'reason' })]))
    const usage = f.coordinator.usage(caller, run.id)
    expect(usage).toEqual(mode === 'scoped' ? [] : [expect.objectContaining({ model: 'fixture-model', inputTokens: 10, outputTokens: 3, cacheReadTokens: 2, cacheWriteTokens: 1 })])
  }
  const launches = await f.launches(), frames = await f.frames()
  const first = launches[0].args[launches[0].args.indexOf('--session-id') + 1]
  expect(launches.slice(1).map(launch => launch.args[launch.args.indexOf('--resume') + 1])).toEqual([first, first])
  expect(frames.filter(frame => frame.type === 'user').at(-1).message.content).toEqual([{ type: 'text', text: '/compact preserve this detail' }])
  if (mode === 'scoped') {
    expect(launches[0]).toMatchObject({ token: 'temporary-only', base: 'http://127.0.0.1:1/lease' })
    expect(launches[0].root).toContain(join(f.directory, 'state')); expect(f.gateway).toHaveBeenCalledTimes(3)
    expect(f.gateway).toHaveBeenCalledWith(expect.objectContaining({ principal: caller.principal }), { model: 'fixture/model', protocol: 'anthropic' }, expect.any(AbortSignal))
    expect(await readFile(join(launches[0].root, first + '.json'), 'utf8')).not.toContain('temporary-only')
  } else { expect(launches[0].root).toBe(join(f.directory, 'native')); expect(f.gateway).not.toHaveBeenCalled() }
})

it('inspects only native version and does not initialize account files or a conversation', async () => {
  const f = await setupClaude(root, runner, cleanups)
  expect(await f.coordinator.inspectInstance(caller, f.instance.id)).toMatchObject({ native: { name: 'Claude Code', version: '2.1.310' },
    authentication: { state: 'unknown', methods: [{ id: 'native-login', name: 'Claude Code native login' }] }, models: { status: 'unsupported', items: [] } })
  expect(await f.launches()).toEqual([expect.objectContaining({ args: ['--version'] })])
  await expect(readFile(join(f.directory, 'native/.claude.json'))).rejects.toMatchObject({ code: 'ENOENT' })
  await expect(readFile(f.trace)).rejects.toMatchObject({ code: 'ENOENT' })
  expect(f.db.prepare('SELECT count(*) AS count FROM studio_agent_runs').get()?.count).toBe(0)
  const locations = await f.coordinator.resourceLocations(caller, f.instance.id, 1)
  expect(locations.skills.find(source => source.id === 'native-skills')?.path).toBe(join(f.directory, 'native/skills'))
  expect(locations.configs.find(source => source.id === 'workspace-config-2')?.path).toBe(join(f.directory, '.mcp.json'))
  expect(await f.coordinator.setupInstance(caller, f.instance.id, 1)).toMatchObject({ cli: { state: 'available', version: '2.1.310' }, authentication: { kind: 'native', args: expect.arrayContaining(['auth', 'login']) } })
})

it.each(['approval', 'question'] as const)('binds Claude %s answers to their native request and Run', async text => {
  const f = await setupClaude(root, runner, cleanups), run = f.start(text)
  await vi.waitFor(() => expect(f.coordinator.interactions(caller, run.id)).toHaveLength(1))
  const interaction = f.coordinator.interactions(caller, run.id)[0]
  await expect(f.coordinator.respond(caller, run.id, { interactionId: interaction.id, idempotencyKey: 'bad', choiceId: 'forged' })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
  await f.coordinator.respond(caller, run.id, { interactionId: interaction.id, idempotencyKey: 'yes', choiceId: text === 'question' ? '1' : 'allow' })
  await f.coordinator.wait(run.id)
  expect(f.coordinator.get(caller, run.id).status).toBe('completed')
  const response = (await f.frames()).find(frame => frame.type === 'control_response').response.response
  expect(response).toMatchObject(text === 'question' ? { behavior: 'allow', updatedInput: { answers: { 'Which?': 'Second' } } } : { behavior: 'allow', updatedInput: { file_path: 'fixture.txt' } })
  expect(f.coordinator.output(caller, run.id, -1).filter(event => event.type === 'tool.completed')).toHaveLength(1)
})

it('withdraws a native permission that was resolved elsewhere', async () => {
  const f = await setupClaude(root, runner, cleanups), run = f.start('withdraw')
  await f.coordinator.wait(run.id)
  expect(f.coordinator.get(caller, run.id).status).toBe('completed')
  expect(f.coordinator.interactions(caller, run.id)).toEqual([expect.objectContaining({ status: 'withdrawn' })])
  expect((await f.frames()).some(frame => frame.type === 'control_response')).toBe(false)
})

it.each(['crash', 'broken', 'wait', 'late-exit', 'late-error'])('cleans up native %s before another turn', async text => {
  const f = await setupClaude(root, runner, cleanups), run = f.start(text)
  if (text === 'wait') { await vi.waitFor(async () => expect((await f.frames()).some(frame => frame.type === 'user')).toBe(true)); await f.coordinator.cancel(caller, run.id) }
  await f.coordinator.wait(run.id)
  expect(f.coordinator.get(caller, run.id).status).toBe(text === 'wait' ? 'cancelled' : 'failed')
  const next = f.start('hello'); await f.coordinator.wait(next.id)
  expect(f.coordinator.get(caller, next.id).status).toBe('completed')
})

it('keeps a successful native result uncommitted until output drains and the process exits', async () => {
  const f = await setupClaude(root, runner, cleanups), run = f.start('gated-exit')
  await vi.waitFor(() => expect(f.coordinator.output(caller, run.id, -1).some(event => event.type === 'message.snapshot')).toBe(true))
  expect(f.coordinator.get(caller, run.id).status).toBe('running')
  await writeFile(f.trace + '.gate', 'exit')
  await f.coordinator.wait(run.id)
  expect(f.coordinator.get(caller, run.id).status).toBe('completed')
})

it('merges managed MCP and host instructions without replacing native settings and removes temporary launch configuration', async () => {
  const f = await setupClaude(root, runner, cleanups, 'global', { systemPrompt: 'Saved instructions', mcpServers: { managed: { command: 'managed-cli', args: [], env: { ELECTRON_RUN_AS_NODE: '1' } } } })
  await mkdir(join(f.directory, 'native'), { recursive: true })
  const settings = '{"permissions":{"ask":["Write"]},"theme":"native-choice"}'
  await writeFile(join(f.directory, 'native/settings.json'), settings)
  await writeFile(join(f.directory, 'native/hermes-rules.md'), 'Native editable instructions')
  await writeFile(join(f.directory, 'native/mcp.json'), JSON.stringify({ mcpServers: { original: { command: 'user-owned-cli' } } }))
  const run = f.start('hello'); await f.coordinator.wait(run.id)
  expect(f.coordinator.get(caller, run.id).status).toBe('completed')
  expect(await readFile(join(f.directory, 'native/settings.json'), 'utf8')).toBe(settings)
  const launch = (await f.launches())[0]
  expect(launch.mcp.mcpServers).toEqual({ original: { command: 'user-owned-cli' }, managed: { command: 'managed-cli', args: [], env: { ELECTRON_RUN_AS_NODE: '1' } } })
  await expect(readFile(launch.args[launch.args.indexOf('--mcp-config') + 1])).rejects.toMatchObject({ code: 'ENOENT' })
  expect((await f.frames())[0].request.appendSystemPrompt).toBe('Native editable instructions\n\nSaved instructions')
})

it('discovers dynamic commands and forwards namespace/alias selections with their original argument tail through the worker', async () => {
  const f = await setupClaude(root, runner, cleanups), sessionId = 'fixture:commands', chat = { ...caller, surface: 'chat' as const, sessionId }
  const initial = f.coordinator.start(chat, f.instance.id, { content: [{ type: 'text', text: 'hello' }] }, 'initial', undefined, { kind: 'chat', sessionId })
  await f.coordinator.wait(initial.id)
  expect(f.coordinator.get(caller, initial.id).status).toBe('completed')
  const target = { agentTypeId: 'claude-code', fingerprint: 'fixture-target', isWorking: false, instanceId: f.instance.id, instanceRevision: 1 }
  const commands = new PluginCommands({ registry: f.host.commands, store: new PluginCommandStore(f.db), authorize: () => target,
    context: f.context, persist: () => undefined, publish() {} })
  cleanups.push(async () => { await commands.close() })
  const catalog = commands.list(chat, sessionId), help = catalog.find(command => command.name === 'help')!, compact = catalog.find(command => command.name === 'compact')!
  expect(help).toMatchObject({ aliases: ['assist'], argsHint: '[topic]' })
  const tail = '  "quoted value"\nnext line'
  for (const [selected, text, expected] of [[help, `/${help.qualifiedName}${tail}`, '/help' + tail], [help, '/assist topic', '/help topic'], [compact, '/compact keep the details', '/compact keep the details']] as const) {
    const started = commands.start(chat, { sessionId, commandId: selected.id, revision: selected.revision, text, idempotencyKey: text })
    await vi.waitFor(() => expect(commands.get(chat, started.id).status).toBe('completed'))
    expect(commands.get(chat, started.id).results).toEqual([expect.objectContaining({ action: 'submitted', ok: true, terminal: false })])
    await f.coordinator.wait(f.commandRuns.at(-1)!)
    expect((await f.frames()).filter(frame => frame.type === 'user').at(-1).message.content).toEqual([{ type: 'text', text: expected }])
  }
})

it('keeps two host chat conversations on distinct native sessions while restoring only their own history', async () => {
  const f = await setupClaude(root, runner, cleanups)
  for (const [index, sessionId] of ['fixture:a', 'fixture:b', 'fixture:a'].entries()) {
    const run = f.coordinator.start({ ...caller, surface: 'chat', sessionId }, f.instance.id, { content: [{ type: 'text', text: 'hello' }] }, `chat-${index}`, undefined, { kind: 'chat', sessionId })
    await f.coordinator.wait(run.id)
    expect(f.coordinator.get(caller, run.id).status).toBe('completed')
  }
  const launches = await f.launches(), nativeIds = launches.map(launch => launch.args[launch.args.indexOf(launch.args.includes('--resume') ? '--resume' : '--session-id') + 1])
  expect(nativeIds[0]).not.toBe(nativeIds[1]); expect(nativeIds[2]).toBe(nativeIds[0])
})

it('does not charge a failed native turn again when restoring its original successful checkpoint', async () => {
  const f = await setupClaude(root, runner, cleanups), usage: number[] = []
  for (const text of ['hello', 'late-exit', 'hello']) {
    const run = f.start(text); await f.coordinator.wait(run.id)
    expect(f.coordinator.get(caller, run.id).status).toBe(text === 'late-exit' ? 'failed' : 'completed')
    usage.push(f.coordinator.usage(caller, run.id).reduce((sum, item) => sum + (item.inputTokens || 0), 0))
  }
  expect(usage).toEqual([10, 10, 10])
  const frames = await f.frames()
  expect(frames.filter(frame => frame.request?.subtype === 'get_usage')).toHaveLength(3)
  const launches = await f.launches(), nativeId = launches[0].args[launches[0].args.indexOf('--session-id') + 1]
  expect(launches.slice(1).map(launch => launch.args[launch.args.indexOf('--resume') + 1])).toEqual([nativeId, nativeId])
})

it('assembles native completed text blocks that share a message id and deduplicates repeated block deliveries', async () => {
  const f = await setupClaude(root, runner, cleanups), run = f.start('multiblock'); await f.coordinator.wait(run.id)
  expect(f.coordinator.get(caller, run.id).status).toBe('completed')
  const snapshots = f.coordinator.output(caller, run.id, -1).filter(event => event.type === 'message.snapshot')
  expect(snapshots).toEqual([expect.objectContaining({ messageId: 'answer', text: 'Claude ' }), expect.objectContaining({ messageId: 'answer', text: 'Claude answer' })])
})

it('rejects scoped credential overrides before native admission and preserves the editable configuration', async () => {
  const f = await setupClaude(root, runner, cleanups, 'scoped'), resources = await f.coordinator.resourceLocations(caller, f.instance.id, 1)
  const path = resources.configs.find(source => source.id === 'native-settings')!.path
  await mkdir(join(path, '..'), { recursive: true })
  const content = JSON.stringify({ env: { ANTHROPIC_API_KEY: 'private-native-key' }, permissions: { ask: ['Write'] } })
  await writeFile(path, content)
  const denied = f.start('hello'); await f.coordinator.wait(denied.id)
  expect(f.coordinator.get(caller, denied.id)).toMatchObject({ status: 'failed', errorCode: 'CAPABILITY_UNSUPPORTED' })
  expect(await readFile(path, 'utf8')).toBe(content)
  await expect(readFile(f.trace + '.launches')).rejects.toMatchObject({ code: 'ENOENT' })
  expect(JSON.stringify(f.coordinator.output(caller, denied.id, -1))).not.toContain('private-native-key')
  await writeFile(path, '{"theme":"native-choice","env":{"ANTHROPIC_BASE_URL":"https://unused.invalid"}}')
  const next = f.start('hello'); await f.coordinator.wait(next.id)
  expect(f.coordinator.get(caller, next.id).status).toBe('completed')
  const launch = (await f.launches())[0], overlay = JSON.parse(launch.args[launch.args.indexOf('--settings') + 1])
  expect(overlay.env.ANTHROPIC_BASE_URL).toBe('http://127.0.0.1:1/lease')
  expect(JSON.stringify(launch.args)).not.toContain('temporary-only')
})

it('consumes host-owned Studio MCP credentials for only the active Run and removes native launch files after success and cancellation', async () => {
  let f: Awaited<ReturnType<typeof setupClaude>>
  f = await setupClaude(root, runner, cleanups, 'global', { studioMcp: { enabled: true, browser: false, devices: false, use: false },
    mcpServers: { 'ekko-studio-api': { command: 'must-not-receive-credentials', env: { PRIVATE: 'must-not-forward' } } } },
  (instance: any, scope: any, _provider: any, signal: AbortSignal) => createNativeAgentContext(instance, scope, signal, runId => {
    if (!['starting', 'running', 'waiting_input'].includes(f.executions.get(runId)?.status || '')) throw new Error('Run ended')
  }))
  let prior: string | undefined
  for (const cancel of [false, true]) {
    const run = f.start('approval')
    await vi.waitFor(() => expect(f.coordinator.get(caller, run.id).status).toBe('waiting_input'))
    const launch = (await f.launches()).at(-1), injected = launch.mcp.mcpServers['ekko-studio-api']
    expect(injected.command).not.toBe('must-not-receive-credentials')
    expect(injected.env).toMatchObject({ ELECTRON_RUN_AS_NODE: '1', HERMES_WEB_UI_PROFILE: 'one', HERMES_WEB_UI_TOKEN: '', AUTH_TOKEN: '' })
    expect(injected.env).not.toHaveProperty('PRIVATE')
    const file = injected.env.HERMES_WEB_UI_RUN_TOKEN_FILE, credential = JSON.parse(await readFile(file, 'utf8'))
    expect(credential.token).not.toBe(prior); prior = credential.token
    expect(runMcpCredentials.authenticate(credential.token)).toMatchObject({ userId: 7, profile: 'one', sessionId: `agent-run:${run.id}` })
    const frames = await f.frames()
    expect(JSON.stringify(frames.findLast(frame => frame.request?.subtype === 'initialize'))).toContain('context_id=')
    if (cancel) await f.coordinator.cancel(caller, run.id)
    else {
      const question = f.coordinator.interactions(caller, run.id)[0]
      await f.coordinator.respond(caller, run.id, { interactionId: question.id, idempotencyKey: 'allow', choiceId: 'allow' })
    }
    await f.coordinator.wait(run.id)
    expect(f.coordinator.get(caller, run.id).status).toBe(cancel ? 'cancelled' : 'completed')
    expect(runMcpCredentials.authenticate(credential.token)).toBeUndefined()
    await expect(readFile(file)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(readFile(launch.args[launch.args.indexOf('--mcp-config') + 1])).rejects.toMatchObject({ code: 'ENOENT' })
    expect(JSON.stringify(await f.frames())).not.toContain(credential.token)
  }
})

it('fails explicitly when native history is missing rather than starting a replacement conversation', async () => {
  const f = await setupClaude(root, runner, cleanups), first = f.start('hello'); await f.coordinator.wait(first.id)
  const launch = (await f.launches())[0], session = launch.args[launch.args.indexOf('--session-id') + 1]
  await rm(join(launch.root, session + '.json'))
  const second = f.start('continue'); await f.coordinator.wait(second.id)
  expect(f.coordinator.get(caller, second.id).status).toBe('failed')
  expect((await f.launches())[1].args).toContain('--resume')
})

it('rejects foreign and revoked execution scopes before starting the native CLI', async () => {
  const f = await setupClaude(root, runner, cleanups)
  expect(() => f.coordinator.start({ ...caller, profileId: 'foreign' }, f.instance.id, { content: [{ type: 'text', text: 'hello' }] }, 'foreign')).toThrow()
  f.authorize.mockImplementation(() => { throw new StudioError('FORBIDDEN', 'Revoked') })
  expect(() => f.start('hello')).toThrow(expect.objectContaining({ code: 'FORBIDDEN' }))
  await expect(readFile(f.trace + '.launches')).rejects.toMatchObject({ code: 'ENOENT' })
})

it.each(['process', 'gateway', 'prepared'] as const)('makes the runtime unavailable after %s cleanup fails, while still attempting the remaining cleanup', async phase => {
  const directory = await mkdtemp(join(root, `cleanup-${phase}-`)), stateDirectory = join(directory, 'state'), cli = join(directory, 'cli.cjs')
  await writeFile(cli, claudeProtocolFixture)
  const signal = new AbortController().signal, processes = new ManagedProcessScope(signal, () => {}), failure = new Error(`${phase} cleanup was not confirmed`)
  let launchFile: string | undefined, replaced = false
  const spawn = vi.fn(async (input: ProcessSpawnInput) => {
    launchFile = input.args[input.args.indexOf('--mcp-config') + 1]
    const handle = await processes.api.spawn(input)
    return { ...handle, read: () => handle.read(), write: (data: Uint8Array) => handle.write(data), end: () => handle.end(), stop: () => handle.stop(), dispose: async () => {
      await handle.dispose()
      if (phase === 'process') throw failure
      if (phase === 'prepared' && !replaced) {
        replaced = true
        // Native has finished reading its launch file. Replacing it with a
        // directory makes the real nonrecursive cleanup fail deterministically.
        await rm(launchFile!, { force: true }); await mkdir(launchFile!); await writeFile(join(launchFile!, 'retained'), 'cleanup failure fixture')
      }
    } }
  })
  const gatewayDispose = vi.fn(async () => { if (phase === 'gateway') throw failure })
  const gateway = vi.fn(async (): Promise<ModelGatewayHandle> => ({ baseUrl: 'http://127.0.0.1:1/lease/v1', token: 'temporary-only', model: 'fixture-model', protocol: 'anthropic', images: true, dispose: gatewayDispose }))
  const native = createClaudeRuntime({ instanceId: 'cleanup', configRevision: 1, mode: 'scoped', config: {
    cwd: directory, command: process.execPath, args: [cli], model: 'fixture-model', env: { TRACE: join(directory, 'trace') },
    mcpServers: { fixture: { command: 'unused-native-fixture-server', env: { ELECTRON_RUN_AS_NODE: '1' } } },
  } }, { stateDirectory, signal, runtimeSessionId: 'cleanup-lease', processes: { spawn }, logger: { info() {}, warn() {}, error() {} } } as unknown as AgentRuntimeContext)
  cleanups.push(async () => { await native.dispose(); await processes.close() })
  const context = { signal, scope: { ...caller, runId: 'cleanup-run', runtimeSessionId: 'cleanup-lease' }, models: { gateway } } as unknown as AgentRunContext
  const run = await native.run({ content: [{ type: 'text', text: 'hello' }] }, context), output: unknown[] = []
  const drained = (async () => { for await (const event of run.events) output.push(event) })()
  if (phase === 'prepared') await expect(run.result).rejects.toMatchObject({ code: 'ERR_FS_EISDIR' })
  else await expect(run.result).rejects.toBe(failure)
  await drained
  expect(output).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'message.snapshot', text: 'Claude answer' })]))
  expect(gatewayDispose).toHaveBeenCalledTimes(1)
  await expect(native.run({ content: [{ type: 'text', text: 'must not run' }] }, context)).rejects.toMatchObject({ code: 'RUNTIME_UNAVAILABLE' })
  expect(spawn).toHaveBeenCalledTimes(1); expect(gateway).toHaveBeenCalledTimes(1)
  if (phase === 'prepared') expect(await readFile(join(launchFile!, 'retained'), 'utf8')).toBe('cleanup failure fixture')
  else await expect(readFile(launchFile!)).rejects.toMatchObject({ code: 'ENOENT' })
})

it('does not publish a newer checkpoint when native success is followed by gateway cleanup failure', async () => {
  const f = await setupClaude(root, runner, cleanups, 'scoped'), first = f.start('hello'); await f.coordinator.wait(first.id)
  const provider = f.coordinator.get(caller, first.id).provider, checkpoint = f.executions.state.checkpoint(f.instance.id, provider, f.instance.revision)
  expect(checkpoint).toEqual({ sessionId: expect.any(String) })
  const original = f.gateway.getMockImplementation()!
  f.gateway.mockImplementation(async () => ({ ...await original(), dispose: async () => { throw new StudioError('RUNTIME_UNAVAILABLE', 'Gateway cleanup was not confirmed') } }))
  const second = f.start('continue'); await f.coordinator.wait(second.id)
  expect(f.coordinator.get(caller, second.id)).toMatchObject({ status: 'failed', errorCode: 'RUNTIME_UNAVAILABLE' })
  expect(f.coordinator.output(caller, second.id, -1)).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'message.snapshot', text: 'Claude answer' })]))
  expect(f.executions.state.checkpoint(f.instance.id, provider, f.instance.revision)).toEqual(checkpoint)
})

it('uses bypassPermissions and answers tool permissions without showing an approval by default', async () => {
  const f = await setupClaude(root, runner, cleanups)
  const { permissionMode: _manual, ...config } = f.instance.config
  await f.coordinator.updateInstance(caller, f.instance.id, { revision: 1, mode: f.instance.mode, config })
  const run = f.start('approval')
  await f.coordinator.wait(run.id)
  expect(f.coordinator.get(caller, run.id).status).toBe('completed')
  expect(f.coordinator.interactions(caller, run.id)).toEqual([])
  expect((await f.launches())[0].args).toEqual(expect.arrayContaining(['--permission-mode', 'bypassPermissions', '--allow-dangerously-skip-permissions']))
  expect((await f.frames()).find(frame => frame.type === 'control_response').response.response).toMatchObject({ behavior: 'allow', updatedInput: { file_path: 'fixture.txt' } })
})
