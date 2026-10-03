export interface BiliAgentIdentityInput {
  agent: string
  profile: string
  sessionId: string
  /** Accepted only to make it explicit that native ids are not part of this identity. */
  nativeSessionId?: string
}

function identityPart(value: string, field: string): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 256 || /[\u0000\r\n]/u.test(value)) {
    throw new TypeError(`Bili ${field} is invalid`)
  }
  return encodeURIComponent(value.trim())
}

/** Stable per-agent/profile/Studio-session identity; never derived from a parent native id. */
export function buildBiliAgentIdentity(input: BiliAgentIdentityInput): string {
  return [
    identityPart(input.agent, 'agent'),
    identityPart(input.profile, 'profile'),
    identityPart(input.sessionId, 'session'),
  ].join(':')
}

export const createBiliAgentIdentity = buildBiliAgentIdentity
