import type { Json, Dispose } from './core'

/** Core chat protocol events, including resumed snapshots and transport state. */
export interface SessionEvent {
  event: string
  session_id: string
  [key: string]: Json
}
export type SessionListener = (event: SessionEvent) => void
/** A live subscription; commands dispatch and their outcomes arrive as events. */
export interface HostSession {
  readonly sessionId: string
  run(input: string | Record<string, Json>[], options?: Record<string, Json>): Promise<void>
  stop(): Promise<void>
  resume(): Promise<void>
  queue: { insert(queueId: string): Promise<void>; cancel(queueId: string): Promise<void> }
  interactions: {
    approve(approvalId: string, choice: string): Promise<void>
    clarify(clarifyId: string, response: string): Promise<void>
  }
  /** Releases this subscription; stopping the run is an explicit operation. */
  close: Dispose
}
export type SessionConnector = (sessionId: string, listener: SessionListener, kind?: 'chat' | 'bot') => Promise<HostSession>
