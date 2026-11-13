import type {
  PrimaryAgentBridgeRuntimeState,
  PrimaryAgentOpsDependencies,
} from '../contracts/agents/ops'

let dependencies: PrimaryAgentOpsDependencies | null = null

export function configurePrimaryAgentOps(next: PrimaryAgentOpsDependencies): void {
  dependencies = next
}

function configured(): PrimaryAgentOpsDependencies {
  if (!dependencies) throw new Error('Studio primary agent operations have not been configured')
  return dependencies
}

export function getPrimaryAgentBridgeRuntimeState(): PrimaryAgentBridgeRuntimeState {
  return configured().getBridgeRuntimeState()
}

export function pingPrimaryAgentBridge(endpoint: string): Promise<Record<string, unknown>> {
  return configured().pingBridge(endpoint)
}
