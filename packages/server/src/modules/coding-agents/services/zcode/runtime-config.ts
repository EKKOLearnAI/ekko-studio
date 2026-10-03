import { join } from 'node:path'
import { createScopedRuntimeConfig, type ScopedRuntimeInput, type ScopedRuntimeConfig } from '../runtime/scoped-config'

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
        requiresMfjsToolSchema: false, inputFormat: { supportsText: true, supportsImage: false,
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
