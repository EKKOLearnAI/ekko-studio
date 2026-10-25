import sharp from 'sharp'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { buildClaudeFixture, claudeCaller as caller, setupClaude } from '../fixtures/claude-plugin-harness'

const nativeCommand = process.env.STUDIO_CLAUDE_NATIVE_COMMAND
let root: string, runner: string
beforeAll(async () => { if (nativeCommand) { root = await mkdtemp(join(tmpdir(), 'studio-claude-native-中文 ')); runner = await buildClaudeFixture(root) } })
afterAll(async () => { if (root) await rm(root, { recursive: true, force: true }) })

it.runIf(!!nativeCommand).each(['global', 'scoped'] as const)('drives the pinned real Claude executable through its worker against local model/MCP fixtures (%s)', async mode => {
  const cleanups: Array<() => Promise<void>> = [], requests: any[] = [], tools: string[] = [], modelCredentials: Array<{ url: string; apiKey?: string; authorization?: string }> = []
  let calls = 0, wantTool = false, issuedTool = false, summarizing = false
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(chunk)
    const body = JSON.parse(Buffer.concat(chunks).toString() || '{}')
    if (req.url?.includes('count_tokens')) { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"input_tokens":120}'); return }
    if (!req.url?.includes('/messages')) { res.writeHead(404); res.end('{}'); return }
    requests.push(body); modelCredentials.push({ url: req.url!, apiKey: req.headers['x-api-key'] as string | undefined, authorization: req.headers.authorization }); calls++
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' })
    const send = (type: string, data: Record<string, unknown>) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`)
    const tool = (body.tools || []).find((tool: any) => tool.name?.includes('native_probe'))
    const invokeTool = wantTool && !issuedTool && tool
    if (invokeTool) issuedTool = true
    const messageId = `native-message-${calls}`, text = `Native Claude local fixture ${calls}`
    send('message_start', { message: { id: messageId, type: 'message', role: 'assistant', model: body.model, content: [], stop_reason: null,
      usage: { input_tokens: 12, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } } })
    send('content_block_start', { index: 0, content_block: invokeTool ? { type: 'tool_use', id: `native-tool-${calls}`, name: tool.name, input: {} } : { type: 'text', text: '' } })
    send('content_block_delta', { index: 0, delta: invokeTool ? { type: 'input_json_delta', partial_json: '{}' } : { type: 'text_delta', text } })
    send('content_block_stop', { index: 0 })
    if (!invokeTool && !summarizing) {
      // Native stream-json publishes one assistant envelope per completed block.
      send('content_block_start', { index: 1, content_block: { type: 'text', text: '' } })
      send('content_block_delta', { index: 1, delta: { type: 'text_delta', text: ' Second native text block.' } })
      send('content_block_stop', { index: 1 })
    }
    send('message_delta', { delta: { stop_reason: invokeTool ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 5 } })
    send('message_stop', {}); res.end()
  })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  const base = `http://127.0.0.1:${(server.address() as any).port}`
  const image = await sharp({ create: { width: 32, height: 32, channels: 3, background: 'red' } }).png().toBuffer(), imageId = '00000000-0000-0000-0000-000000000001'
  let turns = 0
  try {
      const artifacts = { read: async (_scope: unknown, id: string, offset: number = 0) => {
        expect(id).toBe(imageId); expect(offset).toBe(0)
        return { id, mediaType: 'image/png', byteLength: image.length, data: image.toString('base64'), offset: 0, nextOffset: image.length, done: true }
      } }
      const f = await setupClaude(root, runner, cleanups, mode, { command: nativeCommand!, args: [], model: 'fixture-model' }, undefined, artifacts)
      const mcp = join(f.directory, 'mcp.cjs'), trace = join(f.directory, 'mcp-trace')
      await writeFile(mcp, String.raw`require('node:readline').createInterface({input:process.stdin}).on('line',line=>{const r=JSON.parse(line);if(r.id===undefined)return;require('node:fs').appendFileSync(process.env.MCP_TRACE,JSON.stringify(r)+'\n');const result=r.method==='initialize'?{protocolVersion:r.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'native-fixture',version:'1.0.0'}}:r.method==='tools/list'?{tools:[{name:'native_probe',description:'Local native compatibility fixture',inputSchema:{type:'object',properties:{}}}]}:r.method==='tools/call'?{content:[{type:'text',text:'native MCP success'}]}:{};process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:r.id,result})+'\n')});`)
      const config = { ...f.config, env: { ...f.config.env as Record<string, string>, ANTHROPIC_BASE_URL: base, ANTHROPIC_API_KEY: 'local-fixture-only',
        ENABLE_TOOL_SEARCH: 'false', CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: '1', DISABLE_AUTOUPDATER: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' },
        systemPrompt: 'STUDIO_CLAUDE_INSTRUCTION', mcpServers: { compatibility: { command: process.execPath, args: [mcp], env: { ELECTRON_RUN_AS_NODE: '1', MCP_TRACE: trace } } } }
      let instance = await f.coordinator.updateInstance(caller, f.instance.id, { revision: 1, config, mode })
      f.gateway.mockImplementation(async () => ({ baseUrl: base + '/v1', token: 'scoped-local-only', model: 'fixture-model', protocol: 'anthropic', images: true, dispose: async () => {} } as any))
      const locations = await f.coordinator.resourceLocations(caller, instance.id, instance.revision), nativeRoot = locations.skills.find(source => source.id === 'native-skills')!.path.replace(/\/skills$/, '')
      await mkdir(join(nativeRoot, 'skills/native-compatibility'), { recursive: true })
      await writeFile(join(nativeRoot, 'skills/native-compatibility/SKILL.md'), '---\nname: native-compatibility\ndescription: STUDIO_CLAUDE_SKILL_MARKER\n---\nReply using the local fixture.\n')
      await writeFile(join(nativeRoot, 'CLAUDE.md'), 'STUDIO_CLAUDE_NATIVE_MEMORY')
      if (mode === 'scoped') await writeFile(join(nativeRoot, 'settings.json'), JSON.stringify({ model: 'native-preference-model', env: { ANTHROPIC_API_KEY: 'native-preference-key', ANTHROPIC_BASE_URL: base + '/native-preference' } }))
      const before = await readdir(nativeRoot)
      if (mode === 'global') expect(await f.coordinator.inspectInstance(caller, instance.id)).toMatchObject({ native: { version: '2.1.310' }, authentication: { state: 'unknown' } })
      else await expect(f.coordinator.inspectInstance(caller, instance.id)).rejects.toMatchObject({ code: 'CAPABILITY_UNSUPPORTED' })
      expect(await readdir(nativeRoot)).toEqual(before)
      if (mode === 'scoped') {
        const denied = f.coordinator.start(caller, instance.id, { content: [{ type: 'text', text: 'Must fail before native admission.' }] }, 'blocked-credential-override')
        await f.coordinator.wait(denied.id)
        expect(f.coordinator.get(caller, denied.id)).toMatchObject({ status: 'failed', errorCode: 'CAPABILITY_UNSUPPORTED' })
        expect(requests).toEqual([])
        const stored = JSON.parse(await readFile(join(nativeRoot, 'settings.json'), 'utf8'))
        expect(stored.env.ANTHROPIC_API_KEY).toBe('native-preference-key')
        delete stored.env.ANTHROPIC_API_KEY
        await writeFile(join(nativeRoot, 'settings.json'), JSON.stringify(stored))
      }
      const previous: string[] = []
      for (let turn = 0; turn < 5; turn++) {
        wantTool = turn === 1; issuedTool = false; summarizing = turn === 3
        const offset = requests.length
        const run = f.coordinator.start(caller, instance.id, { content: [{ type: 'text', text: turn === 3 ? '/compact retain the local fixture details' : turn === 2 ? '/native-compatibility retain original arguments' : 'Say a brief greeting.' },
          ...(turn === 1 ? [{ type: 'image' as const, artifactId: imageId, mediaType: 'image/png' }] : [])] }, `native-${mode}-${turn}`)
        let finished = false
        const answer = (async () => {
          while (!finished) {
            for (const interaction of f.coordinator.interactions(caller, run.id).filter(item => item.status === 'pending')) {
              const choice = interaction.choices.find(choice => choice.id === 'allow')
              if (!choice) throw new Error(`Unsupported actual native permission: ${JSON.stringify(interaction)}`)
              await f.coordinator.respond(caller, run.id, { interactionId: interaction.id, idempotencyKey: interaction.id, choiceId: choice.id })
            }
            await new Promise(resolve => setTimeout(resolve, 10))
          }
        })()
        await Promise.all([f.coordinator.wait(run.id).finally(() => { finished = true }), answer])
        const receipt = f.coordinator.get(caller, run.id), output = f.coordinator.output(caller, run.id, -1)
        expect(receipt).toMatchObject({ status: 'completed' })
        expect(output.some(event => event.type === 'message.snapshot' && (turn === 3 ? event.text.includes('Compacted') : event.text.includes('Native Claude local fixture'))), JSON.stringify({ turn, requests: requests.length - offset, output })).toBe(true)
        if (turn !== 3) {
          const last = output.filter(event => event.type === 'message.snapshot').at(-1)!
          expect(last.type === 'message.snapshot' && last.text.includes('Native Claude local fixture') && last.text.includes('Second native text block.')).toBe(true)
        }
        const bodies = requests.slice(offset), nativeInput = JSON.stringify(bodies)
        if (mode === 'scoped') for (const credential of modelCredentials.slice(offset)) {
          expect(credential.url.startsWith('/v1/messages')).toBe(true)
          expect(!credential.apiKey || credential.apiKey === 'scoped-local-only').toBe(true)
          expect(!credential.authorization || credential.authorization === 'Bearer scoped-local-only').toBe(true)
          expect(!!credential.apiKey || !!credential.authorization).toBe(true)
        }
        const usage = f.coordinator.usage(caller, run.id)
        if (mode === 'global') {
          expect(usage.reduce((sum, item) => sum + (item.inputTokens || 0), 0)).toBe(bodies.length * 12)
          expect(usage.reduce((sum, item) => sum + (item.outputTokens || 0), 0)).toBe(bodies.length * 5)
        } else expect(usage).toEqual([])
        if (turn !== 3) {
          expect(nativeInput).toContain('STUDIO_CLAUDE_INSTRUCTION')
          expect(nativeInput).toContain('STUDIO_CLAUDE_NATIVE_MEMORY')
          expect(nativeInput).toContain('STUDIO_CLAUDE_SKILL_MARKER')
        } else expect(bodies.length).toBeGreaterThan(0)
        if (turn && turn !== 3) expect(nativeInput).toContain(previous.at(-1)!)
        if (turn === 1) {
          expect(nativeInput).toContain(image.toString('base64'))
          const mcpTrace = (await readFile(trace, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
          expect(mcpTrace.some(request => request.method === 'tools/call')).toBe(true)
          tools.push(mode)
        }
        previous.push(`Native Claude local fixture ${calls}`); turns++
        if (turn === 0) instance = await f.coordinator.updateInstance(caller, instance.id, { revision: instance.revision, config: { ...instance.config, systemPrompt: 'STUDIO_CLAUDE_INSTRUCTION refreshed' }, mode })
      }
    console.log(JSON.stringify({ mode, nativeVersion: '2.1.310', workerTurns: turns, localModelRequests: calls, realMcpModes: tools }))
  } finally {
    for (const cleanup of cleanups.reverse()) await cleanup()
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
})
