import { isAbsolute } from 'node:path'
import { AcpConnection, ManagedProcessTransport, NativeRpcConnection } from '@ekko-studio/agent-drivers'
import { StudioError, nativeAgentLaunch, nativeAgentLogin, nativeAgentSetup, type AgentManagementAdapter, type AgentInspection } from '@ekko-studio/plugin-sdk'
import { locations } from './resources'
import { copilotEnvironment } from './environment'

const setup = nativeAgentSetup('copilot', '@github/copilot@1.0.91', ['login'])
const login = nativeAgentLogin('copilot', ['login'])
export const management: AgentManagementAdapter = {
  locations,
  prepareInstall: async () => ({ kind: 'npm', packageName: '@github/copilot', version: '1.0.91', bin: 'copilot', runner: 'node' }),
  setup,
  async prepareLogin(input, context) { return { ...await login(input, context), env: { ...input.config.env as Record<string, string>, ...await copilotEnvironment(input.config, context) } } },
  async inspect({ config, mode }, context) {
    if (mode === 'scoped') throw new StudioError('CAPABILITY_UNSUPPORTED', 'Scoped inspection requires a model-bound management context')
    if (!isAbsolute(String(config.cwd))) throw new StudioError('INVALID_ARGUMENT', 'Copilot working directory must be absolute')
    const env = { ...config.env as Record<string, string>, ...await copilotEnvironment(config, context) }, launch = nativeAgentLaunch('copilot', config, context)
    const handle = await context.processes.spawn({ command: launch.command, args: [...launch.args, '--acp', '--no-auto-update'], cwd: String(config.cwd), env })
    const transport = new ManagedProcessTransport(handle), acp = new AcpConnection(transport, { session() {}, update() {}, permissionRequired: true })
    const abortAcp = () => { acp.dispose(); void transport.dispose().catch(() => {}) }
    context.signal.addEventListener('abort', abortAcp, { once: true })
    let result: AgentInspection
    try {
      if (context.signal.aborted) throw new StudioError('CANCELLED', 'Inspection ended')
      const metadata = await acp.initialize()
      if (metadata.authMethods !== undefined && (!Array.isArray(metadata.authMethods) || metadata.authMethods.length > 32)) throw new StudioError('INVALID_ARGUMENT', 'Invalid ACP authentication methods')
      result = { native: { name: metadata.agentInfo?.name || 'GitHub Copilot', ...(metadata.agentInfo?.version ? { version: metadata.agentInfo.version } : {}) },
        authentication: { state: 'unknown', methods: (metadata.authMethods || []).map((method: any) => ({ id: method.id, name: method.name })) },
        models: { status: 'unsupported', items: [] } }
    } finally { context.signal.removeEventListener('abort', abortAcp); acp.dispose(); await transport.dispose() }
    if (context.signal.aborted) throw new StudioError('CANCELLED', 'Inspection ended')
    const sdk = await context.processes.spawn({ command: launch.command, args: [...launch.args, '--headless', '--no-auto-update', '--stdio'], cwd: String(config.cwd), env })
    const rpc = new NativeRpcConnection(sdk, { notification() {} }, { framing: 'content-length', jsonrpc: true })
    const abortRpc = () => { void rpc.close().catch(() => {}) }
    context.signal.addEventListener('abort', abortRpc, { once: true })
    try {
      if (context.signal.aborted) throw new StudioError('CANCELLED', 'Inspection ended')
      await rpc.start()
      const authentication = await rpc.request('auth.getStatus', {})
      if (typeof authentication?.isAuthenticated !== 'boolean') throw new StudioError('INVALID_ARGUMENT', 'Invalid Copilot authentication status')
      result.authentication.state = authentication.isAuthenticated ? 'authenticated' : 'required'
      if (!authentication.isAuthenticated) { result.models.status = 'authentication_required'; return result }
      const catalog = await rpc.request('models.list', {})
      if (!Array.isArray(catalog?.models) || catalog.models.length > 512) throw new StudioError('RESOURCE_EXHAUSTED', 'Invalid Copilot model catalog')
      result.models = { status: 'available', items: catalog.models.map((model: any) => ({ id: model.id, name: model.name || model.id })) }
      return result
    } finally { context.signal.removeEventListener('abort', abortRpc); await rpc.close() }
  },
}
