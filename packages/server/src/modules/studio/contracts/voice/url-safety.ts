export function assertSafeTtsBaseUrl(url: URL, providerLabel: string) {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`${providerLabel} TTS baseUrl must use http or https`)
  }

  if (url.username || url.password) {
    throw new Error(`${providerLabel} TTS baseUrl must not include credentials`)
  }
}

export async function assertSafeResolvedTtsBaseUrl(url: URL, providerLabel: string) {
  assertSafeTtsBaseUrl(url, providerLabel)
}

export function normalizeSafeTtsBaseUrl(baseUrl: string, providerLabel: string): string {
  const value = String(baseUrl || '').trim()
  if (!value) {
    return ''
  }

  const url = new URL(value)
  assertSafeTtsBaseUrl(url, providerLabel)
  return url.toString()
}
