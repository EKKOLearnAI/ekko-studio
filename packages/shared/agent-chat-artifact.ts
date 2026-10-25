/** Opaque transcript reference. It is never a local filesystem path or URL. */
export function agentChatArtifactPath(sessionId: string, artifactId: string): string {
  return `agent-artifact:${encodeURIComponent(sessionId)}/${artifactId}`
}
export function parseAgentChatArtifactPath(value: string): { sessionId: string; artifactId: string } | null {
  const match = /^agent-artifact:([^/]+)\/([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/.exec(value)
  if (!match) return null
  try {
    const sessionId = decodeURIComponent(match[1])
    return sessionId && sessionId.length <= 256 ? { sessionId, artifactId: match[2] } : null
  } catch { return null }
}
