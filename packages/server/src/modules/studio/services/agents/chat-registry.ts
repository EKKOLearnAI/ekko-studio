import type { AgentChats } from './chats'
import { getDb } from '../../infrastructure/database'

let chats: AgentChats | undefined
/** Bootstrap wiring only; importing the chat transport does not load a worker. */
export function setAgentChatService(value: AgentChats | undefined): void { chats = value }
export function getAgentChatService(): AgentChats | undefined { return chats }
/** Persistent routing identity survives a stopped host and deleted chats. */
export function isManagedAgentChat(sessionId: string): boolean {
  if (typeof sessionId !== 'string' || !sessionId) return false
  if (chats?.isBound(sessionId)) return true
  const db = getDb()
  return !!(db?.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='studio_agent_chat_bindings'").get()
    && db.prepare('SELECT 1 FROM studio_agent_chat_bindings WHERE session_id=?').get(sessionId))
}
