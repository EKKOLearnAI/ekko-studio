// Optional real CLI acceptance against local model fixtures and temporary homes.
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { createHash } from 'node:crypto';
import { DatabaseSync } from "node:sqlite";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import sharp from "sharp";
import { stringify as yamlStringify } from 'yaml';
const project = fileURLToPath(new URL("..", import.meta.url));
async function main() {
  const root = await mkdtemp(join(tmpdir(), "studio-real-plugin-turns-"));
  process.env.HERMES_WEB_UI_HOME = join(root, 'studio-home');
  const mcpFixture = join(root, "mcp-fixture.cjs");
  await writeFile(mcpFixture, String.raw`const readline = require('node:readline');
readline.createInterface({ input: process.stdin }).on('line', line => {
  const message = JSON.parse(line);
  require('node:fs').appendFileSync(process.env.MCP_TRACE_FILE, JSON.stringify({ method: message.method, tool: process.env.MCP_TOOL }) + '\n');
  if (message.id === undefined) return;
  const result = message.method === 'initialize' ? { protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'continuity-fixture', version: '1.0.0' } }
    : message.method === 'tools/list' ? { tools: [{ name: process.env.MCP_TOOL, description: 'Local continuity acceptance fixture', inputSchema: { type: 'object', properties: {} } }] }
    : message.method === 'prompts/list' ? { prompts: [] }
    : message.method === 'resources/list' ? { resources: [] }
    : message.method === 'resources/templates/list' ? { resourceTemplates: [] }
    : message.method === 'tools/call' ? { content: [{ type: 'text', text: 'fixture' }] } : {};
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }) + '\n');
});`);
  const mcpServers = revision => ({ continuity: { command: process.execPath, args: [mcpFixture], env: { ELECTRON_RUN_AS_NODE: '1', MCP_TRACE_FILE: join(root, 'mcp-trace.jsonl'), MCP_TOOL: `continuity_v${revision}` } } });
  const managedModule = join(root, "managed.cjs");
  await build({
    stdin: { contents: `export { AgentCoordinator } from './packages/server/src/modules/studio/services/agents/coordinator';
export { AgentRegistry } from './packages/server/src/modules/studio/services/agents/registry';
export { PluginEventBus } from './packages/server/src/modules/studio/services/events/plugin-events';
export { AgentManagementStore } from './packages/server/src/modules/studio/repositories/agent-management-store';
export { AgentExecutionStore } from './packages/server/src/modules/studio/repositories/agent-execution-store';
export { ManagedProcessScope } from './packages/server/src/modules/studio/services/processes/managed';
export { createNativeAgentContext } from './packages/server/src/modules/studio/services/agents/native-context';
export { runMcpCredentials } from './packages/server/src/modules/studio/services/auth/run-mcp-credentials';
export { config as studioConfig } from './packages/server/src/modules/studio/public/config';
export { PluginModelGateways } from './packages/server/src/modules/studio/services/models/gateway';
export { PluginModelCallStore } from './packages/server/src/modules/studio/repositories/plugin-model-call-store';
export { OpenAIResponsesModelClient } from './packages/ekko-agent/src/model/providers/openai-responses';
export { OpenAICompatibleModelClient } from './packages/ekko-agent/src/model/providers/openai-compatible';
export { translatedNativeRequest } from './packages/server/src/modules/studio/services/models/native-adapter';
export { AnthropicMessagesModelClient } from './packages/ekko-agent/src/model/providers/anthropic';`, resolveDir: project, loader: "ts" },
    bundle: true,
    alias: { '@ekko-studio/plugin-sdk': join(project, 'packages/studio-plugin-sdk/src/index.ts') },
    platform: "node",
    target: "node24.22.1",
    format: "cjs",
    outfile: managedModule,
    logLevel: "silent"
  });
  const { AgentCoordinator, AgentRegistry, PluginEventBus, AgentExecutionStore, AgentManagementStore, ManagedProcessScope, createNativeAgentContext, runMcpCredentials, studioConfig, PluginModelGateways, PluginModelCallStore, OpenAIResponsesModelClient, AnthropicMessagesModelClient, OpenAICompatibleModelClient, translatedNativeRequest } = createRequire(import.meta.url)(managedModule);
  let calls = 0, completedTurns = 0, completedCommands = 0, installedClis = 0;
  const managedInstall = process.env.STUDIO_MANAGED_CLI === '1';
  const vendors = process.env.STUDIO_AGENT_VENDORS ? process.env.STUDIO_AGENT_VENDORS.split(',') : ['codex', 'qwen-code'];
  if (!vendors.length || vendors.some(value => !['codex', 'qwen-code', 'kimi', 'codebuddy', 'copilot', 'opencode', 'pi', 'dsh', 'grok'].includes(value))) throw new Error('Unknown native verification vendor');
  const fixtureInputTokens = process.env.STUDIO_NATIVE_COMMANDS === '1' ? 12000 : 12;
  const commandAfterTurn = Number(process.env.STUDIO_NATIVE_COMMAND_AFTER_TURN || 0);
  if (!Number.isSafeInteger(commandAfterTurn) || commandAfterTurn < 0 || commandAfterTurn > 1) throw new Error('Native command turn must be 0 or 1');
  let activeTarget = 'native', activeVendor, searchIssued = false;
  let nativeMcpEnabled = false, nativeMcpIssued = false, nativeMcpContext;
  const nativeMcpRequests = [];
  const nativeClientRequests = [];
  const requests = [];
  const imageData = (await sharp({ create: { width: 32, height: 32, channels: 3, background: 'red' } }).png().toBuffer()).toString('base64');
  const hasImage = value => value && typeof value === 'object' && (['input_image', 'image', 'image_url'].includes(value.type) || Object.values(value).some(hasImage));
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString() || "{}");
    if (req.url?.startsWith('/api/')) {
      const credential = runMcpCredentials.authenticate(String(req.headers.authorization || '').replace(/^Bearer /, ''));
      const current = credential && credential.contextId === req.headers['x-studio-run-context'] && credential.profile === req.headers['x-hermes-profile'];
      res.writeHead(current ? 200 : 403, { 'Content-Type': 'application/json' });
      if (!current) { res.end(JSON.stringify({ error: 'Native MCP turn authorization failed' })); return; }
      if (req.url.startsWith('/api/openapi.json')) {
        res.end(JSON.stringify({ openapi: '3.1.0', paths: { '/api/studio/fixture-native-context': { get: { responses: { '200': { description: 'Local native MCP fixture' } } } } } }));
      } else {
        nativeMcpRequests.push({ vendor: activeVendor, sessionId: credential.sessionId, contextId: credential.contextId });
        res.end(JSON.stringify({ message: 'Native Studio MCP fixture reached', context_id: credential.contextId }));
      }
      return;
    }
    if (!req.url?.includes("responses") && !req.url?.includes("messages") && !req.url?.includes('chat/completions')) {
      res.writeHead(404);
      res.end("{}");
      return;
    }
    calls++; requests.push(body);
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
    let responseSequence = 0;
    const send = (type, data) => res.write(`event: ${type}
data: ${JSON.stringify({ type, ...(type.startsWith('response.') ? { sequence_number: responseSequence++ } : {}), ...data })}

`);
    const id = `response-${calls}`, messageId = `message-${calls}`, text = `Native fixture answer ${calls}`;
    const responseMetadata = { created_at: Math.floor(Date.now() / 1000), model: body.model };
    const flattenedTools = (body.tools || []).flatMap(tool => tool.type === 'namespace' ? (tool.tools || []).map(child => ({ ...child, namespace: tool.name })) : [tool]);
    const matchTool = (tool, name) => (tool.name || tool.function?.name) === name
      || (tool.name || tool.function?.name) === `studio_${createHash('sha256').update(JSON.stringify([null, name])).digest('hex').slice(0, 48)}`;
    const searchTool = flattenedTools.find(tool => matchTool(tool, 'tool_search') || matchTool(tool, 'ToolSearch') || activeVendor === 'grok' && matchTool(tool, 'search_tool'));
    const deferredTools = (body.messages || []).flatMap(message => Array.isArray(message.content) ? message.content : []).filter(part => part.type === 'tool_result')
      .flatMap(part => [...String(part.content).matchAll(/<function>(.*?)<\/function>/gs)].map(match => JSON.parse(match[1])));
    const codebuddyResults = activeVendor === 'codebuddy' ? JSON.stringify([
      ...(body.messages || []).filter(message => message.role === 'tool').map(message => message.content),
      ...(body.messages || []).flatMap(message => Array.isArray(message.content) ? message.content.filter(part => part.type === 'tool_result').map(part => part.content) : []),
      ...(Array.isArray(body.input) ? body.input.filter(item => item.type === 'function_call_output').map(item => item.output) : []),
    ]) : '';
    const codebuddyApi = codebuddyResults.match(/\bmcp__[A-Za-z0-9_.:-]*ekko_studio_api_request\b/)?.[0];
    const grokResults = activeVendor === 'grok' ? [
      ...(Array.isArray(body.input) ? body.input.filter(item => item.type === 'function_call_output').map(item => item.output) : []),
      ...(body.messages || []).filter(message => message.role === 'tool').map(message => message.content),
      ...(body.messages || []).flatMap(message => Array.isArray(message.content) ? message.content.filter(part => part.type === 'tool_result').map(part => part.content) : []),
    ].map(value => typeof value === 'string' ? value : JSON.stringify(value)).join('\n') : '';
    const grokApi = grokResults.match(/"tool_name"\s*:\s*"([^"]*ekko_studio_api_request)"/)?.[1];
    const apiTool = flattenedTools.find(tool => (tool.name || tool.function?.name || '').includes('ekko_studio_api_request'))
      || deferredTools.find(tool => tool.name?.includes('ekko_studio_api_request')) || (codebuddyApi ? { name: codebuddyApi } : grokApi ? { name: grokApi } : undefined);
    const discover = ['qwen-code', 'codebuddy', 'grok'].includes(activeVendor) && searchTool && !searchIssued;
    if (discover || (nativeMcpEnabled && apiTool && !nativeMcpIssued)) {
      if (discover) searchIssued = true; else nativeMcpIssued = true;
      const deferred = !discover && !!apiTool.parametersJsonSchema;
      const codebuddyProxy = !discover && codebuddyApi && flattenedTools.find(tool => matchTool(tool, 'DeferExecuteTool'));
      const toolName = discover ? searchTool.name || searchTool.function.name : grokApi ? 'use_tool' : codebuddyProxy ? codebuddyProxy.name || codebuddyProxy.function.name : deferred ? 'tool_call' : apiTool.name || apiTool.function.name;
      const nativeArgs = { method: 'GET', path: '/api/studio/fixture-native-context', context_id: nativeMcpContext };
      const toolId = `tool-${calls}`, args = JSON.stringify(discover
        ? activeVendor === 'codebuddy' ? { queries: nativeMcpEnabled ? ['ekko_studio_api_request', 'continuity'] : ['continuity'], top_k: 10 }
          : { query: nativeMcpEnabled ? 'continuity ekko_studio_api_request' : 'continuity', ...(activeVendor === 'grok' ? {} : { max_results: nativeMcpEnabled ? 10 : 5 }) }
        : grokApi ? { tool_name: grokApi, tool_input: nativeArgs } : codebuddyProxy ? { toolName: codebuddyApi, params: nativeArgs } : deferred ? { name: apiTool.name, arguments: nativeArgs } : nativeArgs);
      if (req.url.includes('responses')) {
        const item = { type: 'function_call', id: toolId, call_id: toolId, name: toolName, arguments: args, ...(!discover && apiTool.namespace ? { namespace: apiTool.namespace } : {}) };
        send('response.created', { response: { id, object: 'response', ...responseMetadata, status: 'in_progress', output: [] } });
        send('response.output_item.added', { output_index: 0, item: { ...item, arguments: '' } });
        send('response.function_call_arguments.delta', { item_id: toolId, output_index: 0, delta: args });
        send('response.function_call_arguments.done', { item_id: toolId, output_index: 0, arguments: args });
        send('response.output_item.done', { output_index: 0, item });
        send('response.completed', { response: { id, object: 'response', ...responseMetadata, status: 'completed', output: [item], usage: { input_tokens: fixtureInputTokens, output_tokens: 5, total_tokens: fixtureInputTokens + 5, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } } });
      } else if (req.url.includes('chat/completions')) {
        res.write(`data: ${JSON.stringify({ id, choices: [{ delta: { tool_calls: [{ index: 0, id: toolId, type: 'function', function: { name: toolName, arguments: args } }] } }] })}\n\n`);
        res.write(`data: ${JSON.stringify({ id, choices: [{ delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: fixtureInputTokens, completion_tokens: 5 } })}\n\n`);
        res.write('data: [DONE]\n\n');
      } else {
        send('message_start', { message: { id: messageId, type: 'message', role: 'assistant', model: body.model, content: [], stop_reason: null, usage: { input_tokens: fixtureInputTokens, output_tokens: 0 } } });
        send('content_block_start', { index: 0, content_block: { type: 'tool_use', id: toolId, name: toolName, input: {} } });
        send('content_block_delta', { index: 0, delta: { type: 'input_json_delta', partial_json: args } });
        send('content_block_stop', { index: 0 });
        send('message_delta', { delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 5 } });
        send('message_stop', {});
      }
      res.end(); return;
    }
    if (req.url.includes("responses")) {
      const item = { id: messageId, type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text, annotations: [] }] };
      send("response.created", { response: { id, object: "response", ...responseMetadata, status: "in_progress", output: [] } });
      send("response.output_item.added", { output_index: 0, item: { ...item, status: "in_progress", content: [] } });
      send("response.content_part.added", { item_id: messageId, output_index: 0, content_index: 0, part: { type: "output_text", text: "", annotations: [] } });
      send("response.output_text.delta", { item_id: messageId, output_index: 0, content_index: 0, delta: text });
      send("response.output_text.done", { item_id: messageId, output_index: 0, content_index: 0, text });
      send("response.output_item.done", { output_index: 0, item });
      send("response.completed", { response: { id, object: "response", ...responseMetadata, status: "completed", output: [item], usage: { input_tokens: fixtureInputTokens, output_tokens: 5, total_tokens: fixtureInputTokens + 5, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } } });
    } else if (req.url.includes('chat/completions')) {
      res.write(`data: ${JSON.stringify({ id, choices: [{ delta: { content: text } }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ id, choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: fixtureInputTokens, completion_tokens: 5 } })}\n\n`);
      res.write('data: [DONE]\n\n');
    } else {
      send("message_start", { message: { id: messageId, type: "message", role: "assistant", model: body.model, content: [], stop_reason: null, usage: { input_tokens: fixtureInputTokens, output_tokens: 0 } } });
      send("content_block_start", { index: 0, content_block: { type: "text", text: "" } });
      send("content_block_delta", { index: 0, delta: { type: "text_delta", text } });
      send("content_block_stop", { index: 0 });
      send("message_delta", { delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 5 } });
      send("message_stop", {});
    }
    res.end();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const base = `http://127.0.0.1:${server.address().port}`;
  studioConfig.port = server.address().port;
  const db = new DatabaseSync(':memory:'), modelStore = new PluginModelCallStore(db), executionStore = new AgentExecutionStore(db), state = executionStore.state;
  const gateways = new PluginModelGateways({ store: modelStore, state, authorize() {}, resolve: async (_profile, publicModel, protocol) => {
    const Client = activeTarget === 'native'
      ? protocol === 'chat-completions' ? OpenAICompatibleModelClient : protocol === 'responses' ? OpenAIResponsesModelClient : AnthropicMessagesModelClient
      : activeTarget === 'chat' ? protocol === 'chat-completions' ? AnthropicMessagesModelClient : OpenAICompatibleModelClient
        : protocol === 'responses' ? AnthropicMessagesModelClient : OpenAIResponsesModelClient;
    const client = new Client({ id: 'fixture', type: 'custom', defaultModel: 'fixture-model', baseUrl: `${base}/v1`, apiKey: 'host-only-fixture-key' });
    return { images: true, transport: activeTarget === 'native' ? 'native' : 'translated',
      request: async (body, signal, sessionId) => {
        try { return await (activeTarget === 'native' ? client.nativeRequest(body, { model: 'fixture-model', messages: [], signal })
          : translatedNativeRequest({ client, protocol, model: 'fixture-model', publicModel, body, signal, sessionId, authorize() {} })); }
        catch (error) { if (process.env.STUDIO_NATIVE_DIAGNOSTICS === '1') console.log(JSON.stringify({ vendor: activeVendor, target: activeTarget, modelFailure: error.message, code: error.code, toolChoice: body.tool_choice })); throw error; }
      },
      record: input => input.onRecorded?.({ ...input.usage, isEstimated: input.isEstimated }) };
  } });
  if (process.env.STUDIO_NATIVE_DIAGNOSTICS === '1') gateways.server.prependListener('request', request => console.log(JSON.stringify({ nativeGatewayPath: request.url?.split('?')[0].replace(/[a-f0-9]{48}/g, '<lease>') })));
  try {
    for (const [mode, target] of [['global', 'native'], ['scoped', 'native'], ['scoped', 'chat'], ['scoped', 'other'], ['scoped', 'switch']]) for (const vendor of vendors) {
      if (managedInstall && target !== 'native') continue;
      activeTarget = target === 'switch' ? 'native' : target;
      activeVendor = vendor;
      nativeMcpEnabled = mode === 'global' && target === 'native';
      const home = join(root, `${vendor}-${mode}-${target}`);
      await mkdir(home);
      const controller = new AbortController(), scope = new ManagedProcessScope(controller.signal, () => {
      });
      let coordinator, events;
      try {
        const config = { cwd: home, mcpServers: mcpServers(1), env: { HOME: home, USERPROFILE: home } };
        if (nativeMcpEnabled) config.studioMcp = { enabled: true, browser: false, devices: false, use: false };
        if (vendor === "codex") {
          await writeFile(join(home, "config.toml"), `model = "fixture-model"
model_provider = "fixture"
[model_providers.fixture]
name = "Local fixture"
base_url = "${base}/v1"
wire_api = "responses"
requires_openai_auth = false
`, { mode: 384 });
          config.command = process.env.STUDIO_CODEX_COMMAND || "codex";
          config.env.CODEX_HOME = home;
          config.approvalPolicy = nativeMcpEnabled ? 'on-request' : 'never';
          config.sandbox = "read-only";
        } else if (vendor === 'qwen-code') {
          config.command = process.env.STUDIO_QWEN_COMMAND || "qwen";
          config.args = ["--auth-type", "anthropic", "--model", "fixture-model"];
          Object.assign(config.env, { QWEN_HOME: home, QWEN_RUNTIME_DIR: join(home, "runtime"), ANTHROPIC_API_KEY: "fixture-only", ANTHROPIC_BASE_URL: base, ANTHROPIC_MODEL: "fixture-model" });
          await writeFile(join(home, "settings.json"), JSON.stringify({ security: { auth: { selectedType: "anthropic" } }, model: { name: "fixture-model" }, modelProviders: { anthropic: [{ id: "fixture-model", envKey: "ANTHROPIC_API_KEY", baseUrl: base, generationConfig: { maxOutputTokens: 256, modalities: { image: true } } }] } }), { mode: 384 });
        } else if (vendor === 'dsh') {
          config.command = process.env.STUDIO_DSH_COMMAND || 'dsh';
          config.model = JSON.stringify(['fixture', 'fixture-model']);
          Object.assign(config.env, { DSH_HOME: home, DSH_TELEMETRY_DISABLED: '1', STUDIO_DSH_NATIVE_FIXTURE_TOKEN: 'fixture-only' });
          const selection = { provider: 'fixture', model: 'fixture-model' };
          const providers = { providers: { fixture: { apiKeyEnv: 'STUDIO_DSH_NATIVE_FIXTURE_TOKEN', api: 'openai-responses', baseURL: `${base}/v1`,
            models: [{ id: 'fixture-model', input: ['text', 'image'], contextWindow: 131072, maxTokens: 256 }] } } };
          await mkdir(join(home, 'profiles', 'web'), { recursive: true });
          await writeFile(join(home, 'settings.yaml'), yamlStringify({ 'agent-default-model': selection, 'llm-pi-ai': providers }));
          await writeFile(join(home, 'cordis.patch.yml'), '[]\n');
          await writeFile(join(home, 'profiles', 'web', 'cordis.patch.yml'), yamlStringify([
            { id: 'agent-default-model', config: selection }, { id: 'llm-pi-ai', config: providers },
          ]));
        } else if (vendor === 'grok') {
          config.command = process.env.STUDIO_GROK_COMMAND || 'grok';
          config.model = 'fixture/native-model';
          Object.assign(config.env, { GROK_HOME: home, STUDIO_GROK_NATIVE_FIXTURE_TOKEN: 'fixture-only' });
          await writeFile(join(home, 'config.toml'), `[models]\ndefault="fixture/native-model"\n[model."fixture/native-model"]\nmodel="fixture-model"\nbase_url="${base}/v1"\nenv_key="STUDIO_GROK_NATIVE_FIXTURE_TOKEN"\napi_backend="responses"\ncontext_window=131072\nmax_completion_tokens=256\n`, { mode: 384 });
        } else if (vendor === 'pi') {
          config.command = process.env.STUDIO_PI_COMMAND || 'pi';
          config.model = 'fixture/fixture-model';
          Object.assign(config.env, { PI_CODING_AGENT_DIR: home, PI_OFFLINE: '1', PI_TELEMETRY: '0' });
          await writeFile(join(home, 'models.json'), JSON.stringify({ providers: { fixture: { baseUrl: `${base}/v1`, apiKey: 'fixture-only', api: 'openai-responses',
            models: [{ id: 'fixture-model', name: 'Fixture model', reasoning: false, input: ['text', 'image'], contextWindow: 131072, maxTokens: 256,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, compat: { supportsStrictMode: false } }] } } }));
        } else if (vendor === 'opencode') {
          config.command = process.env.STUDIO_OPENCODE_COMMAND || 'opencode';
          Object.assign(config.env, { XDG_CONFIG_HOME: join(home, 'config'), XDG_DATA_HOME: join(home, 'data'), XDG_CACHE_HOME: join(home, 'cache'),
            XDG_STATE_HOME: join(home, 'state'), OPENCODE_CONFIG_DIR: join(home, 'opencode'), OPENCODE_DB: join(home, 'opencode.db'),
            OPENCODE_DISABLE_MODELS_FETCH: '1', OPENCODE_DISABLE_AUTOUPDATE: '1',
            OPENCODE_CONFIG_CONTENT: JSON.stringify({ autoupdate: false, model: 'fixture/fixture-model', small_model: 'fixture/fixture-model',
              enabled_providers: ['fixture'], provider: { fixture: { npm: '@ai-sdk/openai-compatible', options: { baseURL: `${base}/v1`, apiKey: 'fixture-only' },
                models: { 'fixture-model': { name: 'Fixture model', attachment: true, tool_call: true,
                  modalities: { input: ['text', 'image'], output: ['text'] }, limit: { context: 131072, output: 256 } } } } } }) });
        } else if (vendor === 'copilot') {
          config.command = process.env.STUDIO_COPILOT_COMMAND || 'copilot';
          config.args = ['--model', 'fixture-model'];
          Object.assign(config.env, { COPILOT_HOME: home, COPILOT_OFFLINE: 'true', COPILOT_PROVIDER_TYPE: 'openai', COPILOT_PROVIDER_BASE_URL: `${base}/v1`,
            COPILOT_PROVIDER_API_KEY: 'fixture-only', COPILOT_PROVIDER_MODEL_ID: 'fixture-model', COPILOT_PROVIDER_WIRE_MODEL: 'fixture-model',
            COPILOT_PROVIDER_WIRE_API: 'completions', COPILOT_MODEL: 'fixture-model', COPILOT_GITHUB_TOKEN: '', GH_TOKEN: '', GITHUB_TOKEN: '' });
          await writeFile(join(home, 'settings.json'), JSON.stringify({ model: 'fixture-model' }));
        } else if (vendor === 'codebuddy') {
          config.command = process.env.STUDIO_CODEBUDDY_COMMAND || 'codebuddy';
          config.args = ['--model', 'fixture-model'];
          Object.assign(config.env, { CODEBUDDY_CONFIG_DIR: home, EKKO_SCOPED_MODEL_TOKEN: 'fixture-only', CODEBUDDY_MODEL: 'fixture-model',
            CODEBUDDY_SMALL_FAST_MODEL: 'fixture-model', CODEBUDDY_BIG_SLOW_MODEL: 'fixture-model', CODEBUDDY_CODE_SUBAGENT_MODEL: 'fixture-model',
            CODEBUDDY_API_KEY: 'fixture-only', CODEBUDDY_AUTH_TOKEN: '', CODEBUDDY_BASE_URL: `${base}/v1`, CODEBUDDY_CUSTOM_HEADERS: '' });
          await writeFile(join(home, 'settings.json'), JSON.stringify({ model: 'fixture-model', autoUpdates: false }));
          await writeFile(join(home, 'models.json'), JSON.stringify({ models: [{ id: 'fixture-model', name: 'Local fixture', vendor: 'Ekko Studio', apiKey: '${EKKO_SCOPED_MODEL_TOKEN}',
            url: `${base}/v1/chat/completions`, maxInputTokens: 131072, maxOutputTokens: 32768, supportsToolCall: true, supportsImages: true }], availableModels: ['fixture-model'] }));
        } else {
          config.command = process.env.STUDIO_KIMI_COMMAND || 'kimi';
          await writeFile(join(home, 'config.toml'), '# Local native verification fixture\n');
          Object.assign(config.env, { KIMI_CODE_HOME: home, KIMI_MODEL_NAME: 'fixture-model', KIMI_MODEL_PROVIDER_TYPE: 'anthropic',
            KIMI_MODEL_BASE_URL: `${base}/v1`, KIMI_MODEL_API_KEY: 'fixture-only', KIMI_MODEL_CAPABILITIES: 'image_in', KIMI_DISABLE_TELEMETRY: '1' });
        }
        const plugin = createRequire(import.meta.url)(join(project, "dist/plugins", vendor, "dist/index.cjs"));
        let definition, staticCatalog = [], nativeCatalog = [];
        plugin.apply({ commands: { register(definition, handler) { staticCatalog.push({ definition, handler }); return () => {}; } }, agents: { register(value) {
          definition = value;
        } } });
        nativeCatalog = staticCatalog;
        if (process.env.STUDIO_NATIVE_COMMANDS === '1' || process.env.STUDIO_NATIVE_COMMAND || process.env.STUDIO_NATIVE_DIAGNOSTICS === '1') {
          const create = definition.create;
          definition.create = async (input, context) => {
            let diagnostics = '';
            const runtime = await create(input, { ...context, commands: { replace: async values => { nativeCatalog = [...staticCatalog, ...values]; } },
              processes: { spawn: async launch => {
                const process = await context.processes.spawn(launch);
                return { ...process, read: async () => {
                  const batch = await process.read();
                  for (const chunk of batch.chunks) if (chunk.stream === 'stderr') diagnostics = (diagnostics + Buffer.from(chunk.data).toString()).slice(-4096);
                  return batch;
                } };
              } } });
            return { ...runtime, run: async (...args) => {
              const handle = await runtime.run(...args);
              return { ...handle, result: handle.result.catch(error => { console.error(JSON.stringify({ vendor, mode, nativeFailure: error.message, nativeMethod: error.method, nativeData: error.data, diagnostics })); throw error; }) };
            } };
          };
        }
        if (nativeMcpEnabled) {
          const create = definition.create;
          definition.create = (input, context) => create(input, { ...context, processes: { spawn: async launch => {
            const process = await context.processes.spawn(launch);
            let pending = '';
            const decoder = new TextDecoder();
            return { ...process, read: async () => {
              const batch = await process.read();
              for (const chunk of batch.chunks) if (chunk.stream === 'stdout') pending += decoder.decode(chunk.data, { stream: true });
              let end;
              while ((end = pending.indexOf('\n')) >= 0) {
                const line = pending.slice(0, end); pending = pending.slice(end + 1);
                try {
                  const message = JSON.parse(line);
                  if (message.method && message.id !== undefined) nativeClientRequests.push({ method: message.method, keys: Object.keys(message.params || {}), mode: message.params?.mode, schema: message.params?.requestedSchema,
                    ...(Array.isArray(message.params?.options) ? { options: message.params.options.map(option => ({ id: option.optionId, kind: option.kind })) } : {}) });
                } catch {}
              }
              return batch;
            } };
          } } });
        }
        if (mode === 'scoped') { config.args = []; config.model = process.env.STUDIO_NATIVE_MODEL || 'fixture/model'; }
        if (mode === 'global' && !managedInstall) {
          const inspectionTimer = setTimeout(() => controller.abort(), 25000);
          try {
            const inspection = await definition.management.inspect({ instanceId: "acceptance", mode: "global", configRevision: 1, config }, { signal: controller.signal, processes: scope.api });
            if (vendor === "codex" && (inspection.authentication.state !== "not_required" || inspection.models.status !== "available")) throw new Error("Unexpected Codex inspection");
            if (vendor === "qwen-code" && (inspection.authentication.state !== "unknown" || inspection.models.status !== "unsupported" || !inspection.authentication.methods.length)) throw new Error("Unexpected Qwen inspection");
            console.log(JSON.stringify({ vendor, inspection: true, authentication: inspection.authentication.state, modelCatalog: inspection.models.status, models: inspection.models.items.length }));
          } finally { clearTimeout(inspectionTimer); }
        }
        const caller = { scopeId: 'acceptance', principal: { kind: 'user', id: '7' }, profileId: 'fixture-profile', surface: 'api', traceId: 'fixture' };
        const registry = new AgentRegistry(), provider = { kind: 'plugin', pluginId: `studio.agent-${definition.id}`, version: '1.0.0', generation: 'first' };
        const register = generation => { const registration = registry.stage(caller.profileId, { ...provider, generation }, [definition.id]); registration.register(definition); registration.commit(); };
        register('first');
        events = new PluginEventBus();
        const options = { managementStore: new AgentManagementStore(db), authorizeManagement() {}, leaseManagement: () => ({ authorize() {}, release() {} }), store: executionStore, registry, events, stateRoot: join(home, 'state'), logger: { info() {}, warn() {}, error() {} }, authorize() {}, validateInput() {},
          authorizeChat: (scope, current, sessionId) => {
            if (scope.principal.id !== caller.principal.id || scope.profileId !== caller.profileId || current.ownerId !== caller.principal.id
              || ![`fixture:${vendor}:a`, `fixture:${vendor}:b`].includes(sessionId)) throw new Error('Chat is outside the local acceptance fixture');
          },
          nativeContext: (instance, scope, _provider, signal) => {
            const native = createNativeAgentContext(instance, scope, signal, runId => {
              if (!['starting', 'running', 'waiting_input'].includes(executionStore.get(runId)?.status)) throw new Error('Native turn ended');
            });
            return native && { ...native, prepare: async (runId, runSignal) => {
              const prepared = await native.prepare(runId, runSignal);
              nativeMcpContext = prepared.turnInstructions?.match(/context_id="([^"]+)"/)?.[1];
              return prepared;
            } };
          },
          settleRun: id => gateways.settleRun(id), context: (scope, signal) => ({ scope, signal,
            artifacts: { read: async (id, offset) => {
              if (id !== '00000000-0000-0000-0000-000000000001' || offset !== 0) throw new Error('Invalid native image read');
              const length = Buffer.from(imageData, 'base64').length;
              return { id, mediaType: 'image/png', byteLength: length, data: imageData, offset: 0, nextOffset: length, done: true };
            } }, models: { gateway: input => gateways.open(scope, input, signal) } }) };
        coordinator = new AgentCoordinator(options);
        if (managedInstall) delete config.command;
        let instance = coordinator.createInstance(caller, { agentTypeId: definition.id, mode, config });
        if (managedInstall) {
          const operation = coordinator.startInstall(caller, instance.id, instance.revision, `managed-install-${instance.id}`);
          await coordinator.managementOperations.wait(caller, operation.id);
          const receipt = coordinator.managementOperations.get(caller, operation.id);
          if (receipt.status !== 'completed') {
            const output = coordinator.managementOperations.output(caller, operation.id, 0);
            throw new Error(`Managed CLI installation failed: ${JSON.stringify(receipt)} ${output.chunks.map(chunk => Buffer.from(chunk.data, 'base64').toString()).join('')}`);
          }
          installedClis++;
        }
        const setup = await coordinator.setupInstance(caller, instance.id, instance.revision);
        if (setup.cli.state !== 'available' || !setup.cli.version || setup.authentication.kind !== (mode === 'scoped' ? 'studio' : 'native')) throw new Error('Unexpected native setup probe');
        console.log(JSON.stringify({ vendor, mode, setup: true, version: setup.cli.version, authentication: setup.authentication.kind }));
        const marker = `STUDIO_RESOURCE_${vendor}_${mode}`;
        const catalog = await coordinator.resourceFiles(caller, instance.id, instance.revision, { action: 'list' });
        const instructions = catalog.configs.find(location => location.id === 'native-instructions')
          || catalog.configs.find(location => location.scope === mode && location.name === 'AGENTS.md');
        if (!instructions) throw new Error(`${vendor} did not expose native instructions`);
        const instructionRef = { kind: 'configs', locationId: instructions.id, path: '' };
        const currentInstructions = await coordinator.resourceFiles(caller, instance.id, instance.revision, { action: 'read', ...instructionRef }, catalog.snapshot);
        await coordinator.resourceFiles(caller, instance.id, instance.revision, { action: 'write', ...instructionRef, content: `Follow the fixture instruction ${marker}_INSTRUCTION.`, etag: currentInstructions.file.etag }, catalog.snapshot);
        await coordinator.importSkill(caller, instance.id, instance.revision, catalog.snapshot, 'native-skills', [{ filename: '技能目录/SKILL.md', data: Buffer.from(`---
name: studio-resource-check
description: Skill marker ${marker}_SKILL.
---
Follow fixture instructions.`) }, { filename: '技能目录/assets/fixture.bin', data: Buffer.from([0, 255, 128]) }]);
        const checkpoints = new Map();
        for (let turn = 0; turn < (nativeMcpEnabled ? 5 : target === 'switch' ? 3 : 2); turn++) {
          searchIssued = false;
          nativeMcpIssued = false;
          if (target === 'switch') activeTarget = turn === 1 ? 'chat' : 'native';
          if (turn) {
            instance = await coordinator.updateInstance(caller, instance.id, { revision: instance.revision, mode,
              config: { ...instance.config, mcpServers: mcpServers(instance.revision + 1), model: mode === 'scoped' ? 'fixture/next-model'
                : vendor === 'dsh' ? JSON.stringify(['fixture', 'fixture-model']) : vendor === 'grok' ? 'fixture/native-model' : ['opencode', 'pi'].includes(vendor) ? 'fixture/fixture-model' : 'fixture-model', systemPrompt: 'Preserve the prior conversation and reply briefly.' } });
            const next = await coordinator.resourceLocations(caller, instance.id, instance.revision);
            if (JSON.stringify(next.configs) !== JSON.stringify(catalog.configs)) throw new Error('Compatible configuration changed resource locations');
            await coordinator.close();
            register('first');
            coordinator = new AgentCoordinator(options);
          }
          {
            const requestOffset = requests.length;
            const mcpTraceOffset = (await readFile(join(root, 'mcp-trace.jsonl'), 'utf8').catch(() => '')).length;
            const content = [{ type: "text", text: `Respond with a brief greeting. Turn ${turn}.` + (process.env.STUDIO_NATIVE_COMMANDS === '1' && turn <= commandAfterTurn && target === 'native' ? '\n' + 'Retain this fixture context for subsequent compression. '.repeat(2000) : '') },
              ...(turn ? [{ type: 'image', artifactId: '00000000-0000-0000-0000-000000000001', mediaType: 'image/png' }] : [])];
            const chatTarget = nativeMcpEnabled && turn >= 2 ? { kind: 'chat', sessionId: `fixture:${vendor}:${turn === 3 ? 'b' : 'a'}` } : undefined;
            const accepted = coordinator.start(caller, instance.id, { content, timeoutMs: 20000 }, `${vendor}-${mode}-${target}-${turn}`, undefined, chatTarget);
            let finished = false;
            const answerFixtureApprovals = async () => {
              while (!finished) {
                for (const interaction of coordinator.interactions(caller, accepted.id).filter(item => item.status === 'pending' && item.kind === 'approval')) {
                  const nativeOptions = nativeClientRequests.filter(request => request.options).at(-1)?.options || [];
                  const choice = interaction.choices.find(option => option.id === 'accept' || nativeOptions.some(native => native.id === option.id && native.kind === 'allow_once'));
                  if (!choice) throw new Error(`Unsupported native fixture approval: ${JSON.stringify({ choices: interaction.choices, nativeOptions })}`);
                  await coordinator.respond(caller, accepted.id, { interactionId: interaction.id, idempotencyKey: `fixture-${interaction.id}`, choiceId: choice.id });
                }
                await new Promise(resolve => setTimeout(resolve, 10));
              }
            };
            await Promise.all([coordinator.wait(accepted.id).finally(() => { finished = true; }), answerFixtureApprovals()]);
            const result = coordinator.get(caller, accepted.id), output = coordinator.output(caller, accepted.id, -1);
            const conversation = result.conversationId ?? instance.id;
            const nextCheckpoint = state.checkpoint(conversation, result.provider, instance.revision);
            if (result.status !== 'completed') throw new Error(`${vendor} ${mode} native turn failed: ${result.errorCode}`);
            if (nativeMcpEnabled && !nativeMcpRequests.some(call => call.sessionId === (result.sessionId ?? `agent-run:${result.id}`) && call.contextId === nativeMcpContext)) {
              const summary = tools => (tools || []).map(tool => ({ type: tool.type, name: tool.name || tool.function?.name, ...(tool.tools ? { tools: summary(tool.tools) } : {}) }));
              throw new Error(`${vendor} did not call the host-injected Studio MCP with its current turn context: ${JSON.stringify({ issued: nativeMcpIssued, nativeClientRequests, tools: requests.slice(requestOffset).map(body => summary(body.tools)), outputs: requests.slice(requestOffset).flatMap(body => body.input || []).filter(item => item.type === 'function_call_output').map(item => item.output), ...(process.env.STUDIO_NATIVE_DIAGNOSTICS === '1' ? { toolResults: requests.slice(requestOffset).flatMap(body => body.messages || []).filter(message => message.role === 'tool').map(message => String(message.content).slice(0, 8000)) } : {}) })}`);
            }
            const nativeInput = JSON.stringify(requests.slice(requestOffset));
            const nativeTools = JSON.stringify(requests.slice(requestOffset).map(body => body.tools));
            // Qwen exposes deferred MCP declarations through tool_search results.
            const mcpCalls = (await readFile(join(root, 'mcp-trace.jsonl'), 'utf8')).slice(mcpTraceOffset).trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
            if (!mcpCalls.some(call => call.method === 'tools/list' && call.tool === `continuity_v${instance.revision}`)
              || !nativeInput.includes(`continuity_v${instance.revision}`) || (turn && nativeTools.includes(`continuity_v${instance.revision - 1}`))) {
              throw new Error(`${vendor} did not replace the configured MCP tools after revision ${instance.revision}: ${JSON.stringify({ observed: mcpCalls, tools: requests.slice(requestOffset).map(body => body.tools?.map(tool => ({ name: tool.name || tool.function?.name }))), output })}`);
            }

            console.log(JSON.stringify({ vendor, mode, turn: turn + 1, nativeInstructionsLoaded: nativeInput.includes(marker + '_INSTRUCTION'), nativeSkillDiscovered: nativeInput.includes(marker + '_SKILL') }));
            if (!nativeInput.includes(marker + '_INSTRUCTION') || !nativeInput.includes(marker + '_SKILL')) throw new Error(`${vendor} ${mode} did not consume the declared native resources`);
            if (nextCheckpoint === undefined) throw new Error('Successful native Run did not commit a checkpoint');
            const previous = checkpoints.get(conversation);
            if (previous !== undefined && JSON.stringify(nextCheckpoint) !== JSON.stringify(previous)) throw new Error(vendor + " changed native session between turns of the same conversation");
            if (previous === undefined && [...checkpoints.values()].some(checkpoint => JSON.stringify(nextCheckpoint) === JSON.stringify(checkpoint))) throw new Error(vendor + ' reused a native session from another conversation');
            checkpoints.set(conversation, nextCheckpoint);
            if (turn && !requests.slice(requestOffset).some(hasImage)) throw new Error(`${vendor} did not forward the image to its model`);
            if (mode === 'scoped') {
              const usage = state.usage(result.id);
              const records = db.prepare('SELECT record_json FROM studio_plugin_model_calls').all().map(row => JSON.parse(row.record_json));
              if (!usage.length || usage.some(call => !call.final || call.source !== 'host' || call.inputTokens !== fixtureInputTokens || call.outputTokens !== 5)) throw new Error(`Native host accounting failed: ${JSON.stringify({ usage, calls: records.filter(call => call.runId === result.id).map(call => ({ id: call.id, status: call.status, error: call.error, errorCode: call.errorCode })) })}`);
              if (records.filter(call => call.runId === result.id).some(call => call.status !== 'completed')) throw new Error('Native model call did not complete');
            }
            console.log(JSON.stringify({ vendor, mode, target, turn: turn + 1, status: result.status, events: output.length, sameNativeSession: previous !== undefined ? true : void 0,
              ...(chatTarget ? { chat: chatTarget.sessionId, nativeHistoryIsolated: true } : {}), configurationRevision: instance.revision, mcpConfigurationApplied: true, coordinatorRestart: !!turn, providerReactivation: !!turn, imageForwarded: turn ? true : void 0 }));
            if (result.status !== "completed" || !output.some((event) => ["message.delta", "message.snapshot"].includes(event.type) && event.text.includes("Native fixture answer"))) throw new Error(`${vendor} real turn did not complete`);
            completedTurns++;
            if ((process.env.STUDIO_NATIVE_COMMANDS === '1' || process.env.STUDIO_NATIVE_COMMAND) && turn === commandAfterTurn && target === 'native') {
              const command = nativeCatalog.find(value => process.env.STUDIO_NATIVE_COMMAND
                ? value.definition.name === process.env.STUDIO_NATIVE_COMMAND : /^(compact|compress)$/.test(value.definition.name));
              console.log(JSON.stringify({ vendor, mode, nativeCommands: nativeCatalog.map(value => value.definition.name) }));
              if (!command) throw new Error(`${vendor} did not advertise the requested native command`);
              const commandRun = coordinator.start(caller, instance.id, { content: [{ type: 'text', text: `/${command.definition.name}` }], timeoutMs: 20000 }, `${vendor}-${mode}-native-command`);
              await coordinator.wait(commandRun.id);
              const compacted = coordinator.get(caller, commandRun.id);
              if (compacted.status !== 'completed') throw new Error(`${vendor} ${mode} native command failed: ${compacted.errorCode}`);
              const checkpoint = state.checkpoint(instance.id, compacted.provider, instance.revision);
              if (JSON.stringify(checkpoint) !== JSON.stringify(nextCheckpoint)) throw new Error(`${vendor} command changed its native conversation`);
              completedCommands++;
              console.log(JSON.stringify({ vendor, mode, nativeCommand: command.definition.name, status: compacted.status, sameNativeSession: true }));
            }
          }
        }
      } finally {
        await coordinator?.close(); events?.close();
        controller.abort();
        await scope.close();
      }
    }
  } finally {
    await gateways.close(); db.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(() => resolve()));
    if (process.env.STUDIO_NATIVE_KEEP_FIXTURE === '1') console.log(JSON.stringify({ fixtureRoot: root }));
    else await rm(root, { recursive: true, force: true });
  }
  console.log(JSON.stringify({ passed: true, turns: completedTurns, ...(managedInstall ? { managedCliInstallations: installedClis } : {}), ...(process.env.STUDIO_NATIVE_COMMANDS === '1' || process.env.STUDIO_NATIVE_COMMAND ? { nativeCommands: completedCommands } : {}), localModelRequests: calls, nativeStudioMcpRequests: nativeMcpRequests.length, remoteProvider: false, accountLogin: false }));
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
