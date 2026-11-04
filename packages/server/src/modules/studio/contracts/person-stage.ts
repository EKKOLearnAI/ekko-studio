/** Trusted host context; never accepted from a chat request or model arguments. */
export interface PersonStageContext {
  flowId: string
  stageId: string
  generation: number
  deliveryId?: string
}
export interface PersonStage {
  confirmation?: {decision_pending?: boolean; state: string; attempts: number; reason: string; message_id: number | null}
  session_title?: string
  bot_type?: string | null
  delivery_state?: string
  delivery_error?: string
  tasks: Array<{ id: string; title: string; status: string; execution_state?: string; agent?: string }>
  id: string; flow_id: string; position: number; group_position: number; session_id: string; goal: string; return_expectation: string
  state: 'pending' | 'active' | 'failed' | 'completed'; result_message_id: number | null; completion_run_id: string
}
export interface PersonConversationFlow {
  /** Zero means repeat until explicitly stopped; existing flows run once. */
  round_limit: number; round_number: number; round_generation: number
  workspace: string
  id: string; owner_user_id: number; creator_session_id: string; title: string; goal: string
  /** current_position indexes execution groups; each stage retains its unique route position. */
  state: 'active' | 'failed' | 'stopped' | 'completed'; revision: number; generation: number; current_position: number
  created_at: number; updated_at: number; stages: PersonStage[]; error: string
}
export interface PersonStageDelivery {
  id: string; owner_user_id: number; flow_id: string; stage_id: string; generation: number
  state: 'pending' | 'queued' | 'failed' | 'delivered' | 'cancelled'; updated_at: number; error: string
}

/** Control follows the unfinished current group, never historical/future participants. */
export function canControlPersonFlow(flow: PersonConversationFlow, sessionId: string) {
  return sessionId === flow.creator_session_id || flow.stages.some(stage => stage.group_position === flow.current_position
    && ['active','failed'].includes(stage.state) && stage.session_id === sessionId)
}
