import { request } from '@/api/client'

export type SessionTaskStatus = 'open' | 'completed' | 'closed'

export interface SessionTaskListItem {
  id: string
  session_id: string
  session_title: string | null
  profile: string
  source: string
  agent: string
  title: string
  summary: string
  status: SessionTaskStatus
  updated_at: number
  message_id: number | null
}

export async function updateSessionTaskStatus(task: SessionTaskListItem, status: SessionTaskStatus) {
  const query = new URLSearchParams({ profile: task.profile })
  return request(`/api/studio/sessions/${encodeURIComponent(task.session_id)}/tasks/${encodeURIComponent(task.id)}/status?${query}`, {
    method: 'PATCH', body: JSON.stringify({ status, expected_updated_at: task.updated_at }),
  })
}

export interface SessionTaskListPage {
  tasks: SessionTaskListItem[]
  total: number
  has_more: boolean
}

export async function fetchSessionTasks(query: { search: string; status: string; order: string; page: number }) {
  // An explicit empty profile lists all profiles available to this account.
  const params = new URLSearchParams({ profile: '', order: query.order,
    offset: String((query.page - 1) * 50), limit: '50' })
  if (query.search) params.set('search', query.search)
  if (query.status) params.set('status', query.status)
  const result = await request<SessionTaskListPage>(`/api/studio/session-tasks?${params}`)
  const offset = (query.page - 1) * 50
  const tasks = result.tasks.slice(0, Math.max(0, Math.min(50, 100 - offset)))
  return { tasks, total: Math.min(100, result.total), has_more: result.has_more && offset + tasks.length < 100 }
}
