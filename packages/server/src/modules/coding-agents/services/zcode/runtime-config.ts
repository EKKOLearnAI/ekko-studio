import { join } from 'node:path'
import { readFile, writeFile } from 'node:fs/promises'
import { createScopedRuntimeConfig, type ScopedRuntimeInput, type ScopedRuntimeConfig } from '../runtime/scoped-config'
import { readZcodePersonalConfig, zcodeReasoningEfforts } from './model-options'

/** Select a builtin model in a private overlay, preserving native provider credentials. */
export async function prepareZcodeGlobalModel(rootDir: string, model: string, env: NodeJS.ProcessEnv, reasoningEffort?: string) {
  const builtinPath = env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE
  if (!builtinPath) throw new Error('ZCode builtin model configuration is unavailable')
  const builtin = JSON.parse(await readFile(builtinPath, 'utf8'))
  const personal: any = { schemaVersion: 1, config: {}, ...await readZcodePersonalConfig(env) }
  const path = join(rootDir, 'native-provider-config.json')
  const previous = personal.config?.defaultModelSelection
  model ||= previous?.modelId || ''
  const candidates = builtin.config?.modelConfigRules?.builtinProviderModelRules?.filter((entry: any) => entry.modelId === model && entry.config?.enabled !== false) || []
  // A model can be shipped by multiple providers; keep the user's native route.
  const rule = candidates.find((entry: any) => entry.providerId === previous?.providerId) || candidates[0]
  if (!rule?.providerId) throw new Error('Unknown ZCode builtin model')
  const options = previous?.modelId === model && previous?.providerId === rule.providerId ? { ...previous.options } : {}
  if (reasoningEffort) {
    const efforts = zcodeReasoningEfforts(builtin, personal, rule.providerId, model)
    if (!efforts?.includes(reasoningEffort)) throw new Error('Unsupported ZCode reasoning level for the selected model')
    options.reasoningLevel = reasoningEffort
  }
  await writeFile(path, JSON.stringify({ ...personal, config: { ...personal.config,
    defaultModelSelection: { providerId: rule.providerId, modelId: model, options },
  } }), { mode: 0o600 })
  return { env: { ZCODE_PERSONAL_PROVIDER_CONFIG_FILE: path }, file: { key: 'providers', path: 'native-provider-config.json', absolutePath: path } }
}

export async function prepareZcodeScopedRuntime(input: ScopedRuntimeInput): Promise<ScopedRuntimeConfig> {
  const { rootDir, model, baseUrl, token, contextWindow, outputLimit, files, json, write } = await createScopedRuntimeConfig(input)
  const args: string[] = []
  const builtinPath = join(rootDir, 'zcode-builtin.json')
  const personalPath = join(rootDir, 'personal-providers.json')
  const env: Record<string, string> = { ZCODE_STORAGE_DIR: join(rootDir, 'storage'), ZCODE_DATA_BASE_DIR: rootDir,
    ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: builtinPath, ZCODE_PERSONAL_PROVIDER_CONFIG_FILE: personalPath,
    ZCODE_BUILTIN_PROVIDER_BUNDLED_CONFIG_FILE: '' }
  // Official ZCode schemaVersion 1: a minimal offline builtin layer supplies
  // model defaults; the personal layer owns the scoped provider and selection.
  await write('builtin', 'zcode-builtin.json', json({ schemaVersion: 1, revision: 0, config: {
    providerConfigRules: { providerRules: [], templateRules: [] }, modelConfigRules: {
      modelRules: [{ modelMatch: '.*', config: { enabled: true, properties: { contextWindow,
        requiresMfjsToolSchema: false, inputFormat: { supportsText: true, supportsImage: true,
          supportsVideo: false, supportsAudio: false, supportsPdf: false }, outputFormat: { supportsText: true },
        supportsToolCall: true, supportsJsonSchemaOutput: false, supportsNativeWebSearch: false,
        supportsMidConversationSystem: false }, optionSpecs: {
          reasoningLevel: { values: ['disabled'], map: '{}' },
          maxOutputTokens: { max: outputLimit, map: "{'max_tokens': maxOutputTokens}" } } } }],
      modelApiRules: [], providerSiteRules: [], templateModelRules: [], builtinProviderModelRules: [] } } }))
  await write('providers', 'personal-providers.json', json({ schemaVersion: 1, config: {
    providerOrder: ['ekko-scoped'], providerConfigRules: { providerRules: [{ providerId: 'ekko-scoped',
      providerName: 'Ekko Studio', enabled: true, config: { group: 'standard-personal',
        access: { type: 'api-key', apiKey: token }, api: { type: 'anthropic-messages', baseUrl },
        personalModelIds: [model] } }] },
    modelConfigRules: { providerModelRules: [], manualProviderModelRules: [] },
    defaultModelSelection: { providerId: 'ekko-scoped', modelId: model, options: { reasoningLevel: 'disabled' } } } }))
  return { args, env, files }
}
