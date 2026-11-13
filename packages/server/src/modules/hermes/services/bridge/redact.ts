export function redactAgentBridgeError(
  error: string | undefined,
  endpoint?: string,
  replacement = '[redacted endpoint]',
): string | undefined {
  if (!error) return error

  let redacted = error
  const configuredEndpoint = endpoint?.trim()
  const candidates = new Set<string>()

  if (configuredEndpoint) {
    candidates.add(configuredEndpoint)

    if (configuredEndpoint.startsWith('ipc://')) {
      const barePath = configuredEndpoint.slice('ipc://'.length)
      if (barePath) candidates.add(barePath)
    }

    if (configuredEndpoint.startsWith('tcp://')) {
      try {
        const url = new URL(configuredEndpoint)
        if (url.host) candidates.add(url.host)
      } catch {
        // Ignore malformed configured endpoints and fall back to literal replacement.
      }
    }
  }

  for (const candidate of candidates) {
    redacted = redacted.split(candidate).join(replacement)
  }

  return redacted
    .replace(/ipc:\/\/[^\s),;]+/g, replacement)
    .replace(/(?:[A-Za-z]:)?[^\s),;]*agent-bridge\.sock/g, replacement)
}
