import { readFile, stat } from 'node:fs/promises'
import { record, text } from '../models/types'

const list = (value: unknown): any[] => Array.isArray(value) ? value : []

export async function readZcodePersonalConfig(env: NodeJS.ProcessEnv): Promise<Record<string, any>> {
  const path = env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE
  if (!path) return {}
  try {
    if ((await stat(path)).size > 4 * 1024 * 1024) throw new Error('ZCode personal configuration exceeds size limit')
    return record(JSON.parse(await readFile(path, 'utf8')))
  } catch (error: any) {
    if (error.code === 'ENOENT') return {}
    throw error
  }
}

/** Resolve only public enum values, using ZCode's ordered native rule layers. */
export function zcodeReasoningEfforts(builtin: any, personal: any, providerId: string, modelId: string): string[] | undefined {
  const config = record(builtin?.config), personalConfig = record(personal?.config)
  const providers = [...list(config.providerConfigRules?.providerRules), ...list(personalConfig.providerConfigRules?.providerRules)]
    .filter(rule => rule?.providerId === providerId)
  let templateId: string | undefined, apiType: string | undefined, baseUrl: string | undefined
  for (const provider of providers) {
    if (provider.templateId !== undefined) templateId = text(provider.templateId)
  }
  function providerApi(api: any) {
    if (api === null) { apiType = baseUrl = undefined; return }
    if (api?.type !== undefined) apiType = text(api.type)
    if (api?.baseUrl !== undefined) baseUrl = text(api.baseUrl)
  }
  for (const template of list(config.providerConfigRules?.templateRules)) {
    if (template.templateId === templateId) providerApi(template.config?.api)
  }
  for (const provider of providers) providerApi(provider.config?.api)
  if (baseUrl) {
    try {
      const url = new URL(baseUrl)
      url.pathname = url.pathname.replace(/\/+$/, '')
      baseUrl = url.toString().replace(/\/(?=[?#]|$)/, '')
    } catch { /* Native rules can match a non-URL string too. */ }
  }
  function matches(pattern: unknown, value: string | undefined, insensitive = false) {
    if (typeof pattern !== 'string' || value === undefined) return false
    try { return new RegExp(`^(?:${pattern})$`, insensitive ? 'i' : undefined).test(value) }
    catch { return false }
  }
  let values: unknown
  function overlay(rule: any) {
    const options = rule?.config?.optionSpecs
    if (options === null || options?.reasoningLevel === null) values = undefined
    else if (options?.reasoningLevel?.values !== undefined) values = options.reasoningLevel.values
  }
  const rules = record(config.modelConfigRules)
  for (const rule of list(rules.modelRules)) {
    if (matches(rule.modelMatch, modelId, true)) overlay(rule)
  }
  for (const rule of list(rules.modelApiRules)) {
    if (matches(rule.modelMatch, modelId, true) && matches(rule.apiTypeMatch, apiType)) overlay(rule)
  }
  for (const rule of list(rules.providerSiteRules)) {
    if (matches(rule.modelMatch, modelId, true) && matches(rule.baseUrlMatch, baseUrl)
      && (rule.apiTypeMatch === undefined || matches(rule.apiTypeMatch, apiType))) overlay(rule)
  }
  for (const rule of list(rules.templateModelRules)) {
    if (rule.templateId === templateId && rule.modelId === modelId) overlay(rule)
  }
  for (const group of [rules.builtinProviderModelRules, personalConfig.modelConfigRules?.providerModelRules]) {
    for (const rule of list(group)) {
      if (rule.providerId === providerId && rule.modelId === modelId) overlay(rule)
    }
  }
  for (const rule of list(personalConfig.modelConfigRules?.manualProviderModelRules)) {
    if (rule.providerId === providerId && rule.modelId === modelId) { values = undefined; overlay(rule) }
  }
  return Array.isArray(values) ? [...new Set(values.flatMap(value => text(value) ? [text(value)!] : []))] : undefined
}
