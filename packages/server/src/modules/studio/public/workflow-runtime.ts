export interface WorkflowRuntimeDependencies {
  isRunCoordinatorAvailable(): boolean
  runAndWait(input: Record<string, unknown>, options: Record<string, unknown>): Promise<any>
  abortSession(sessionId: string, reason: string): Promise<void>
  stopAgentRun(sessionId: string): void
  deletePrimaryAgentSession(sessionId: string, profile: string): Promise<boolean>
  getAvailableModelGroups(profile: string): Promise<any[]>
}

let dependencies: WorkflowRuntimeDependencies | null = null

export function configureWorkflowRuntime(next: WorkflowRuntimeDependencies): void {
  dependencies = next
}

function configured(): WorkflowRuntimeDependencies {
  if (!dependencies) throw new Error('Studio workflow runtime has not been configured')
  return dependencies
}

export const isWorkflowRunCoordinatorAvailable = () => configured().isRunCoordinatorAvailable()
export const runWorkflowAndWait = (input: Record<string, unknown>, options: Record<string, unknown>) => (
  configured().runAndWait(input, options)
)
export const abortWorkflowSession = (sessionId: string, reason: string) => (
  configured().abortSession(sessionId, reason)
)
export const stopWorkflowAgentRun = (sessionId: string) => configured().stopAgentRun(sessionId)
export const deleteWorkflowPrimaryAgentSession = (sessionId: string, profile: string) => (
  configured().deletePrimaryAgentSession(sessionId, profile)
)
export const getWorkflowAvailableModelGroups = (profile: string) => (
  configured().getAvailableModelGroups(profile)
)
