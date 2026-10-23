/**
 * Chat input draft persistence.
 *
 * Drafts are keyed by session id. Sessions that were never persisted
 * (`isLocalOnly`, e.g. a blank chat where the user typed but never sent)
 * only live in this tab's memory: their drafts must not enter localStorage
 * because the session disappears on reload and the draft would be orphaned
 * forever. Persisted session drafts go to localStorage with a 30-day TTL,
 * mirroring `group-chat-room-drafts.ts`.
 */

export const DRAFT_STORAGE_KEY = 'hermes_chat_input_drafts_v1'
export const CHAT_INPUT_DRAFT_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000

interface StoredChatInputDraft {
  text: string
  updatedAt: number
}

interface StoredChatInputDrafts {
  version: 1
  drafts: Record<string, StoredChatInputDraft>
}

/** Drafts for unpersisted sessions; lives for the SPA session only. */
const memoryDrafts = new Map<string, string>()

function emptyDrafts(): StoredChatInputDrafts {
  return { version: 1, drafts: {} }
}

function safeRemoveStorage() {
  try {
    localStorage.removeItem(DRAFT_STORAGE_KEY)
  } catch {
    // Browser storage is optional; the composer must remain usable without it.
  }
}

function sanitizeDraft(value: unknown, now: number): StoredChatInputDraft | null {
  // Legacy format stored plain strings; migrate with a fresh TTL lease.
  if (typeof value === 'string') return value ? { text: value, updatedAt: now } : null
  if (!value || typeof value !== 'object') return null
  const candidate = value as Partial<StoredChatInputDraft>
  if (typeof candidate.text !== 'string' || !Number.isFinite(candidate.updatedAt)) return null
  if (now - Number(candidate.updatedAt) > CHAT_INPUT_DRAFT_MAX_AGE_MS) return null
  return candidate.text ? { text: candidate.text, updatedAt: Number(candidate.updatedAt) } : null
}

function readDrafts(now = Date.now()): StoredChatInputDrafts {
  let raw: string | null
  try {
    raw = localStorage.getItem(DRAFT_STORAGE_KEY)
  } catch {
    return emptyDrafts()
  }
  if (!raw) return emptyDrafts()

  try {
    const parsed = JSON.parse(raw) as Record<string, unknown> | null
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      safeRemoveStorage()
      return emptyDrafts()
    }
    // Legacy format is a bare session-id -> text map without an envelope.
    const source = parsed.version === 1
      ? (parsed.drafts && typeof parsed.drafts === 'object' && !Array.isArray(parsed.drafts)
          ? parsed.drafts as Record<string, unknown>
          : null)
      : parsed
    if (!source) {
      safeRemoveStorage()
      return emptyDrafts()
    }
    const drafts: Record<string, StoredChatInputDraft> = {}
    for (const [sessionId, value] of Object.entries(source)) {
      const draft = sanitizeDraft(value, now)
      if (sessionId && draft) drafts[sessionId] = draft
    }
    const result: StoredChatInputDrafts = { version: 1, drafts }
    if (Object.keys(drafts).length === 0) {
      safeRemoveStorage()
    } else if (JSON.stringify(result) !== raw) {
      // Persist migrations and TTL pruning so garbage does not linger.
      writeDrafts(result)
    }
    return result
  } catch {
    safeRemoveStorage()
    return emptyDrafts()
  }
}

function writeDrafts(drafts: StoredChatInputDrafts) {
  try {
    if (Object.keys(drafts.drafts).length === 0) {
      localStorage.removeItem(DRAFT_STORAGE_KEY)
    } else {
      localStorage.setItem(DRAFT_STORAGE_KEY, JSON.stringify(drafts))
    }
  } catch {
    // Quota/security errors must not block composing or sending.
  }
}

export function loadChatInputDraft(sessionId: string): string {
  if (!sessionId) return ''
  const memory = memoryDrafts.get(sessionId)
  if (memory != null) return memory
  return readDrafts().drafts[sessionId]?.text || ''
}

export function saveChatInputDraft(sessionId: string, text: string, isLocalOnly: boolean) {
  if (!sessionId) return
  if (isLocalOnly) {
    // Never-persisted sessions must not leak drafts into localStorage.
    if (text) memoryDrafts.set(sessionId, text)
    else memoryDrafts.delete(sessionId)
    return
  }
  memoryDrafts.delete(sessionId)
  const drafts = readDrafts()
  if (text) {
    drafts.drafts[sessionId] = { text, updatedAt: Date.now() }
  } else {
    delete drafts.drafts[sessionId]
  }
  writeDrafts(drafts)
}

export function clearChatInputDraft(sessionId: string) {
  if (!sessionId) return
  memoryDrafts.delete(sessionId)
  const drafts = readDrafts()
  if (!(sessionId in drafts.drafts)) return
  delete drafts.drafts[sessionId]
  writeDrafts(drafts)
}

/**
 * Drop in-memory drafts whose sessions are gone (runtime switch, profile
 * filter change, ...). Only memory drafts are pruned against the session
 * list: localStorage drafts belong to other profiles/runtime modes too, so
 * pruning them against the visible list would delete live user data.
 */
export function pruneMemoryChatInputDrafts(aliveIds: Iterable<string>) {
  const alive = new Set(aliveIds)
  for (const sessionId of [...memoryDrafts.keys()]) {
    if (!alive.has(sessionId)) memoryDrafts.delete(sessionId)
  }
}
