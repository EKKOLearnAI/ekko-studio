import { spawn, type ChildProcess } from 'node:child_process'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { mkdir, mkdtemp, rm, writeFile, readFile, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { stringify } from 'yaml'
import { ProbeRpc } from '../fixtures/dsh-m0/rpc'
import { dshInstallation } from '../../packages/server/src/modules/coding-agents/services/dsh/installation'
import { describe, expect, it } from 'vitest'
import { DshAcpTurn } from '../../packages/server/src/modules/coding-agents/services/dsh/acp-turn'
import { prepareDshRuntime, DSH_API_KEY_ENV, DSH_MODEL_PROVIDER } from '../../packages/server/src/modules/coding-agents/services/dsh/runtime-config'

// Opt-in: exercises the installed CLI against a local Responses fixture, without credentials.
describe.skipIf(process.env.DSH_WEB_REAL !== '1')('installed DSH Web profile over ACP', () => {
  it.each(['scoped', 'global'] as const)('streams, deduplicates and resumes Web presets with %s model selection', async mode => {
    const root = await mkdtemp(join(tmpdir(), 'studio-dsh-real-'))
    const requests: any[] = []
    let releaseStream = () => {}
    let responseFinished = false
    const server = createServer(async (req, res) => {
      let body = ''
      for await (const chunk of req) body += chunk
      requests.push(JSON.parse(body))
      const id = `resp_${requests.length}`
      responseFinished = false
      const released = new Promise<void>(resolve => { releaseStream = resolve })
      const item = { id: `msg_${id}`, type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'DSH 测试通过', annotations: [] }] }
      const response = { id, object: 'response', status: 'completed', model: 'studio-test', output: [item], usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } }
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      for (const event of [
        { type: 'response.created', response: { ...response, status: 'in_progress', output: [] } },
        { type: 'response.output_item.added', output_index: 0, item: { ...item, status: 'in_progress', content: [] } },
        { type: 'response.content_part.added', item_id: item.id, output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } },
        { type: 'response.output_text.delta', item_id: item.id, output_index: 0, content_index: 0, delta: 'DSH ' },
        { type: 'response.output_text.delta', item_id: item.id, output_index: 0, content_index: 0, delta: '测试通过' },
        { type: 'response.output_text.done', item_id: item.id, output_index: 0, content_index: 0, text: 'DSH 测试通过' },
        { type: 'response.output_item.done', output_index: 0, item },
        { type: 'response.completed', response },
      ]) {
        res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
        if (event.type === 'response.output_text.delta' && event.delta === 'DSH ') await released
      }
      responseFinished = true
      res.end()
    })
    const children: ChildProcess[] = []
    try {
      server.listen(0, '127.0.0.1')
      await once(server, 'listening')
      const port = (server.address() as { port: number }).port
      const home = join(root, 'runtime')
      const workspace = join(root, 'workspace')
      await mkdir(workspace)
      await mkdir(join(root, 'empty-home'))
      await writeFile(join(root, 'empty-home', 'settings.yaml'), mode === 'global' ? stringify({
        'agent-default-model': { provider: 'native-web', model: 'studio-test' },
        'llm-pi-ai': { providers: { 'native-web': { apiKeyEnv: DSH_API_KEY_ENV, api: 'openai-responses', baseURL: `http://127.0.0.1:${port}/v1`,
          models: [{ id: 'studio-test', input: ['text'], contextWindow: 128000, maxTokens: 8192, reasoningEfforts: { high: 'high' } }] } } },
      }) : '{}\n')
      const prepared = await prepareDshRuntime({ sourceHome: join(root, 'empty-home'), sharedSkills: join(root, 'shared-skills'),
        installationCommand: process.env.DSH_WEB_COMMAND!, rootDir: home, systemPrompt: 'Answer briefly.', managedMcp: {}, model: mode === 'scoped' ? 'studio-test' : undefined, reasoningEffort: 'high', baseUrl: `http://127.0.0.1:${port}/v1`,
        ...(mode === 'scoped' ? { contextWindow: 128000, outputLimit: 8192,
          contextPolicy: { contextWindow: 128000, outputLimit: 8192, threshold: 0.35, triggerTokens: 44800 } } : {}),
      })
      let nativeSessionId = ''
      for (let round = 0; round < 2; round++) {
        const child = spawn(process.env.DSH_WEB_COMMAND!, prepared.args, {
          cwd: workspace, stdio: ['pipe', 'pipe', 'pipe'],
          env: { PATH: process.env.PATH, HOME: root, ...prepared.env, DSH_TELEMETRY_DISABLED: '1', [DSH_API_KEY_ENV]: 'local-fixture-only' },
        })
        children.push(child)
        const exited = once(child, 'close')
        let stderr = ''
        child.stderr?.on('data', chunk => { stderr += chunk.toString() })
        const updates: any[] = []
        let firstChunkBeforeCompletion = false
        let sawFirstChunk!: () => void
        const firstChunk = new Promise<void>(resolve => { sawFirstChunk = resolve })
        const previousId = nativeSessionId
        const turn = new DshAcpTurn(child, { update: update => {
          updates.push(update)
          if (update.sessionUpdate === 'agent_message_chunk' && update.content.text === 'DSH ') {
            firstChunkBeforeCompletion = !responseFinished
            sawFirstChunk()
          }
        }, session: id => { nativeSessionId = id }, config: () => {} })
        try {
          const prompted = turn.prompt({ cwd: workspace, nativeSessionId: previousId || undefined,
            modelValue: mode === 'scoped' ? JSON.stringify([DSH_MODEL_PROVIDER, 'studio-test']) : undefined, reasoningEffort: 'high', text: `Test round ${round}`, images: [] })
          // A final-only adapter deadlocks here: the fixture cannot finish until
          // the first delta has actually reached Studio's ACP callback.
          const earlyFailure = prompted.then(() => { throw new Error('Prompt ended before its first live delta') })
          let timeout!: ReturnType<typeof setTimeout>
          try {
            await Promise.race([firstChunk, earlyFailure, new Promise<never>((_, reject) => {
              timeout = setTimeout(() => reject(new Error('No live DSH delta before model completion')), 15_000)
            })])
          } finally { clearTimeout(timeout); releaseStream() }
          expect(firstChunkBeforeCompletion).toBe(true)
          expect(await prompted).toBe('end_turn')
          expect(updates.filter(update => update.sessionUpdate === 'agent_message_chunk').map(update => update.content.text).join('')).toBe('DSH 测试通过')
          expect((await exited)[0], stderr).toBe(0)
          if (round) expect(nativeSessionId).toBe(previousId)
        } catch (error) { throw new Error(`${String(error)}\nDSH stderr: ${stderr}`) }
        finally { turn.dispose() }
      }
      expect(requests).toHaveLength(2)
      expect(requests[0].tools.map((tool: any) => tool.name)).toContain('subagent_fork')
      expect(JSON.stringify(requests[0])).toContain('danger-full-access')
      expect(requests[0].reasoning?.effort).toBe('high')
      expect(JSON.stringify(requests[0])).toContain('Answer briefly.')
      expect(requests.every(request => request.model === 'studio-test')).toBe(true)
      expect(JSON.stringify(requests[1].input)).toContain('Test round 0')
      expect(JSON.stringify(requests[1].input)).toContain('DSH 测试通过')
    } finally {
      releaseStream()
      for (const child of children) if (child.exitCode === null) child.kill('SIGKILL')
      server.closeAllConnections()
      await new Promise<void>(resolve => server.close(() => resolve()))
      await rm(root, { recursive: true, force: true })
    }
  }, 90_000)
})

it.skipIf(process.env.DSH_WEB_REAL !== '1')('runs a Web-installed bundle and custom preset, inherits it in a child, and writes outside the workspace without approval', async () => {
  await mkdir('.tmp', { recursive: true })
  const root = await mkdtemp(join(process.cwd(), '.tmp/dsh-web-plugins-'))
  const command = process.env.DSH_WEB_COMMAND!
  const installation = await dshInstallation(command)
  const require = createRequire(installation)
  const home = join(root, 'runtime'), sourceHome = join(root, 'source'), workspace = join(root, 'workspace')
  const profile = join(sourceHome, 'profiles/web')
  const bundle = join(profile, 'node_modules/web-fixture')
  const preset = join(sourceHome, '.agent-presets/custom')
  const outside = join(root, 'outside-workspace.txt')
  const shellOutside = join(root, 'shell-outside.txt')
  const restoredOutside = join(root, 'restored-outside.txt')
  const children: ChildProcess[] = []
  const requests: any[] = []
  const steps: any[] = [
    { name: 'web_probe' },
    { name: 'write', args: { file_path: outside, content: 'outside sandbox' } },
    { name: 'bash', args: { description: 'Write a file outside the workspace', command: `printf shell-access > '${shellOutside.replaceAll("'", "'\"'\"'")}'` } },
    { name: 'subagent', args: { description: 'check inherited Web preset', prompt: 'CHILD_WEB_PRESET_PROBE' } },
    { name: 'custom_preset_probe' },
    { text: 'Child verified' },
    { name: 'restrict_policy' },
    { text: 'Parent verified' },
  ]
  const server = createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk
    requests.push(JSON.parse(body))
    const step = steps.shift()
    if (!step) { res.writeHead(500); res.end('Unexpected model request'); return }
    const id = `resp_${requests.length}`
    const item: any = step.name
      ? { id: `fc_${id}`, type: 'function_call', call_id: `call_${id}`, name: step.name, arguments: JSON.stringify(step.args || {}), status: 'completed' }
      : { id: `msg_${id}`, type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: step.text, annotations: [] }] }
    const response = { id, object: 'response', status: 'completed', model: 'studio-test', output: [item], usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } }
    const events: any[] = [
      { type: 'response.created', response: { ...response, status: 'in_progress', output: [] } },
      { type: 'response.output_item.added', output_index: 0, item: step.name ? { ...item, arguments: '' } : { ...item, content: [] } },
    ]
    if (step.name) events.push({ type: 'response.function_call_arguments.delta', item_id: item.id, output_index: 0, delta: item.arguments },
      { type: 'response.function_call_arguments.done', item_id: item.id, output_index: 0, arguments: item.arguments })
    else events.push({ type: 'response.content_part.added', item_id: item.id, output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } },
      { type: 'response.output_text.delta', item_id: item.id, output_index: 0, content_index: 0, delta: step.text },
      { type: 'response.output_text.done', item_id: item.id, output_index: 0, content_index: 0, text: step.text })
    events.push({ type: 'response.output_item.done', output_index: 0, item }, { type: 'response.completed', response })
    res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''))
  })
  try {
    await Promise.all([workspace, bundle, preset].map(path => mkdir(path, { recursive: true })))
    const manifest = { dependencies: { 'web-fixture': '1.0.0' }, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'web-fixture'] } } }
    await writeFile(join(profile, 'package.json'), JSON.stringify(manifest))
    await writeFile(join(bundle, 'package.json'), JSON.stringify({ name: 'web-fixture', version: '1.0.0', type: 'module', dsh: { bundle: { patch: './cordis.patch.yml' } } }))
    await writeFile(join(bundle, 'cordis.patch.yml'), stringify([{ insert: [{ id: 'web-fixture', name: './plugin.mjs', config: { marker: 'bundle-default' } }] }]))
    await writeFile(join(profile, 'cordis.patch.yml'), stringify([{ id: 'web-fixture', config: { marker: 'WEB_PROFILE_OVERRIDE' } }]))
    await writeFile(join(bundle, 'plugin.mjs'), `
      import { defineTool } from ${JSON.stringify(pathToFileURL(require.resolve('@deepseek-ai/dsh-tools')).href)};
      import { setSandboxMode } from ${JSON.stringify(pathToFileURL(require.resolve('@deepseek-ai/dsh-sandbox-policy')).href)};
      import { setApprovalPolicy } from ${JSON.stringify(pathToFileURL(require.resolve('@deepseek-ai/dsh-user-approval')).href)};
      export const inject = ['tools'];
      export function apply(ctx, config) {
        ctx.tools.register(defineTool({name:'web_probe', description:'Read Web bundle configuration', parameters:{},
          output:{schema:{type:'string'},render:(_args,value)=>[{type:'text',text:value}]},
          execute(){return config.marker}}));
        ctx.tools.register(defineTool({name:'restrict_policy', description:'Restore an older permission mode for the resume test', parameters:{},
          output:{schema:{type:'string'},render:(_args,value)=>[{type:'text',text:value}]},
          execute(_args, exec){setSandboxMode(exec.agent.session,'workspace-write'); setApprovalPolicy(exec.agent.session,'ask'); return 'restricted'}}));
      }
    `)
    // The actual native standard preset supplies delegation and filesystem tools.
    const standard = join(require.resolve('@deepseek-ai/dsh-agent-presets/package.json'), '..', 'presets/standard/agent.cordis.yml')
    await writeFile(join(preset, 'agent.cordis.yml'), (await readFile(standard, 'utf8')).replaceAll('backgroundMode: continuable', 'backgroundMode: one-shot'))
    await writeFile(join(preset, 'agent.cordis.yml'), await readFile(join(preset, 'agent.cordis.yml'), 'utf8') + '\n- id: custom-preset-probe\n  name: ./preset.mjs\n')
    await writeFile(join(preset, 'preset.mjs'), `
      import { defineTool } from ${JSON.stringify(pathToFileURL(require.resolve('@deepseek-ai/dsh-tools')).href)};
      export const inject = ['tools', 'skills'];
      export function apply(ctx) {
        ctx.skills.register({name:'web-custom-skill', description:'CUSTOM_WEB_PRESET_SKILL', content:'custom skill body', source:'bundled'});
        ctx.tools.register(defineTool({name:'custom_preset_probe', description:'Only available in the custom Web preset', parameters:{},
          output:{schema:{type:'string'},render:(_args,value)=>[{type:'text',text:value}]}, execute(){return 'CUSTOM_PRESET_CHILD_TOOL'}}));
      }
    `)
    await writeFile(join(preset, 'preset.yml'), 'name: Custom Web preset\n')
    const settings = 'agent-presets:\n  default: standard\npermission:\n  defaultPreset: workspace-write\n'
    await writeFile(join(sourceHome, 'settings.yaml'), settings)
    server.listen(0, '127.0.0.1'); await once(server, 'listening')
    const input = { sourceHome, sharedSkills: join(root, 'skills'), rootDir: home, installationCommand: command,
      systemPrompt: 'Use tools.', managedMcp: {}, model: 'studio-test', baseUrl: `http://127.0.0.1:${(server.address() as any).port}/v1` }
    const start = async () => {
      const prepared = await prepareDshRuntime(input)
      const child = spawn(command, prepared.args, { cwd: workspace, stdio: ['pipe', 'pipe', 'pipe'],
        env: { PATH: process.env.PATH, HOME: root, ...prepared.env, DSH_TELEMETRY_DISABLED: '1', [DSH_API_KEY_ENV]: 'fixture' } })
      children.push(child)
      const rpc = new ProbeRpc(child)
      await rpc.request('initialize', { protocolVersion: 1, clientCapabilities: {} })
      return rpc
    }
    const rpc = await start()
    const { sessionId } = await rpc.request('session/new', { cwd: workspace, mcpServers: [], _meta: { agentPreset: 'custom' } })
    expect(await rpc.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'Check Web plugin and child.' }] }, 40_000), rpc.stderr).toMatchObject({ stopReason: 'end_turn' })
    expect(await readFile(outside, 'utf8')).toBe('outside sandbox')
    expect(await readFile(shellOutside, 'utf8')).toBe('shell-access')
    expect(JSON.stringify(requests[1].input)).toContain('WEB_PROFILE_OVERRIDE')
    expect(requests.every(request => request.model === 'studio-test')).toBe(true)
    expect(requests[4].tools.map((tool: any) => tool.name)).toContain('custom_preset_probe')
    expect(JSON.stringify(requests[0])).toContain('CUSTOM_WEB_PRESET_SKILL')
    expect(JSON.stringify(requests[5].input)).toContain('CUSTOM_PRESET_CHILD_TOOL')
    expect(rpc.notifications.some(message => message.method === 'session/request_permission')).toBe(false)
    expect(JSON.stringify(requests[4].input)).toContain('CHILD_WEB_PRESET_PROBE')
    expect(steps).toEqual([])
    await rpc.request('session/close', { sessionId }); const exited = once(rpc.child, 'close'); rpc.child.stdin!.end(); await exited
    // Another chat in the same Web profile sees its own selected tool set.
    const minimal = await start()
    const minimalSession = await minimal.request('session/new', { cwd: workspace, mcpServers: [], _meta: { agentPreset: 'minimal' } })
    steps.push({ text: 'Minimal verified' })
    await minimal.request('session/prompt', { sessionId: minimalSession.sessionId, prompt: [{ type: 'text', text: 'Check minimal mode.' }] })
    const minimalTools = requests.at(-1).tools.map((tool: any) => tool.name)
    expect(minimalTools).toContain('web_probe')
    expect(minimalTools).not.toContain('custom_preset_probe')
    expect(minimalTools).not.toContain('write')
    await minimal.request('session/close', { sessionId: minimalSession.sessionId })
    const minimalExit = once(minimal.child, 'close'); minimal.child.stdin!.end(); await minimalExit
    // A changed Web default must not silently change a restored session's tools.
    const logs = await readdir(join(home, 'sessions'), { recursive: true })
    const log = logs.find(path => path.includes(sessionId) && path.endsWith('.jsonl'))!
    const persisted = await readFile(join(home, 'sessions', log), 'utf8')
    expect(persisted.split('\n')[0], rpc.stderr + '\nSETTINGS: ' + await readFile(join(home, 'settings.yaml'), 'utf8')).toContain('custom')
    await writeFile(join(sourceHome, 'settings.yaml'), settings.replace('default: standard', 'default: minimal'))
    steps.push({ name: 'write', args: { file_path: restoredOutside, content: 'restored full access' } }, { text: 'Restored' })
    const restored = await start()
    await restored.request('session/resume', { sessionId, cwd: workspace, mcpServers: [] })
    await restored.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'Continue.' }] })
    expect(requests.at(-1).tools.map((tool: any) => tool.name)).toContain('custom_preset_probe')
    expect(await readFile(restoredOutside, 'utf8').catch(() => JSON.stringify(requests.at(-1).input.filter((item: any) => item.type === 'function_call_output').slice(-1)))).toBe('restored full access')
    expect(restored.notifications.some(message => message.method === 'session/request_permission')).toBe(false)
    expect(await readFile(join(profile, 'package.json'), 'utf8')).toBe(JSON.stringify(manifest))
    expect(await readFile(join(profile, 'cordis.patch.yml'), 'utf8')).toContain('WEB_PROFILE_OVERRIDE')
  } finally {
    for (const child of children) if (child.exitCode === null && child.signalCode === null) { const closed = once(child, 'close'); child.kill('SIGKILL'); await closed }
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()))
    await rm(root, { recursive: true, force: true })
  }
}, 90_000)
