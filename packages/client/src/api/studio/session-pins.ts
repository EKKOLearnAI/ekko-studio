import { request } from '../client'

export interface SessionPins { pinnedIds: string[] }

export function fetchSessionPins(profile: string): Promise<SessionPins> {
  return request(`/api/studio/session-pins?profile=${encodeURIComponent(profile)}`)
}

export function setSessionPin(profile: string, sessionId: string, pinned: boolean): Promise<SessionPins> {
  return request(`/api/studio/session-pins/${encodeURIComponent(sessionId)}?profile=${encodeURIComponent(profile)}`, {
    method: 'PUT', body: JSON.stringify({ pinned }),
  })
}

export function migrateSessionPins(profile: string, pinnedIds: string[]): Promise<SessionPins> {
  return request(`/api/studio/session-pins/migrate?profile=${encodeURIComponent(profile)}`, {
    method: 'POST', body: JSON.stringify({ pinnedIds }),
  })
}
