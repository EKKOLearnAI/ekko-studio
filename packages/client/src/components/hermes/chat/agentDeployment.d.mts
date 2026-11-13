export interface AgentDeploymentController {
  start(sessionId: string): void
  cancel(): void
}
export function prepareAgentDeployment(source: Element | null | undefined, options?: { imageSrc?: string }): AgentDeploymentController | null
