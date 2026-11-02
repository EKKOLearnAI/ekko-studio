import { randomUUID } from 'node:crypto'

export const personExecutionSessionId = (executionId: string) => `person-task-${executionId}`

export interface PersonResultIdentity { executionId: string; acceptanceReturnId?: string }
export function personResultQueueId(executionId: string, acceptanceReturnId?: string) {
  return `person-result:${executionId}${acceptanceReturnId ? `:${acceptanceReturnId}` : ''}`
}
/** The optional review identity fences a return; it is never part of the execution ID. */
export function parsePersonResultQueueId(queueId?: string): PersonResultIdentity | undefined {
  if (!queueId?.startsWith('person-result:')) return undefined
  const parts = queueId.slice('person-result:'.length).split(':')
  if (parts.length > 2 || parts.some(part => !part)) return undefined
  return { executionId: parts[0], ...(parts[1] ? { acceptanceReturnId: parts[1] } : {}) }
}

/** Account identity is independent of the Profile used to execute a model call. */
export const personSessionId = () => `person-main-${randomUUID()}`
export const personNotificationRoom = (userId: number) => `person-notifications:${userId}`
export const isPersonSession = (id?: string | null) => !!id?.startsWith('person-main-')
export const isPrivatePersonSession = (id?: string | null) => isPersonSession(id) || !!id?.startsWith('person-task-')
export function ownsPersonSession(userId: number | undefined, session: { id: string; studio_user_id?: string | number | null } | null | undefined) {
  return userId !== undefined && !!session && isPersonSession(session.id) && String(session.studio_user_id) === String(userId)
}
