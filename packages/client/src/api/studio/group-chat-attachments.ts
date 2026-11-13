import { getApiKey, getBaseUrlValue } from '../client'

type GroupChatAttachmentScope = {
    roomId: string
    inviteCode?: string
}

function attachmentScopePath(scope: GroupChatAttachmentScope): string {
    const inviteCode = scope.inviteCode?.trim() || ''
    if (inviteCode) {
        return `/api/studio/group-chat/invites/${encodeURIComponent(inviteCode)}/attachments`
    }
    const roomId = scope.roomId.trim()
    if (!roomId) throw new Error('Room ID is required')
    return `/api/studio/group-chat/rooms/${encodeURIComponent(roomId)}/attachments`
}

export function getGroupChatAttachmentUrl(
    scope: GroupChatAttachmentScope,
    filePath: string,
    fileName?: string,
): string {
    const storedName = filePath.replace(/\\/g, '/').split('/').pop() || ''
    if (!storedName) return ''
    const params = new URLSearchParams()
    if (fileName) params.set('name', fileName)
    if (!scope.inviteCode?.trim()) {
        const token = getApiKey()
        if (token) params.set('token', token)
    }
    const query = params.toString()
    return `${getBaseUrlValue()}${attachmentScopePath(scope)}/${encodeURIComponent(storedName)}${query ? `?${query}` : ''}`
}

export async function uploadGroupChatAttachments(
    scope: GroupChatAttachmentScope,
    attachments: Array<{ name: string; file?: File }>,
): Promise<Array<{ name: string; path: string }>> {
    const formData = new FormData()
    for (const attachment of attachments) {
        if (attachment.file) formData.append('file', attachment.file, attachment.name)
    }
    const headers: Record<string, string> = {}
    if (!scope.inviteCode?.trim()) {
        const token = getApiKey()
        if (token) headers.Authorization = `Bearer ${token}`
    }
    const res = await fetch(
        `${getBaseUrlValue()}${attachmentScopePath(scope)}`,
        { method: 'POST', body: formData, headers },
    )
    if (!res.ok) {
        const body = await res.json().catch(() => ({ error: `Upload failed: ${res.status}` }))
        throw new Error(body.error || `Upload failed: ${res.status}`)
    }
    const body = await res.json() as { files?: Array<{ name: string; path: string }> }
    return body.files || []
}
