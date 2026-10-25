import { StudioError, nativeAgentSetup, type AgentManagementAdapter } from '@ekko-studio/plugin-sdk'
import { locations } from './resources'

const setupNative = nativeAgentSetup('dsh', '@deepseek-ai/dsh@0.1.7-rc.2', ['web'])
export const management: AgentManagementAdapter = {
  locations,
  prepareInstall: async () => ({ kind: 'npm', packageName: '@deepseek-ai/dsh', version: '0.1.7-rc.2', bin: 'dsh', runner: 'node', preferDedupe: true }),
  async setup(input, runtime) { const result = await setupNative(input, runtime); if ('args' in result.installation) result.installation.args.push('--prefer-dedupe'); return result },
  async inspect(input, runtime) {
    const setup = await setupNative(input, runtime)
    if (setup.cli.state !== 'available') throw new StudioError('RUNTIME_UNAVAILABLE', 'DSH executable is not available')
    return { native: { name: 'DeepSeek Harness', ...(setup.cli.version ? { version: setup.cli.version } : {}) },
      authentication: { state: 'unknown', methods: [] }, models: { status: 'unsupported', items: [] } }
  },
}
