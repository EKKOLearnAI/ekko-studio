import type { LocalGroupAgentConnection } from '@/api/studio/group-chat-agent-link'

export type RemoteGroupChatRoom = {
  key: string
  roomId: string
  roomName: string
  roomAlias: string
  inviteCode: string
  cloudOrigin: string
  connected: boolean
  connectorIds: string[]
}

function normalizedOrigin(value: string): string {
  try {
    return new URL(value).origin
  } catch {
    return ''
  }
}

function roomKey(origin: string, roomId: string): string {
  return `${origin}\n${roomId}`
}

export function buildRemoteGroupChatRooms(
  connections: LocalGroupAgentConnection[],
): RemoteGroupChatRoom[] {
  const rooms = new Map<string, RemoteGroupChatRoom>()

  for (const connection of connections) {
    const cloudOrigin = normalizedOrigin(connection.cloudOrigin)
    const roomId = String(connection.roomId || '').trim()
    if (!cloudOrigin || !roomId) continue
    const key = roomKey(cloudOrigin, roomId)

    const authoritativeRoomName = String(connection.roomName || roomId).trim() || roomId
    const roomAlias = String(connection.roomAlias || '').trim()
    const roomName = roomAlias || authoritativeRoomName
    const inviteCode = String(connection.inviteCode || '').trim()
    const existing = rooms.get(key)
    if (existing) {
      existing.connected ||= connection.connected
      if (roomAlias) {
        existing.roomAlias = roomAlias
        existing.roomName = roomAlias
      } else if (!existing.roomAlias && existing.roomName === roomId && roomName !== roomId) {
        existing.roomName = roomName
      }
      if (!existing.inviteCode && inviteCode) existing.inviteCode = inviteCode
      if (!existing.connectorIds.includes(connection.connectorId)) existing.connectorIds.push(connection.connectorId)
      continue
    }
    rooms.set(key, {
      key,
      roomId,
      roomName,
      roomAlias,
      inviteCode,
      cloudOrigin,
      connected: connection.connected,
      connectorIds: [connection.connectorId],
    })
  }

  return [...rooms.values()].sort((a, b) =>
    a.roomName.localeCompare(b.roomName) || a.cloudOrigin.localeCompare(b.cloudOrigin),
  )
}
