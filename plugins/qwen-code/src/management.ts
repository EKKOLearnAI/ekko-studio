import { locations } from './resources'
import { isAbsolute } from 'node:path'
import { AcpConnection, ManagedProcessTransport } from '@ekko-studio/agent-drivers'
import { StudioError, nativeAgentLaunch, nativeAgentSetup, nativeAgentLogin, type AgentManagementAdapter } from '@ekko-studio/plugin-sdk'

export const management: AgentManagementAdapter = {
  prepareInstall: async () => ({ kind: 'npm', packageName: '@qwen-code/qwen-code', version: '0.25.0', bin: 'qwen', runner: 'node' }),
  prepareLogin: nativeAgentLogin('qwen', []),
  locations,
  setup: nativeAgentSetup('qwen', '@qwen-code/qwen-code@0.25.0', [], '/auth'),
  async inspect({ config, mode }, context) {
    if (mode === 'scoped') throw new StudioError('CAPABILITY_UNSUPPORTED', 'Scoped inspection requires a model-bound management context')
    const cwd = String(config.cwd)
    if (!isAbsolute(cwd)) throw new StudioError('INVALID_ARGUMENT', 'Qwen working directory must be absolute')
    const process = await context.processes.spawn({ command: nativeAgentLaunch('qwen', config, context).command, args: [...nativeAgentLaunch('qwen', config, context).args, '--acp'],
      cwd, env: config.env as Record<string, string> | undefined })
    const transport = new ManagedProcessTransport(process)
    const connection = new AcpConnection(transport, { session() {}, update() {}, permissionRequired: true })
    const abort = () => { connection.dispose(); void transport.dispose().catch(() => {}) }
    context.signal.addEventListener('abort', abort, { once: true })
    try {
      if (context.signal.aborted) throw new StudioError('CANCELLED', 'Inspection ended')
      const response = await connection.initialize()
      if (response.authMethods !== undefined && (!Array.isArray(response.authMethods) || response.authMethods.length > 32)) throw new Error('Invalid ACP authentication methods')
      return {
        native: { name: response.agentInfo?.name ?? 'Qwen Code', ...(response.agentInfo?.version ? { version: response.agentInfo.version } : {}) },
        // v1 initialize advertises methods, not the current login state. Model
        // discovery requires a session; inspection must not create history.
        authentication: { state: 'unknown', methods: (response.authMethods || []).map((method: any) => ({ id: method.id, name: method.name })) },
        models: { status: 'unsupported', items: [] },
      }
    } finally { context.signal.removeEventListener('abort', abort); connection.dispose(); await transport.dispose() }
  },
}
