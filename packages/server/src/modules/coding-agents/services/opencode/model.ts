import { existsSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'

/** OpenCode step parts reference the assistant message that owns the model. */
export function readOpenCodeMessageModel(databasePath: string | undefined, sessionId: string, messageId: string): { model: string; provider?: string } | undefined {
  if (!databasePath || !sessionId || !messageId || !existsSync(databasePath)) return
  let db: DatabaseSync | undefined
  try {
    db = new DatabaseSync(databasePath, { readOnly: true })
    const row = db.prepare('SELECT data FROM message WHERE id = ? AND session_id = ?').get(messageId, sessionId)
    if (!row || typeof row.data !== 'string') return
    const message = JSON.parse(row.data)
    if (message.role !== 'assistant' || typeof message.modelID !== 'string' || !message.modelID.trim()) return
    return { model: message.modelID.trim(), provider: typeof message.providerID === 'string' ? message.providerID : undefined }
  } catch { return } finally { db?.close() }
}
