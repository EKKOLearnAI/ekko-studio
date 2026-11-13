import { readFile, stat } from 'node:fs/promises'
import { ModelDiscoveryError, record, text, type ModelDiscoveryAdapter } from '../models/types'
import { readZcodePersonalConfig, zcodeReasoningEfforts } from './model-options'

export const zcodeModels: ModelDiscoveryAdapter = {
  source: 'config', scope: 'builtin',
  async discover(context) {
    const file = context.env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE
    if (!file) throw new ModelDiscoveryError('unsupported')
    let size: number
    try { size = (await stat(file)).size }
    catch (error: any) { throw new ModelDiscoveryError(error.code === 'ENOENT' ? 'unsupported' : 'error') }
    if (size > 4 * 1024 * 1024) throw new ModelDiscoveryError('error')
    const config = record(JSON.parse(await readFile(file, 'utf8')))
    const personal = await readZcodePersonalConfig(context.env)
    const selected = personal.config?.defaultModelSelection
    const rules = record(record(config.config).modelConfigRules).builtinProviderModelRules
    if (!Array.isArray(rules)) throw new ModelDiscoveryError('unsupported')
    return { models: rules.flatMap((raw: unknown) => {
      const rule = record(raw), id = text(rule.modelId), provider = text(rule.providerId)
      const reasoningEfforts = id && provider ? zcodeReasoningEfforts(config, personal, provider, id) : undefined
      return id ? [{ id, name: id, ...(provider ? { provider } : {}), hidden: rule.config?.enabled === false,
        ...(selected?.modelId === id && selected?.providerId === provider ? { isDefault: true } : {}),
        ...(reasoningEfforts ? { reasoningEfforts } : {}),
      }] : []
    }) }
  },
}
