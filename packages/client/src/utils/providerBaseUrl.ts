export type ApiKeyFunPresetProvider = 'fun-codex' | 'fun-claude'

export function isApiKeyFunBaseUrl(baseUrl: string): boolean {
  const value = baseUrl.trim()
  if (!value) return false

  try {
    const parsed = new URL(value)
    const hostname = parsed.hostname.toLowerCase()
    return hostname === 'apikey.fan' || hostname.endsWith('.apikey.fan')
  } catch {
    // Fall back to a string match so partially typed values still route on submit.
    return /^(?:https?:\/\/)?(?:[a-z0-9-]+\.)*apikey\.fan(?:\/|$)/i.test(value)
  }
}

export function inferApiKeyFunPresetProvider(model: string): ApiKeyFunPresetProvider | null {
  const normalized = model.trim().toLowerCase()
  if (!normalized) return null
  if (normalized.startsWith('claude')) return 'fun-claude'
  if (normalized.startsWith('gpt') || normalized.includes('codex')) return 'fun-codex'

  return null
}
