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
  /** This account marked the conversation unread by hand. */
  manualUnread?: boolean
  /** Revision of the latest manual mark; a read must name it to clear the mark. */
  unreadRevision?: number
  /** Session incarnation; manual unread requests must name the one they observed. */
  generation?: string
  /** Completed content or a manual mark awaiting a read receipt; false while working. */
  unread: boolean
}

export interface SessionStateSnapshot { sessions: SessionListState[] }
