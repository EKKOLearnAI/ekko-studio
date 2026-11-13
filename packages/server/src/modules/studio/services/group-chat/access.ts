import type { GroupChatRuntimeServer } from './runtime'

type GroupChatStorage = ReturnType<GroupChatRuntimeServer['getStorage']>

function userProfiles(user: any): string[] {
    return Array.isArray(user?.profiles) ? user.profiles.map(String).filter(Boolean) : []
}

function isRoomOwner(room: any, user: any): boolean {
    if (!user) return true
    const ownerAuthUserId = Number(room?.ownerAuthUserId || 0)
    if (ownerAuthUserId > 0) {
        return typeof user.id === 'number' && ownerAuthUserId === user.id
    }
    // Rooms created before ownership was persisted have no stronger ownership
    // signal. Keep the authenticated super admin as their legacy owner.
    return user.role === 'super_admin'
}

function hasProfileRoomAccess(storage: GroupChatStorage, roomId: string, user: any): boolean {
    const profiles = userProfiles(user)
    if (!profiles.length || typeof storage.getRoomsForProfiles !== 'function') return false
    return storage.getRoomsForProfiles(profiles).some((room: any) => room.id === roomId)
}

export function canManageGroupChatRoom(storage: GroupChatStorage, roomId: string, user: any): boolean {
    if (!user || user.role === 'super_admin') return true
    const room = typeof storage.getRoom === 'function' ? storage.getRoom(roomId) : null
    if (room && isRoomOwner(room, user)) return true
    return hasProfileRoomAccess(storage, roomId, user)
}

export function isGroupChatRoomOwner(storage: GroupChatStorage, roomId: string, user: any): boolean {
    const room = typeof storage.getRoom === 'function' ? storage.getRoom(roomId) : null
    return Boolean(room && isRoomOwner(room, user))
}

export function canReadGroupChatRoom(storage: GroupChatStorage, roomId: string, user: any): boolean {
    if (canManageGroupChatRoom(storage, roomId, user)) return true
    return typeof user?.id === 'number' && typeof storage.getMemberByAuthUserId === 'function' && !!storage.getMemberByAuthUserId(roomId, user.id)
}

export function groupChatUserProfiles(user: any): string[] {
    return userProfiles(user)
}

export function publicGroupChatInviteRoom(room: any) {
    const ownerAuthUserId = Number(room.ownerAuthUserId || 0)
    return {
        id: String(room.id || ''),
        name: String(room.name || ''),
        inviteCode: null,
        canManage: false,
        canMentionAll: false,
        summaryProfile: '',
        summaryProvider: '',
        summaryModel: '',
        summaryApiMode: '',
        summaryEveryTurns: 0,
        totalTokens: 0,
        workspace: '',
        ownerMemberId: ownerAuthUserId > 0 ? `auth:${ownerAuthUserId}` : '',
        allowGuestAgents: Number(room.allowGuestAgents || 0),
        guestAgentApproval: 'owner',
        maxGuestAgentsPerMember: Math.max(1, Number(room.maxGuestAgentsPerMember || 1)),
    }
}
