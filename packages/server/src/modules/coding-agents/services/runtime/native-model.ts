import { createReadStream, existsSync } from 'fs'
import { readdir } from 'fs/promises'
import { join } from 'path'
import { createInterface } from 'readline'
import { DatabaseSync } from 'node:sqlite'

export async function findRollout(root: string, sessionId: string, depth = 0): Promise<string | undefined> {
  if (depth > 3) return
  let entries
  try { entries = await readdir(root, { withFileTypes: true }) } catch { return }
  for (const entry of entries) {
    if (entry.isFile() && entry.name.startsWith('rollout-') && entry.name.endsWith(`-${sessionId}.jsonl`)) return join(root, entry.name)
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^\d{2,4}$/.test(entry.name)) continue
    const found = await findRollout(join(root, entry.name), sessionId, depth + 1)
    if (found) return found
  }
}

/** Read only the identified thread, and never reuse a previous turn's model. */
export async function readCodexTurnModel(home: string, sessionId: string, startedAt: number): Promise<{ model: string; provider?: string } | undefined> {
  const endedAt = Date.now()
  if (!/^[a-zA-Z0-9-]+$/.test(sessionId)) return
  const file = await findRollout(join(home, 'sessions'), sessionId)
  if (!file) return
  const models = new Set<string>()
  let provider: string | undefined
  let matchedSession = false
  const stream = createReadStream(file, { encoding: 'utf8', signal: AbortSignal.timeout(2_000) })
  const lines = createInterface({ input: stream, crlfDelay: Infinity })
  try {
    for await (const line of lines) {
      let event: any
      try { event = JSON.parse(line) } catch { continue }
      const payload = event.payload || {}
      if (event.type === 'session_meta') {
        matchedSession = payload.id === sessionId
        provider = typeof payload.model_provider === 'string' ? payload.model_provider : undefined
      }
      const timestamp = Date.parse(event.timestamp)
      if (event.type === 'turn_context' && timestamp >= startedAt && timestamp <= endedAt && typeof payload.model === 'string' && payload.model.trim()) {
        models.add(payload.model.trim())
      }
    }
  } catch { return } finally {
    lines.close()
    stream.destroy()
  }
  if (matchedSession && models.size === 1) return { model: [...models][0], provider }
}

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
