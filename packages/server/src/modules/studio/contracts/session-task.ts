export type SessionTaskStatus = 'open' | 'completed' | 'closed'

/** User goals persist across turns; they are independent of run task plans. */
export interface SessionTask {
  id: string
  title: string
  summary: string
  status: SessionTaskStatus
  source_message_id: number
  evidence_message_id: number | null
  completion_evidence: string
  created_at: number
  updated_at: number
  completed_at: number | null
}

export interface SessionTasksSnapshot {
  session_id: string
  revision: number
  updated_at: number
  tasks: SessionTask[]
}

export interface SessionTaskChange {
  id?: string
  title: string
  summary: string
  status: 'open' | 'completed'
  completion_evidence?: string
}

export interface SessionTasksUpdate {
  revision: number
  changes: SessionTaskChange[]
}

export interface SessionTaskListItem extends SessionTask {
  session_id: string
  session_title: string | null
  profile: string
  source: string
  agent: string
  /** Visible user message starting the associated request/completion turn. */
  message_id: number | null
}

export interface SessionTaskListQuery {
  profiles: string[]
  excludeSessionIds?: string[]
  search?: string
  status?: SessionTaskStatus
  order: 'newest' | 'oldest'
  offset: number
  limit: number
}

export interface SessionTaskListPage {
  tasks: SessionTaskListItem[]
  total: number
  has_more: boolean
}
