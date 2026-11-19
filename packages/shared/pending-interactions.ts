export interface PendingWorkflowApprovals {
  workflowId: string
  title: string
  profile: string
  runId: string | null
  pendingApprovals: Array<{ nodeId: string; executionId: string }>
}
