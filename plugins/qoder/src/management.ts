import { isAbsolute } from 'node:path'
import { AcpConnection, ManagedProcessTransport } from '@ekko-studio/agent-drivers'
import { StudioError, nativeAgentLaunch, nativeAgentLogin, nativeAgentSetup, type AgentManagementAdapter } from '@ekko-studio/plugin-sdk'
import { locations } from './resources'
import { checkQoderPlatform } from './environment'

const setup = nativeAgentSetup('qoder', '@qoder-ai/qodercli@1.1.78', ['login'])
const login = nativeAgentLogin('qoder', ['login'])
export const management: AgentManagementAdapter = {
  locations,
  async prepareInstall() { checkQoderPlatform(); return { kind: 'npm', packageName: '@qoder-ai/qodercli', version: '1.1.78', bin: 'qoder', runner: 'node' } },
  async setup(input, context) { checkQoderPlatform(); return setup(input, context) },
  async prepareLogin(input, context) { checkQoderPlatform(); return login(input, context) },
  async inspect({ config, mode }, context) {
    checkQoderPlatform()
    if (mode !== 'global') throw new StudioError('CAPABILITY_UNSUPPORTED', 'Qoder requires a native account instance')
    if (!isAbsolute(String(config.cwd))) throw new StudioError('INVALID_ARGUMENT', 'Qoder working directory must be absolute')
    const launch = nativeAgentLaunch('qoder', config, context)
    const process = await context.processes.spawn({ command: launch.command, args: [...launch.args, '--acp'], cwd: String(config.cwd),
      env: config.env as Record<string, string> | undefined })
    const transport = new ManagedProcessTransport(process), connection = new AcpConnection(transport, { session() {}, update() {}, permissionRequired: true })
    const abort = () => { connection.dispose(); void transport.dispose().catch(() => {}) }
    context.signal.addEventListener('abort', abort, { once: true })
    try {
      if (context.signal.aborted) throw new StudioError('CANCELLED', 'Inspection ended')
      const response = await connection.initialize()
      if (response.authMethods !== undefined && (!Array.isArray(response.authMethods) || response.authMethods.length > 32)) throw new StudioError('INVALID_ARGUMENT', 'Invalid ACP authentication methods')
      return { native: { name: response.agentInfo?.name || 'Qoder', ...(response.agentInfo?.version ? { version: response.agentInfo.version } : {}) },
        authentication: { state: 'unknown', methods: (response.authMethods || []).map((method: any) => ({ id: method.id, name: method.name })) },
        models: { status: 'unsupported', items: [] } }
    } finally { context.signal.removeEventListener('abort', abort); connection.dispose(); await transport.dispose() }
  },
}
