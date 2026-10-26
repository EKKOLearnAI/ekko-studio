import { createHash } from 'node:crypto'
import { getDb } from '../infrastructure/database'
import { sortGroupMessagesCanonical, groupRunOrder } from '../services/group-chat/group-message-ordering'
import { deleteWorkspaceRunChangesByChangeIds } from './workspace-run-changes-store'

export interface GroupMessageSelectionGroup {
  id: string
  kind: 'message' | 'run'
  messageIds: string[]
  deleteBlockedReason?: 'summarized' | 'summary_boundary_unknown'
}

export function groupMessageDeletionError(message: string, status = 409): Error & { status: number } {
  return Object.assign(new Error(message), { status })
}

function selectionState(roomId: string) {
  const db = getDb()
  if (!db) throw groupMessageDeletionError('Storage unavailable', 503)
  const room = db.prepare('SELECT * FROM gc_rooms WHERE id = ?').get(roomId) as any
  if (!room) throw groupMessageDeletionError('Room not found', 404)
  const summary = db.prepare('SELECT * FROM gc_room_summaries WHERE roomId = ?').get(roomId) as any
  const snapshot = db.prepare('SELECT * FROM gc_context_snapshots WHERE roomId = ?').get(roomId) as any
  if (summary?.status === 'summarizing'
    || db.prepare("SELECT 1 FROM gc_execution_queue WHERE roomId = ? AND status IN ('queued', 'running') LIMIT 1").get(roomId)
    || db.prepare("SELECT 1 FROM gc_handoff_attempts WHERE roomId = ? AND status IN ('claimed', 'admitted', 'dispatched', 'outcome_unknown') LIMIT 1").get(roomId)) {
    throw groupMessageDeletionError('Group chat is busy; wait for pending work to finish')
  }
  const messages = sortGroupMessagesCanonical(db.prepare('SELECT * FROM gc_messages WHERE roomId = ? ORDER BY id').all(roomId) as any[])
  if (messages.some(message => message.finish_reason === 'streaming')) {
    throw groupMessageDeletionError('Group chat is busy; wait for pending work to finish')
  }
  let protectedThrough = -1
  let unknownBoundary = false
  for (const boundary of [
    summary && { id: summary.summaryThroughMessageId, timestamp: summary.summaryThroughMessageTimestamp, hasSummary: !!summary.summary || summary.summarizedTurnCount > 0 },
    snapshot && { id: snapshot.lastMessageId, timestamp: snapshot.lastMessageTimestamp, hasSummary: !!snapshot.summary },
  ]) {
    if (!boundary) continue
    if (!boundary.id) {
      if (boundary.hasSummary || boundary.timestamp) unknownBoundary = true
      continue
    }
    const index = messages.findIndex(message => message.id === boundary.id)
    if (index < 0 || messages[index].timestamp !== boundary.timestamp) unknownBoundary = true
    else protectedThrough = Math.max(protectedThrough, index)
  }
  const groups = new Map<string, GroupMessageSelectionGroup>()
  const hash = createHash('sha256').update(JSON.stringify([roomId, room.messageDeletionRevision, room.summaryGeneration, summary, snapshot]))
  messages.forEach((message, index) => {
    hash.update(JSON.stringify(message))
    const isAgent = message.role === 'assistant' || message.role === 'tool'
    const runId = String(message.run_id || '').trim() || groupRunOrder(message.id).baseId
    const key = isAgent ? JSON.stringify([message.senderAgentRecordId || message.senderId, runId]) : `message:${message.id}`
    let group = groups.get(key)
    if (!group) {
      group = { id: message.id, kind: isAgent ? 'run' : 'message', messageIds: [] }
      groups.set(key, group)
    }
    group.messageIds.push(message.id)
    if (unknownBoundary) group.deleteBlockedReason = 'summary_boundary_unknown'
    else if (index <= protectedThrough) group.deleteBlockedReason = 'summarized'
  })
  return { groups: [...groups.values()], historyRevision: hash.digest('hex') }
}

export function getGroupMessageSelection(roomId: string) {
  return selectionState(roomId)
}

/** The caller holds the room summary lock and verifies runtime idleness synchronously. */
export function deleteGroupMessages(roomId: string, messageIds: unknown, historyRevision: unknown, refreshTokens: () => number) {
  if (!Array.isArray(messageIds) || !messageIds.length || messageIds.length > 10000
    || messageIds.some(id => typeof id !== 'string' || !id || id.length > 500)
    || typeof historyRevision !== 'string' || !/^[a-f0-9]{64}$/.test(historyRevision)) {
    throw groupMessageDeletionError('Invalid message selection', 400)
  }
  const db = getDb()
  if (!db) throw groupMessageDeletionError('Storage unavailable', 503)
  db.exec('BEGIN IMMEDIATE')
  try {
    const current = selectionState(roomId)
    if (current.historyRevision !== historyRevision) throw groupMessageDeletionError('History changed; select messages again')
    const byMessage = new Map(current.groups.flatMap(group => group.messageIds.map(id => [id, group] as const)))
    const selected = new Set<GroupMessageSelectionGroup>()
    for (const id of messageIds) {
      const group = byMessage.get(id)
      if (!group) throw groupMessageDeletionError('Message not found in this room', 404)
      if (group.deleteBlockedReason) throw groupMessageDeletionError('Summarized messages cannot be deleted')
      selected.add(group)
    }
    const deletedIds = [...selected].flatMap(group => group.messageIds)
    for (const id of deletedIds) {
      const changes = db.prepare('SELECT change_id FROM workspace_run_changes WHERE room_id = ? AND message_id = ?').all(roomId, id) as Array<{ change_id: string }>
      deleteWorkspaceRunChangesByChangeIds(db, changes.map(change => change.change_id))
      for (const table of ['gc_message_routing_claims', 'gc_message_routing_decisions', 'gc_message_routing_contexts', 'gc_execution_queue']) {
        db.prepare(`DELETE FROM ${table} WHERE roomId = ? AND messageId = ?`).run(roomId, id)
      }
      // Completed handoff records are audit history. Removing their source prevents resuming them.
      db.prepare('DELETE FROM gc_messages WHERE roomId = ? AND id = ?').run(roomId, id)
    }
    db.prepare('UPDATE gc_rooms SET messageDeletionRevision = messageDeletionRevision + 1, summaryGeneration = summaryGeneration + 1 WHERE id = ?').run(roomId)
    // A failed multi-batch summary may retain a frozen, not-yet-summarized cutoff.
    // Restart that drain from the retained tail, without changing the committed summary.
    db.prepare("UPDATE gc_room_summaries SET summaryDrainThroughMessageId = '' WHERE roomId = ? AND summaryDrainThroughMessageId != ''").run(roomId)
    const totalTokens = refreshTokens()
    const room = db.prepare('SELECT messageDeletionRevision FROM gc_rooms WHERE id = ?').get(roomId) as any
    const count = db.prepare('SELECT COUNT(*) AS total FROM gc_messages WHERE roomId = ?').get(roomId) as any
    db.exec('COMMIT')
    return { roomId, messageIds: deletedIds, deletedGroups: selected.size, messageDeletionRevision: Number(room.messageDeletionRevision), messageCount: Number(count.total), totalTokens }
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}
