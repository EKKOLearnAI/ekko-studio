<script setup lang="ts">
import { ref, computed, nextTick, onMounted, onUnmounted, watch, h } from 'vue'
import { useI18n } from 'vue-i18n'
import { NButton, NDropdown, NTooltip, type DropdownOption } from 'naive-ui'
import { useGroupChatStore } from '@/stores/hermes/group-chat'
import { useSettingsStore } from '@/stores/hermes/settings'
import { useToolTraceVisibility } from '@/composables/useToolTraceVisibility'
import { extractClipboardFiles } from '@/utils/clipboard-files'
import ImagePreviewOverlay from '@/components/hermes/chat/ImagePreviewOverlay.vue'
import { buildMentionOptions, type MentionOption } from './mention-options'
import type { GroupChatMention } from '@/api/studio/group-chat'
import type { Attachment } from '@/stores/hermes/chat'
import { clampChatInputHeight, isMobileChatInputViewport } from '@/utils/chat-input-height'
import VoiceDialogueControls from '@/components/hermes/chat/VoiceDialogueControls.vue'
import { normalizeComposerVoiceTranscript, useComposerVoiceInput } from '@/composables/useComposerVoiceInput'
import {
    clearGroupChatRoomDraft,
    loadGroupChatRoomDraft,
    saveGroupChatRoomDraft,
    type GroupChatTrackedMention,
} from './group-chat-room-drafts'

const { t } = useI18n()
const props = withDefaults(defineProps<{
    roomId?: string | null
    sendBlocked?: boolean
    allowAttachments?: boolean
    showSettings?: boolean
    allowAllMention?: boolean
}>(), {
    roomId: null,
    sendBlocked: false,
    allowAttachments: true,
    showSettings: true,
    allowAllMention: false,
})
const emit = defineEmits<{
    send: [content: string, attachments?: Attachment[], mentions?: GroupChatMention[]]
    'send-blocked': []
}>()
const store = useGroupChatStore()
const settingsStore = useSettingsStore()
const { toolTraceVisible, toggleToolTraceVisible } = useToolTraceVisibility()

const inputText = ref('')
const mentions = ref<GroupChatTrackedMention[]>([])
const previousInputText = ref('')
const textareaRef = ref<HTMLTextAreaElement>()
const dropdownRef = ref<HTMLDivElement>()
const fileInputRef = ref<HTMLInputElement>()
const attachments = ref<Attachment[]>([])
const previewAttachment = ref<Attachment | null>(null)
const isSending = ref(false)
const pendingSendRoomId = ref<string | null>(null)
const isDragging = ref(false)
const dragCounter = ref(0)
const isComposing = ref(false)
const activeMessageReference = computed(() => store.activeMessageReference)
const messageReferencePreview = computed(() =>
    activeMessageReference.value?.content.replace(/\s+/g, ' ').trim() || '',
)
const autoPlaySpeech = ref(false)
const inputSettingsOptions = computed<DropdownOption[]>(() => [
    {
        label: t('chat.autoPlaySpeech'),
        key: 'autoPlaySpeech',
        icon: () => h('span', {
            class: ['settings-check', { active: autoPlaySpeech.value }],
            'aria-hidden': 'true',
        }, autoPlaySpeech.value ? '✓' : ''),
    },
    {
        label: t('chat.showToolCalls'),
        key: 'toolTrace',
        icon: () => h('span', {
            class: ['settings-check', { active: toolTraceVisible.value }],
            'aria-hidden': 'true',
        }, toolTraceVisible.value ? '✓' : ''),
    },
])
const isMobileViewport = ref(typeof window !== 'undefined' ? isMobileChatInputViewport(window.innerWidth) : false)
const manualTextareaResize = ref(false)
const configuredTextareaHeight = computed(() =>
    isMobileViewport.value ? null : clampChatInputHeight(settingsStore.display.chat_input_height),
)

onMounted(() => {
    if (props.showSettings) {
        const saved = localStorage.getItem('autoPlaySpeech')
        if (saved !== null) {
            autoPlaySpeech.value = saved === 'true'
            store.setAutoPlaySpeech(autoPlaySpeech.value)
        }
    } else {
        autoPlaySpeech.value = false
        store.setAutoPlaySpeech(false)
    }
    syncViewport()
    window.addEventListener('resize', syncViewport)
    nextTick(() => {
        applyConfiguredTextareaHeight()
    })
})

watch(autoPlaySpeech, (value) => {
    localStorage.setItem('autoPlaySpeech', String(value))
    store.setAutoPlaySpeech(value)
})

function handleInputSettingsSelect(key: string | number) {
    if (key === 'autoPlaySpeech') {
        autoPlaySpeech.value = !autoPlaySpeech.value
        return
    }

    if (key === 'toolTrace') {
        toggleToolTraceVisible()
    }
}

watch(configuredTextareaHeight, () => {
    applyConfiguredTextareaHeight()
})

watch(() => settingsStore.display.chat_input_height, () => {
    manualTextareaResize.value = false
    applyConfiguredTextareaHeight()
})

watch(
    () => activeMessageReference.value?.id,
    (id) => {
        if (!id) return
        const reference = activeMessageReference.value
        const senderId = reference?.senderId?.trim() || ''
        const agent = store.agents.find(candidate => senderId && (candidate.agentId === senderId || candidate.id === senderId))
        const isSelf = !!senderId && senderId === store.userId
        if (agent && !isSelf && !mentions.value.some(mention => mention.type === 'agent' && mention.participantId === agent.agentId)) {
            insertStructuredMention({
                type: 'agent',
                participantId: agent.agentId,
                displayName: agent.name,
            })
            store.emitTyping()
        }
        nextTick(() => textareaRef.value?.focus())
    },
)

function clearMessageReference() {
    const roomId = store.currentRoomId
    if (roomId) store.clearMessageReference(roomId)
    textareaRef.value?.focus()
}

// 自定义高度拖拽
const textareaHeight = ref<number | null>(null)
const inputWrapperStyle = computed(() => {
    const height = textareaHeight.value ?? configuredTextareaHeight.value
    if (height === null) return {}
    return { minHeight: `${height + 63}px` }
})

function syncViewport() {
  if (typeof window === 'undefined') return
  isMobileViewport.value = isMobileChatInputViewport(window.innerWidth)
}

function resetTextareaHeight() {
    manualTextareaResize.value = false
    applyConfiguredTextareaHeight()
}

function autoSizeTextarea(el: HTMLTextAreaElement | undefined = textareaRef.value) {
    if (!el || textareaHeight.value !== null) return
    el.style.height = 'auto'
    el.style.height = Math.min(el.scrollHeight, 100) + 'px'
}

function applyConfiguredTextareaHeight() {
    if (manualTextareaResize.value) return

    textareaHeight.value = configuredTextareaHeight.value

    const textarea = textareaRef.value
    if (!textarea) return

    if (textareaHeight.value === null) {
        autoSizeTextarea(textarea)
        return
    }

    textarea.style.height = `${textareaHeight.value}px`
}

function startResize(e: MouseEvent) {
  e.preventDefault()
  const el = textareaRef.value
  if (!el) return
  manualTextareaResize.value = true
  const startHeight = el.clientHeight
  const startY = e.clientY

  function onMouseMove(e: MouseEvent) {
    const deltaY = e.clientY - startY
    const newHeight = startHeight - deltaY
    textareaHeight.value = clampChatInputHeight(newHeight) ?? textareaHeight.value
  }

  function onMouseUp() {
    document.removeEventListener('mousemove', onMouseMove)
    document.removeEventListener('mouseup', onMouseUp)
    document.body.style.cursor = ''
    document.body.style.userSelect = ''
  }

  document.body.style.cursor = 'row-resize'
  document.body.style.userSelect = 'none'
  document.addEventListener('mousemove', onMouseMove)
  document.addEventListener('mouseup', onMouseUp)
}

// ─── Mention State ───────────────────────────────────────

const mentionActive = ref(false)
const mentionQuery = ref('')
const mentionStartIndex = ref(-1)
const dropdownX = ref(0)
const dropdownY = ref(0)
const dropdownBottom = ref(0)
const placement = ref<'bottom' | 'top'>('bottom')
const activeIndex = ref(0)

const filteredMentionOptions = computed(() => buildMentionOptions(
    store.agents,
    mentionQuery.value,
    props.allowAllMention,
    t('groupChat.allAgents'),
))

const canSend = computed(() => !!inputText.value.trim() || (props.allowAttachments && attachments.value.length > 0))

function resetTransientComposerState() {
    previewAttachment.value = null
    for (const attachment of attachments.value) URL.revokeObjectURL(attachment.url)
    attachments.value = []
    mentionActive.value = false
    mentionStartIndex.value = -1
    mentionQuery.value = ''
}

function restoreRoomDraft(roomId: string | null) {
    resetTransientComposerState()
    const draft = roomId ? loadGroupChatRoomDraft(roomId) : null
    inputText.value = draft?.text || ''
    mentions.value = draft?.mentions.map(mention => ({ ...mention })) || []
    previousInputText.value = inputText.value
    nextTick(() => {
        autoSizeTextarea()
    })
}

watch(
    () => props.roomId,
    roomId => restoreRoomDraft(roomId),
    { immediate: true },
)

watch(
    [inputText, mentions],
    () => {
        if (!props.roomId) return
        saveGroupChatRoomDraft(props.roomId, {
            text: inputText.value,
            mentions: mentions.value,
        })
    },
    { deep: true, flush: 'sync' },
)

// ─── Scroll active item into view ──────────────────────

function scrollToActive() {
    nextTick(() => {
        if (!dropdownRef.value) return
        const active = dropdownRef.value.querySelector('.active') as HTMLElement | null
        if (active) active.scrollIntoView({ block: 'nearest', behavior: 'instant' })
    })
}

// ─── Mention Logic ───────────────────────────────────────

function updateMentionState() {
    const el = textareaRef.value
    if (!el) { mentionActive.value = false; return }

    const text = inputText.value
    const cursorPos = el.selectionStart

    // Find the last @ before the cursor
    let atPos = -1
    for (let i = cursorPos - 1; i >= 0; i--) {
        if (text[i] === '@') { atPos = i; break }
        if (text[i] === ' ' || text[i] === '\n') break
    }

    if (atPos === -1) {
        mentionActive.value = false
        return
    }

    // Make sure the @ is not part of a word (preceded by space or start of line)
    // Using /\w/ which matches [a-zA-Z0-9_]; CJK/punctuation/emoji are not \w so they work as delimiters
    if (atPos > 0 && /\w/.test(text[atPos - 1])) {
        mentionActive.value = false
        return
    }

    const query = text.slice(atPos + 1, cursorPos)
    if (query.includes(' ')) {
        mentionActive.value = false
        return
    }

    mentionQuery.value = query
    mentionStartIndex.value = atPos
    activeIndex.value = 0

    // Calculate dropdown position using mirror span
    const mirror = document.createElement('span')
    const style = getComputedStyle(el)
    const props = ['fontFamily', 'fontSize', 'fontWeight', 'letterSpacing', 'textTransform', 'wordSpacing', 'textIndent', 'border', 'padding', 'boxSizing', 'lineHeight']
    props.forEach(p => { (mirror.style as any)[p] = style[p as any] })
    mirror.style.position = 'absolute'
    mirror.style.visibility = 'hidden'
    mirror.style.whiteSpace = 'nowrap'
    mirror.textContent = text.slice(0, atPos + 1)

    const rect = el.getBoundingClientRect()
    document.body.appendChild(mirror)
    const mirrorRect = mirror.getBoundingClientRect()
    document.body.removeChild(mirror)

    dropdownX.value = rect.left + mirrorRect.width - el.scrollLeft

    // Decide placement: if dropdown would go below viewport, flip upward
    const estimatedHeight = Math.min(filteredMentionOptions.value.length * 36 + 8, 240)
    const spaceBelow = window.innerHeight - rect.top + el.scrollTop - 8
    if (spaceBelow < estimatedHeight && rect.top - el.scrollTop - 8 > estimatedHeight) {
        placement.value = 'top'
        dropdownY.value = rect.top - el.scrollTop - 8
    } else {
        placement.value = 'bottom'
        dropdownY.value = rect.top - el.scrollTop - 8
    }

    dropdownBottom.value = window.innerHeight - dropdownY.value

    mentionActive.value = filteredMentionOptions.value.length > 0
}

function selectMention(option: MentionOption) {
    if (isSending.value) return
    const el = textareaRef.value
    if (!el || mentionStartIndex.value === -1) return

    const before = inputText.value.slice(0, mentionStartIndex.value)
    replaceInputRange(mentionStartIndex.value, el.selectionStart, `@${option.name} `, option)
    mentionActive.value = false

    nextTick(() => {
        if (el) {
            const newPos = before.length + option.name.length + 2
            el.setSelectionRange(newPos, newPos)
            el.focus()
            autoSizeTextarea(el)
        }
    })
}

function insertMention(name: string, participantId?: string) {
    if (isSending.value) return
    const mentionName = String(name || '').trim()
    if (!mentionName) return

    const el = textareaRef.value
    const selectionStart = el?.selectionStart ?? inputText.value.length
    const selectionEnd = el?.selectionEnd ?? selectionStart
    const before = inputText.value.slice(0, selectionStart)
    const after = inputText.value.slice(selectionEnd)
    const leadingSpace = before && !/\s$/.test(before) ? ' ' : ''
    const trailingSpace = after && /^\s/.test(after) ? '' : ' '
    const inserted = `${leadingSpace}@${mentionName}${trailingSpace}`
    const matchingAgents = store.agents.filter(agent => agent.name === mentionName)
    const identifiedAgent = participantId
        ? matchingAgents.find(agent => agent.agentId === participantId)
        : matchingAgents.length === 1
            ? matchingAgents[0]
            : undefined
    replaceInputRange(
        selectionStart,
        selectionEnd,
        inserted,
        identifiedAgent
            ? { type: 'agent', participantId: identifiedAgent.agentId, displayName: identifiedAgent.name }
            : undefined,
    )
    mentionActive.value = false
    mentionStartIndex.value = -1
    mentionQuery.value = ''
    store.emitTyping()

    nextTick(() => {
        if (!el) return
        const existingWhitespaceOffset = !trailingSpace && /^[ \t]/.test(after) ? 1 : 0
        const nextPosition = before.length + inserted.length + existingWhitespaceOffset
        el.setSelectionRange(nextPosition, nextPosition)
        el.focus()
        autoSizeTextarea(el)
    })
}

function normalizeMention(mention: GroupChatMention | MentionOption): GroupChatMention | null {
    const displayName = 'displayName' in mention ? mention.displayName : mention.name
    const normalized: GroupChatMention = mention.type === 'all'
        ? { type: 'all', displayName: 'all' }
        : {
            type: 'agent',
            participantId: mention.participantId,
            displayName,
        }
    if (!normalized.displayName || (normalized.type === 'agent' && !normalized.participantId)) return null
    return normalized
}

function replaceInputRange(start: number, end: number, replacement: string, mention?: GroupChatMention | MentionOption) {
    const before = inputText.value
    const delta = replacement.length - (end - start)
    mentions.value = mentions.value
        .filter(candidate => candidate.end <= start || candidate.start >= end)
        .map(candidate => candidate.start >= end
            ? { ...candidate, start: candidate.start + delta, end: candidate.end + delta }
            : candidate)
    inputText.value = `${before.slice(0, start)}${replacement}${before.slice(end)}`
    previousInputText.value = inputText.value

    const normalized = mention ? normalizeMention(mention) : null
    if (normalized) {
        const tokenEnd = start + `@${normalized.displayName}`.length
        mentions.value.push({ ...normalized, start, end: tokenEnd })
    }
}

function insertVoiceTranscriptIntoInput(text: string) {
    if (isSending.value) return
    const transcript = normalizeComposerVoiceTranscript(text)
    if (!transcript) return
    const el = textareaRef.value
    const selectionStart = el?.selectionStart ?? inputText.value.length
    const selectionEnd = el?.selectionEnd ?? selectionStart
    const before = inputText.value.slice(0, selectionStart)
    const after = inputText.value.slice(selectionEnd)
    const prefix = before && !/\s$/.test(before) ? ' ' : ''
    const suffix = after && !/^\s/.test(after) ? ' ' : ''
    const inserted = `${prefix}${transcript}${suffix}`
    replaceInputRange(selectionStart, selectionEnd, inserted)
    mentionActive.value = false
    store.emitTyping()
    nextTick(() => {
        if (!el) return
        const cursor = selectionStart + prefix.length + transcript.length
        el.focus()
        el.setSelectionRange(cursor, cursor)
        autoSizeTextarea(el)
    })
}

const voiceInput = useComposerVoiceInput({
    insertTranscript: insertVoiceTranscriptIntoInput,
})

function insertStructuredMention(mention: GroupChatMention) {
    if (isSending.value) return
    const normalized = normalizeMention(mention)
    if (!normalized) return
    if (mentions.value.some(candidate =>
        candidate.type === normalized.type &&
        candidate.participantId === normalized.participantId &&
        inputText.value.slice(candidate.start, candidate.end) === `@${normalized.displayName}`,
    )) return
    replaceInputRange(0, 0, `@${normalized.displayName} `, normalized)
}

function syncMentionMetadata() {
    const current = inputText.value
    const previous = previousInputText.value
    let prefix = 0
    while (prefix < previous.length && prefix < current.length && previous[prefix] === current[prefix]) prefix += 1
    let suffix = 0
    while (
        suffix < previous.length - prefix &&
        suffix < current.length - prefix &&
        previous[previous.length - suffix - 1] === current[current.length - suffix - 1]
    ) suffix += 1
    const previousChangedEnd = previous.length - suffix
    const delta = current.length - previous.length
    mentions.value = mentions.value
        .filter(mention => mention.end <= prefix || mention.start >= previousChangedEnd)
        .map(mention => mention.start >= previousChangedEnd
            ? { ...mention, start: mention.start + delta, end: mention.end + delta }
            : mention)
        .filter(mention => current.slice(mention.start, mention.end) === `@${mention.displayName}`)
    previousInputText.value = current
}

// ─── Event Handlers ──────────────────────────────────────

function handleKeydown(e: KeyboardEvent) {
    // Mention navigation — fully custom, no NDropdown interference
    if (mentionActive.value && filteredMentionOptions.value.length > 0) {
        if (e.key === 'ArrowDown') {
            e.preventDefault()
            activeIndex.value = (activeIndex.value + 1) % filteredMentionOptions.value.length
            scrollToActive()
            return
        }
        if (e.key === 'ArrowUp') {
            e.preventDefault()
            activeIndex.value = (activeIndex.value - 1 + filteredMentionOptions.value.length) % filteredMentionOptions.value.length
            scrollToActive()
            return
        }
        if (e.key === 'Enter' || e.key === 'Tab') {
            e.preventDefault()
            selectMention(filteredMentionOptions.value[activeIndex.value])
            return
        }
        if (e.key === 'Escape') {
            e.preventDefault()
            mentionActive.value = false
            return
        }
    }

    if (e.key !== 'Enter' || e.shiftKey) return
    if (isComposing.value || e.isComposing || e.keyCode === 229) return
    e.preventDefault()
    handleSend()
}

function handleSend() {
    if (isSending.value) return
    const content = inputText.value.trim()
    if (!content && attachments.value.length === 0) return
    if (props.sendBlocked) {
        emit('send-blocked')
        return
    }

    const structuredMentions = mentions.value.map(({ start: _start, end: _end, ...mention }) => mention)
    isSending.value = true
    pendingSendRoomId.value = props.roomId
    emit('send', content, attachments.value.length > 0 ? attachments.value : undefined, structuredMentions.length ? structuredMentions : undefined)
}

function completeSend(success: boolean) {
    if (!isSending.value) return
    const submittedRoomId = pendingSendRoomId.value
    isSending.value = false
    pendingSendRoomId.value = null
    if (!success) return

    if (submittedRoomId) clearGroupChatRoomDraft(submittedRoomId)
    if (props.roomId !== submittedRoomId) return
    inputText.value = ''
    mentions.value = []
    previousInputText.value = ''
    resetTransientComposerState()
}

function handleInput(e: Event) {
    store.emitTyping()
    syncMentionMetadata()
    if (!isComposing.value) {
        updateMentionState()
    }

    // 用户手动拖拽自定义高度时，不覆盖
    if (textareaHeight.value !== null) return
    const el = e.target as HTMLTextAreaElement
    autoSizeTextarea(el)
}

function handleMentionClick(option: MentionOption) {
    selectMention(option)
}

function handleMentionHover(index: number) {
    activeIndex.value = index
}

// ─── Click outside to close dropdown ─────────────────

function onDocumentMousedown(e: MouseEvent) {
    if (!mentionActive.value) return
    const target = e.target as HTMLElement
    if (!target.closest('.mention-dropdown')) {
        mentionActive.value = false
    }
}

onMounted(() => {
    document.addEventListener('mousedown', onDocumentMousedown)
})

onUnmounted(() => {
    document.removeEventListener('mousedown', onDocumentMousedown)
    window.removeEventListener('resize', syncViewport)
})

function handleCompositionStart() {
    isComposing.value = true
}

function handleCompositionEnd() {
    requestAnimationFrame(() => {
        isComposing.value = false
        updateMentionState()
    })
}

function addFile(file: File) {
    if (isSending.value || !props.allowAttachments) return
    if (attachments.value.find(a => a.name === file.name)) return
    const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
    attachments.value.push({
        id,
        name: file.name,
        type: file.type,
        size: file.size,
        url: URL.createObjectURL(file),
        file,
    })
}

function addFiles(files: File[]) {
    for (const file of files) addFile(file)
    if (files.length > 0) textareaRef.value?.focus()
}

function handleAttachClick() {
    if (!props.allowAttachments) return
    fileInputRef.value?.click()
}

function handleFileChange(e: Event) {
    const input = e.target as HTMLInputElement
    if (!input.files) return
    addFiles(Array.from(input.files))
    input.value = ''
}

function handlePaste(e: ClipboardEvent) {
    if (!props.allowAttachments) return
    const files = extractClipboardFiles(e.clipboardData)
    if (!files.length) return
    e.preventDefault()
    addFiles(files)
}

function handleDragOver(e: DragEvent) {
    if (!props.allowAttachments) return
    e.preventDefault()
}

function handleDragEnter(e: DragEvent) {
    if (!props.allowAttachments) return
    e.preventDefault()
    if (e.dataTransfer?.types.includes('Files')) {
        dragCounter.value++
        isDragging.value = true
    }
}

function handleDragLeave() {
    dragCounter.value--
    if (dragCounter.value <= 0) {
        dragCounter.value = 0
        isDragging.value = false
    }
}

function handleDrop(e: DragEvent) {
    if (!props.allowAttachments) return
    e.preventDefault()
    dragCounter.value = 0
    isDragging.value = false
    addFiles(Array.from(e.dataTransfer?.files || []))
}

defineExpose({ addFiles, insertMention, handleSend, completeSend })

function removeAttachment(id: string) {
    if (isSending.value) return
    const idx = attachments.value.findIndex(a => a.id === id)
    if (idx !== -1) {
        if (previewAttachment.value?.id === id) previewAttachment.value = null
        URL.revokeObjectURL(attachments.value[idx].url)
        attachments.value.splice(idx, 1)
    }
}

function formatSize(bytes: number): string {
    if (bytes < 1024) return bytes + ' B'
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB'
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB'
}

function isImage(type: string): boolean {
    return type.startsWith('image/')
}

function openAttachmentPreview(attachment: Attachment) {
    if (!isImage(attachment.type)) return
    previewAttachment.value = attachment
}
</script>

<template>
    <div class="chat-input-area">
        <div v-if="attachments.length > 0" class="attachment-previews">
            <div v-for="att in attachments" :key="att.id" class="attachment-preview" :class="{ image: isImage(att.type) }">
                <button
                    v-if="isImage(att.type)"
                    type="button"
                    class="attachment-thumb-button"
                    :aria-label="att.name"
                    @click="openAttachmentPreview(att)"
                >
                    <img :src="att.url" :alt="att.name" class="attachment-thumb" />
                </button>
                <div v-else class="attachment-file">
                    <span class="file-name">{{ att.name }}</span>
                    <span class="file-size">{{ formatSize(att.size) }}</span>
                </div>
                <button class="attachment-remove" @click="removeAttachment(att.id)">
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                </button>
            </div>
        </div>
        <ImagePreviewOverlay
            v-if="previewAttachment"
            :src="previewAttachment.url"
            :alt="previewAttachment.name"
            @close="previewAttachment = null"
        />
        <div v-if="activeMessageReference" class="message-reference-preview">
            <span class="message-reference-text">{{ messageReferencePreview }}</span>
            <button
                type="button"
                class="message-reference-remove"
                :aria-label="t('chat.cancelReference')"
                :title="t('chat.cancelReference')"
                @click.stop="clearMessageReference"
            >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <line x1="18" y1="6" x2="6" y2="18" />
                    <line x1="6" y1="6" x2="18" y2="18" />
                </svg>
            </button>
        </div>
        <div
            class="input-wrapper"
            :class="{ 'drag-over': isDragging }"
            :style="inputWrapperStyle"
            @dragover="handleDragOver"
            @dragenter="handleDragEnter"
            @dragleave="handleDragLeave"
            @drop="handleDrop"
        >
            <input v-if="props.allowAttachments" ref="fileInputRef" type="file" multiple class="file-input-hidden" @change="handleFileChange" />
            <div class="resize-handle" :title="t('chat.inputHeightResizeHint')" @mousedown="startResize" @dblclick="resetTextareaHeight"></div>
            <textarea
                ref="textareaRef"
                v-model="inputText"
                class="input-textarea"
                :style="textareaHeight ? { height: textareaHeight + 'px' } : {}"
                :placeholder="t('groupChat.inputPlaceholder')"
                rows="1"
                :readonly="isSending"
                @keydown="handleKeydown"
                @compositionstart="handleCompositionStart"
                @compositionend="handleCompositionEnd"
                @input="handleInput"
                @paste="handlePaste"
            />
            <div class="input-toolbar">
                <div class="input-top-bar">
                    <NTooltip v-if="props.allowAttachments" trigger="hover" :disabled="isMobileViewport">
                        <template #trigger>
                            <NButton quaternary size="tiny" circle class="toolbar-icon-button" @click="handleAttachClick">
                                <template #icon>
                                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M12 5v14"/><path d="M5 12h14"/></svg>
                                </template>
                            </NButton>
                        </template>
                        {{ t('chat.attachFiles') }}
                    </NTooltip>
                    <NDropdown
                        v-if="props.showSettings"
                        trigger="click"
                        :options="inputSettingsOptions"
                        :show-arrow="true"
                        @select="handleInputSettingsSelect"
                    >
                        <NTooltip trigger="hover" :disabled="isMobileViewport">
                            <template #trigger>
                                <NButton quaternary size="tiny" class="input-settings-button" :aria-label="t('sidebar.settings')">
                                    <template #icon>
                                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
                                            <circle cx="12" cy="12" r="3"/>
                                            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.6 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06A2 2 0 1 1 7.04 4.3l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51h.08a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9c.2.6.77 1 1.4 1H21a2 2 0 1 1 0 4h-.09c-.63 0-1.2.4-1.51 1Z"/>
                                        </svg>
                                    </template>
                                    <span class="input-settings-label">{{ t('sidebar.settings') }}</span>
                                    <svg class="toolbar-chevron" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m6 9 6 6 6-6"/></svg>
                                </NButton>
                            </template>
                            {{ t('sidebar.settings') }}
                        </NTooltip>
                    </NDropdown>
                </div>
                <div class="input-actions">
                    <VoiceDialogueControls
                        :status="voiceInput.dialogue.status.value"
                        :transcript="voiceInput.transcript.value"
                        :error="voiceInput.error.value"
                        :events="voiceInput.dialogue.events.value"
                        :on-start="voiceInput.start"
                        :on-stop="voiceInput.stop"
                        :on-cancel="voiceInput.cancel"
                    />
                    <NButton
                        size="medium"
                        type="primary"
                        circle
                        class="send-button"
                        :disabled="!canSend || isSending"
                        :aria-label="t('chat.send')"
                        @click="handleSend"
                    >
                        <template #icon>
                            <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5"/><path d="m5 12 7-7 7 7"/></svg>
                        </template>
                        <span class="visually-hidden">{{ t('chat.send') }}</span>
                    </NButton>
                </div>
            </div>
        </div>
        <Transition name="dropdown-fade">
            <div
                v-if="mentionActive && filteredMentionOptions.length > 0"
                ref="dropdownRef"
                class="mention-dropdown"
                :class="{ 'placement-top': placement === 'top' }"
                :style="{
                    left: dropdownX + 'px',
                    top: placement === 'bottom' ? dropdownY + 'px' : 'auto',
                    bottom: placement === 'top' ? dropdownBottom + 'px' : 'auto',
                }"
            >
                <div
                    v-for="(option, i) in filteredMentionOptions"
                    :key="option.key"
                    class="mention-dropdown-item"
                    :class="{ active: i === activeIndex, 'mention-all-option': option.type === 'all' }"
                    @mousedown.prevent="handleMentionClick(option)"
                    @mouseenter="handleMentionHover(i)"
                >
                    <span class="mention-name">{{ option.label }}</span>
                    <span class="mention-profile">{{ option.description }}</span>
                </div>
            </div>
        </Transition>
    </div>
</template>

<style scoped lang="scss">
@use "@/styles/variables" as *;

.chat-input-area {
    padding: 6px 12px 10px;
    border-top: 0;
    background-color: $bg-main-surface;
    flex-shrink: 0;
}

.input-top-bar {
    display: flex;
    align-items: center;
    gap: 7px;
    min-width: 0;
    flex: 1;
    padding: 0;
}

.auto-play-speech-switch {
    display: flex;
    align-items: center;
    gap: 5px;
    padding-inline-start: 2px;
    margin-inline-start: 0;

    .switch-label {
        display: flex;
        align-items: center;
        justify-content: center;
        width: 16px;
        height: 16px;
        color: #999999;
    }
}

.tool-trace-toggle {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    color: #999999;
    width: 24px;
    min-width: 24px;
    height: 22px;
    margin-inline-start: 0;
    padding: 0;
    background: transparent !important;

    :deep(.n-button__state-border),
    :deep(.n-button__border),
    :deep(.n-button__ripple) {
        display: none;
    }

    .tool-trace-icon {
        display: block;
        width: 16px;
        height: 16px;
    }
}

.input-settings-button {
    color: $text-secondary;
    border-radius: 999px;
    padding: 0 7px 0 6px;

    :deep(.n-button__content) {
        gap: 4px;
    }

    :deep(.n-button__state-border),
    :deep(.n-button__border),
    :deep(.n-button__ripple) {
        display: none;
    }
}

.toolbar-chevron {
    flex: 0 0 12px;
    color: $text-muted;
}

.attachment-previews {
    width: 100%;
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    padding: 0 0 10px;
}

.attachment-preview {
    position: relative;
    border-radius: $radius-sm;
    overflow: hidden;
    background-color: $bg-secondary;
    border: 1px solid $border-color;

    &.image {
        width: 112px;
        height: 72px;
    }
}

.attachment-thumb {
    display: block;
    width: 100%;
    height: 100%;
    object-fit: contain;
}

.attachment-thumb-button {
    display: block;
    width: 100%;
    height: 100%;
    padding: 0;
    border: 0;
    background:
        linear-gradient(45deg, rgba(127, 127, 127, 0.08) 25%, transparent 25%),
        linear-gradient(-45deg, rgba(127, 127, 127, 0.08) 25%, transparent 25%),
        linear-gradient(45deg, transparent 75%, rgba(127, 127, 127, 0.08) 75%),
        linear-gradient(-45deg, transparent 75%, rgba(127, 127, 127, 0.08) 75%);
    background-position: 0 0, 0 6px, 6px -6px, -6px 0;
    background-size: 12px 12px;
    cursor: zoom-in;
}

.attachment-file {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 2px;
    padding: 8px 12px;
    min-width: 80px;
    max-width: 140px;
    color: $text-secondary;

    .file-name {
        font-size: 11px;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        max-width: 100%;
    }

    .file-size {
        font-size: 10px;
        color: $text-muted;
    }
}

.attachment-remove {
    position: absolute;
    top: 2px;
    right: 2px;
    width: 18px;
    height: 18px;
    border-radius: 50%;
    border: none;
    background: rgba(0, 0, 0, 0.5);
    color: var(--text-on-overlay);
    display: flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
    opacity: 0;
    transition: opacity $transition-fast;

    .attachment-preview:hover & {
        opacity: 1;
    }
}

.file-input-hidden {
    display: none;
}

.typing-dots {
    display: inline-flex;
    align-items: center;
    gap: 2px;

    span {
        display: block;
        width: 4px;
        height: 4px;
        border-radius: 50%;
        background-color: $text-muted;
        animation: typing-bounce 1.2s infinite;

        &:nth-child(2) { animation-delay: 0.2s; }
        &:nth-child(3) { animation-delay: 0.4s; }
    }
}

@keyframes typing-bounce {
    0%, 60%, 100% { transform: translateY(0); opacity: 0.4; }
    30% { transform: translateY(-3px); opacity: 1; }
}

.message-reference-preview {
    display: flex;
    align-items: center;
    gap: 10px;
    min-width: 0;
    margin: 0 8px 8px;
    padding: 4px 8px;
    border-radius: 8px;
    background: rgba(var(--accent-primary-rgb), 0.07);
    cursor: default;
}

.message-reference-text {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    color: $text-secondary;
    font-size: 12px;
    line-height: 24px;
    text-overflow: ellipsis;
    white-space: nowrap;
}

.message-reference-remove {
    display: flex;
    align-items: center;
    justify-content: center;
    flex: 0 0 24px;
    width: 24px;
    height: 24px;
    padding: 0;
    border: 0;
    border-radius: 7px;
    background: transparent;
    color: $text-muted;
    cursor: pointer;

    &:hover {
        color: $text-primary;
        background: rgba(var(--text-primary-rgb), 0.08);
    }
}

.input-wrapper {
    display: flex;
    flex-direction: column;
    align-items: stretch;
    gap: 8px;
    width: 100%;
    min-height: 150px;
    background-color: $bg-card;
    border: 1px solid var(--input-border-color);
    border-radius: $radius-md;
    padding: 12px 10px 8px;
    position: relative;
    box-shadow: 0 8px 28px rgba(0, 0, 0, 0.08);
    transition: border-color $transition-fast, box-shadow $transition-fast;

    &:focus-within {
        border-color: var(--input-border-focus-color);
        box-shadow: 0 10px 32px rgba(0, 0, 0, 0.11);
    }

    &:hover:not(:focus-within) {
        border-color: var(--input-border-hover-color);
    }

    &.drag-over {
        border-color: $accent-primary;
        background-color: rgba(var(--accent-primary-rgb), 0.04);
    }

    .dark & {
        background-color: $bg-main-surface;
        box-shadow: 0 8px 28px rgba(0, 0, 0, 0.32);
    }
}

.resize-handle {
    position: absolute;
    top: -4px;
    left: 0;
    right: 0;
    height: 8px;
    cursor: row-resize;
    z-index: 2;

    &:hover {
        background: rgba($accent-primary, 0.15);
        border-radius: 4px;
    }
}

.input-textarea {
    display: block;
    flex: 1;
    width: 100%;
    background: none;
    border: none;
    outline: none;
    color: $text-primary;
    font-family: $font-ui;
    font-size: 14px;
    line-height: 1.5;
    resize: none;
    max-height: 400px;
    min-height: 24px;
    padding: 0;
    overflow-y: auto;

    @media (max-width: 768px) {
        font-size: 16px;
    }

    &::placeholder {
        color: var(--input-placeholder-color);
        opacity: 1;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
    }
}

.input-actions {
    display: flex;
    gap: 7px;
    flex-shrink: 0;
    align-items: center;
}

.input-toolbar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    min-height: 32px;
}

.toolbar-icon-button {
    color: $text-muted;
}

.send-button {
    width: 30px !important;
    min-width: 30px !important;
    height: 30px !important;
    padding: 0 !important;
    border: 0 !important;
    box-shadow: none !important;

    :deep(.n-button__icon) {
        margin: 0 !important;
    }

    :deep(.n-button__content) {
        display: none;
    }

    :deep(.n-button__border),
    :deep(.n-button__state-border),
    :deep(.n-button__ripple),
    :deep(.n-base-wave) {
        display: none;
    }

    &:disabled {
        color: var(--text-on-overlay);
        background-color: #9f9f9f;
        opacity: 1;
    }
}

.visually-hidden {
    position: absolute;
    width: 1px;
    height: 1px;
    padding: 0;
    margin: -1px;
    overflow: hidden;
    clip: rect(0, 0, 0, 0);
    white-space: nowrap;
    border: 0;
}

@media (max-width: 768px) {
    .chat-input-area {
        padding: 6px 8px calc(12px + env(safe-area-inset-bottom, 0px));
    }

    .input-top-bar {
        gap: 5px;
    }

    .auto-play-speech-switch {
        display: none;
    }
}

/* ── Custom mention dropdown (replaces NDropdown) ── */

.mention-dropdown {
    position: fixed;
    background: $bg-card;
    border: 1px solid $border-color;
    border-radius: 8px;
    box-shadow: 0 4px 16px rgba(0, 0, 0, 0.3);
    min-width: 200px;
    max-height: 240px;
    overflow-y: auto;
    z-index: 9999;
    padding: 4px;
}

.mention-dropdown-item {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: 8px 12px;
    border-radius: 6px;
    cursor: pointer;
    transition: background 0.1s;

    &:hover,
    &.active {
        background: rgba(var(--text-primary-rgb), 0.08);
    }

    .mention-name {
        color: $text-primary;
        font-size: 14px;
        font-weight: 500;
    }

    .mention-profile {
        color: $text-muted;
        font-size: 12px;
    }

    &.mention-all-option .mention-name {
        color: $accent-primary;
        font-weight: 600;
    }
}

/* ── Dropdown fade/scale animation (matching NDropdown) ── */

.dropdown-fade-enter-active {
    transition: opacity 0.2s cubic-bezier(0, 0, .2, 1), transform 0.2s cubic-bezier(0, 0, .2, 1);
    transform-origin: top;
}
.dropdown-fade-leave-active {
    transition: opacity 0.2s cubic-bezier(.4, 0, 1, 1), transform 0.2s cubic-bezier(.4, 0, 1, 1);
    transform-origin: top;
}
.dropdown-fade-enter-from,
.dropdown-fade-leave-to {
    opacity: 0;
    transform: scale(0.9);
}
.placement-top.dropdown-fade-enter-active,
.placement-top.dropdown-fade-leave-active {
    transform-origin: bottom;
}

@media (max-width: 768px) {
    .input-wrapper {
        min-height: 96px;
        gap: 6px;
        padding: 8px 10px;
    }

    .input-textarea {
        flex: 1 1 auto;
    }

    .input-settings-button {
        min-width: 36px;
        padding: 0 4px 0 6px;

        :deep(.n-button__content) {
            gap: 2px;
        }

        :deep(.n-button__icon) {
            margin: 0;
        }
    }

    .input-settings-label {
        display: none;
    }

    .input-textarea::placeholder {
        font-size: 13px;
        line-height: 1.35;
    }
}
</style>
