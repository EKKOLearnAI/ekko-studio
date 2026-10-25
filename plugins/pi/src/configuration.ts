import { randomUUID } from 'node:crypto'
import { mkdir, open, rename, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { StudioError, type AgentContextConfiguration, type AgentRuntimeContext, type JsonObject, type ModelGatewayHandle } from '@ekko-studio/plugin-sdk'

export function directories(config: JsonObject, mode: string, runtime: AgentRuntimeContext) {
  const env = config.env as Record<string, string> || {}
  const home = mode === 'scoped' ? runtime.stateDirectory && join(runtime.stateDirectory, 'home') : env.HOME || env.USERPROFILE || homedir()
  const root = mode === 'scoped' ? runtime.stateDirectory && join(runtime.stateDirectory, 'pi') : env.PI_CODING_AGENT_DIR || home && join(home, '.pi', 'agent')
  if (!home || !root || ![home, root, String(config.cwd)].every(isAbsolute)) throw new StudioError('INVALID_ARGUMENT', 'Pi requires absolute native directories')
  return { home, root }
}

export async function preparePi(configuration: AgentContextConfiguration, config: JsonObject, mode: string, runtime: AgentRuntimeContext, gateway?: ModelGatewayHandle) {
  if (!runtime.stateDirectory) throw new StudioError('CAPABILITY_UNSUPPORTED', 'Pi requires host-managed session storage')
  if (mode === 'scoped' && !gateway) throw new StudioError('CAPABILITY_UNSUPPORTED', 'Scoped Pi requires a host model gateway')
  const { home, root } = directories(config, mode, runtime), sessions = join(runtime.stateDirectory, 'sessions')
  await Promise.all([runtime.stateDirectory, sessions, ...(mode === 'scoped' ? [home, root] : [])].map(path => mkdir(path, { recursive: true, mode: 0o700 })))
  const servers = Object.fromEntries(Object.entries(configuration.mcpServers || {}).map(([name, server]) => {
    if (server.type === 'sse') throw new StudioError('CAPABILITY_UNSUPPORTED', 'Pi does not support legacy SSE MCP servers')
    const { disabled, ...native } = server
    return [name, { ...native, enabled: server.enabled !== false && disabled !== true, exposure: 'direct' }]
  }))
  const path = join(runtime.stateDirectory, `pi-context-${runtime.runtimeSessionId}.json`)
  const nonce = randomUUID()
  const descriptor = { nonce, systemPrompt: configuration.systemPrompt || '', mcpServers: servers, ...(gateway ? { model: {
    baseUrl: gateway.baseUrl, name: gateway.model, images: gateway.images === true, reasoning: !!config.reasoningEffort && config.reasoningEffort !== 'off',
    contextWindow: config.contextWindow || 131072, outputLimit: config.outputLimit || 32768 } } : {}) }
  const dispose = async () => { await rm(`${path}.tmp`, { force: true }); await rm(`${path}.ready`, { force: true }); await rm(path, { force: true }) }
  try { await writeFile(`${path}.tmp`, JSON.stringify(descriptor), { mode: 0o600 }); await rename(`${path}.tmp`, path) }
  catch (error) { await dispose(); throw error }
  const ready = async () => {
    let file
    try {
      file = await open(`${path}.ready`, 'r')
      const buffer = Buffer.alloc(128), { bytesRead } = await file.read(buffer, 0, buffer.length, 0)
      if (buffer.subarray(0, bytesRead).toString() !== nonce) throw new Error('Invalid acknowledgement')
    } catch { throw new StudioError('RUNTIME_UNAVAILABLE', 'Pi did not load its managed runtime extension') }
    finally { await file?.close() }
  }
  return { sessions, dispose, ready, env: { STUDIO_PI_CONTEXT_FILE: path, PI_OFFLINE: '1', PI_TELEMETRY: '0',
    ...(mode === 'scoped' ? { HOME: home, USERPROFILE: home, PI_CODING_AGENT_DIR: root, STUDIO_PI_MODEL_TOKEN: gateway!.token } : {}) },
    args: [...(gateway ? ['--provider', 'studio-runtime', '--model', 'studio-model'] : config.model ? ['--model', String(config.model)] : []),
      ...(config.reasoningEffort ? ['--thinking', String(config.reasoningEffort)] : []), '--session-dir', sessions,
      ...(config.approveProjectConfig === true ? ['--approve'] : ['--no-approve'])] }
}
