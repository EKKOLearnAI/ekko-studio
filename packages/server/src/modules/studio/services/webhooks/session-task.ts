import type { SessionTask } from '../../contracts/session-task'

type TaskText = Pick<SessionTask, 'title' | 'summary' | 'completion_evidence'>
export interface WebhookSessionTask extends Omit<SessionTask, keyof TaskText>, Partial<TaskText> {
  /** Session ledger revision at the time of this event. */
  revision: number
}

/** Project saved task fields explicitly; text follows the endpoint's content switch. */
export function sessionTaskWebhookContent(task: WebhookSessionTask, includeContent: boolean): WebhookSessionTask {
  return {
    id: task.id, revision: task.revision, status: task.status,
    source_message_id: task.source_message_id, evidence_message_id: task.evidence_message_id,
    created_at: task.created_at, updated_at: task.updated_at, completed_at: task.completed_at,
    ...(includeContent ? { title: task.title, summary: task.summary, completion_evidence: task.completion_evidence } : {}),
  }
}
