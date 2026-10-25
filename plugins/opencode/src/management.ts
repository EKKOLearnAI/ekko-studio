import { isAbsolute } from 'node:path'
import { AcpConnection, ManagedProcessTransport } from '@ekko-studio/agent-drivers'
import { StudioError, nativeAgentLaunch, nativeAgentLogin, nativeAgentSetup, type AgentManagementAdapter } from '@ekko-studio/plugin-sdk'
import { nativeEnvironment } from './configuration'
import { locations } from './resources'

const setup = nativeAgentSetup('opencode', 'opencode-ai@1.19.4', ['auth', 'login'])
const login = nativeAgentLogin('opencode', ['auth', 'login'])
export const management: AgentManagementAdapter = {
  locations, setup,
  prepareInstall: async () => ({ kind: 'npm', packageName: 'opencode-ai', version: '1.19.4', bin: 'opencode', runner: 'binary' }),
  async prepareLogin(input, context) { return { ...await login(input, context), env: { ...input.config.env as Record<string, string>, ...nativeEnvironment(input.config) } } },
  async inspect({ config, mode }, context) {
    if (mode === 'scoped') throw new StudioError('CAPABILITY_UNSUPPORTED', 'Scoped inspection requires a model-bound management context')
    if (!isAbsolute(String(config.cwd))) throw new StudioError('INVALID_ARGUMENT', 'OpenCode working directory must be absolute')
    const launch = nativeAgentLaunch('opencode', config, context)
    const handle = await context.processes.spawn({ command: launch.command, args: [...launch.args, 'acp'], cwd: String(config.cwd),
      env: { ...config.env as Record<string, string>, ...nativeEnvironment(config) } })
    const transport = new ManagedProcessTransport(handle), connection = new AcpConnection(transport, { session() {}, update() {}, permissionRequired: true })
    const abort = () => { connection.dispose(); void transport.dispose().catch(() => {}) }
    context.signal.addEventListener('abort', abort, { once: true })
    try {
      if (context.signal.aborted) throw new StudioError('CANCELLED', 'Inspection ended')
      const response = await connection.initialize()
      if (response.authMethods !== undefined && (!Array.isArray(response.authMethods) || response.authMethods.length > 32)) throw new StudioError('INVALID_ARGUMENT', 'Invalid ACP authentication methods')
      return { native: { name: response.agentInfo?.name || 'OpenCode', ...(response.agentInfo?.version ? { version: response.agentInfo.version } : {}) },
        authentication: { state: 'unknown', methods: (response.authMethods || []).map((method: any) => ({ id: method.id, name: method.name })) },
        models: { status: 'unsupported', items: [] } }
    } finally { context.signal.removeEventListener('abort', abort); connection.dispose(); await transport.dispose() }
  },
}
