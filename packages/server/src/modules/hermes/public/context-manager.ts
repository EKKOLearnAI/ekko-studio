export {
  assertBridgeContextCapabilities,
  compactBiliConversation,
  configureHermesContextManager,
  observeHermesProfileWorker,
  restartHermesProfileWorker,
  resolveSessionContextOwner,
  type HermesContextManagerSettings,
  type HermesProfileWorker,
  type HermesProfileWorkerObservation,
  type HermesProfileWorkerRestart,
  type SessionContextOwner,
} from '../services/bridge/context-manager'
export { AgentBridgeClient } from '../services/bridge/client'
export type {
  AgentBridgeContextManagerOptions,
  AgentBridgeContextManagerStatus,
  AgentBridgeContextOwner,
} from '../services/bridge/client'