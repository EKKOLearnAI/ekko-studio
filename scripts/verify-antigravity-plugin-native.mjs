// Actual manually supplied agy, disposable homes, local model only. No account access.
import { createServer } from 'node:http'
import { once } from 'node:events'
import { createRequire } from 'node:module'
import { mkdtemp, mkdir, readFile, writeFile, rm, cp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { build } from 'esbuild'
import sharp from 'sharp'
const project = fileURLToPath(new URL('..', import.meta.url)),
  cli = process.env.STUDIO_ANTIGRAVITY_COMMAND
if (!cli?.startsWith('/')) throw new Error('Set STUDIO_ANTIGRAVITY_COMMAND to the exact manually supplied, verified executable')
const root = await mkdtemp(join(tmpdir(), 'studio-antigravity-acceptance-')),
  modulePath = join(root, 'host.cjs'),
  runner = join(root, 'runner.cjs'),
  artifact = join(root, 'plugin')
await build({
  stdin: {
    contents: `export { AgentCoordinator } from './packages/server/src/modules/studio/services/agents/coordinator';
export { AgentRegistry } from './packages/server/src/modules/studio/services/agents/registry';
export { PluginEventBus } from './packages/server/src/modules/studio/services/events/plugin-events';
export { AgentExecutionStore } from './packages/server/src/modules/studio/repositories/agent-execution-store';
export { PluginStore } from './packages/server/src/modules/studio/repositories/plugin-store';
export { PluginHost } from './packages/server/src/modules/studio/services/plugins/host';
export { createExecutionContext } from './packages/server/src/modules/studio/services/context/execution';
export { PluginModelGateways } from './packages/server/src/modules/studio/services/models/gateway';
export { PluginModelCallStore } from './packages/server/src/modules/studio/repositories/plugin-model-call-store';
export { OpenAIResponsesModelClient } from './packages/ekko-agent/src/model/providers/openai-responses';
export { responsesToGemini } from './packages/studio-agent-drivers/src/protocol/gemini';`,
    resolveDir: project,
    loader: 'ts',
  },
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node24.22.1',
  outfile: modulePath,
  logLevel: 'silent',
  alias: { '@ekko-studio/plugin-sdk': join(project, 'packages/studio-plugin-sdk/src/index.ts') },
})
const {
  AgentCoordinator,
  AgentRegistry,
  PluginEventBus,
  AgentExecutionStore,
  PluginStore,
  PluginHost,
  createExecutionContext,
  PluginModelGateways,
  PluginModelCallStore,
  OpenAIResponsesModelClient,
  responsesToGemini,
} = createRequire(import.meta.url)(modulePath)
await build({
  entryPoints: [join(project, 'packages/studio-plugin-runner/src/main.ts')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node24.22.1',
  outfile: runner,
  logLevel: 'silent',
})
await build({
  entryPoints: [join(project, 'plugins/antigravity/src/index.ts')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node24.22.1',
  outfile: join(artifact, 'dist/index.cjs'),
  logLevel: 'silent',
  alias: {
    '@ekko-studio/plugin-sdk': join(project, 'packages/studio-plugin-sdk/src/index.ts'),
    '@ekko-studio/agent-drivers': join(project, 'packages/studio-agent-drivers/src/index.ts'),
  },
})
await cp(join(project, 'plugins/antigravity/studio-plugin.json'), join(artifact, 'studio-plugin.json'))
const manifest = JSON.parse(await readFile(join(artifact, 'studio-plugin.json'), 'utf8')),
  requests = [],
  nativeRequests = [],
  seenMcp = new Set()
let mode = 'global',
  calls = 0,
  imagePath = '',
  readIssued = false,
  mcpIssued = false
const png = await sharp({ create: { width: 32, height: 32, channels: 3, background: 'red' } })
  .png()
  .toBuffer()
const hasImage = (value) =>
  value &&
  typeof value === 'object' &&
  (['input_image', 'image', 'image_url'].includes(value.type) ||
    String(value.inlineData?.mimeType || '').startsWith('image/') ||
    Object.values(value).some(hasImage))
const mcpFixture = join(root, 'mcp.cjs'),
  mcpTrace = join(root, 'mcp.jsonl')
await writeFile(
  mcpFixture,
  String.raw`require('node:readline').createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);if(m.id===undefined)return;let result={};if(m.method==='initialize')result={protocolVersion:m.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'continuity',version:'1'}};else if(m.method==='tools/list')result={tools:[{name:'continuity',description:'Actual Studio continuity fixture',inputSchema:{type:'object',properties:{}}}]};else if(m.method==='tools/call'){require('node:fs').appendFileSync(process.env.TRACE,'called\n');result={content:[{type:'text',text:'MCP_ACTUAL_OK'}]}};else if(m.method==='prompts/list')result={prompts:[]};else if(m.method==='resources/list'||m.method==='resources/templates/list')result=m.method==='resources/list'?{resources:[]}:{resourceTemplates:[]};process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result})+'\n')})`,
)
function answer(body, gemini) {
  const text = JSON.stringify(gemini ? body.contents : body.input)
  const title = /title generator|Generate a.*title|concise title/i.test(JSON.stringify(body.systemInstruction || body.instructions))
  const tools = gemini ? (body.tools || []).flatMap((value) => value.functionDeclarations || []) : body.tools || []
  const image = /Before answering, open each attached image/.test(text)
  const paths = text.match(/\/[^\s"\\]+\/images\/turn-[^\s"\\]+\/0\.png/g)
  if (paths?.length) imagePath = paths.at(-1)
  const wanted =
    image && !readIssued
      ? tools.find((value) => /^(view_file|read_file)$/.test(value.name))
      : !mcpIssued
        ? tools.find((value) => /continuity$/.test(value.name))
        : undefined
  let output
  if (!title && wanted) {
    const arguments_ = /^(view_file|read_file)$/.test(wanted.name)
      ? Object.fromEntries(
          ((wanted.parameters || wanted.parametersJsonSchema)?.required || []).map((key) => [
            key,
            /path/i.test(key) ? imagePath : /line|offset/i.test(key) ? 1 : 'fixture',
          ]),
        )
      : {}
    if (/^(view_file|read_file)$/.test(wanted.name)) readIssued = true
    else {
      mcpIssued = true
      seenMcp.add(mode)
    }
    output = [
      { type: 'function_call', id: `fc_${calls}`, call_id: `call_${calls}`, name: wanted.name, arguments: JSON.stringify(arguments_) },
    ]
  } else
    output = [
      {
        type: 'message',
        id: `message_${calls}`,
        role: 'assistant',
        status: 'completed',
        content: [{ type: 'output_text', text: title ? 'Local Probe' : 'STUDIO_ANTIGRAVITY_OK', annotations: [] }],
      },
    ]
  return {
    id: `response_${calls}`,
    object: 'response',
    model: 'selected-studio-model',
    status: 'completed',
    output,
    usage: { input_tokens: 12, output_tokens: 5, total_tokens: 17 },
  }
}
const server = createServer(async (req, res) => {
  try {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const body = JSON.parse(Buffer.concat(chunks).toString())
    calls++
    const gemini = req.url.includes('GenerateContent') || req.url.includes('generateContent')
    if (gemini) nativeRequests.push(body)
    else requests.push(body)
    const response = answer(body, gemini)
    if (gemini) {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.end(`data: ${JSON.stringify(responsesToGemini(response))}\n\n`)
    } else {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(response))
    }
  } catch (error) {
    res.writeHead(500)
    res.end(JSON.stringify({ error: { message: error.message } }))
  }
})
server.listen(0, '127.0.0.1')
await once(server, 'listening')
const base = `http://127.0.0.1:${server.address().port}`
const db = new DatabaseSync(':memory:'),
  executions = new AgentExecutionStore(db),
  modelStore = new PluginModelCallStore(db),
  store = new PluginStore(db),
  registry = new AgentRegistry(),
  events = new PluginEventBus()
const logger = {
  info() {},
  warn(message, data) {
    if (process.env.STUDIO_ANTIGRAVITY_DIAGNOSTICS === '1') console.log(message, data)
  },
  error() {},
}
const gateways = new PluginModelGateways({
  store: modelStore,
  state: executions.state,
  authorize() {},
  resolve: async () => {
    const client = new OpenAIResponsesModelClient({
      id: 'fixture',
      type: 'custom',
      defaultModel: 'selected-studio-model',
      baseUrl: `${base}/v1`,
      apiKey: 'host-only-fixture',
    })
    return {
      images: true,
      transport: 'native',
      request: (body, signal) => client.nativeRequest(body, { model: 'selected-studio-model', messages: [], signal }),
      record: (input) => input.onRecorded?.({ ...input.usage, isEstimated: input.isEstimated }),
    }
  },
})
const caller = { scopeId: 'acceptance', principal: { kind: 'user', id: 'owner' }, profileId: 'one', surface: 'api', traceId: 'acceptance' }
const context = (scope, signal) =>
  createExecutionContext(scope, signal, logger, {
    authorize: async () => {},
    agents: { list: async () => [] },
    sessions: { get: async () => null },
    models: { gateway: (_scope, input) => gateways.open(scope, input, signal) },
    artifacts: {
      read: async (_scope, id, offset) => {
        if (id !== '00000000-0000-0000-0000-000000000001' || offset !== 0) throw new Error('Wrong image')
        return {
          id,
          mediaType: 'image/png',
          byteLength: png.length,
          data: png.toString('base64'),
          offset: 0,
          nextOffset: png.length,
          done: true,
        }
      },
    },
  })
const options = {
  store: executions,
  registry,
  events,
  logger,
  authorize() {},
  validateInput() {},
  context,
  stateRoot: join(root, 'state'),
  settleRun: (id) => gateways.settleRun(id),
}
let coordinator = new AgentCoordinator(options)
const host = new PluginHost({
  store,
  registry,
  events,
  context,
  logger,
  runnerPath: runner,
  artifactsRoot: join(root, 'installed'),
  eventContext: async (_state, _event, signal) => context(caller, signal),
  acceptEvents: async (batch) => {
    for (const event of batch) events.publish(event)
  },
})
try {
  await host.registerSystemArtifact(artifact, manifest.id)
  await host.configure(
    {
      pluginId: manifest.id,
      profileId: caller.profileId,
      ownerId: caller.principal.id,
      enabled: true,
      config: {},
      grants: manifest.requires.capabilities,
    },
    0,
  )
  for (mode of ['global', 'scoped']) {
    const home = join(root, mode)
    await mkdir(join(home, '.gemini/antigravity-cli'), { recursive: true })
    await writeFile(
      join(home, '.gemini/antigravity-cli/settings.json'),
      JSON.stringify({ modelProvider: 'gemini', trustedWorkspaces: [home] }),
    )
    const config = {
      cwd: home,
      command: cli,
      args: ['--log-file', join(root, 'native.log')],
      ...(mode === 'scoped' ? { model: 'fixture/model' } : {}),
      env: {
        HOME: home,
        USERPROFILE: home,
        AGY_CLI_DISABLE_AUTO_UPDATE: '1',
        GEMINI_API_KEY: 'local-global-only',
        GOOGLE_GEMINI_BASE_URL: base,
      },
      mcpServers: { continuity: { command: process.execPath, args: [mcpFixture], env: { ELECTRON_RUN_AS_NODE: '1', TRACE: mcpTrace } } },
    }
    const instance = coordinator.createInstance(caller, { agentTypeId: 'antigravity', mode, config })
    const locations = await coordinator.resourceLocations(caller, instance.id, 1)
    const settings = locations.configs.find((value) => value.id === 'native-settings')
    await mkdir(join(settings.path, '..'), { recursive: true })
    await writeFile(settings.path, JSON.stringify({ modelProvider: 'gemini', trustedWorkspaces: [home] }))
    const setup = await coordinator.setupInstance(caller, instance.id, 1)
    if (setup.cli.state !== 'available') throw new Error('Manual CLI unavailable')
    console.log(JSON.stringify({ mode, version: setup.cli.version, manual: true }))
    let identity
    for (const turn of [0, 1]) {
      readIssued = false
      mcpIssued = false
      const offset = requests.length,
        nativeOffset = nativeRequests.length
      const content = [
        { type: 'text', text: 'Call the continuity MCP tool then reply STUDIO_ANTIGRAVITY_OK.' },
        ...(turn ? [{ type: 'image', artifactId: '00000000-0000-0000-0000-000000000001', mediaType: 'image/png' }] : []),
      ]
      const run = coordinator.start(caller, instance.id, { content, timeoutMs: 20000 }, `${mode}-${turn}`)
      await coordinator.wait(run.id)
      const result = coordinator.get(caller, run.id),
        output = coordinator.output(caller, run.id, -1)
      if (result.status !== 'completed') {
        console.log(JSON.stringify({ result, output }))
        throw new Error(`Native ${mode}/${turn} failed`)
      }
      const checkpoint = executions.state.checkpoint(instance.id, result.provider, 1)
      if (!checkpoint?.nativeSessionId || (identity && identity !== checkpoint.nativeSessionId))
        throw new Error('Native resume identity changed')
      identity = checkpoint.nativeSessionId
      if (!output.some((value) => value.type === 'message.delta' && value.text.includes('STUDIO_ANTIGRAVITY_OK')))
        throw new Error('Actual native answer missing')
      const actualRequests = mode === 'global' ? nativeRequests.slice(nativeOffset) : requests.slice(offset)
      if (turn && !actualRequests.some((value) => JSON.stringify(value.contents || value.input).includes('STUDIO_ANTIGRAVITY_OK')))
        throw new Error('Restored native history did not reach the model')
      if (turn && !actualRequests.some(hasImage)) throw new Error(`Actual native ${mode} image did not reach model`)
      if (turn) {
        const retained = await readFile(imagePath).then(
          () => true,
          (error) => {
            if (error.code === 'ENOENT') return false
            throw error
          },
        )
        if (retained) throw new Error('Temporary native image was not removed')
      }
      if (
        mode === 'scoped' &&
        (actualRequests.some((value) => value.model !== 'selected-studio-model') || !executions.state.usage(run.id).length)
      )
        throw new Error('Selected model routing/accounting failed')
      if (!output.some((value) => value.type === 'tool.completed' && /continuity/.test(value.name)))
        console.log(JSON.stringify({ mode, turn, mcpMissing: true }))
      console.log(
        JSON.stringify({
          mode,
          turn,
          status: result.status,
          nativeResume: !!turn,
          imageForwarded: !!turn,
          mcp: output.some((value) => value.type === 'tool.completed' && /continuity/.test(value.name)),
          modelCalls: actualRequests.length,
          usage: executions.state
            .usage(run.id)
            .map((value) => ({ source: value.source, input: value.inputTokens, output: value.outputTokens })),
        }),
      )
      await coordinator.close()
      coordinator = new AgentCoordinator(options)
    }
  }
  const trace = await readFile(mcpTrace, 'utf8').catch((error) => {
    if (error.code === 'ENOENT') return ''
    throw error
  })
  if (!trace.trim() || trace.trim().split('\n').length < 4)
    throw new Error('Native MCP tools were configured but not exposed or invoked; full native acceptance remains incomplete')
  console.log(JSON.stringify({ passed: true, turns: 4, requests: calls, nativeMcpCalls: trace.trim().split('\n').length }))
} finally {
  await coordinator.close()
  await host.close()
  events.close()
  await gateways.close()
  db.close()
  await new Promise((resolve) => server.close(resolve))
  if (process.env.STUDIO_ANTIGRAVITY_DIAGNOSTICS === '1') console.log('Diagnostic root:', root)
  else await rm(root, { recursive: true, force: true })
}
