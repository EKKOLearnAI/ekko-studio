import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { StudioError, type AgentContextConfiguration, type AgentRuntimeContext, type JsonObject, type ModelGatewayHandle } from '@ekko-studio/plugin-sdk'
import { directories, launchZcode } from './environment'
import { reasoningEfforts } from './models'
import { createZcodeRelay } from './relay'

export async function readJson(path: string, optional = true): Promise<Record<string, any>> {
  try {
    if ((await stat(path)).size > 4 * 1024 * 1024) throw new StudioError('RESOURCE_EXHAUSTED', 'ZCode configuration exceeds size limit')
    const value = JSON.parse(await readFile(path, 'utf8'))
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected an object')
    return value
  } catch (error: any) {
    if (optional && error.code === 'ENOENT') return {}
    if (error instanceof StudioError) throw error
    throw new StudioError('INVALID_ARGUMENT', 'Invalid ZCode configuration')
  }
}

export async function nativeConfiguration(config: JsonObject, mode: string, runtime: AgentRuntimeContext, injected = true) {
  const dirs = directories(config, mode, runtime), cwd = String(config.cwd), servers: Record<string, any> = Object.create(null)
  if (!injected) return { dirs, servers }
  const ancestors: string[] = []
  let current = resolve(cwd), foundRoot = false
  while (ancestors.length < 128) {
    ancestors.push(current)
    const marker = await stat(join(current, '.git')).catch((error: any) => { if (error.code === 'ENOENT') return undefined; throw error })
    if (marker?.isDirectory() || marker?.isFile()) { foundRoot = true; break }
    const parent = dirname(current); if (parent === current) break; current = parent
  }
  if (ancestors.length >= 128) throw new StudioError('RESOURCE_EXHAUSTED', 'ZCode workspace ancestry is too deep')
  const projectDirectories = foundRoot ? ancestors.reverse() : [cwd]
  const projects = await Promise.all(projectDirectories.flatMap(directory => [join(directory, 'zcode.json'), join(directory, '.zcode', 'config.json')].map(async path => ({ directory, value: await readJson(path) }))))
  const user = await readJson(join(dirs.home, '.zcode', 'cli', 'config.json'))
  let enabled = user.features?.mcp !== false
  for (const { directory, value } of projects) {
    if (value.features?.mcp !== undefined) enabled = value.features.mcp !== false
    for (const [name, server] of Object.entries(value.mcp?.servers || {}) as Array<[string, any]>) servers[name] = { ...server, ...(server.type === 'stdio' ? { cwd: resolve(directory, server.cwd || '.') } : {}) }
  }
  Object.assign(servers, user.mcp?.servers || {})
  if (!enabled) for (const name of Object.keys(servers)) delete servers[name]
  return { dirs, servers }
}

export async function prepareZcode(configuration: AgentContextConfiguration, config: JsonObject, mode: string, runtime: AgentRuntimeContext, signal: AbortSignal, gateway?: ModelGatewayHandle) {
  if (!runtime.stateDirectory) throw new StudioError('CAPABILITY_UNSUPPORTED', 'ZCode requires host-managed auxiliary storage')
  if (mode === 'scoped' && !gateway) throw new StudioError('CAPABILITY_UNSUPPORTED', 'Scoped ZCode requires a model gateway')
  const { dirs, servers } = await nativeConfiguration(config, mode, runtime, !!Object.keys(configuration.mcpServers || {}).length), launch = launchZcode(config, runtime)
  const environment: Record<string, string> = { ...launch.env }
  if (mode === 'scoped') Object.assign(environment, { HOME: dirs.home, USERPROFILE: dirs.home, ZCODE_DATA_BASE_DIR: dirs.base, ZCODE_STORAGE_DIR: dirs.storage })
  else environment.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE ||= dirs.personal
  await mkdir(runtime.stateDirectory, { recursive: true, mode: 0o700 })
  await Promise.all((mode === 'scoped' ? [dirs.home, dirs.storage] : []).map(path => mkdir(path, { recursive: true, mode: 0o700 })))
  const temporary = await mkdtemp(join(runtime.stateDirectory, 'zcode-turn-'))
  let relay: Awaited<ReturnType<typeof createZcodeRelay>> | undefined
  let selection: { providerId: string; modelId: string; options?: { reasoningLevel: string } } | undefined
  const dispose = async () => { try { await relay?.dispose() } finally { await rm(temporary, { recursive: true, force: true }) } }
  try {
    if (gateway) {
      relay = await createZcodeRelay(gateway, signal)
      const builtin = { schemaVersion: 1, revision: 0, config: { providerConfigRules: { providerRules: [], templateRules: [] }, modelConfigRules: {
        modelRules: [{ modelMatch: '.*', config: { enabled: true, properties: { contextWindow: config.contextWindow || 131072,
          requiresMfjsToolSchema: false, inputFormat: { supportsText: true, supportsImage: gateway.images === true, supportsVideo: false, supportsAudio: false, supportsPdf: false },
          outputFormat: { supportsText: true }, supportsToolCall: true, supportsJsonSchemaOutput: false, supportsNativeWebSearch: false, supportsMidConversationSystem: false },
        optionSpecs: { reasoningLevel: { values: ['disabled'], map: '{}' }, maxOutputTokens: { max: config.outputLimit || 32768, map: "{'max_tokens': maxOutputTokens}" } } } }],
        modelApiRules: [], providerSiteRules: [], templateModelRules: [], builtinProviderModelRules: [] } } }
      selection = { providerId: 'studio-runtime', modelId: gateway.model, options: { reasoningLevel: 'disabled' } }
      const personal = { schemaVersion: 1, config: { providerOrder: ['studio-runtime'], providerConfigRules: { providerRules: [{ providerId: 'studio-runtime', providerName: 'Studio',
        config: { group: 'standard-personal', access: { type: 'api-key', apiKey: relay.key }, api: { type: 'anthropic-messages', baseUrl: relay.baseUrl }, personalModelIds: [gateway.model] } }] },
        modelConfigRules: { providerModelRules: [], manualProviderModelRules: [] }, defaultModelSelection: selection } }
      const builtinPath = join(temporary, 'builtin.json'), personalPath = join(temporary, 'personal.json')
      await Promise.all([writeFile(builtinPath, JSON.stringify(builtin), { mode: 0o600 }), writeFile(personalPath, JSON.stringify(personal), { mode: 0o600 })])
      Object.assign(environment, { ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: builtinPath, ZCODE_PERSONAL_PROVIDER_CONFIG_FILE: personalPath, ZCODE_BUILTIN_PROVIDER_BUNDLED_CONFIG_FILE: '' })
    } else if (config.model || config.reasoningEffort) {
      const file = environment.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE
      if (!file) throw new StudioError('CAPABILITY_UNSUPPORTED', 'ZCode builtin model configuration is unavailable')
      const builtin = await readJson(file, false), personal = await readJson(dirs.personal), previous = personal.config?.defaultModelSelection
      const model = config.model || previous?.modelId
      const candidates = (builtin.config?.modelConfigRules?.builtinProviderModelRules || []).filter((rule: any) => rule.modelId === model && rule.config?.enabled !== false)
      const rule = candidates.find((value: any) => value.providerId === previous?.providerId) || candidates[0]
      if (!rule?.providerId) throw new StudioError('INVALID_ARGUMENT', 'Unknown ZCode builtin model')
      const options = previous?.modelId === model && previous?.providerId === rule.providerId ? { ...previous.options } : {}
      if (config.reasoningEffort) {
        if (!reasoningEfforts(builtin, personal, rule.providerId, String(model))?.includes(String(config.reasoningEffort))) throw new StudioError('INVALID_ARGUMENT', 'Unsupported ZCode reasoning level')
        options.reasoningLevel = config.reasoningEffort
      }
      selection = { providerId: rule.providerId, modelId: String(model), ...(options.reasoningLevel ? { options: { reasoningLevel: options.reasoningLevel } } : {}) }
    }
    const nativeEnabledNames = new Set(Object.entries(servers).filter(([, server]) => server.enabled !== false && server.enable !== false && server.disabled !== true).map(([name]) => name))
    for (const [name, server] of Object.entries(configuration.mcpServers || {})) servers[name] = { ...server, enabled: server.enabled !== false && server.disabled !== true }
    const mcpServers = Object.entries(servers).flatMap<Record<string, any>>(([name, server]) => {
      if (['__proto__', 'prototype', 'constructor'].includes(name)) throw new StudioError('INVALID_ARGUMENT', 'Invalid ZCode MCP server name')
      if (server.enabled === false || server.enable === false || server.disabled === true) return []
      if (server.cwd && resolve(String(config.cwd), server.cwd) !== resolve(String(config.cwd))) throw new StudioError('CAPABILITY_UNSUPPORTED', 'ZCode native MCP working directories cannot be combined with managed MCP injection')
      const common = { name, isolation: 'session', ...(typeof server.timeoutMs === 'number' ? { timeoutMs: server.timeoutMs } : {}), ...(server.protocolVersion ? { protocolVersion: server.protocolVersion } : {}) }
      if (!server.type || server.type === 'stdio') return [{ ...common, command: server.command, args: server.args || [], env: Object.entries(server.env || {}).map(([name, value]) => ({ name, value })) }]
      return [{ ...common, type: server.type === 'streamable_http' ? 'http' : server.type, url: server.url, headers: Object.entries(server.headers || {}).map(([name, value]) => ({ name, value })), ...(server.oauth ? { oauth: server.oauth } : {}) }]
    })
    if (!mcpServers.length && Object.entries(configuration.mcpServers || {}).some(([name, server]) => nativeEnabledNames.has(name) && (server.enabled === false || server.disabled === true))) throw new StudioError('CAPABILITY_UNSUPPORTED', 'ZCode cannot replace its native MCP configuration with an empty server list')
    if (mcpServers.length > 64) throw new StudioError('RESOURCE_EXHAUSTED', 'Too many ZCode MCP servers')
    return { launch, env: environment, temporary, selection, mcpServers, dispose }
  } catch (error) { await dispose(); throw error }
}
