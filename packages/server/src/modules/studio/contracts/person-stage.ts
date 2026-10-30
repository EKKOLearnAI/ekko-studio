/** Trusted host context; never accepted from a chat request or model arguments. */
export interface PersonStageContext {
  flowId: string
  stageId: string
  generation: number
  deliveryId?: string
}
export interface PersonStage {
  session_title?: string
  bot_type?: string | null
  delivery_state?: string
  delivery_error?: string
  tasks: Array<{ id: string; title: string; status: string; execution_state?: string; agent?: string }>
  id: string; flow_id: string; position: number; group_position: number; session_id: string; goal: string; return_expectation: string
  state: 'pending' | 'active' | 'failed' | 'completed'; result_message_id: number | null; completion_run_id: string
}
export interface PersonConversationFlow {
  id: string; owner_user_id: number; creator_session_id: string; title: string; goal: string
  /** current_position indexes execution groups; each stage retains its unique route position. */
  state: 'active' | 'failed' | 'stopped' | 'completed'; revision: number; generation: number; current_position: number
  created_at: number; updated_at: number; stages: PersonStage[]; error: string
}
export interface PersonStageDelivery {
  id: string; owner_user_id: number; flow_id: string; stage_id: string; generation: number
  state: 'pending' | 'queued' | 'failed' | 'delivered' | 'cancelled'; updated_at: number; error: string
}
