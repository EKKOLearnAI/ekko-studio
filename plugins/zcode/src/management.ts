import { StudioError, nativeAgentSetup, type AgentManagementAdapter } from '@ekko-studio/plugin-sdk'
import { directories, docsUrl, launchZcode } from './environment'
import { locations } from './resources'
import { readJson } from './configuration'
import { reasoningEfforts } from './models'

const nativeSetup = nativeAgentSetup('zcode', { kind: 'manual', url: docsUrl }, ['login'])
const setup: NonNullable<AgentManagementAdapter['setup']> = async (input, context) => {
  const launch = launchZcode(input.config, context)
  return nativeSetup({ ...input, config: { ...input.config, command: launch.command, args: launch.args, env: launch.env } }, context)
}
export const management: AgentManagementAdapter = {
  locations, setup,
  async prepareLogin({ config, mode }, context) {
    if (mode !== 'global') throw new StudioError('CAPABILITY_UNSUPPORTED', 'Scoped instances use Studio credentials')
    const launch = launchZcode(config, context), dirs = directories(config, mode, context)
    return { command: launch.command, args: [...launch.args, 'login'], cwd: String(config.cwd), env: { ...launch.env, ZCODE_PERSONAL_PROVIDER_CONFIG_FILE: dirs.personal } }
  },
  async inspect(input, context) {
    if (input.mode !== 'global') throw new StudioError('CAPABILITY_UNSUPPORTED', 'Scoped inspection requires a model-bound management context')
    const version = await setup(input, context)
    if (version.cli.state !== 'available') throw new StudioError('RUNTIME_UNAVAILABLE', 'ZCode is unavailable')
    const path = launchZcode(input.config, context).env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE
    let models: { status: 'unsupported' | 'available'; items: Array<{ id: string; name: string; isDefault?: boolean; reasoningEfforts?: string[] }> } = { status: 'unsupported', items: [] }
    if (path) {
      const builtin = await readJson(path), personal = await readJson(directories(input.config, input.mode, context).personal), selected = personal.config?.defaultModelSelection
      const rules = builtin.config?.modelConfigRules?.builtinProviderModelRules
      if (Array.isArray(rules)) {
        if (rules.length > 1024) throw new StudioError('RESOURCE_EXHAUSTED', 'ZCode model catalog is too large')
        const ids = new Set<string>()
        const items = rules.flatMap((rule: any) => {
          if (typeof rule.modelId !== 'string' || !rule.modelId || rule.modelId.length > 256 || typeof rule.providerId !== 'string' || rule.config?.enabled === false || ids.has(rule.modelId)) return []
          ids.add(rule.modelId)
          const efforts = reasoningEfforts(builtin, personal, rule.providerId, rule.modelId)
          return [{ id: rule.modelId, name: rule.modelId, ...(selected?.modelId === rule.modelId ? { isDefault: true } : {}), ...(efforts ? { reasoningEfforts: efforts } : {}) }]
        })
        models = { status: 'available', items }
      }
    }
    return { native: { name: 'ZCode', version: version.cli.version }, authentication: { state: 'unknown', methods: [{ id: 'zcode-login', name: 'Z.AI OAuth' }] }, models }
  },
}
