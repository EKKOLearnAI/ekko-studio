import { socketEndpoint } from '@/utils/deployment-url'
import { io, type Socket } from 'socket.io-client'
import { getActiveProfileName, getApiKey, getBaseUrlValue } from '../client'
import type { WorkflowRecord, WorkflowRunRecord } from './workflows'

export type WorkflowRuntimeState = 'idle' | 'queued' | 'running' | 'pending_approval' | 'completed' | 'skipped' | 'failed' | 'approval_rejected' | 'canceled'

export interface WorkflowRuntimeStatus {
  workflowId: string
  status: WorkflowRuntimeState
  runId: string | null
  startedAt: number | null
  updatedAt: number
  completedAt: number | null
  error: string | null
  nodeStatuses?: Record<string, WorkflowRuntimeState>
  pendingApprovals?: Array<{ nodeId: string; executionId: string }>
  run?: WorkflowRunRecord | null
}


export interface WorkflowRuntimeEvidenceError {
  workflowId: string
  runId: string | null
  error: string
}

interface WorkflowSocketAck<T> {
  ok: boolean
  data?: T
  error?: string
}

let socket: Socket | null = null
let socketProfile: string | null = null

function activeProfile(profile?: string | null): string {
  return profile || getActiveProfileName() || 'default'
}

export function connectWorkflowSocket(profile?: string | null): Socket {
  const nextProfile = activeProfile(profile)
  if (socket && socketProfile === nextProfile) return socket
  if (socket) {
    socket.disconnect()
    socket = null
  }

  socketProfile = nextProfile
  socket = io(socketEndpoint(getBaseUrlValue(), '/workflow').url, {
    path: socketEndpoint(getBaseUrlValue(), '/workflow').path,
    auth: { token: getApiKey() },
    query: { profile: nextProfile },
    transports: ['websocket', 'polling'],
    reconnection: true,
    reconnectionAttempts: Infinity,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 30000,
    randomizationFactor: 0.5,
    timeout: 30000,
  })
  return socket
}

export function disconnectWorkflowSocket(): void {
  socket?.disconnect()
  socket = null
  socketProfile = null
}

function emitWithAck<TRequest, TResponse>(
  event: string,
  request: TRequest,
  profile?: string | null,
): Promise<TResponse> {
  const activeSocket = connectWorkflowSocket(profile)
  return new Promise((resolve, reject) => {
    activeSocket.timeout(30000).emit(event, request, (err: Error | null, response: WorkflowSocketAck<TResponse>) => {
      if (err) {
        reject(err)
        return
      }
      if (!response?.ok) {
        reject(new Error(response?.error || `${event} failed`))
        return
      }
      resolve(response.data as TResponse)
    })
  })
}

export async function listWorkflowsSocket(profile?: string | null): Promise<WorkflowRecord[]> {
  const data = await emitWithAck<{ profile?: string | null }, { workflows: WorkflowRecord[] }>(
    'workflows.list',
    profile ? { profile } : {},
    profile,
  )
  return data.workflows
}

export async function subscribeWorkflowStatuses(workflowId?: string | null, profile?: string | null): Promise<WorkflowRuntimeStatus[]> {
  const data = await emitWithAck<{ workflowId?: string | null }, { statuses: WorkflowRuntimeStatus[] }>(
    'workflow.status.subscribe',
    workflowId ? { workflowId } : {},
    profile,
  )
  return data.statuses
}

export async function unsubscribeWorkflowStatuses(workflowId?: string | null, profile?: string | null): Promise<void> {
  await emitWithAck<{ workflowId?: string | null }, { ok: true }>(
    'workflow.status.unsubscribe',
    workflowId ? { workflowId } : {},
    profile,
  )
}

export function onWorkflowStatusUpdated(
  handler: (status: WorkflowRuntimeStatus) => void,
  profile?: string | null,
): () => void {
  const activeSocket = connectWorkflowSocket(profile)
  activeSocket.on('workflow.status.updated', handler)
  return () => activeSocket.off('workflow.status.updated', handler)
}

export function onWorkflowStatusError(
  handler: (error: WorkflowRuntimeEvidenceError) => void,
  profile?: string | null,
): () => void {
  const activeSocket = connectWorkflowSocket(profile)
  activeSocket.on('workflow.status.error', handler)
  return () => activeSocket.off('workflow.status.error', handler)
}
