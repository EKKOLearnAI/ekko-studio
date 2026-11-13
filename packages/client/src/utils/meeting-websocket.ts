import { getApiKey, getBaseUrl } from '@/api/client'

/** Browser WebSocket upgrades carry the same credential as local HTTP APIs. */
export function meetingWebSocketUrl(path: '/ws/asr' | '/ws/diarize' | '/ws/omni-realtime'): string {
  const url = new URL(`${getBaseUrl()}${path}`, window.location.origin)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  const token = getApiKey()
  if (token) url.searchParams.set('token', token)
  return url.toString()
}
