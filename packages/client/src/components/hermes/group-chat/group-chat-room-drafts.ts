import type { GroupChatMention } from '@/api/studio/group-chat'

export const GROUP_CHAT_ROOM_DRAFT_STORAGE_KEY = 'hermes_group_chat_room_drafts_v1'
export const GROUP_CHAT_ROOM_DRAFT_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000

export type GroupChatTrackedMention = GroupChatMention & {
    start: number
    end: number
}

export interface GroupChatRoomDraft {
    text: string
    mentions: GroupChatTrackedMention[]
}

interface StoredGroupChatRoomDraft extends GroupChatRoomDraft {
    updatedAt: number
}

interface StoredGroupChatRoomDrafts {
    version: 1
    rooms: Record<string, StoredGroupChatRoomDraft>
}

function emptyDrafts(): StoredGroupChatRoomDrafts {
    return { version: 1, rooms: {} }
}

function safeRemoveStorage() {
    try {
        localStorage.removeItem(GROUP_CHAT_ROOM_DRAFT_STORAGE_KEY)
    } catch {
        // Browser storage is optional; the composer must remain usable without it.
    }
}

function isValidMention(text: string, value: unknown): value is GroupChatTrackedMention {
    if (!value || typeof value !== 'object') return false
    const mention = value as Partial<GroupChatTrackedMention>
    if (mention.type !== 'agent' && mention.type !== 'all') return false
    if (typeof mention.displayName !== 'string' || !mention.displayName) return false
    if (mention.type === 'agent' && (typeof mention.participantId !== 'string' || !mention.participantId)) return false
    if (!Number.isInteger(mention.start) || !Number.isInteger(mention.end)) return false
    const start = Number(mention.start)
    const end = Number(mention.end)
    if (start < 0 || end <= start || end > text.length) return false
    return text.slice(start, end) === `@${mention.displayName}`
}

function sanitizeDraft(value: unknown, now: number): StoredGroupChatRoomDraft | null {
    if (!value || typeof value !== 'object') return null
    const candidate = value as Partial<StoredGroupChatRoomDraft>
    if (typeof candidate.text !== 'string' || !Number.isFinite(candidate.updatedAt)) return null
    if (now - Number(candidate.updatedAt) > GROUP_CHAT_ROOM_DRAFT_MAX_AGE_MS) return null
    const rawMentions = Array.isArray(candidate.mentions) ? candidate.mentions : []
    return {
        text: candidate.text,
        mentions: rawMentions.filter(mention => isValidMention(candidate.text as string, mention)),
        updatedAt: Number(candidate.updatedAt),
    }
}

function readDrafts(now = Date.now()): StoredGroupChatRoomDrafts {
    let raw: string | null
    try {
        raw = localStorage.getItem(GROUP_CHAT_ROOM_DRAFT_STORAGE_KEY)
    } catch {
        return emptyDrafts()
    }
    if (!raw) return emptyDrafts()

    try {
        const parsed = JSON.parse(raw) as Partial<StoredGroupChatRoomDrafts>
        if (parsed.version !== 1 || !parsed.rooms || typeof parsed.rooms !== 'object' || Array.isArray(parsed.rooms)) {
            safeRemoveStorage()
            return emptyDrafts()
        }
        const rooms: Record<string, StoredGroupChatRoomDraft> = {}
        for (const [roomId, value] of Object.entries(parsed.rooms)) {
            const draft = sanitizeDraft(value, now)
            if (roomId && draft && (draft.text || draft.mentions.length)) rooms[roomId] = draft
        }
        const result: StoredGroupChatRoomDrafts = { version: 1, rooms }
        if (Object.keys(rooms).length === 0) {
            safeRemoveStorage()
        } else if (JSON.stringify(result) !== raw) {
            writeDrafts(result)
        }
        return result
    } catch {
        safeRemoveStorage()
        return emptyDrafts()
    }
}

function writeDrafts(drafts: StoredGroupChatRoomDrafts) {
    try {
        if (Object.keys(drafts.rooms).length === 0) {
            localStorage.removeItem(GROUP_CHAT_ROOM_DRAFT_STORAGE_KEY)
        } else {
            localStorage.setItem(GROUP_CHAT_ROOM_DRAFT_STORAGE_KEY, JSON.stringify(drafts))
        }
    } catch {
        // Quota/security errors must not block composing or sending.
    }
}

export function loadGroupChatRoomDraft(roomId: string): GroupChatRoomDraft | null {
    if (!roomId) return null
    const draft = readDrafts().rooms[roomId]
    if (!draft) return null
    return {
        text: draft.text,
        mentions: draft.mentions.map(mention => ({ ...mention })),
    }
}

export function saveGroupChatRoomDraft(roomId: string, draft: GroupChatRoomDraft) {
    if (!roomId) return
    const drafts = readDrafts()
    const mentions = draft.mentions.filter(mention => isValidMention(draft.text, mention))
    if (!draft.text && mentions.length === 0) {
        delete drafts.rooms[roomId]
    } else {
        drafts.rooms[roomId] = {
            text: draft.text,
            mentions: mentions.map(mention => ({ ...mention })),
            updatedAt: Date.now(),
        }
    }
    writeDrafts(drafts)
}

export function clearGroupChatRoomDraft(roomId: string) {
    if (!roomId) return
    const drafts = readDrafts()
    if (!(roomId in drafts.rooms)) return
    delete drafts.rooms[roomId]
    writeDrafts(drafts)
}
