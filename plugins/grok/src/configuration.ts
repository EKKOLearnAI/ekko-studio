import { homedir } from 'node:os'
import { cp, lstat, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, sep } from 'node:path'
import { parse, stringify } from 'smol-toml'
import { StudioError, type AgentContextConfiguration, type AgentRuntimeContext, type JsonObject, type ModelGatewayHandle } from '@ekko-studio/plugin-sdk'

export const TOKEN_ENV = 'STUDIO_GROK_MODEL_TOKEN'
export function directories(config: JsonObject, runtime: Pick<AgentRuntimeContext, 'stateDirectory'>) {
  const env = (config.env || {}) as Record<string, string>, home = env.HOME || env.USERPROFILE || homedir(), source = env.GROK_HOME || join(home, '.grok')
  if (![home, source, String(config.cwd)].every(isAbsolute)) throw new StudioError('INVALID_ARGUMENT', 'Grok requires absolute directories')
  return { home, source, root: runtime.stateDirectory && join(runtime.stateDirectory, 'grok'), editable: runtime.stateDirectory && join(runtime.stateDirectory, 'grok-resources') }
}
export async function readOptional(path: string) { try { return await readFile(path, 'utf8') } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return ''; throw error } }
const managedNames = new Set(['hermes-studio-api', 'hermes-studio-browser', 'hermes-studio-devices', 'hermes-studio-use', 'ekko-studio-api', 'ekko-studio-browser', 'ekko-studio-devices', 'ekko-studio-use', 'ekko-studio-plan', 'ekko-studio-interaction', 'hermes-studio', 'hermes-studio-mcp', 'ekko-studio-mcp', 'hermes-web-ui-mcp'])
const copied = new Set(['agents', 'hooks', 'personas', 'plugins', 'roles', 'rules', 'skills', 'workflows'])
const routeKeys = new Set(['models', 'model', 'auth', 'account', 'api_key', 'access_token', 'refresh_token', 'auth_token', 'base_url', 'env_key', 'api_backend'])
function hasRoute(value: unknown): boolean { return Boolean(value && typeof value === 'object' && Object.keys(value).some(key => routeKeys.has(key))) }
/** Grok currently ignores project model tables; reject conflicting definitions rather than depending on that version detail. */
export async function verifyProjectRouting(cwd: string) {
  for (let directory = cwd;; directory = dirname(directory)) {
    for (const name of ['.grok/config.toml', '.grok/config.local.toml']) {
      const content = await readOptional(join(directory, name))
      if (content && hasRoute(parse(content))) throw new StudioError('CAPABILITY_UNSUPPORTED', 'Project Grok model routing conflicts with scoped Studio credentials')
    }
    if (dirname(directory) === directory) break
  }
}
/** Scoped editable files contain native preferences, never a generated model lease or turn instructions. */
function scopedSettings(content: string): Record<string, any> {
  const native = parse(content) as Record<string, any>
  const settings = Object.fromEntries(Object.entries(native).filter(([key]) => !routeKeys.has(key)))
  if (settings.mcp_servers && typeof settings.mcp_servers === 'object') settings.mcp_servers = Object.fromEntries(Object.entries(settings.mcp_servers).filter(([name]) => !managedNames.has(name)))
  return settings
}
async function seedFile(path: string, content: string | (() => Promise<string>)) {
  try { await lstat(path); return } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  const value = typeof content === 'function' ? await content() : content
  try { await writeFile(path, value, { mode: 0o600, flag: 'wx' }) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
}
async function copyOptional(source: string, target: string, force = true) {
  try { await cp(source, target, { recursive: true, dereference: true, force, errorOnExist: false }) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
}
export async function initializeScopedResources(config: JsonObject, runtime: Pick<AgentRuntimeContext, 'stateDirectory'>): Promise<string> {
  const { source, editable } = directories(config, runtime)
  if (!editable) throw new StudioError('CAPABILITY_UNSUPPORTED', 'Grok resources require host-managed storage')
  const marker = join(runtime.stateDirectory!, '.grok-resources-initialized')
  if (await readOptional(marker) === '1') return editable
  await mkdir(editable, { recursive: true, mode: 0o700 })
  await seedFile(join(editable, 'config.toml'), async () => stringify(scopedSettings(await readOptional(join(source, 'config.toml')))))
  await seedFile(join(editable, 'AGENTS.md'), await readOptional(join(source, 'AGENTS.md')))
  // Imports happen once. Later removal is an intentional scoped edit, not a missing seed.
  for (const name of copied) await copyOptional(join(source, name), join(editable, name), false)
  await writeFile(marker, '1', { mode: 0o600 })
  return editable
}
export async function prepareGrok(context: AgentContextConfiguration, config: JsonObject, mode: 'global' | 'scoped', runtime: AgentRuntimeContext, gateway?: ModelGatewayHandle) {
  const { home, source, root } = directories(config, runtime)
  if (!root) throw new StudioError('CAPABILITY_UNSUPPORTED', 'Grok requires host-managed storage')
  const scoped = mode === 'scoped'
  if (scoped && !gateway) throw new StudioError('CAPABILITY_UNSUPPORTED', 'Scoped Grok requires a Studio gateway')
  if (scoped) {
    await verifyProjectRouting(String(config.cwd))
    for (const path of [join(source, 'managed_config.toml'), join(source, 'requirements.toml'), ...(process.platform === 'win32' ? [] : ['/etc/grok/managed_config.toml', '/etc/grok/requirements.toml'])]) {
      const content = await readOptional(path)
      if (content && hasRoute(parse(content))) throw new StudioError('CAPABILITY_UNSUPPORTED', 'Managed Grok model routing conflicts with scoped Studio credentials')
    }
  }
  await mkdir(root, { recursive: true, mode: 0o700 })
  try {
    const path = relative(await realpath(root), await realpath(source))
    if (!path || (!isAbsolute(path) && path !== '..' && !path.startsWith(`..${sep}`))) throw new StudioError('INVALID_ARGUMENT', 'Native Grok home must be outside the runtime overlay')
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  const resourceRoot = scoped ? await initializeScopedResources(config, runtime) : source
  // Only the runtime overlay is rebuilt; sessions and persistent editable resources are separate.
  for (const name of copied) {
    await rm(join(root, name), { recursive: true, force: true })
    await copyOptional(join(resourceRoot, name), join(root, name))
  }
  // Shared Skills are a distinct read-only source; local/native imports are not reseeded.
  await copyOptional(join(home, '.agents/skills'), join(root, 'skills'))
  for (const name of ['auth.json', 'managed_config.toml', 'requirements.toml', 'sandbox.toml']) {
    await rm(join(root, name), { force: true })
    if (!scoped || name !== 'auth.json') await copyOptional(join(source, name), join(root, name))
  }
  const content = await readOptional(join(resourceRoot, 'config.toml'))
  const settings = scoped ? scopedSettings(content) : parse(content) as Record<string, any>
  if (scoped) {
    settings.models = { default: 'studio-runtime', ...(config.reasoningEffort ? { default_reasoning_effort: config.reasoningEffort } : {}) }
    settings.model = { 'studio-runtime': { model: gateway!.model, name: gateway!.model, base_url: gateway!.baseUrl, env_key: TOKEN_ENV, api_backend: 'responses',
      context_window: Number(config.contextWindow || 128000), max_completion_tokens: Number(config.outputLimit || 8192) } }
  }
  const mcp = Object.fromEntries(Object.entries(settings.mcp_servers && typeof settings.mcp_servers === 'object' ? settings.mcp_servers : {}).filter(([name]) => !managedNames.has(name)))
  for (const [name, server] of Object.entries(context.mcpServers || {})) {
    if ('command' in server) mcp[name] = { enabled: server.enabled !== false && !server.disabled, command: server.command, args: server.args || [], ...(server.env ? { env: server.env } : {}) }
    else { if (server.type === 'sse') throw new StudioError('CAPABILITY_UNSUPPORTED', 'Grok SSE MCP is unsupported'); mcp[name] = { enabled: server.enabled !== false && !server.disabled, url: server.url, ...(server.headers ? { headers: server.headers } : {}) } }
  }
  settings.mcp_servers = mcp
  await writeFile(join(root, 'config.toml'), stringify(settings), { mode: 0o600 })
  const instructions = [await readOptional(join(resourceRoot, 'AGENTS.md')), ...(scoped ? [`Grok Build is the coding harness. The selected upstream model ID is ${JSON.stringify(gateway!.model)}. When asked about model identity, use this exact selected model ID.`] : []), context.systemPrompt].filter(Boolean).join('\n\n')
  await writeFile(join(root, 'AGENTS.md'), instructions, { mode: 0o600 })
  const env: Record<string, string> = { ...(config.env as Record<string, string> || {}), GROK_HOME: root }
  if (scoped) { env.HOME = join(runtime.stateDirectory!, 'home'); env.USERPROFILE = env.HOME; await mkdir(env.HOME, { recursive: true, mode: 0o700 }); env[TOKEN_ENV] = gateway!.token }
  return { root, env, instructions, args: ['--always-approve', '--no-auto-update', ...(scoped ? ['--model', 'studio-runtime'] : config.model ? ['--model', String(config.model)] : []), ...(config.reasoningEffort ? ['--reasoning-effort', String(config.reasoningEffort)] : [])] }
}
