import { nativeAgentLogin, nativeAgentSetup, type AgentManagementAdapter } from '@ekko-studio/plugin-sdk'
import { locations } from './resources'
const setup = nativeAgentSetup('agy', { kind: 'manual', url: 'https://antigravity.google/docs/cli/install' }, [])
export const management: AgentManagementAdapter = {
  locations,
  setup,
  prepareLogin: nativeAgentLogin('agy', []),
  async inspect(input, context) {
    const result = await setup(input, context)
    return {
      native: { name: 'Antigravity', ...(result.cli.version ? { version: result.cli.version } : {}) },
      authentication: { state: input.mode === 'scoped' ? 'not_required' : 'unknown', methods: [] },
      models: { status: 'unsupported', items: [] },
    }
  },
}
