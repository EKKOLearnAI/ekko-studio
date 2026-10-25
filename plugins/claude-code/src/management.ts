import { StudioError, nativeAgentLaunch, nativeAgentLogin, nativeAgentSetup, type AgentManagementAdapter, type AgentRuntimeContext, type JsonObject } from '@ekko-studio/plugin-sdk'
import { directories, nativeEnvironment } from './configuration'
import { locations } from './resources'

export const claudeVersion = '2.1.310'
async function output(config: JsonObject, context: AgentRuntimeContext, args: string[]) {
  const launch = nativeAgentLaunch('claude', config, context)
  const handle = await context.processes.spawn({ command: launch.command, args: [...launch.args, ...args], cwd: String(config.cwd), env: nativeEnvironment(config) })
  const abort = () => { void handle.dispose().catch(() => {}) }
  context.signal.addEventListener('abort', abort, { once: true })
  try {
    let text = '', bytes = 0
    const decoder = new TextDecoder()
    while (true) {
      if (context.signal.aborted) throw new StudioError('CANCELLED', 'Claude inspection cancelled')
      const batch = await handle.read()
      for (const chunk of batch.chunks) {
        bytes += chunk.data.length
        if (bytes > 256 * 1024 || batch.truncated) throw new StudioError('RESOURCE_EXHAUSTED', 'Claude inspection output exceeded its limit')
        if (chunk.stream === 'stdout') text += decoder.decode(chunk.data, { stream: true })
      }
      if (batch.exit && !batch.chunks.length) return { text: text + decoder.decode(), code: batch.exit.code }
    }
  } finally { context.signal.removeEventListener('abort', abort); await handle.dispose() }
}

export const management: AgentManagementAdapter = {
  locations,
  setup: nativeAgentSetup('claude', `@anthropic-ai/claude-code@${claudeVersion}`, ['auth', 'login']),
  prepareLogin: nativeAgentLogin('claude', ['auth', 'login']),
  prepareInstall: async () => ({ kind: 'npm', packageName: '@anthropic-ai/claude-code', version: claudeVersion, bin: 'claude', runner: 'binary' }),
  async inspect({ config, mode }, context) {
    if (mode !== 'global') throw new StudioError('CAPABILITY_UNSUPPORTED', 'Scoped inspection requires a model-bound management context')
    directories(config, mode, context)
    const version = await output(config, context, ['--version'])
    if (version.code !== 0) throw new StudioError('RUNTIME_UNAVAILABLE', 'Claude version check failed')
    const native = { name: 'Claude Code', ...(version.text.match(/\b\d+\.\d+\.\d+(?:[-+][a-zA-Z0-9.-]+)?\b/) ? { version: version.text.match(/\b\d+\.\d+\.\d+(?:[-+][a-zA-Z0-9.-]+)?\b/)![0] } : {}) }
    // Both auth status and initialize create native .claude.json/backups on a new
    // Home. Do not turn a read-only check into account configuration initialization.
    return { native, authentication: { state: 'unknown', methods: [{ id: 'native-login', name: 'Claude Code native login' }] },
      models: { status: 'unsupported', items: [] } }
  },
}
