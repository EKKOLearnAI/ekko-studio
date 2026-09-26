<script setup lang="ts">
import TaskPlanCard from '../chat/TaskPlanCard.vue'
import { computed, defineAsyncComponent, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useMessage } from 'naive-ui'
import ProfileAvatar from '@/components/hermes/profiles/ProfileAvatar.vue'
import {
    copyTextToClipboard,
    extractUnifiedDiffPayload,
    handleCodeBlockCopyClick,
    inferStructuredLanguage,
    renderHighlightedCodeBlock,
} from '../chat/highlight'
import { parseThinking, countThinkingChars } from '@/utils/thinking-parser'
import { useGlobalSpeech } from '@/composables/useSpeech'
import { useVoiceSettings } from '@/composables/useVoiceSettings'
import { speedToEdgeRate, hzToEdgePitch } from '@/utils/ttsHelpers'
import { formatChatTimestamp } from '@/utils/chat-timestamp'
import {
    type ChatMessage,
    type GroupWorkspaceDiffFile,
    type GroupWorkspaceDiffPayload,
    type RoomAgent,
    type MemberInfo,
} from '@/api/studio/group-chat'
import { getGroupChatAttachmentUrl } from '@/api/studio/group-chat-attachments'
import { useGroupChatStore } from '@/stores/hermes/group-chat'
import { formatReferencedContentForDisplay, parseMessageReference } from '@/stores/hermes/chat'
import { isPreviewableFile } from '@/utils/hermes/file-preview'
import ToolChangeCard from '@/components/hermes/chat/ToolChangeCard.vue'
import { useFilesStore } from '@/stores/hermes/files'
import { useToolPanelStore } from '@/stores/hermes/tool-panel'
import { isServerTtsProvider } from '@/api/studio/tts'
import { groupAgentAvatar, groupMessageAgent, parseStoredAvatar } from '@/utils/group-agent-avatar'
import GroupAgentMessageAvatar from './GroupAgentMessageAvatar.vue'
import GroupAgentRobotIcon from './GroupAgentRobotIcon.vue'
import ImagePreviewOverlay from '@/components/hermes/chat/ImagePreviewOverlay.vue'

const MarkdownRenderer = defineAsyncComponent(async () => (await import('../chat/MarkdownRenderer.vue')).default)

const TOOL_PAYLOAD_DISPLAY_LIMIT = 1000
const JSON_STRING_DISPLAY_LIMIT = 200
const JSON_MAX_DEPTH = 6
const JSON_MAX_NODES = 1000
const JSON_MAX_KEYS_PER_OBJECT = 50
const JSON_MAX_ITEMS_PER_ARRAY = 50
const JSON_TRUNCATED_KEY = '__truncated__'
const STREAMING_MARKDOWN_RENDER_INTERVAL_MS = 100

const props = withDefaults(defineProps<{
    message: ChatMessage
    agents: RoomAgent[]
    members?: MemberInfo[]
    currentUserId?: string
    embedded?: boolean
    allowSpeech?: boolean
}>(), {
    embedded: false,
    allowSpeech: true,
})

const emit = defineEmits<{
    mentionAgent: [agent: RoomAgent]
}>()

const { t } = useI18n()
const toast = useMessage()
const groupChatStore = useGroupChatStore()
const filesStore = useFilesStore()
const toolPanelStore = useToolPanelStore()
const speech = useGlobalSpeech()
const voiceSettings = useVoiceSettings()
const previewUrl = ref<string | null>(null)
const activeAgentInfo = computed(() => props.agents.find(a =>
    !a.historical && (
        a.id === props.message.senderAgentRecordId
        || a.agentId === props.message.senderId
        || (!props.message.senderAgentRecordId && a.name === props.message.senderName)
    )
))
const agentInfo = computed(() => groupMessageAgent(props.message, props.agents))
const isAgent = computed(() => Boolean(agentInfo.value))

const isAgentError = computed(() => {
    if (props.message.role !== 'assistant') return false
    if (props.message.finish_reason === 'error') return true
    return /^Error:\s*/i.test(props.message.content || '')
})

const isSelf = computed(() => {
    return !!props.currentUserId && props.message.senderId === props.currentUserId
})

const agentOwnerInfo = computed(() => {
    const ownerMemberId = agentInfo.value?.ownerMemberId
    if (!ownerMemberId) return null
    return props.members?.find(member => member.userId === ownerMemberId) || null
})
const messageTtsProfile = computed(() => agentInfo.value?.profile?.trim() || '')

const timeStr = computed(() => formatChatTimestamp(props.message.timestamp))

// 找当前消息发送者在 members 里的记录
const memberInfo = computed(() => {
    if (isAgent.value) return null
    return props.members?.find(m =>
        m.userId === props.message.senderId ||
        m.name === props.message.senderName
    ) || null
})

// 解析 member 的 avatar JSON
const memberAvatar = computed(() => {
    return parseStoredAvatar(memberInfo.value?.avatar)
})

// 当前消息要显示的头像(profile / member / fallback)
const currentAvatar = computed(() => {
    if (isAgent.value) {
        return groupAgentAvatar(agentInfo.value)
    }
    return memberAvatar.value
})

// 给 ProfileAvatar 的 name seed
const avatarDisplayName = computed(() => {
    if (isAgent.value) return agentInfo.value?.agent || 'hermes'
    return props.message.senderName || props.message.senderId || 'user'
})

const mentionNames = computed(() => ['all', ...props.agents.map(a => a.name).filter(Boolean)])
const parsedThinking = computed(() => parseThinking(props.message.content || '', { streaming: !!props.message.isStreaming }))
const hasReasoningField = computed(() => !!(props.message.reasoning && props.message.reasoning.length > 0))
const hasThinking = computed(() => hasReasoningField.value || parsedThinking.value.hasThinking)
const thinkingFullText = computed(() => {
    const parts: string[] = []
    if (props.message.reasoning) parts.push(props.message.reasoning)
    parts.push(...parsedThinking.value.segments)
    if (parsedThinking.value.pending) parts.push(parsedThinking.value.pending)
    return parts.join('\n\n')
})
const thinkingCharCount = computed(() => {
    let count = countThinkingChars(parsedThinking.value)
    if (props.message.reasoning) count += props.message.reasoning.length
    return count
})
const thinkingStreamingNow = computed(() => {
    if (!props.message.isStreaming) return false
    if (parsedThinking.value.pending !== null) return true
    if (hasReasoningField.value && !props.message.content) return true
    return false
})
const thinkingOverride = ref<boolean | null>(null)
const thinkingExpanded = computed(() => {
    if (thinkingOverride.value !== null) return thinkingOverride.value
    return false
})
const assistantBody = computed(() => parsedThinking.value.body || props.message.content || '')
function resolveGroupImageUrl(path: string): string {
    return getGroupChatAttachmentUrl({
        roomId: props.message.roomId || groupChatStore.currentRoomId || '',
        inviteCode: groupChatStore.inviteGuest ? groupChatStore.activeInviteCode || undefined : undefined,
    }, path)
}
const contentBlocks = computed(() => {
    const content = props.message.content || ''
    const trimmed = content.trim()
    if (!trimmed.startsWith('[') || !trimmed.endsWith(']')) return null
    try {
        const parsed = JSON.parse(trimmed)
        if (!Array.isArray(parsed) || parsed.length === 0) return null
        return parsed.every((block: any) => (
            block
            && typeof block === 'object'
            && (block.type === 'text' || block.type === 'image' || block.type === 'file')
        )) ? parsed : null
    } catch {
        return null
    }
})
const renderedAttachments = computed(() => {
    if (props.message.attachments?.length) return props.message.attachments
    const blocks = contentBlocks.value
    if (!blocks) return []
    return blocks.flatMap((block: any, index: number) => {
        if (block?.type !== 'image' && block?.type !== 'file') return []
        const path = String(block.path || '')
        if (!path) return []
        const name = String(block.name || `${block.type}-${index + 1}`)
        const normalizedPath = normalizeLocalFilePath(path)
        const attachmentUrl = getGroupChatAttachmentUrl({
            roomId: props.message.roomId || groupChatStore.currentRoomId || '',
            inviteCode: groupChatStore.inviteGuest
                ? groupChatStore.activeInviteCode || undefined
                : undefined,
        }, normalizedPath, name)
        return [{
            id: `${props.message.id}_attachment_${index}`,
            name,
            type: block.type === 'image' ? String(block.media_type || 'image/*') : String(block.media_type || 'application/octet-stream'),
            size: 0,
            url: attachmentUrl,
            path: normalizedPath,
        }]
    })
})
const hasAttachments = computed(() => renderedAttachments.value.length > 0)
const displayBody = computed(() => {
    const blocks = contentBlocks.value
    if (!blocks) return assistantBody.value
    return blocks
        .filter((block: any) => block?.type === 'text' && typeof block.text === 'string')
        .map((block: any) => block.text)
        .join('\n')
})
const renderedDisplayBody = ref(displayBody.value)
let streamingMarkdownTimer: ReturnType<typeof setTimeout> | null = null

function clearStreamingMarkdownTimer() {
    if (streamingMarkdownTimer === null) return
    clearTimeout(streamingMarkdownTimer)
    streamingMarkdownTimer = null
}

watch([displayBody, () => props.message.isStreaming], ([body, isStreaming]) => {
    if (!isStreaming) {
        clearStreamingMarkdownTimer()
        renderedDisplayBody.value = body
        return
    }
    if (streamingMarkdownTimer !== null) return
    streamingMarkdownTimer = setTimeout(() => {
        streamingMarkdownTimer = null
        renderedDisplayBody.value = displayBody.value
    }, STREAMING_MARKDOWN_RENDER_INTERVAL_MS)
})
const parsedMessageReference = computed(() =>
    props.message.role !== 'assistant' && props.message.role !== 'tool'
        ? parseMessageReference(displayBody.value)
        : null,
)
const referencedContentMarkdown = computed(() =>
    parsedMessageReference.value
        ? formatReferencedContentForDisplay(parsedMessageReference.value.content)
        : '',
)
const copyableContent = computed(() => {
    if (isToolMessage.value) return null
    if (parsedMessageReference.value) {
        return [referencedContentMarkdown.value, parsedMessageReference.value.reply]
            .filter(Boolean)
            .join('\n\n')
    }
    const content = displayBody.value || ''
    return content.trim() ? content : null
})
const quotableContent = computed(() => {
    if (isToolMessage.value || props.message.isStreaming || isAgentError.value) return null
    const content = props.message.role === 'assistant'
        ? displayBody.value
        : parsedMessageReference.value?.reply || parsedMessageReference.value?.content || displayBody.value
    return content.trim() || null
})

const toolExpanded = ref(false)
const expandedWorkspaceChangeIds = ref(new Set<string>())
const isToolMessage = computed(() => props.message.role === 'tool')
const assistantWorkspaceChanges = computed(() => props.message.workspaceChanges || [])
const selectedWorkspaceDiffFileId = computed(() => toolPanelStore.workspaceDiff?.file.id ?? null)
const toolArgsPayload = computed(() => formatToolPayload(props.message.toolArgs))
const toolResultPayload = computed(() => formatToolPayload(props.message.toolResult, true))
const hasToolDetails = computed(() => !!(
    props.message.reasoning?.trim()
    || toolArgsPayload.value.full
    || toolResultPayload.value.full
))
const fullToolArgs = computed(() => toolArgsPayload.value.full)
const formattedToolArgs = computed(() => toolArgsPayload.value.display)
const fullToolResult = computed(() => toolResultPayload.value.full)
const formattedToolResult = computed(() => toolResultPayload.value.display)
const renderedToolArgs = computed(() => formattedToolArgs.value ? renderToolPayload(formattedToolArgs.value, toolArgsPayload.value.language) : '')
const renderedToolResult = computed(() => formattedToolResult.value ? renderToolPayload(formattedToolResult.value, toolResultPayload.value.language) : '')

function isWorkspaceChangeExpanded(changeId: string): boolean {
    return expandedWorkspaceChangeIds.value.has(changeId)
}

function toggleWorkspaceChange(changeId: string): void {
    const next = new Set(expandedWorkspaceChangeIds.value)
    if (next.has(changeId)) next.delete(changeId)
    else next.add(changeId)
    expandedWorkspaceChangeIds.value = next
}

function openWorkspaceDiffFileForPayload(file: GroupWorkspaceDiffFile, payload: GroupWorkspaceDiffPayload | null): void {
    if (!payload || !file) return
    filesStore.closePreview()
    toolPanelStore.openInlineWorkspaceDiff({
        id: file.id ?? file.path,
        path: String(file.path || ''),
        additions: Number(file.additions || 0),
        deletions: Number(file.deletions || 0),
        binary: file.binary === true,
    }, typeof file.patch === 'string' ? file.patch : null, payload.workspace || payload.workspace_root || '')
}

const canPlaySpeech = computed(() => {
    if (!props.allowSpeech) return false
    if (props.message.role !== 'assistant') return false
    if (!displayBody.value.trim()) return false
    if (messageTtsProfile.value) return true
    if (isServerTtsProvider(voiceSettings.provider.value)) return true
    return speech.isSupported
})
const isPlayingThisMessage = computed(() => {
    if (messageTtsProfile.value || isServerTtsProvider(voiceSettings.provider.value)) {
        return speech.currentCustomMessageId.value === props.message.id && speech.isCustomPlaying.value
    }
    return speech.currentMessageId.value === props.message.id && speech.isPlaying.value
})
const isPausedThisMessage = computed(() => {
    if (messageTtsProfile.value || isServerTtsProvider(voiceSettings.provider.value)) {
        return speech.currentCustomMessageId.value === props.message.id && speech.isCustomPaused.value
    }
    return speech.currentMessageId.value === props.message.id && speech.isPaused.value
})

type ToolPayload = {
    full: string
    display: string
    language?: string
}

function truncateLongString(value: string, marker: string): string {
    return value.length > JSON_STRING_DISPLAY_LIMIT ? value.slice(0, JSON_STRING_DISPLAY_LIMIT) + '\n' + marker : value
}

function truncateJsonValue(value: unknown, marker: string): unknown {
    let nodeCount = 0
    const seen = new WeakSet<object>()

    function stringifyLength(candidate: unknown): number {
        return JSON.stringify(candidate, null, 2).length
    }

    function visit(current: unknown, depth: number): unknown {
        nodeCount += 1
        if (nodeCount > JSON_MAX_NODES) return marker
        if (typeof current === 'string') return truncateLongString(current, marker)
        if (current === null || typeof current !== 'object') return current
        if (seen.has(current)) return `[Circular ${marker}]`
        if (depth >= JSON_MAX_DEPTH) return Array.isArray(current) ? `[Array ${marker}]` : `[Object ${marker}]`

        seen.add(current)

        if (Array.isArray(current)) {
            const result: unknown[] = []
            const maxItems = Math.min(current.length, JSON_MAX_ITEMS_PER_ARRAY)
            for (let i = 0; i < maxItems; i += 1) {
                const remaining = current.length - i
                result.push(visit(current[i], depth + 1))
                if (stringifyLength(result) > TOOL_PAYLOAD_DISPLAY_LIMIT) {
                    result.pop()
                    result.push(`${marker}: ${remaining} more items`)
                    seen.delete(current)
                    return result
                }
            }
            if (current.length > maxItems) result.push(`${marker}: ${current.length - maxItems} more items`)
            seen.delete(current)
            return result
        }

        const entries = Object.entries(current as Record<string, unknown>)
        const result: Record<string, unknown> = {}
        const maxKeys = Math.min(entries.length, JSON_MAX_KEYS_PER_OBJECT)
        for (let i = 0; i < maxKeys; i += 1) {
            const [key, val] = entries[i]
            const remaining = entries.length - i
            result[key] = visit(val, depth + 1)
            if (stringifyLength(result) > TOOL_PAYLOAD_DISPLAY_LIMIT) {
                delete result[key]
                result[JSON_TRUNCATED_KEY] = `${marker}: ${remaining} more keys`
                seen.delete(current)
                return result
            }
        }
        if (entries.length > maxKeys) result[JSON_TRUNCATED_KEY] = `${marker}: ${entries.length - maxKeys} more keys`
        seen.delete(current)
        return result
    }

    const truncated = visit(value, 0)
    if (stringifyLength(truncated) <= TOOL_PAYLOAD_DISPLAY_LIMIT) return truncated
    return { [JSON_TRUNCATED_KEY]: marker }
}

function normalizeToolPayload(raw: unknown): string {
    if (raw === null || raw === undefined || raw === '') return ''
    if (typeof raw === 'string') return raw
    try {
        const serialized = JSON.stringify(raw)
        if (serialized !== undefined) return serialized
    } catch {
        // Fall through to String(raw) for non-serializable runtime payloads.
    }
    return String(raw)
}

function formatToolPayload(raw?: unknown, extractDiff = false): ToolPayload {
    const text = normalizeToolPayload(raw)
    if (!text) return { full: '', display: '' }

    const shouldParseJson = typeof raw !== 'string' || /^[\[{]/.test(text.trim())
    if (shouldParseJson) {
        try {
            const parsed = JSON.parse(text)
            const full = JSON.stringify(parsed, null, 2)
            const extractedDiff = extractDiff ? extractUnifiedDiffPayload(parsed) : null
            if (extractedDiff) {
                return {
                    full,
                    display: extractedDiff,
                    language: 'diff',
                }
            }
            const display = full.length > TOOL_PAYLOAD_DISPLAY_LIMIT
                ? JSON.stringify(truncateJsonValue(parsed, t('chat.truncated')), null, 2)
                : full
            return { full, display, language: 'json' }
        } catch {
            // Fall through to text rendering for non-JSON strings.
        }
    }

    const language = inferStructuredLanguage(text)
    return {
        full: text,
        display: language === 'diff' || text.length <= TOOL_PAYLOAD_DISPLAY_LIMIT ? text : text.slice(0, TOOL_PAYLOAD_DISPLAY_LIMIT) + '\n' + t('chat.truncated'),
        language,
    }
}


function renderToolPayload(content: string, language?: string): string {
    return renderHighlightedCodeBlock(content, language, t('common.copy'), {
        maxHighlightLength: TOOL_PAYLOAD_DISPLAY_LIMIT,
        formatDiffFoldLabel: (hiddenCount) => t('chat.unchangedLines', { count: hiddenCount }),
    })
}

async function handleToolDetailClick(event: MouseEvent): Promise<void> {
    const target = event.target
    if (!(target instanceof HTMLElement)) return
    const button = target.closest<HTMLElement>('[data-copy-code="true"]')
    if (!button) return
    event.preventDefault()

    const source = button.closest<HTMLElement>('[data-copy-source]')?.dataset.copySource
    if (source === 'tool-args' && fullToolArgs.value) {
        const ok = await copyTextToClipboard(fullToolArgs.value)
        if (ok) toast.success(t('common.copied'))
        else toast.error(t('chat.copyFailed'))
        return
    }
    if (source === 'tool-result' && fullToolResult.value) {
        const ok = await copyTextToClipboard(fullToolResult.value)
        if (ok) toast.success(t('common.copied'))
        else toast.error(t('chat.copyFailed'))
        return
    }

    const copyResult = await handleCodeBlockCopyClick(event)
    if (copyResult) toast.success(t('common.copied'))
    else if (copyResult === false) toast.error(t('chat.copyFailed'))
}

function handleAutoplayTtsError(err: unknown) {
    if (err instanceof Error && err.name === 'AbortError') return
    console.warn('[GroupMessageItem] TTS autoplay failed:', err)
}

function playSpeech(content: string, autoplay = false, profileOverride = '') {
    if (!props.allowSpeech) return
    if (!content.trim()) return
    const profile = profileOverride.trim() || messageTtsProfile.value
    if (profile) {
        if (autoplay) speech.enqueueProfileSpeech(props.message.id, content, profile)
        else speech.profileToggle(props.message.id, content, profile)
        return
    }
    if (voiceSettings.provider.value === 'openai') {
        if (!voiceSettings.openaiBaseUrl.value) return
        const options = {
            provider: 'openai' as const,
            baseUrl: voiceSettings.openaiBaseUrl.value,
            apiKey: voiceSettings.openaiApiKey.value,
            model: voiceSettings.openaiModel.value,
            voice: voiceSettings.openaiVoice.value,
        }
        if (autoplay) void speech.openaiPlay(props.message.id, content, options).catch(handleAutoplayTtsError)
        else speech.openaiToggle(props.message.id, content, options)
        return
    }
    if (voiceSettings.provider.value === 'custom') {
        if (!voiceSettings.customUrl.value) return
        const options = {
            provider: 'custom' as const,
            baseUrl: voiceSettings.customUrl.value,
            apiKey: voiceSettings.customApiKey.value || undefined,
        }
        if (autoplay) void speech.openaiPlay(props.message.id, content, options).catch(handleAutoplayTtsError)
        else speech.openaiToggle(props.message.id, content, options)
        return
    }
    if (voiceSettings.provider.value === 'edge') {
        const options = {
            provider: 'edge' as const,
            baseUrl: '/api/tts/proxy',
            voice: voiceSettings.edgeVoice.value,
            rate: speedToEdgeRate(voiceSettings.edgeRate.value),
            pitch: hzToEdgePitch(voiceSettings.edgePitchHz.value),
        }
        if (autoplay) void speech.openaiPlay(props.message.id, content, options).catch(handleAutoplayTtsError)
        else speech.openaiToggle(props.message.id, content, options)
        return
    }
    if (voiceSettings.provider.value === 'mimo') {
        const apiKey = voiceSettings.mimoApiKey.value
        const options = {
            baseUrl: voiceSettings.mimoBaseUrl.value,
            apiKey: apiKey || undefined,
            authMode: voiceSettings.mimoAuthMode.value,
            model: voiceSettings.mimoModel.value,
            voiceMode: voiceSettings.mimoModel.value === 'mimo-v2.5-tts-voicedesign' ? 'voiceDesign' as const : voiceSettings.mimoModel.value === 'mimo-v2.5-tts-voiceclone' ? 'voiceClone' as const : 'preset' as const,
            voice: voiceSettings.mimoVoice.value,
            voiceDesignDesc: voiceSettings.mimoVoiceDesignDesc.value || undefined,
            voiceCloneDataUri: voiceSettings.mimoVoiceCloneDataUri.value || undefined,
            voiceCloneFormat: voiceSettings.mimoVoiceCloneFormat.value,
            stylePrompt: voiceSettings.mimoStylePrompt.value || undefined,
        }
        if (autoplay) void speech.mimoPlay(props.message.id, content, options).catch(handleAutoplayTtsError)
        else speech.mimoToggle(props.message.id, content, options)
        return
    }
    if (voiceSettings.provider.value === 'doubao') {
        const options = {
            provider: 'doubao' as const,
            baseUrl: voiceSettings.doubaoBaseUrl.value,
            model: voiceSettings.doubaoModel.value,
            voice: voiceSettings.doubaoVoice.value,
            stylePrompt: voiceSettings.doubaoStylePrompt.value || undefined,
            speed: voiceSettings.doubaoSpeed.value || undefined,
        }
        if (autoplay) void speech.openaiPlay(props.message.id, content, options).catch(handleAutoplayTtsError)
        else speech.openaiToggle(props.message.id, content, options)
        return
    }
    if (isServerTtsProvider(voiceSettings.provider.value)) {
        const options = {
            provider: voiceSettings.provider.value,
        }
        if (autoplay) void speech.openaiPlay(props.message.id, content, options).catch(handleAutoplayTtsError)
        else speech.openaiToggle(props.message.id, content, options)
        return
    }
    if (voiceSettings.provider.value === 'webspeech') {
        speech.toggleBrowser(props.message.id, content, {
            voiceName: voiceSettings.webspeechVoice.value || undefined,
        })
        return
    }
    if (autoplay) speech.enqueue(props.message.id, content)
    else speech.toggle(props.message.id, content)
}

function handleSpeechToggle() {
    if (canPlaySpeech.value) playSpeech(displayBody.value)
}

async function copyBubbleContent() {
    const text = copyableContent.value
    if (!text) return
    const ok = await copyTextToClipboard(text)
    if (ok) toast.success(t('chat.copiedBubble'))
    else toast.error(t('chat.copyFailed'))
}

function referenceBubbleContent() {
    const content = quotableContent.value
    const roomId = groupChatStore.currentRoomId
    if (!content || !roomId) return
    const role = props.message.role === 'assistant' || isAgent.value ? 'assistant' : 'user'
    groupChatStore.setMessageReference(roomId, {
        id: props.message.id,
        role,
        content,
        sender: props.message.senderName || props.message.senderId,
        senderId: props.message.senderId,
    })
}

function isImage(type: string): boolean {
    return type.startsWith('image/')
}

function isVideo(type: string, name: string): boolean {
    return type.startsWith('video/') || /\.(?:mp4|mov|m4v|webm)$/i.test(name)
}

function attachmentPath(attachment: { path?: string; url?: string }): string | null {
    if (attachment.path) return attachment.path
    try {
        return new URL(attachment.url || '', window.location.origin).searchParams.get('path')
    } catch {
        return null
    }
}

function isStoredGroupAttachment(attachment: { path?: string; url?: string }): boolean {
    const rawPath = String(attachment.path || '').trim()
    if (rawPath) {
        const path = rawPath.split(/[?#]/, 1)[0].split(/[\\/]/).pop() || ''
        return /^[a-f0-9]{32}(?:\.[a-z0-9]{1,12})?$/i.test(path)
    }
    return /\/api\/studio\/group-chat\/(?:rooms|invites)\/[^/?#]+\/attachments\/[^/?#]+/i.test(String(attachment.url || ''))
}

function handleAttachmentClick(event: MouseEvent, attachment: { name: string; size?: number; path?: string; url?: string }): void {
    if (!isPreviewableFile(attachment.name)) return
    if (isStoredGroupAttachment(attachment) && attachment.url) {
        const previewEvent = new CustomEvent('hermes:preview-group-attachment', {
            cancelable: true,
            detail: {
                sourceUrl: attachment.url,
                fileName: attachment.name,
                size: Number(attachment.size || 0),
            },
        })
        window.dispatchEvent(previewEvent)
        if (previewEvent.defaultPrevented) event.preventDefault()
        return
    }
    const path = attachmentPath(attachment)
    if (!path) return
    const previewEvent = new CustomEvent('hermes:preview-workspace-file', {
        cancelable: true,
        detail: { path, fileName: attachment.name },
    })
    window.dispatchEvent(previewEvent)
    if (previewEvent.defaultPrevented) event.preventDefault()
}

function normalizeLocalFilePath(path: string): string {
    return /^[a-zA-Z]:\\/.test(path) ? path.replace(/\\/g, '/') : path
}

function formatSize(bytes: number): string {
    if (bytes < 1024) return bytes + ' B'
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB'
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB'
}

let autoPlayHandler: ((e: Event) => void) | null = null

onMounted(() => {
    if (!props.allowSpeech) return
    autoPlayHandler = (e: Event) => {
        const event = e as CustomEvent<{ messageId: string; content: string; profile?: string }>
        if (event.detail?.messageId === props.message.id && canPlaySpeech.value) {
            playSpeech(event.detail.content || displayBody.value, true, event.detail.profile)
        }
    }
    window.addEventListener('auto-play-speech', autoPlayHandler)
})

onBeforeUnmount(() => {
    clearStreamingMarkdownTimer()
    if (autoPlayHandler) window.removeEventListener('auto-play-speech', autoPlayHandler)
    if (speech.currentMessageId.value === props.message.id || speech.currentCustomMessageId.value === props.message.id) speech.stop()
})
</script>

<template>
    <div v-if="message.taskPlan" class="group-task-plan-container">
        <TaskPlanCard class="group-task-plan-card" :plan="message.taskPlan" />
    </div>
    <div v-else-if="isToolMessage" class="group-message tool-message" :class="{ embedded }">
        <div class="msg-body">
            <div v-if="!embedded" class="msg-header">
                <GroupAgentMessageAvatar
                    v-if="isAgent && agentInfo"
                    :agent="agentInfo"
                    :owner="agentOwnerInfo"
                    :mentionable="!!activeAgentInfo"
                    :size="22"
                    @mention="emit('mentionAgent', $event)"
                />
                <ProfileAvatar v-else :name="avatarDisplayName" :avatar="currentAvatar" :size="22" />
                <span class="sender-name">{{ message.senderName }}</span>
                <GroupAgentRobotIcon v-if="isAgent" class="sender-agent-icon" />
                <span v-if="isAgent && agentInfo?.description" class="agent-desc">{{ agentInfo.description }}</span>
            </div>
            <div class="tool-line" :class="{ expandable: hasToolDetails }" @click="hasToolDetails && (toolExpanded = !toolExpanded)">
                <svg
                    v-if="hasToolDetails"
                    width="10"
                    height="10"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="2"
                    class="tool-chevron"
                    :class="{ rotated: toolExpanded }"
                >
                    <polyline points="9 18 15 12 9 6" />
                </svg>
                <svg v-else width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" class="tool-icon">
                    <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" />
                </svg>
                <span class="tool-name">{{ message.toolName || message.tool_name || 'tool' }}</span>
                <span v-if="message.toolPreview && !toolExpanded" class="tool-preview">{{ message.toolPreview }}</span>
                <span v-if="message.toolStatus === 'running'" class="tool-spinner"></span>
                <span v-if="message.toolStatus === 'error'" class="tool-error-badge">{{ t('chat.error') }}</span>
                <span v-if="message.toolStatus === 'interrupted'" class="tool-interrupted-badge">{{ t('chat.toolResultUnavailable') }}</span>
            </div>
            <div v-if="toolExpanded && hasToolDetails" class="tool-details" @click="handleToolDetailClick">
                <div v-if="message.reasoning?.trim()" class="tool-detail-section">
                    <div class="tool-detail-label">{{ t('chat.thinkingLabel') }}</div>
                    <div class="tool-detail-reasoning">
                        <MarkdownRenderer :content="message.reasoning" />
                    </div>
                </div>
                <div v-if="formattedToolArgs" class="tool-detail-section" data-copy-source="tool-args">
                    <div class="tool-detail-label">{{ t('chat.arguments') }}</div>
                    <div class="tool-detail-code-block" v-html="renderedToolArgs"></div>
                </div>
                <div v-if="formattedToolResult" class="tool-detail-section" data-copy-source="tool-result">
                    <div class="tool-detail-label">{{ t('chat.result') }}</div>
                    <div class="tool-detail-code-block" v-html="renderedToolResult"></div>
                </div>
            </div>
            <span v-if="!embedded" class="msg-time">{{ timeStr }}</span>
        </div>
    </div>
    <div v-else class="group-message" :class="{ agent: isAgent, self: isSelf, embedded }">
        <div class="msg-body">
            <div v-if="!embedded" class="msg-header">
                <GroupAgentMessageAvatar
                    v-if="isAgent && agentInfo"
                    :agent="agentInfo"
                    :owner="agentOwnerInfo"
                    :mentionable="!!activeAgentInfo"
                    :size="22"
                    @mention="emit('mentionAgent', $event)"
                />
                <ProfileAvatar v-else :name="avatarDisplayName" :avatar="currentAvatar" :size="22" />
                <span class="sender-name">{{ message.senderName }}</span>
                <GroupAgentRobotIcon v-if="isAgent" class="sender-agent-icon" />
                <span v-if="isAgent && agentInfo?.description" class="agent-desc">{{ agentInfo.description }}</span>
            </div>
            <div
                class="msg-content"
                :class="{
                    'agent-content': isAgent,
                    'agent-error': isAgentError,
                    'speech-playing': isPlayingThisMessage && !isPausedThisMessage,
                }"
            >
                <div v-if="hasAttachments" class="msg-attachments">
                    <div
                        v-for="att in renderedAttachments"
                        :key="att.id"
                        class="msg-attachment"
                        :class="{
                            image: isImage(att.type),
                            video: message.role === 'user' && isVideo(att.type, att.name),
                        }"
                    >
                        <img v-if="isImage(att.type)" :src="att.url" :alt="att.name" class="msg-attachment-thumb" @click="previewUrl = att.url" />
                        <template v-else-if="message.role === 'user' && isVideo(att.type, att.name)">
                            <video
                                class="msg-attachment-video"
                                :src="att.url"
                                controls
                                playsinline
                                preload="metadata"
                            ></video>
                            <div class="msg-attachment-video-footer">
                                <span class="att-name">{{ att.name }}</span>
                                <span v-if="att.size" class="att-size">{{ formatSize(att.size) }}</span>
                            </div>
                        </template>
                        <a v-else class="msg-attachment-file" :href="att.url" :title="t('download.downloadFile')" @click="handleAttachmentClick($event, att)">
                            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                                <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                                <polyline points="14 2 14 8 20 8" />
                            </svg>
                            <span class="att-name">{{ att.name }}</span>
                            <span class="att-size">{{ formatSize(att.size) }}</span>
                        </a>
                    </div>
                </div>
                <div v-if="hasThinking" class="thinking-block" :class="{ expanded: thinkingExpanded }">
                    <div class="thinking-header" @click="thinkingOverride = !thinkingExpanded">
                        <svg
                            width="10"
                            height="10"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            stroke-width="2"
                            class="thinking-chevron"
                            :class="{ rotated: thinkingExpanded }"
                        >
                            <polyline points="9 18 15 12 9 6" />
                        </svg>
                        <span class="thinking-icon">💭</span>
                        <span class="thinking-label">
                            {{ thinkingStreamingNow ? t('chat.thinkingInProgress') : t('chat.thinkingLabel') }}
                        </span>
                        <span class="thinking-meta">· {{ t('chat.thinkingChars', { count: thinkingCharCount }) }}</span>
                    </div>
                    <div v-if="thinkingExpanded" class="thinking-body">
                        <MarkdownRenderer :content="thinkingFullText" />
                    </div>
                </div>
                <template v-if="parsedMessageReference">
                    <MarkdownRenderer :content="referencedContentMarkdown" :mention-names="mentionNames" :resolve-image-url="resolveGroupImageUrl" />
                    <MarkdownRenderer v-if="parsedMessageReference.reply" :content="parsedMessageReference.reply" :mention-names="mentionNames" :resolve-image-url="resolveGroupImageUrl" />
                </template>
                <MarkdownRenderer v-else-if="renderedDisplayBody" :content="renderedDisplayBody" :mention-names="mentionNames" :resolve-image-url="resolveGroupImageUrl" :defer-images="!!message.isStreaming" />
                <ToolChangeCard
                    v-for="change in assistantWorkspaceChanges"
                    :key="change.change_id"
                    class="assistant-workspace-change"
                    :files="change.files || []"
                    :files-changed="change.files_changed || 0"
                    :additions="change.additions || 0"
                    :deletions="change.deletions || 0"
                    :expanded="isWorkspaceChangeExpanded(change.change_id)"
                    :selected-file-id="selectedWorkspaceDiffFileId"
                    :title="t('chat.changesThisTurn')"
                    @toggle="toggleWorkspaceChange(change.change_id)"
                    @select="file => openWorkspaceDiffFileForPayload(file, change)"
                />
                <span v-if="message.isStreaming && !renderedDisplayBody" class="streaming-dots">
                    <span></span><span></span><span></span>
                </span>
            </div>
            <div class="message-meta">
                <button
                    v-if="canPlaySpeech"
                    type="button"
                    class="speech-bubble-btn"
                    :class="{ playing: isPlayingThisMessage, paused: isPausedThisMessage }"
                    :title="isPlayingThisMessage ? (isPausedThisMessage ? t('chat.resumeSpeech') : t('chat.pauseSpeech')) : t('chat.playSpeech')"
                    @click="handleSpeechToggle"
                >
                    <svg v-if="!isPlayingThisMessage || isPausedThisMessage" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="5 3 19 12 5 21 5 3"/></svg>
                    <svg v-else width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>
                </button>
                <button
                    v-if="copyableContent"
                    type="button"
                    class="copy-bubble-btn"
                    :title="t('chat.copyBubble')"
                    @click="copyBubbleContent"
                >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <rect x="9" y="9" width="13" height="13" rx="2" ry="2"/>
                        <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
                    </svg>
                </button>
                <button
                    v-if="quotableContent"
                    type="button"
                    class="reference-bubble-btn"
                    :title="t('chat.referenceMessage')"
                    @click="referenceBubbleContent"
                >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                        <path d="M9 17l-5-5 5-5" />
                        <path d="M20 18v-2a4 4 0 0 0-4-4H4" />
                    </svg>
                </button>
                <span v-if="!embedded" class="message-time">{{ timeStr }}</span>
            </div>
        </div>
    </div>
    <ImagePreviewOverlay
        v-if="previewUrl"
        :src="previewUrl"
        alt=""
        @close="previewUrl = null"
    />
</template>

<style scoped lang="scss">
@use "@/styles/variables" as *;

.group-task-plan-container {
    display: flow-root;
    width: 100%;
    min-width: 0;
}

.group-task-plan-card {
    width: calc(100% - 10px);
    max-width: none;
    margin: 5px;
}

.group-message {
    display: flex;
    padding: 2px 0;
    min-width: 0;
    max-width: 100%;
    box-sizing: border-box;

    &.self {
        flex-direction: row-reverse;

        .msg-body {
            align-items: flex-end;
        }

        .msg-header {
            flex-direction: row-reverse;
        }
    }

    &.agent .msg-content.agent-content {
        background-color: rgba(var(--accent-primary-rgb), 0.06);
    }

    &.agent .msg-content.agent-error {
        color: $error;
        background-color: rgba(var(--error-rgb), 0.06);
        border: 1px solid rgba(var(--error-rgb), 0.2);

        :deep(.markdown-body),
        :deep(.markdown-body p),
        :deep(.markdown-body li),
        :deep(.markdown-body strong),
        :deep(.markdown-body code) {
            color: $error;
        }
    }

    &.self .msg-content {
        background-color: rgba(var(--accent-primary-rgb), 0.06);
    }

    &.embedded {
        width: 100%;
        padding: 0;
        gap: 0;

        .msg-body {
            width: 100%;
            max-width: 100%;
        }

        .msg-content,
        &.agent .msg-content.agent-content,
        &.self .msg-content {
            background: transparent;
            border: 0;
            border-radius: 0;
            padding: 8px 10px;
        }

        .message-meta {
            padding-inline: 10px;
        }
    }
}

.tool-message {
    align-items: flex-start;

    &.embedded {
        padding: 4px 8px;
    }
}

.tool-line {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 2px 4px;
    border-radius: $radius-sm;
    color: $text-muted;
    font-size: 11px;
    min-width: 0;
    max-width: 100%;
    box-sizing: border-box;

    &.expandable {
        cursor: pointer;

        &:hover {
            background: rgba(0, 0, 0, 0.03);
        }
    }
}

.tool-interrupted-badge {
    flex: 0 0 auto;
    color: $text-muted;
    font-size: 10px;
}

.tool-chevron {
    flex-shrink: 0;
    transition: transform 0.15s ease;

    &.rotated {
        transform: rotate(90deg);
    }
}

.tool-icon,
.tool-chevron {
    flex: 0 0 auto;
    opacity: 0.75;
}

.tool-name {
    flex: 0 1 auto;
    min-width: 0;
    font-family: $font-code;
    color: $text-muted;
    font-weight: 400;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}

.tool-preview {
    display: block;
    flex: 1 1 auto;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    max-width: min(400px, 100%);
}

.tool-spinner {
    width: 10px;
    height: 10px;
    border: 1.5px solid $text-muted;
    border-top-color: transparent;
    border-radius: 50%;
    animation: spin 0.6s linear infinite;
    flex-shrink: 0;
}

.tool-error-badge {
    font-size: 9px;
    color: $error;
    background: rgba(var(--error-rgb), 0.08);
    padding: 0 4px;
    border-radius: 3px;
    line-height: 14px;
    margin-inline-start: 4px;
}

.tool-details {
    margin-inline-start: 16px;
    margin-top: 2px;
    border-inline-start: 2px solid $border-light;
    padding-inline-start: 10px;
}

.assistant-workspace-change {
    margin-top: 10px;
}

.tool-detail-section {
    margin-bottom: 6px;
}

.tool-detail-label {
    margin-bottom: 2px;
    color: $text-muted;
    font-size: 10px;
    font-weight: 600;
    letter-spacing: 0.3px;
    text-transform: uppercase;
}

.tool-detail-code-block {
    :deep(.hljs-code-block) {
        margin: 0;
    }

    :deep(.code-header) {
        background: rgba(0, 0, 0, 0.02);
    }

    :deep(code.hljs) {
        font-size: 11px;
        max-height: 300px;
        overflow-y: auto;
        white-space: pre-wrap;
        word-break: break-word;
    }
}

.tool-detail-reasoning {
    max-height: 300px;
    overflow-y: auto;
    padding: 8px 10px;
    border: 1px solid $border-light;
    border-radius: $radius-sm;
    background: rgba(var(--text-primary-rgb), 0.035);
    color: $text-secondary;
    font-size: 12px;

    :deep(.markdown-body > :first-child) {
        margin-top: 0;
    }

    :deep(.markdown-body > :last-child) {
        margin-bottom: 0;
    }
}

@keyframes spin {
    to {
        transform: rotate(360deg);
    }
}

.msg-body {
    display: flex;
    flex-direction: column;
    min-width: min(500px, 100%);
    max-width: 85%;
    box-sizing: border-box;
}

.msg-header {
    display: flex;
    align-items: center;
    gap: 6px;
    padding-bottom: 6px;
    color: $text-secondary;
    font-size: 12px;
    line-height: 22px;

    .sender-name {
        min-width: 0;
        max-width: 240px;
        overflow: hidden;
        color: inherit;
        font-size: inherit;
        font-weight: 400;
        text-overflow: ellipsis;
        white-space: nowrap;
    }

    .sender-agent-icon {
        flex: 0 0 auto;
        width: 14px;
        height: 14px;
    }

    .agent-desc {
        font-size: 11px;
        color: $text-muted;
        font-style: italic;
    }
}

.msg-time,
.message-time {
    font-size: 12px;
    color: var(--text-muted);
    opacity: 0.6;
    user-select: none;
}

.message-meta {
    display: flex;
    align-items: center;
    gap: 6px;
    margin-top: 4px;
    padding: 0 4px;
    padding-bottom: 4px;
    color: $text-muted;
    opacity: 1;
}

@media (hover: hover) and (pointer: fine) {
    .group-message.self .message-meta {
        opacity: 0;
        transition: opacity 0.15s ease;
    }

    .group-message.self:hover .message-meta,
    .group-message.self:focus-within .message-meta {
        opacity: 1;
    }
}

.copy-bubble-btn,
.reference-bubble-btn,
.speech-bubble-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 24px;
    height: 24px;
    border: none;
    background: transparent;
    color: inherit;
    cursor: pointer;
    border-radius: $radius-sm;
    padding: 0;
    transition: color 0.15s ease, background 0.15s ease;

    &:hover {
        color: $text-secondary;
        background: rgba(0, 0, 0, 0.06);
    }

}

.speech-bubble-btn {
    &.playing {
        color: var(--accent-primary);
        animation: pulse 1.5s ease-in-out infinite;

        &.paused {
            animation: none;
            opacity: 0.6;
        }
    }
}

@keyframes rainbow-glow {
    0% {
        box-shadow:
            0 0 0 2px #ff6b6b,
            0 0 10px rgba(255, 107, 107, 0.4),
            0 0 20px rgba(255, 107, 107, 0.2);
    }
    16.66% {
        box-shadow:
            0 0 0 2px #feca57,
            0 0 10px rgba(254, 202, 87, 0.4),
            0 0 20px rgba(254, 202, 87, 0.2);
    }
    33.33% {
        box-shadow:
            0 0 0 2px #48dbfb,
            0 0 10px rgba(72, 219, 251, 0.4),
            0 0 20px rgba(72, 219, 251, 0.2);
    }
    50% {
        box-shadow:
            0 0 0 2px #ff9ff3,
            0 0 10px rgba(255, 159, 243, 0.4),
            0 0 20px rgba(255, 159, 243, 0.2);
    }
    66.66% {
        box-shadow:
            0 0 0 2px #54a0ff,
            0 0 10px rgba(84, 160, 255, 0.4),
            0 0 20px rgba(84, 160, 255, 0.2);
    }
    83.33% {
        box-shadow:
            0 0 0 2px #5f27cd,
            0 0 10px rgba(95, 39, 205, 0.4),
            0 0 20px rgba(95, 39, 205, 0.2);
    }
    100% {
        box-shadow:
            0 0 0 2px #ff6b6b,
            0 0 10px rgba(255, 107, 107, 0.4),
            0 0 20px rgba(255, 107, 107, 0.2);
    }
}

.group-message:not(.embedded) .msg-content {
    min-width: min(500px, 100%);
}

.msg-content {
    padding: 10px 14px;
    font-size: var(--font-size-base);
    line-height: 1.65;
    color: $text-primary;
    border-radius: 10px;
    background-color: $msg-user-bg;
    min-width: 0;
    max-width: 100%;
    box-sizing: border-box;
    word-break: break-word;
    overflow-wrap: anywhere;

    &.speech-playing {
        box-shadow:
            0 0 0 2px #ff6b6b,
            0 0 10px rgba(255, 107, 107, 0.4),
            0 0 20px rgba(255, 107, 107, 0.2);
        animation: rainbow-glow 4s linear infinite;
    }

    &.agent-error {
        color: $error;
        background-color: rgba(var(--error-rgb), 0.06);
        border: 1px solid rgba(var(--error-rgb), 0.2);

        :deep(.markdown-body),
        :deep(.markdown-body p),
        :deep(.markdown-body li),
        :deep(.markdown-body strong),
        :deep(.markdown-body code) {
            color: $error;
        }
    }

    :deep(.mention-highlight) {
        color: #409eff;
        font-weight: 600;
        cursor: default;
    }
}

:global(html.theme-has-custom-background .group-message:not(.embedded) .msg-content:not(.agent-error)),
:global(html.theme-has-custom-background .group-message.agent:not(.embedded) .msg-content.agent-content:not(.agent-error)),
:global(html.theme-has-custom-background .group-message.self:not(.embedded) .msg-content:not(.agent-error)) {
    background-color: rgba(var(--bg-main-surface-rgb), 0.78);
    border: 1px solid rgba(var(--text-primary-rgb), 0.18);
    -webkit-backdrop-filter: blur(8px) saturate(110%);
    backdrop-filter: blur(8px) saturate(110%);
}

.msg-attachments {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    margin-bottom: 8px;
}

.msg-attachment {
    border-radius: $radius-sm;
    overflow: hidden;
    background-color: $bg-secondary;
    border: 1px solid $border-color;

    &.image {
        width: 96px;
        height: 96px;
    }

    &.video {
        width: min(360px, 100%);
        background: #000;
    }
}

.msg-attachment-thumb {
    width: 100%;
    height: 100%;
    object-fit: cover;
    display: block;
    cursor: zoom-in;
}

.msg-attachment-video {
    display: block;
    width: 100%;
    aspect-ratio: 16 / 9;
    max-height: 280px;
    background: #000;
    object-fit: contain;
}

.msg-attachment-video-footer {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 7px 10px;
    color: $text-secondary;
    background: $bg-secondary;
    font-size: 12px;

    .att-name {
        min-width: 0;
        flex: 1;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
    }

    .att-size {
        flex-shrink: 0;
        color: $text-muted;
        font-size: 11px;
    }
}

.msg-attachment-file {
    display: flex;
    align-items: center;
    gap: 6px;
    min-width: 140px;
    max-width: 220px;
    padding: 8px 10px;
    color: $text-secondary;
    text-decoration: none;

    .att-name {
        flex: 1;
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        font-size: 12px;
    }

    .att-size {
        font-size: 11px;
        color: $text-muted;
    }
}

.thinking-block {
    margin-bottom: 8px;
    padding: 4px 0;
    border-bottom: 1px dashed $border-light;

    .thinking-header {
        display: flex;
        align-items: center;
        gap: 6px;
        font-size: 11px;
        color: $text-muted;
        cursor: pointer;
        padding: 2px 4px;
        border-radius: $radius-sm;
        user-select: none;

        &:hover {
            background: rgba(0, 0, 0, 0.03);
        }
    }

    .thinking-chevron {
        flex-shrink: 0;
        transition: transform 0.15s ease;

        &.rotated {
            transform: rotate(90deg);
        }
    }

    .thinking-icon {
        font-size: 11px;
        flex-shrink: 0;
    }

    .thinking-label {
        font-weight: 500;
        flex-shrink: 0;
    }

    .thinking-meta {
        color: $text-muted;
        font-variant-numeric: tabular-nums;
    }

    .thinking-body {
        margin-top: 6px;
        padding: 6px 10px;
        border-inline-start: 2px solid $border-light;
        font-size: 13px;
        opacity: 0.85;
        font-style: italic;

        :deep(p) {
            margin: 0.3em 0;
        }
    }
}

.streaming-dots {
    display: flex;
    gap: 4px;
    padding: 4px 0;

    span {
        width: 6px;
        height: 6px;
        background-color: $text-muted;
        border-radius: 50%;
        animation: pulse 1.4s infinite ease-in-out;

        &:nth-child(2) { animation-delay: 0.2s; }
        &:nth-child(3) { animation-delay: 0.4s; }
    }
}

@keyframes pulse {
    0%,
    80%,
    100% {
        opacity: 0.3;
        transform: scale(0.8);
    }
    40% {
        opacity: 1;
        transform: scale(1);
    }
}
@media (max-width: $breakpoint-mobile) {
    .group-message .msg-body {
        min-width: 0;
        width: 100%;
        max-width: 100%;
    }

    .group-message:not(.embedded) .msg-content {
        min-width: 0;
        width: 100%;
    }

    .group-message.embedded {
        .msg-content,
        &.agent .msg-content.agent-content,
        &.self .msg-content {
            padding: 10px 14px;
        }
    }
}
</style>
