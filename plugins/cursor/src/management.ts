import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { StudioError, nativeAgentLaunch, nativeAgentLogin, type AgentManagementAdapter, type AgentRuntimeContext, type JsonObject } from '@ekko-studio/plugin-sdk'
import { directories, installationUrl, validateArguments } from './configuration'
import { locations } from './resources'

/** Even --version bootstraps cli-config.json; keep this away from the account Home. */
async function version(config: JsonObject, context: AgentRuntimeContext) {
  directories(config)
  const launch = nativeAgentLaunch('agent', config, context)
  validateArguments(launch.args)
  const home = await mkdtemp(join(tmpdir(), 'studio-cursor-inspect-'))
  let process: Awaited<ReturnType<typeof context.processes.spawn>> | undefined
  const abort = () => { void process?.dispose().catch(() => {}) }
  context.signal.addEventListener('abort', abort, { once: true })
  try {
    process = await context.processes.spawn({ command: launch.command, args: [...launch.args, '--disable-auto-update', '--version'], cwd: home,
      env: { HOME: home, USERPROFILE: home, CURSOR_CONFIG_DIR: join(home, '.cursor'), XDG_CONFIG_HOME: join(home, 'xdg'), XDG_CACHE_HOME: join(home, 'cache'),
        NODE_COMPILE_CACHE: join(home, 'compile-cache'), CURSOR_API_KEY: '', CURSOR_AUTH_TOKEN: '', CURSOR_API_ENDPOINT: '', AGENT_CLI_CREDENTIAL_STORE: 'file', CURSOR_DISABLE_AUTO_UPDATE: '1', NO_OPEN_BROWSER: '1' } })
    let output = '', bytes = 0
    const decoder = new TextDecoder()
    while (true) {
      if (context.signal.aborted) throw new StudioError('CANCELLED', 'Cursor inspection cancelled')
      const batch = await process.read()
      for (const chunk of batch.chunks) {
        bytes += chunk.data.length
        if (bytes > 16384 || batch.truncated) throw new StudioError('RESOURCE_EXHAUSTED', 'Cursor version output exceeded its limit')
        if (chunk.stream === 'stdout') output += decoder.decode(chunk.data, { stream: true })
      }
      if (batch.exit && !batch.chunks.length) {
        if (batch.exit.code !== 0) throw new StudioError('RUNTIME_UNAVAILABLE', 'Cursor version check failed')
        return (output + decoder.decode()).match(/\b\d{4}\.\d{2}\.\d{2}-[a-zA-Z0-9]{6,40}\b/)?.[0]
      }
    }
  } finally {
    context.signal.removeEventListener('abort', abort)
    try { await process?.dispose() } finally { await rm(home, { recursive: true, force: true }) }
  }
}

export const management: AgentManagementAdapter = {
  locations,
  prepareLogin: nativeAgentLogin('agent', ['login']),
  async setup({ config, mode }, context) {
    if (mode !== 'global') throw new StudioError('CAPABILITY_UNSUPPORTED', 'Cursor uses a native Cursor account and supports global mode only')
    const unavailable = !config.command && context.nativeCli?.state === 'unavailable'
    const launch = unavailable ? { command: 'agent', args: [] } : nativeAgentLaunch('agent', config, context)
    const result: Awaited<ReturnType<NonNullable<AgentManagementAdapter['setup']>>> = { cli: { state: 'unavailable' }, installation: { kind: 'manual', url: installationUrl },
      authentication: { kind: 'native', command: launch.command, args: [...launch.args, 'login'] } }
    if (unavailable) return result
    try { const value = await version(config, context); result.cli = { state: 'available', ...(value ? { version: value } : {}) } }
    catch (error) { if (!(error instanceof StudioError) || error.code !== 'RUNTIME_UNAVAILABLE') throw error }
    return result
  },
  async inspect({ config, mode }, context) {
    if (mode !== 'global') throw new StudioError('CAPABILITY_UNSUPPORTED', 'Cursor supports global mode only')
    const value = await version(config, context)
    return { native: { name: 'Cursor', ...(value ? { version: value } : {}) }, authentication: { state: 'unknown', methods: [{ id: 'native-login', name: 'Cursor native login' }] },
      models: { status: 'unsupported', items: [] } }
  },
}
