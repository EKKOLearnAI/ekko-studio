import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { prepareZcodeGlobalModel } from '../../packages/server/src/modules/coding-agents/services/zcode/runtime-config'
import { zcodeReasoningEfforts } from '../../packages/server/src/modules/coding-agents/services/zcode/model-options'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'zcode-native-model-'))
  roots.push(root)
  const builtin = join(root, 'builtin.json'), personal = join(root, 'personal.json')
  await writeFile(builtin, JSON.stringify({ config: { modelConfigRules: { builtinProviderModelRules: [
    { providerId: 'native-account', modelId: 'native-model' },
  ] } } }))
  return { root, personal, env: { ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: builtin, ZCODE_PERSONAL_PROVIDER_CONFIG_FILE: personal } }
}

describe('ZCode global model selection', () => {
  it.each(['native-model', ''])('applies an explicit native effort to the selected or default model: %s', async model => {
    const { root, personal, env } = await fixture()
    await writeFile(env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE, JSON.stringify({ config: { modelConfigRules: {
      modelRules: [{ modelMatch: 'native-model', config: { optionSpecs: { reasoningLevel: { values: ['low', 'high', 'max'] } } } }],
      builtinProviderModelRules: [{ providerId: 'native-account', modelId: 'native-model' }],
    } } }))
    const source = JSON.stringify({ config: { defaultModelSelection: {
      providerId: 'native-account', modelId: 'native-model', options: { reasoningLevel: 'low' },
    } } })
    await writeFile(personal, source)
    const prepared = await prepareZcodeGlobalModel(root, model, env, 'max')
    expect(JSON.parse(await readFile(prepared.file.absolutePath, 'utf8')).config.defaultModelSelection).toEqual({
      providerId: 'native-account', modelId: 'native-model', options: { reasoningLevel: 'max' },
    })
    expect(await readFile(personal, 'utf8')).toBe(source)
    await expect(prepareZcodeGlobalModel(root, model, env, 'xhigh')).rejects.toThrow('Unsupported ZCode reasoning level')
  })

  it('follows native API, site, template and personal override precedence for effort values', () => {
    const builtin = { config: {
      providerConfigRules: {
        templateRules: [{ templateId: 'native-template', config: { api: { type: 'native-api', baseUrl: 'https://native.test/' } } }],
        providerRules: [{ providerId: 'account', templateId: 'native-template' }],
      }, modelConfigRules: {
        modelRules: [{ modelMatch: '.*', config: { optionSpecs: { reasoningLevel: { values: ['disabled', 'enabled'] } } } }],
        modelApiRules: [{ modelMatch: 'MODEL', apiTypeMatch: 'native-api', config: { optionSpecs: { reasoningLevel: { values: ['low', 'high'] } } } }],
        providerSiteRules: [{ modelMatch: 'model', baseUrlMatch: 'https://native\\.test', config: { optionSpecs: { reasoningLevel: { values: ['high', 'max'] } } } }],
        templateModelRules: [{ templateId: 'native-template', modelId: 'Model', config: { optionSpecs: { reasoningLevel: { values: ['low', 'max'] } } } }],
        builtinProviderModelRules: [{ providerId: 'account', modelId: 'Model', config: { optionSpecs: { reasoningLevel: { map: '{}' } } } }],
      },
    } }
    expect(zcodeReasoningEfforts(builtin, {}, 'account', 'Model')).toEqual(['low', 'max'])
    const personal: any = { config: { modelConfigRules: { providerModelRules: [{ providerId: 'account', modelId: 'Model',
      config: { optionSpecs: { reasoningLevel: { values: ['high'] } } } }] } } }
    expect(zcodeReasoningEfforts(builtin, personal, 'account', 'Model')).toEqual(['high'])
    personal.config.modelConfigRules.manualProviderModelRules = [{ providerId: 'account', modelId: 'Model', config: {} }]
    expect(zcodeReasoningEfforts(builtin, personal, 'account', 'Model')).toBeUndefined()
    personal.config.modelConfigRules.manualProviderModelRules[0].config = { optionSpecs: { reasoningLevel: { values: ['disabled'] } } }
    expect(zcodeReasoningEfforts(builtin, personal, 'account', 'Model')).toEqual(['disabled'])
  })
  it('uses a private selection overlay and preserves native credentials and source settings', async () => {
    const { root, personal, env } = await fixture()
    const source = JSON.stringify({ schemaVersion: 1, config: {
      providerConfigRules: { providerRules: [{ providerId: 'native-account', config: { access: { apiKey: 'native-credential' } } }] },
      defaultModelSelection: { providerId: 'previous', modelId: 'old-model', options: { reasoningLevel: 'old-only' } },
    } })
    await writeFile(personal, source)
    const prepared = await prepareZcodeGlobalModel(root, 'native-model', env)
    const overlay = JSON.parse(await readFile(prepared.env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE, 'utf8'))
    expect(await readFile(personal, 'utf8')).toBe(source)
    expect(overlay.config.providerConfigRules).toEqual(JSON.parse(source).config.providerConfigRules)
    expect(overlay.config.defaultModelSelection).toEqual({ providerId: 'native-account', modelId: 'native-model', options: {} })
    if (process.platform !== 'win32') expect((await stat(prepared.file.absolutePath)).mode & 0o777).toBe(0o600)
  })

  it('preserves model options only when they belong to the same native selection', async () => {
    const { root, personal, env } = await fixture()
    await writeFile(personal, JSON.stringify({ config: { defaultModelSelection: {
      providerId: 'native-account', modelId: 'native-model', options: { reasoningLevel: 'high' },
    } } }))
    const prepared = await prepareZcodeGlobalModel(root, 'native-model', env)
    expect(JSON.parse(await readFile(prepared.file.absolutePath, 'utf8')).config.defaultModelSelection.options).toEqual({ reasoningLevel: 'high' })
  })

  it('retains the current native provider when multiple providers ship the selected model', async () => {
    const { root, personal, env } = await fixture()
    await writeFile(env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE, JSON.stringify({ config: { modelConfigRules: { builtinProviderModelRules: [
      { providerId: 'other-account', modelId: 'native-model' }, { providerId: 'native-account', modelId: 'native-model' },
    ] } } }))
    await writeFile(personal, JSON.stringify({ config: { defaultModelSelection: { providerId: 'native-account', modelId: 'old-model' } } }))
    const prepared = await prepareZcodeGlobalModel(root, 'native-model', env)
    expect(JSON.parse(await readFile(prepared.file.absolutePath, 'utf8')).config.defaultModelSelection).toEqual({ providerId: 'native-account', modelId: 'native-model', options: {} })
  })

  it('does not choose a disabled builtin declaration when the same model has a usable provider', async () => {
    const { root, env } = await fixture()
    await writeFile(env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE, JSON.stringify({ config: { modelConfigRules: { builtinProviderModelRules: [
      { providerId: 'disabled-account', modelId: 'native-model', config: { enabled: false } },
      { providerId: 'native-account', modelId: 'native-model' },
    ] } } }))
    const prepared = await prepareZcodeGlobalModel(root, 'native-model', env)
    expect(JSON.parse(await readFile(prepared.file.absolutePath, 'utf8')).config.defaultModelSelection.providerId).toBe('native-account')
  })

  it('supports absent personal settings and rejects models outside the builtin directory', async () => {
    const { root, env } = await fixture()
    const prepared = await prepareZcodeGlobalModel(root, 'native-model', env)
    expect(JSON.parse(await readFile(prepared.file.absolutePath, 'utf8')).schemaVersion).toBe(1)
    await expect(prepareZcodeGlobalModel(root, 'unknown-model', env)).rejects.toThrow('Unknown ZCode builtin model')
  })
})
