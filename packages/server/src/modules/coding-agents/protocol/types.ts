/** Wire formats supported by the shared Coding Agent provider bridge. */
export type AgentApiMode =
  | 'chat_completions'
  | 'codex_responses'
  | 'anthropic_messages'
  | 'bedrock_converse'
  | 'codex_app_server'

export type ApiMode = AgentApiMode

export interface CodingAgentImageInput {
  name: string
  path: string
  mediaType: string
}
