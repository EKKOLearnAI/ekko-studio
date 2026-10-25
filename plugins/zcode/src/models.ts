const list = (value: unknown): any[] => Array.isArray(value) ? value : []
const record = (value: any): Record<string, any> => value && typeof value === 'object' && !Array.isArray(value) ? value : {}
const text = (value: unknown): string | undefined => typeof value === 'string' && value.trim() ? value.trim() : undefined

/** Native ordered rule layers, including personal overrides and explicit resets. */
export function reasoningEfforts(builtin: any, personal: any, providerId: string, modelId: string): string[] | undefined {
  const config = record(builtin?.config), personalConfig = record(personal?.config)
  const providers = [...list(config.providerConfigRules?.providerRules), ...list(personalConfig.providerConfigRules?.providerRules)].filter(rule => rule?.providerId === providerId)
  let templateId: string | undefined, apiType: string | undefined, baseUrl: string | undefined
  for (const provider of providers) if (provider.templateId !== undefined) templateId = text(provider.templateId)
  function api(value: any) {
    if (value === null) { apiType = baseUrl = undefined; return }
    if (value?.type !== undefined) apiType = text(value.type)
    if (value?.baseUrl !== undefined) baseUrl = text(value.baseUrl)
  }
  for (const template of list(config.providerConfigRules?.templateRules)) if (template.templateId === templateId) api(template.config?.api)
  for (const provider of providers) api(provider.config?.api)
  if (baseUrl) try { const url = new URL(baseUrl); url.pathname = url.pathname.replace(/\/+$/, ''); baseUrl = url.toString().replace(/\/(?=[?#]|$)/, '') } catch { /* Native patterns also allow plain strings. */ }
  const matches = (pattern: unknown, value: string | undefined, insensitive = false) => {
    if (typeof pattern !== 'string' || value === undefined || pattern.length > 4096) return false
    try { return new RegExp(`^(?:${pattern})$`, insensitive ? 'i' : undefined).test(value) } catch { return false }
  }
  let values: unknown
  function overlay(rule: any) {
    const options = rule?.config?.optionSpecs
    if (options === null || options?.reasoningLevel === null) values = undefined
    else if (options?.reasoningLevel?.values !== undefined) values = options.reasoningLevel.values
  }
  const rules = record(config.modelConfigRules)
  for (const rule of list(rules.modelRules)) if (matches(rule.modelMatch, modelId, true)) overlay(rule)
  for (const rule of list(rules.modelApiRules)) if (matches(rule.modelMatch, modelId, true) && matches(rule.apiTypeMatch, apiType)) overlay(rule)
  for (const rule of list(rules.providerSiteRules)) if (matches(rule.modelMatch, modelId, true) && matches(rule.baseUrlMatch, baseUrl) && (rule.apiTypeMatch === undefined || matches(rule.apiTypeMatch, apiType))) overlay(rule)
  for (const rule of list(rules.templateModelRules)) if (rule.templateId === templateId && rule.modelId === modelId) overlay(rule)
  for (const group of [rules.builtinProviderModelRules, personalConfig.modelConfigRules?.providerModelRules]) for (const rule of list(group)) if (rule.providerId === providerId && rule.modelId === modelId) overlay(rule)
  for (const rule of list(personalConfig.modelConfigRules?.manualProviderModelRules)) if (rule.providerId === providerId && rule.modelId === modelId) { values = undefined; overlay(rule) }
  return Array.isArray(values) ? [...new Set(values.flatMap(value => text(value) ? [text(value)!] : []))] : undefined
}
