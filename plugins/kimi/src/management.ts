import { AcpConnection, ManagedProcessTransport } from '@ekko-studio/agent-drivers'
import { StudioError, nativeAgentLaunch, nativeAgentLogin, nativeAgentSetup, type AgentManagementAdapter } from '@ekko-studio/plugin-sdk'
import { locations } from './resources'
import { kimiEnvironment } from './environment'

export const management: AgentManagementAdapter = {
  locations,
  prepareInstall: async () => ({ kind: 'npm', packageName: '@moonshot-ai/kimi-code', version: '2.1.1', bin: 'kimi', runner: 'node' }),
  setup: nativeAgentSetup('kimi', '@moonshot-ai/kimi-code@2.1.1', ['login']),
  prepareLogin: nativeAgentLogin('kimi', ['login']),
  async inspect({ config, mode }, context) {
    if (mode === 'scoped') throw new StudioError('CAPABILITY_UNSUPPORTED', 'Scoped inspection requires a model-bound management context')
    const env = await kimiEnvironment(config, context), launch = nativeAgentLaunch('kimi', config, context)
    const handle = await context.processes.spawn({ command: launch.command, args: [...launch.args, 'acp'], cwd: String(config.cwd), env: { ...config.env as Record<string, string>, ...env } })
    const transport = new ManagedProcessTransport(handle), connection = new AcpConnection(transport, { session() {}, update() {}, permissionRequired: true })
    const abort = () => { connection.dispose(); void transport.dispose().catch(() => {}) }
    context.signal.addEventListener('abort', abort, { once: true })
    try {
      if (context.signal.aborted) throw context.signal.reason
      const response = await connection.initialize()
      if (response.authMethods !== undefined && (!Array.isArray(response.authMethods) || response.authMethods.length > 32)) throw new StudioError('INVALID_ARGUMENT', 'Invalid ACP authentication methods')
      return { native: { name: response.agentInfo?.name || 'Kimi Code', ...(response.agentInfo?.version ? { version: response.agentInfo.version } : {}) },
        authentication: { state: 'unknown', methods: (response.authMethods || []).map((method: any) => ({ id: method.id, name: method.name })) },
        models: { status: 'unsupported', items: [] } }
    } finally { context.signal.removeEventListener('abort', abort); connection.dispose(); await transport.dispose() }
  },
}
