import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { StudioError, type AgentContextConfiguration, type AgentRuntimeContext, type JsonObject, type ModelGatewayHandle } from '@ekko-studio/plugin-sdk'

const providerFlags = ['CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY', 'CLAUDE_CODE_USE_ANTHROPIC_AWS', 'CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD', 'CLAUDE_CODE_USE_MANTLE', 'CLAUDE_CODE_USE_GATEWAY']
const credentials = new Set(['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_CUSTOM_HEADERS', 'CLAUDE_CONFIG_DIR', 'HOME', 'USERPROFILE'])
function rejectCredentialOverrides(settings: Record<string, any>) {
  if (['apiKeyHelper', 'awsAuthRefresh', 'awsCredentialExport', 'gcpAuthRefresh'].some(key => settings[key])
    || Object.keys(settings.env || {}).some(key => credentials.has(key.toUpperCase()))) throw new StudioError('CAPABILITY_UNSUPPORTED', 'Scoped Claude settings cannot override Studio credentials or private storage')
}
export function verifyScopedSettings(value: unknown, baseUrl: string) {
  const settings = value as Record<string, any>
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) throw new StudioError('INVALID_ARGUMENT', 'Invalid effective Claude settings')
  rejectCredentialOverrides(settings)
  if (settings.env?.ANTHROPIC_BASE_URL !== baseUrl || providerFlags.some(key => settings.env?.[key] !== '0')) throw new StudioError('CAPABILITY_UNSUPPORTED', 'Native Claude policy conflicts with Studio model routing')
}

export function directories(config: JsonObject, mode: 'global' | 'scoped', context: Pick<AgentRuntimeContext, 'stateDirectory'>) {
  const env = config.env as Record<string, string> || {}
  const home = mode === 'scoped' ? context.stateDirectory && join(context.stateDirectory, 'home') : env.HOME || env.USERPROFILE || homedir()
  const root = mode === 'scoped' ? context.stateDirectory && join(context.stateDirectory, 'claude') : env.CLAUDE_CONFIG_DIR || join(home!, '.claude')
  if (!home || !root) throw new StudioError('CAPABILITY_UNSUPPORTED', 'Scoped Claude Code requires host-managed storage')
  if (![home, root, String(config.cwd)].every(isAbsolute)) throw new StudioError('INVALID_ARGUMENT', 'Claude Code directories must be absolute')
  return { home, root }
}

export function nativeEnvironment(config: JsonObject): Record<string, string> {
  return { ...config.env as Record<string, string>, DISABLE_AUTOUPDATER: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' }
}

export async function prepareClaude(config: JsonObject, mode: 'global' | 'scoped', context: AgentRuntimeContext,
  configuration: AgentContextConfiguration, gateway?: ModelGatewayHandle) {
  const { home, root } = directories(config, mode, context)
  const env = nativeEnvironment(config)
  const args: string[] = []
  if (mode === 'scoped') {
    if (!gateway) throw new StudioError('CAPABILITY_UNSUPPORTED', 'Scoped Claude Code requires a model gateway')
    await Promise.all([mkdir(home, { recursive: true, mode: 0o700 }), mkdir(root, { recursive: true, mode: 0o700 })])
    const baseUrl = gateway.baseUrl.replace(/\/v1\/?$/, '')
    Object.assign(env, { HOME: home, USERPROFILE: home, CLAUDE_CONFIG_DIR: root,
      ANTHROPIC_BASE_URL: baseUrl, ANTHROPIC_API_KEY: gateway.token, ANTHROPIC_AUTH_TOKEN: gateway.token,
      CLAUDE_CODE_OAUTH_TOKEN: '', ...Object.fromEntries(providerFlags.map(key => [key, '0'])),
      ANTHROPIC_MODEL: gateway.model, ANTHROPIC_DEFAULT_HAIKU_MODEL: gateway.model, ANTHROPIC_DEFAULT_SONNET_MODEL: gateway.model,
      ANTHROPIC_DEFAULT_OPUS_MODEL: gateway.model, ANTHROPIC_SMALL_FAST_MODEL: gateway.model, ENABLE_TOOL_SEARCH: env.ENABLE_TOOL_SEARCH || 'true' })
    for (const path of [join(root, 'settings.json'), join(String(config.cwd), '.claude/settings.json'), join(String(config.cwd), '.claude/settings.local.json')]) {
      try {
        const text = await readFile(path, 'utf8')
        if (Buffer.byteLength(text) > 1024 * 1024) throw new StudioError('RESOURCE_EXHAUSTED', 'Claude settings exceed their limit')
        const settings = JSON.parse(text)
        if (!settings || typeof settings !== 'object' || Array.isArray(settings)) throw new StudioError('INVALID_ARGUMENT', 'Invalid Claude settings')
        rejectCredentialOverrides(settings)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error instanceof StudioError ? error : new StudioError('INVALID_ARGUMENT', 'Invalid Claude settings')
      }
    }
    // Native settings.env overrides the process environment. A non-secret flag
    // overlay pins routing; the credential itself remains exclusively in env.
    args.push('--settings', JSON.stringify({ env: Object.fromEntries(['ANTHROPIC_BASE_URL', 'ANTHROPIC_MODEL', 'ANTHROPIC_DEFAULT_HAIKU_MODEL',
      'ANTHROPIC_DEFAULT_SONNET_MODEL', 'ANTHROPIC_DEFAULT_OPUS_MODEL', 'ANTHROPIC_SMALL_FAST_MODEL', ...providerFlags].map(key => [key, env[key]])) }))
  }
  const servers: Record<string, unknown> = Object.create(null)
  // This legacy resource remains editable; the native CLI also loads its own user/project MCP layers.
  try {
    const text = await readFile(join(root, 'mcp.json'), 'utf8')
    if (Buffer.byteLength(text) > 1024 * 1024) throw new StudioError('RESOURCE_EXHAUSTED', 'Claude MCP configuration is too large')
    const parsed = JSON.parse(text)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || (parsed.mcpServers && (typeof parsed.mcpServers !== 'object' || Array.isArray(parsed.mcpServers)))) throw new Error('Invalid MCP configuration')
    Object.assign(servers, parsed.mcpServers || {})
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new StudioError('INVALID_ARGUMENT', 'Invalid Claude MCP configuration') }
  for (const [name, server] of Object.entries(configuration.mcpServers || {})) {
    if (server.enabled === false || server.disabled) { delete servers[name]; continue }
    const { enabled: _enabled, disabled: _disabled, ...native } = server
    servers[name] = 'url' in native ? { ...native, type: native.type === 'streamable_http' ? 'http' : native.type || 'http' } : native
  }
  if (Object.keys(servers).length > 128) throw new StudioError('RESOURCE_EXHAUSTED', 'Claude MCP server limit exceeded')
  let nativePrompt = ''
  try {
    nativePrompt = await readFile(join(root, 'hermes-rules.md'), 'utf8')
    if (Buffer.byteLength(nativePrompt) > 65536) throw new StudioError('RESOURCE_EXHAUSTED', 'Claude instructions exceed their limit')
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  let path: string | undefined
  if (Object.keys(servers).length) {
    if (!context.stateDirectory) throw new StudioError('CAPABILITY_UNSUPPORTED', 'Managed Claude MCP requires host-managed storage')
    await mkdir(context.stateDirectory, { recursive: true, mode: 0o700 })
    path = join(context.stateDirectory, `mcp-${context.runtimeSessionId}.json`)
    await writeFile(path, JSON.stringify({ mcpServers: servers }), { mode: 0o600 })
    args.push('--mcp-config', path)
  }
  if (config.model || gateway) args.push('--model', gateway?.model || String(config.model))
  if (config.reasoningEffort) args.push('--effort', String(config.reasoningEffort))
  const permissionMode = config.permissionMode || 'bypassPermissions'
  args.push('--permission-mode', String(permissionMode))
  if (permissionMode === 'bypassPermissions') args.push('--allow-dangerously-skip-permissions')
  if (config.contextWindow) env.CLAUDE_CODE_AUTO_COMPACT_WINDOW = String(config.contextWindow)
  if (config.outputLimit) env.CLAUDE_CODE_MAX_OUTPUT_TOKENS = String(config.outputLimit)
  return { env, args, nativePrompt, cleanup: async () => { if (path) await rm(path, { force: true }) } }
}
