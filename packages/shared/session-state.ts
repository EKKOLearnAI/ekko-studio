/** Account-specific read cursor and live execution state, independent of open tabs. */
export interface SessionListState {
  sessionId: string
  profile?: string
  working: boolean
  backgroundPending: number
  lastMessageId: number
  readMessageId: number
  lastAttentionId?: number
  readAttentionId?: number
  /** Completed content awaiting a read receipt; false while working. */
  unread: boolean
}

export interface SessionStateSnapshot { sessions: SessionListState[] }
