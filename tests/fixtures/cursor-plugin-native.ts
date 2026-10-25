import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { createServer } from 'node:http'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { AgentExecutionStore } from '../../packages/server/src/modules/studio/repositories/agent-execution-store'
import { PluginStore } from '../../packages/server/src/modules/studio/repositories/plugin-store'
import { AgentCoordinator } from '../../packages/server/src/modules/studio/services/agents/coordinator'
import { AgentRegistry } from '../../packages/server/src/modules/studio/services/agents/registry'
import { PluginHost } from '../../packages/server/src/modules/studio/services/plugins/host'
import { PluginEventBus } from '../../packages/server/src/modules/studio/services/events/plugin-events'
import { createExecutionContext } from '../../packages/server/src/modules/studio/services/context/execution'
import type { ExecutionScope } from '../../packages/studio-plugin-sdk/src'

async function main() {
  const root = process.argv[2], home = join(root, 'home'), cwd = join(root, 'workspace'), native = join(home, '.cursor')
  await Promise.all([mkdir(native, { recursive: true }), mkdir(cwd)])
  const settings = JSON.stringify({ version: 1, editor: { vimMode: false }, permissions: { allow: [], deny: [] }, network: { useHttp1ForAgent: true } })
  const mcp = JSON.stringify({ mcpServers: { user: { command: 'user-preserved', disabled: true } } })
  await writeFile(join(native, 'cli-config.json'), settings); await writeFile(join(native, 'mcp.json'), mcp)
  const requests: string[] = []
  const server = createServer((request, response) => {
    requests.push(String(request.url)); request.resume()
    response.writeHead(401, { 'content-type': 'application/json' }); response.end(JSON.stringify({ code: 'unauthenticated', message: 'Local fixture has no Cursor account' }))
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address(); assert(address && typeof address === 'object')
  const db = new DatabaseSync(':memory:'), executions = new AgentExecutionStore(db), store = new PluginStore(db), registry = new AgentRegistry(), events = new PluginEventBus()
  const logger = { info() {}, warn() {}, error() {} }
  const scope: ExecutionScope = { scopeId: 'verify', principal: { kind: 'user', id: 'fixture' }, profileId: 'fixture', surface: 'api', traceId: 'fixture' }
  const context = (identity: ExecutionScope, signal: AbortSignal) => createExecutionContext(identity, signal, logger, { authorize: async () => {},
    agents: { list: async () => [] }, sessions: { get: async () => null } })
  const coordinator = new AgentCoordinator({ store: executions, registry, events, logger, authorize: () => {}, context, stateRoot: join(root, 'state') })
  const host = new PluginHost({ store, registry, events, context, logger, runnerPath: join(root, 'runner.cjs'), artifactsRoot: join(root, 'installed'),
    eventContext: async (_state, _event, signal) => context(scope, signal), acceptEvents: async batch => { for (const event of batch) events.publish(event) } })
  try {
    const manifest = JSON.parse(await readFile(join(root, 'plugin/studio-plugin.json'), 'utf8'))
    await host.registerSystemArtifact(join(root, 'plugin'), manifest.id)
    await host.configure({ pluginId: manifest.id, profileId: scope.profileId, ownerId: scope.principal.id, enabled: true, config: {}, grants: manifest.requires.capabilities }, 0)
    const config = { cwd, command: process.env.STUDIO_CURSOR_COMMAND!, env: { HOME: home, USERPROFILE: home, CURSOR_CONFIG_DIR: native, XDG_CONFIG_HOME: join(home, 'xdg'), XDG_CACHE_HOME: join(home, 'cache'),
      AGENT_CLI_CREDENTIAL_STORE: 'file', CURSOR_API_ENDPOINT: `http://127.0.0.1:${address.port}`, CURSOR_API_KEY: 'local-fixture-invalid-key', CURSOR_AUTH_TOKEN: '', NO_OPEN_BROWSER: '1' } }
    const instance = coordinator.createInstance(scope, { agentTypeId: 'cursor', mode: 'global', config })
    const inspected = await coordinator.inspectInstance(scope, instance.id)
    assert.equal(inspected.native?.version, '2026.10.22-27dcf5f'); assert.equal(inspected.authentication.state, 'unknown'); assert.equal(inspected.models.status, 'unsupported')
    assert.equal(await readFile(join(native, 'cli-config.json'), 'utf8'), settings)
    assert.equal(db.prepare('SELECT count(*) AS count FROM studio_agent_runs').get()?.count, 0)
    const setup = await coordinator.setupInstance(scope, instance.id, 1)
    assert.deepEqual(setup.installation, { kind: 'manual', url: 'https://cursor.com/docs/cli/installation' })
    const locations = await coordinator.resourceLocations(scope, instance.id, 1)
    assert(locations.configs.some(location => location.path === join(native, 'mcp.json')))
    const run = coordinator.start(scope, instance.id, { content: [{ type: 'text', text: 'Say hello using only the local fixture endpoint.' }], timeoutMs: 15000 }, 'native-auth-boundary')
    await coordinator.wait(run.id)
    const result = coordinator.get(scope, run.id)
    assert.equal(result.status, 'failed'); assert.equal(executions.state.checkpoint(instance.id, result.provider, 1), undefined)
    assert(requests.length > 0, 'Expected the native CLI to reach only the explicit local fixture endpoint')
    assert.equal(await readFile(join(native, 'mcp.json'), 'utf8'), mcp)
    console.log(JSON.stringify({ version: inspected.native?.version, setup: 'manual', authentication: 'unknown', nativeBoundary: 'local Cursor protocol rejects unauthenticated request', requests, status: result.status, accountInferenceVerified: false }))
  } finally {
    await coordinator.close(); await host.close(); events.close(); db.close()
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()))
  }
}
void main().catch(error => { console.error(error); process.exitCode = 1 })
