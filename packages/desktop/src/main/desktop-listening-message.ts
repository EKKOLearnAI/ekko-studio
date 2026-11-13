export function desktopListeningPort(message: unknown): number | null {
  if (!message || typeof message !== 'object') return null
  const value = message as { type?: unknown; port?: unknown }
  return value.type === 'hermes-desktop:listening' && Number.isInteger(value.port)
    && Number(value.port) > 0 && Number(value.port) <= 65535 ? Number(value.port) : null
}
