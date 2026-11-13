export interface TaskPlanSnapshot {
  session_id: string
  run_id: string
  plan_id: string
  revision: number
  execution_state: 'running' | 'ended' | 'interrupted' | 'failed'
  explanation?: string
  plan: Array<{ id: string; step: string; status: 'pending' | 'in_progress' | 'completed' }>
  created_at: number
  updated_at: number
}
