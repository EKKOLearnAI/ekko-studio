import type { PersonSelection } from './person'

export interface PersonAcceptanceConfig {
  enabled: true
  orchestration?: 'bot_tasks' | 'legacy'
  progression?: 'automatic'
  initial_goal: string
  initial_request?: { session_id: string; message_id: number; content: string }
  criteria: Array<{ id: string; text: string }>
  verifier_agent_id: string
  reviewer_session_id?: string
  verifier_selection: PersonSelection
  max_attempts: number
  timeout_minutes: number
}
export type PersonAcceptanceState = 'pending' | 'developing' | 'verifying' | 'repairing' | 'awaiting_dispatch' | 'verification_pending' | 'awaiting_review' | 'repair_required' | 'passed' | 'failed' | 'blocked' | 'interrupted'
export interface PersonAcceptance {
  execution_id: string
  task_id: string
  state: PersonAcceptanceState
  snapshot_json: string
  attempt: number
  deadline: number
  active_session_id: string
  worker_output: string
  reason: string
  updated_at: number
  orchestration: 'legacy' | 'bot_tasks'
  cycle_id: string
}
export interface PersonAcceptanceCheck {
  criterion_id: string
  status: 'passed' | 'failed' | 'blocked'
  findings: string
  evidence: Array<{ path: string; description: string }>
  issues?: Array<{ description: string; disposition: 'repair' | 'resolved' | 'out_of_scope'; reason: string }>
}
export interface PersonAcceptanceReport {
  verdict: 'passed' | 'failed' | 'blocked'
  summary: string
  checks: PersonAcceptanceCheck[]
}
export interface PersonAcceptanceAttempt {
  id: string
  execution_id: string
  verification_execution_id: string
  ordinal: number
  session_id: string
  run_id: string
  state: string
  raw_output: string
  report_json: string
  evidence_json: string
  error: string
  report_protocol: 'agent_json' | 'bot_review'
  decision_json: string
  decision_attempts: number
}
/** Bot tool arguments only; independent Agents return ordinary reports. */
export const personAcceptanceReportSchema = {
  type: 'object', additionalProperties: false,
  properties: {
    verdict: { type: 'string', enum: ['passed','failed','blocked'] },
    summary: { type: 'string', minLength: 1, maxLength: 4000 },
    checks: { type: 'array', minItems: 1, maxItems: 20, items: {
      type: 'object', additionalProperties: false,
      properties: {
        criterion_id: { type: 'string', minLength: 1, maxLength: 100 },
        status: { type: 'string', enum: ['passed','failed','blocked'] },
        findings: { type: 'string', minLength: 1, maxLength: 4000 },
        evidence: { type: 'array', maxItems: 10, items: {
          type: 'object', additionalProperties: false,
          properties: { path: { type: 'string', minLength: 1, maxLength: 4000 }, description: { type: 'string', minLength: 1, maxLength: 2000 } },
          required: ['path','description'],
        } },
        issues: { type:'array',maxItems:20,description:'Enumerate concrete product issues, including non-blocking ones. In-scope unresolved issues require repair. Coverage limitations are not product defects. Use resolved/out_of_scope only with a concrete reason.',items:{
          type:'object',additionalProperties:false,properties:{description:{type:'string',minLength:1,maxLength:2000},disposition:{type:'string',enum:['repair','resolved','out_of_scope']},reason:{type:'string',minLength:1,maxLength:2000}},required:['description','disposition','reason'],
        } },
      }, required: ['criterion_id','status','findings','evidence','issues'],
    } },
  }, required: ['verdict','summary','checks'],
}
export const personAcceptanceInputSchema = {
  type: 'object', additionalProperties: false,
  description: 'Explicit deliverable acceptance, including 验收一下看好不好看. Omit for ordinary tasks or opt-out.',
  properties: {
    enabled: { type: 'boolean', description: 'true: independent acceptance and completion gate; false: ordinary execution.' },
    criteria: { type: 'array', minItems: 1, maxItems: 20, items: { type: 'string', minLength: 1, maxLength: 2000 }, description: 'Required when enabled. Verifier-only checks and evidence procedures; visual quality requires rendered screenshots and findings. Keep these procedures out of the development goal.' },
    verifier_agent_id: { type: 'string', minLength: 1, maxLength: 100, description: 'Required when enabled. Capable saved preset from bot_agents_list; may equal developer agent_id (fresh verification session).' },
    reviewer_session_id: { type:'string',minLength:1,maxLength:100,description:'When the user names another Bot to review (e.g. 让暖暖验收), resolve it with bot_sessions_query and bind its exact session_id. That Bot receives the review and records the decision; the host automatically sends product defects to the original developer task for repair. A worker preset is not a Bot identity. Omit for review by the current Bot.' },
    max_attempts: { type: 'integer', minimum: 1, maximum: 5 },
    timeout_minutes: { type: 'integer', minimum: 1, maximum: 120 },
  }, required: ['enabled'],
} as const
