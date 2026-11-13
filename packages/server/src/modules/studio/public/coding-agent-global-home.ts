import { homedir } from 'os'

/**
 * Authoritative home for user-managed Coding Agent configuration.
 *
 * Runtime directories under the Ekko Studio data root are derived launch
 * artifacts. Settings, memory, MCP configuration, and skills shown in the UI
 * must always resolve from this global home instead.
 */
export function getCodingAgentGlobalHome(): string {
  return process.env.HERMES_CODING_AGENT_GLOBAL_HOME?.trim() || homedir()
}
