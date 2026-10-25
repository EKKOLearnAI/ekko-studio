import { lstat, mkdir, readdir, readFile, symlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join } from 'node:path'
import { StudioError, type AgentContextConfiguration, type AgentRuntimeContext, type JsonObject } from '@ekko-studio/plugin-sdk'
import { record } from './protocol'

export function nativeHome(config: JsonObject): string {
  const env = (config.env || {}) as Record<string, string>,
    home = env.HOME || env.USERPROFILE || homedir()
  if (!isAbsolute(home)) throw new StudioError('INVALID_ARGUMENT', 'Antigravity HOME must be absolute')
  return home
}
export function sourceHome(config: JsonObject, mode: 'global' | 'scoped', runtime: Pick<AgentRuntimeContext, 'stateDirectory'>): string {
  if (mode === 'global') return nativeHome(config)
  if (!runtime.stateDirectory) throw new StudioError('CAPABILITY_UNSUPPORTED', 'Antigravity requires host-managed storage')
  return join(runtime.stateDirectory, 'native-home')
}
async function json(path: string): Promise<JsonObject> {
  let value: string
  try {
    value = await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}
    throw error
  }
  if (Buffer.byteLength(value) > 1024 * 1024) throw new StudioError('RESOURCE_EXHAUSTED', 'Antigravity native configuration is too large')
  try {
    const parsed: unknown = JSON.parse(value.replace(/^\uFEFF/, '').trim() || '{}')
    if (!record(parsed)) throw new Error()
    return parsed
  } catch {
    throw new StudioError('INVALID_ARGUMENT', 'Antigravity native configuration must be a JSON object')
  }
}
async function link(source: string, target: string, kind: 'dir' | 'file') {
  await mkdir(dirname(target), { recursive: true })
  try {
    await symlink(source, target, kind === 'dir' ? 'junction' : 'file')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    const item = await lstat(target)
    if (!item.isSymbolicLink()) throw new StudioError('REVISION_CONFLICT', 'Antigravity native link is occupied')
  }
}
export async function prepareNative(
  config: JsonObject,
  mode: 'global' | 'scoped',
  runtime: AgentRuntimeContext,
  context: AgentContextConfiguration,
  external?: { baseUrl: string; token: string },
) {
  if (!runtime.stateDirectory) throw new StudioError('CAPABILITY_UNSUPPORTED', 'Antigravity requires host-managed storage')
  const home = sourceHome(config, mode, runtime),
    source = join(home, '.gemini'),
    shadowHome = join(runtime.stateDirectory, 'shadow', runtime.runtimeSessionId),
    shadow = join(shadowHome, '.gemini')
  await mkdir(join(shadow, 'config'), { recursive: true })
  await mkdir(join(shadow, 'antigravity-cli'), { recursive: true })
  // Native state stays in its own home. Scoped history is linked only to the instance's managed home.
  await mkdir(join(source, 'antigravity'), { recursive: true })
  for (const entry of await readdir(source, { withFileTypes: true })) {
    if (entry.name === 'config' || entry.name === 'antigravity-cli') continue
    await link(join(source, entry.name), join(shadow, entry.name), entry.isDirectory() ? 'dir' : 'file')
  }
  for (const name of ['config', 'antigravity-cli']) {
    const entries = await readdir(join(source, name), { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return []
      throw error
    })
    for (const entry of entries) {
      if (['mcp_config.json', 'settings.json', 'AGENTS.md', 'skills'].includes(entry.name)) continue
      await link(join(source, name, entry.name), join(shadow, name, entry.name), entry.isDirectory() ? 'dir' : 'file')
    }
  }
  if (mode === 'global' && process.platform === 'darwin') {
    for (const [part, kind] of [
      ['Library/Keychains', 'dir'],
      ['Library/Preferences/com.apple.security.plist', 'file'],
    ] as const) {
      const path = join(home, part),
        exists = await lstat(path).catch((error: NodeJS.ErrnoException) => {
          if (error.code === 'ENOENT') return
          throw error
        })
      if (exists) await link(path, join(shadowHome, part), kind)
    }
  }
  const skills = join(shadow, 'config', 'skills')
  await mkdir(skills, { recursive: true })
  for (const directory of [join(source, 'config', 'skills'), join(home, '.agents', 'skills')]) {
    const entries = await readdir(directory, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return []
      throw error
    })
    for (const entry of entries)
      if (entry.isDirectory() || entry.isSymbolicLink()) await link(join(directory, entry.name), join(skills, entry.name), 'dir')
  }
  const settings = await json(join(source, 'antigravity-cli', 'settings.json')),
    mcp = await json(join(source, 'config', 'mcp_config.json'))
  const injected = Object.fromEntries(
    Object.entries(context.mcpServers || {}).map(([name, entry]) => {
      if (entry.type === 'sse') throw new StudioError('CAPABILITY_UNSUPPORTED', 'Antigravity native MCP requires stdio or Streamable HTTP')
      const { enabled, url, ...rest } = entry as typeof entry & { url?: string }
      return [name, { ...rest, ...(url ? { serverUrl: url } : {}), ...(enabled === undefined ? {} : { disabled: !enabled }) }]
    }),
  )
  if (external) settings.modelProvider = 'gemini'
  const permissions = record(settings.permissions) ? settings.permissions : {}
  settings.permissions = {
    ...permissions,
    allow: [
      ...new Set([
        ...(Array.isArray(permissions.allow) ? permissions.allow : []),
        ...Object.entries(injected)
          .filter(([, entry]) => !entry.disabled)
          .map(([name]) => `mcp(${name}/*)`),
      ]),
    ],
  }
  let rules = ''
  try {
    rules = await readFile(join(source, 'config', 'AGENTS.md'), 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  await writeFile(join(shadow, 'antigravity-cli', 'settings.json'), JSON.stringify(settings), { mode: 0o600 })
  await writeFile(
    join(shadow, 'config', 'mcp_config.json'),
    JSON.stringify({ ...mcp, mcpServers: { ...(record(mcp.mcpServers) ? mcp.mcpServers : {}), ...injected } }),
    { mode: 0o600 },
  )
  await writeFile(join(shadow, 'config', 'AGENTS.md'), [rules, context.systemPrompt].filter(Boolean).join('\n\n'), { mode: 0o600 })
  return {
    home: shadowHome,
    env: {
      HOME: shadowHome,
      USERPROFILE: shadowHome,
      AGY_CLI_DISABLE_AUTO_UPDATE: '1',
      ANTIGRAVITY_GEMINI_DIR: join(shadowHome, '.gemini'),
      ...(external
        ? {
            GEMINI_API_KEY: external.token,
            GOOGLE_GEMINI_BASE_URL: external.baseUrl,
            AGY_ADC_AUTH: 'false',
            GOOGLE_GENAI_USE_VERTEXAI: 'false',
          }
        : {}),
    },
  }
}

/** Scoped native preferences must not redirect the Run's ephemeral Gemini credential. */
export async function assertScopedRouting(config: JsonObject, runtime: Pick<AgentRuntimeContext, 'stateDirectory'>): Promise<void> {
  const home = sourceHome(config, 'scoped', runtime),
    cwd = String(config.cwd)
  const paths = [
    join(home, '.gemini/antigravity-cli/settings.json'),
    join(home, '.gemini/config/config.json'),
    ...['.agents', '.gemini'].flatMap((directory) =>
      ['settings.json', 'settings.local.json', 'config.json'].map((name) => join(cwd, directory, name)),
    ),
  ]
  const protectedEnv =
    /^(GEMINI_API_KEY|GOOGLE_GEMINI_BASE_URL|ANTIGRAVITY_GEMINI_DIR|AGY_ADC_AUTH|GOOGLE_APPLICATION_CREDENTIALS|GOOGLE_GENAI_USE_VERTEXAI)$/
  const visit = (value: unknown, depth = 0): void => {
    if (depth > 32) throw new StudioError('INVALID_ARGUMENT', 'Antigravity configuration nesting is too deep')
    if (Array.isArray(value)) {
      for (const entry of value) visit(entry, depth + 1)
      return
    }
    if (!record(value)) return
    for (const [name, entry] of Object.entries(value)) {
      if (
        protectedEnv.test(name) ||
        (['customModelsConfig', 'gcp', 'baseUrl', 'baseURL', 'apiKey'].includes(name) && entry !== null) ||
        (name === 'modelProvider' && entry !== 'gemini' && entry !== '')
      )
        throw new StudioError('CAPABILITY_UNSUPPORTED', 'Scoped Antigravity native configuration conflicts with Studio model routing')
      visit(entry, depth + 1)
    }
  }
  for (const path of paths) visit(await json(path))
}
