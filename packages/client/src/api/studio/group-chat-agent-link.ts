import { request } from '../client'

export type RemoteGroupAgentDescriptor = {
  agent: 'hermes' | 'ekko' | 'codex' | 'claude' | 'pi' | 'grok' | 'opencode' | 'dsh' | 'cursor'
  agentMode: 'scoped' | 'global'
  priorAgentMode?: 'scoped' | 'global' | ''
  profile: string
  provider: string
  model: string
  apiMode: string
  agentPreset?: string
  reasoningEffort: string
  name: string
  description: string
  avatar: string
  agentId?: string
}

export type GroupAgentPairingRequest = {
  id: string
  roomId: string
  ownerMemberId: string
  ownerName: string
  targetOrigin: string
  agent: RemoteGroupAgentDescriptor
  status: 'draft' | 'pending' | 'approved' | 'connecting' | 'consumed' | 'rejected' | 'expired' | 'failed'
  createdAt: number
  expiresAt: number
  approvedAt: number | null
  ticketExpiresAt: number | null
  consumedAt: number | null
  failureReason: string
}

export function listLocalGroupAgents(): Promise<{ protocolVersion: number; agents: RemoteGroupAgentDescriptor[] }> {
  return request('/api/studio/group-chat-link/v1/agents')
}

export type LocalGroupAgentConnection = {
  connectorId: string
  cloudOrigin: string
  targetOrigin: string
  roomId?: string
  roomName?: string
  roomAlias?: string
  inviteCode?: string
  agent: RemoteGroupAgentDescriptor
  connected: boolean
}

export function listLocalGroupAgentConnections(): Promise<{ connections: LocalGroupAgentConnection[] }> {
  return request('/api/studio/group-chat-link/v1/connections')
}

export function connectLocalGroupAgent(input: {
  cloudOrigin: string
  targetOrigin: string
  pairingTicket: string
  agent: RemoteGroupAgentDescriptor
}): Promise<{ ok: boolean; connectorId: string; roomId?: string; roomName?: string; inviteCode?: string }> {
  return request('/api/studio/group-chat-link/v1/connect', {
    method: 'POST',
    body: JSON.stringify(input),
  })
}

export function connectLocalGroupAgentHandoff(input: {
  cloudOrigin: string
  targetOrigin: string
  inviteCode: string
  requestId: string
  requestSecret: string
  pairingTicket: string
  agent: RemoteGroupAgentDescriptor
}): Promise<{ ok: boolean; accepted: boolean }> {
  return request('/api/studio/group-chat-link/v1/connect-handoff', {
    method: 'POST',
    body: JSON.stringify(input),
  })
}

export function disconnectLocalGroupAgent(connectorId: string): Promise<{ ok: boolean }> {
  return request('/api/studio/group-chat-link/v1/disconnect', {
    method: 'POST',
    body: JSON.stringify({ connectorId }),
  })
}

export function renameLocalGroupAgentRoom(
  connectorId: string,
  name: string,
): Promise<{ ok: boolean; updated: number }> {
  return request(`/api/studio/group-chat-link/v1/connections/${encodeURIComponent(connectorId)}/room-alias`, {
    method: 'PUT',
    body: JSON.stringify({ name }),
  })
}

export function leaveLocalGroupAgentRoom(
  connectorId: string,
): Promise<{ ok: boolean; removed: number; notified: number }> {
  return request(`/api/studio/group-chat-link/v1/connections/${encodeURIComponent(connectorId)}/leave-room`, {
    method: 'POST',
  })
}

export function updateLocalGroupAgent(
  connectorId: string,
  agent: RemoteGroupAgentDescriptor,
): Promise<{ ok: boolean; connection: LocalGroupAgentConnection }> {
  return request(`/api/studio/group-chat-link/v1/connections/${encodeURIComponent(connectorId)}`, {
    method: 'PUT',
    body: JSON.stringify({ agent }),
  })
}

export function requestGuestAgentPairing(
  inviteCode: string,
  input: {
    ownerMemberId: string
    membershipToken: string
    targetOrigin: string
    agent: RemoteGroupAgentDescriptor
  },
): Promise<{
  request: GroupAgentPairingRequest
  requestSecret: string
  pairingTicket: string
}> {
  return request(`/api/studio/group-chat/invites/${encodeURIComponent(inviteCode)}/agent-links`, {
    method: 'POST',
    body: JSON.stringify(input),
  })
}

export function createGuestAgentHandoff(
  inviteCode: string,
  input: {
    requestId: string
    requestSecret: string
    pairingTicket: string
    ownerMemberId: string
    membershipToken: string
    targetOrigin: string
  },
): Promise<{ request: GroupAgentPairingRequest }> {
  return request(`/api/studio/group-chat/invites/${encodeURIComponent(inviteCode)}/agent-link-handoffs`, {
    method: 'POST',
    body: JSON.stringify(input),
  })
}

export function getGuestAgentPairingStatus(
  inviteCode: string,
  requestId: string,
  requestSecret: string,
): Promise<{ request: GroupAgentPairingRequest }> {
  return request(
    `/api/studio/group-chat/invites/${encodeURIComponent(inviteCode)}/agent-links/${encodeURIComponent(requestId)}`,
    { headers: { 'X-Group-Agent-Request-Secret': requestSecret } },
  )
}

export function listPendingGroupAgentPairings(roomId: string): Promise<{ requests: GroupAgentPairingRequest[] }> {
  return request(`/api/studio/group-chat/rooms/${encodeURIComponent(roomId)}/agent-link-requests`)
}

export function decideGroupAgentPairing(
  roomId: string,
  requestId: string,
  approved: boolean,
): Promise<{ request: GroupAgentPairingRequest }> {
  return request(
    `/api/studio/group-chat/rooms/${encodeURIComponent(roomId)}/agent-link-requests/${encodeURIComponent(requestId)}/decision`,
    {
      method: 'POST',
      body: JSON.stringify({ approved }),
    },
  )
}

export function updateGuestAgentPolicy(
  roomId: string,
  input: {
    allowGuestAgents: boolean
    maxGuestAgentsPerMember: number
    allowRemoteWorkspaceAccess: boolean
  },
): Promise<{
  policy: {
    allowGuestAgents: number
    guestAgentApproval: 'owner'
    maxGuestAgentsPerMember: number
    allowRemoteWorkspaceAccess: number
  }
}> {
  return request(`/api/studio/group-chat/rooms/${encodeURIComponent(roomId)}/guest-agent-policy`, {
    method: 'PUT',
    body: JSON.stringify(input),
  })
}

export function revokeGroupAgentConnector(roomId: string, connectorId: string): Promise<{ ok: boolean }> {
  return request(
    `/api/studio/group-chat/rooms/${encodeURIComponent(roomId)}/agent-connectors/${encodeURIComponent(connectorId)}`,
    { method: 'DELETE' },
  )
}
