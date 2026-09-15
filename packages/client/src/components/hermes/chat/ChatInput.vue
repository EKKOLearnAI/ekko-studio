<script setup lang="ts">
import type { Attachment } from '@/stores/hermes/chat'
import { useChatStore } from '@/stores/hermes/chat'
import { useChatAnnotationsStore } from '@/stores/hermes/chat-annotations'
import ResponseAnnotationComposer from './ResponseAnnotationComposer.vue'
import { useAppStore } from '@/stores/hermes/app'
import { useProfilesStore } from '@/stores/hermes/profiles'
import { useSettingsStore } from '@/stores/hermes/settings'
import { fetchContextLength } from '@/api/studio/sessions'
import { setModelContext } from '@/api/hermes/model-context'
import { fetchSocialMessagePlatforms } from '@/api/studio/social-messages'
import { fetchSkills, type SkillCategory, type SkillInfo } from '@/api/hermes/skills'
import { deleteSkillBundleApi, fetchSkillBundles, type SkillBundleInfo } from '@/api/hermes/skill-bundles'
import { NButton, NTooltip, NModal, NInputNumber, NPopover, NSlider, NDropdown, useDialog, useMessage, type DropdownOption } from 'naive-ui'
import { computed, ref, nextTick, onMounted, onUnmounted, watch, h } from 'vue'
import { useI18n } from 'vue-i18n'
import { useToolTraceVisibility } from '@/composables/useToolTraceVisibility'
import { extractClipboardFiles } from '@/utils/clipboard-files'
import VoiceDialogueControls from './VoiceDialogueControls.vue'
import BundleCreateModal from './BundleCreateModal.vue'
import { BRIDGE_SESSION_COMMAND_DEFINITIONS } from '@/utils/hermes/bridge-session-commands'
import { clampChatInputHeight, isMobileChatInputViewport } from '@/utils/chat-input-height'
import { normalizeComposerVoiceTranscript, useComposerVoiceInput } from '@/composables/useComposerVoiceInput'
import { extractRepresentativeVideoFrames, isVideoFile } from '@/utils/video-frame-extraction'
import ImagePreviewOverlay from './ImagePreviewOverlay.vue'

const chatStore = useChatStore()
const annotationsStore = useChatAnnotationsStore()
const appStore = useAppStore()
const profilesStore = useProfilesStore()
const settingsStore = useSettingsStore()
const { t } = useI18n()
const message = useMessage()
const dialog = useDialog()
const { toolTraceVisible, toggleToolTraceVisible } = useToolTraceVisibility()

const props = withDefaults(defineProps<{
  modelLabel?: string
  modelDisabled?: boolean
  initialText?: string
  persistDraft?: boolean
}>(), {
  modelLabel: '',
  modelDisabled: false,
  initialText: '',
  persistDraft: true,
})

const emit = defineEmits<{
  modelClick: []
  voiceClick: []
}>()

const reasoningEffortOptions = computed(() => [
  { label: t('chat.reasoningEffort.options.default'), value: '' },
  { label: t('chat.reasoningEffort.options.none'), value: 'none' },
  { label: t('chat.reasoningEffort.options.minimal'), value: 'minimal' },
  { label: t('chat.reasoningEffort.options.low'), value: 'low' },
  { label: t('chat.reasoningEffort.options.medium'), value: 'medium' },
  { label: t('chat.reasoningEffort.options.high'), value: 'high' },
  { label: t('chat.reasoningEffort.options.xhigh'), value: 'xhigh' },
  { label: t('chat.reasoningEffort.options.max'), value: 'max' },
])
const currentReasoningEffort = computed<string>(() =>
  chatStore.activeSession?.reasoningEffort || ''
)
const reasoningEffortSliderValue = computed(() => {
  const index = reasoningEffortOptions.value.findIndex(option => option.value === currentReasoningEffort.value)
  return index >= 0 ? index : 0
})
const reasoningEffortAccentColors = [
  '#94a3b8',
  '#2ac8e9',
  '#2bd9b4',
  '#4ed786',
  '#b9d93a',
  '#f9c33c',
  '#f77734',
  '#ef4444',
] as const
const reasoningEffortAccentStyle = computed(() => ({
  '--reasoning-effort-accent-color': reasoningEffortAccentColors[reasoningEffortSliderValue.value]
    || reasoningEffortAccentColors[0],
}))
const isMoaSession = computed(() => chatStore.activeSession?.provider === 'moa')
const isGlobalCodingAgentSession = computed(() =>
  chatStore.activeSession?.codingAgentMode === 'global'
)
const reasoningEffortLabel = computed<string>(() => {
  const v = currentReasoningEffort.value
  if (!v) return t('chat.reasoningEffort.defaultLabel')
  const opt = reasoningEffortOptions.value.find(o => o.value === v)
  return opt?.label || v
})
function onReasoningEffortChange(value: string | null | undefined) {
  const sid = chatStore.activeSessionId
  if (!sid) return
  chatStore.setSessionReasoningEffort(sid, value || '')
}
function reasoningEffortSliderLabel(value: number) {
  return reasoningEffortOptions.value[Math.round(value)]?.label || reasoningEffortLabel.value
}
function onReasoningEffortSliderChange(value: number | [number, number]) {
  const numericValue = Array.isArray(value) ? value[0] : value
  const option = reasoningEffortOptions.value[Math.round(numericValue)]
  if (option) onReasoningEffortChange(option.value)
}

function handleModelButtonClick() {
  if (props.modelDisabled) return
  emit('modelClick')
}

const compactModelLabel = computed(() => {
  const label = props.modelLabel || t('models.selectModel')
  const parts = label.split('/').filter(Boolean)
  return parts[parts.length - 1] || label
})

const DRAFT_STORAGE_KEY = 'hermes_chat_input_drafts_v1'
type DraftMap = Record<string, string>
const inputText = ref('')
const textareaRef = ref<HTMLTextAreaElement>()
const commandDropdownRef = ref<HTMLDivElement>()
const fileInputRef = ref<HTMLInputElement>()
const attachments = ref<Attachment[]>([])
const previewAttachment = ref<Attachment | null>(null)
const pendingVideoFrameJobs = new Set<Promise<void>>()
const isPreparingAttachments = ref(false)
let sendAwaitingAttachments = false
const isDragging = ref(false)
const dragCounter = ref(0)
const isComposing = ref(false)
const isSubmitting = ref(false)
const activeMessageReference = computed(() => chatStore.activeMessageReference)
const activeAnnotationSessionId = computed(() => chatStore.activeSessionId || '')
const activeResponseAnnotations = computed(() => activeAnnotationSessionId.value
  ? annotationsStore.annotationsForSession(activeAnnotationSessionId.value) ?? []
  : [])
const responseAnnotationAttachments = computed<Attachment[]>(() => activeResponseAnnotations.value.flatMap(annotation =>
  (annotationsStore.pendingFilesForAnnotation(annotation.id) ?? []).map((file, index) => ({
    id: `annotation-file:${annotation.id}:${index}:${file.name}:${file.size}:${file.lastModified}`,
    name: file.name,
    type: file.type || 'application/octet-stream',
    size: file.size,
    url: '',
    file,
    annotationId: annotation.id,
  })),
))
const messageReferencePreview = computed(() =>
  activeMessageReference.value?.content.replace(/\s+/g, ' ').trim() || '',
)
const isMobileViewport = ref(typeof window !== 'undefined' ? isMobileChatInputViewport(window.innerWidth) : false)
const manualTextareaResize = ref(false)
const configuredTextareaHeight = computed(() =>
  isMobileViewport.value ? null : clampChatInputHeight(settingsStore.display.chat_input_height),
)

type SlashCommandOption = {
  name: string
  args: string
  description: string
  insertText?: string
  key: string
  opensSkillPicker?: boolean
  opensBundlePicker?: boolean
  opensBundleCreator?: boolean
}

function insertVoiceTranscriptIntoInput(text: string) {
  const normalizedTranscript = normalizeComposerVoiceTranscript(text)
  if (!normalizedTranscript) return

  const el = textareaRef.value
  const currentValue = inputText.value
  const selectionStart = el?.selectionStart ?? currentValue.length
  const selectionEnd = el?.selectionEnd ?? selectionStart
  const before = currentValue.slice(0, selectionStart)
  const after = currentValue.slice(selectionEnd)
  const prefix = before && !/\s$/.test(before) ? ' ' : ''
  const suffix = after && !/^\s/.test(after) ? ' ' : ''
  const nextValue = `${before}${prefix}${normalizedTranscript}${suffix}${after}`
  const nextCursorPosition = before.length + prefix.length + normalizedTranscript.length

  inputText.value = nextValue
  slashActive.value = false

  nextTick(() => {
    const textarea = textareaRef.value
    if (!textarea) return

    textarea.focus()
    textarea.setSelectionRange(nextCursorPosition, nextCursorPosition)
    autoSizeTextarea(textarea)
  })
}

function clearMessageReference() {
  const sessionId = chatStore.activeSessionId
  if (sessionId) chatStore.clearMessageReference(sessionId)
  textareaRef.value?.focus()
}

watch(
  () => activeMessageReference.value?.id,
  (id) => {
    if (!id) return
    nextTick(() => textareaRef.value?.focus())
  },
)

const voiceInput = useComposerVoiceInput({
  insertTranscript: insertVoiceTranscriptIntoInput,
})

const CODING_AGENT_SLASH_COMMANDS = ['context', 'compact', 'usage', 'status']

const bridgeCommands = computed<SlashCommandOption[]>(() =>
  BRIDGE_SESSION_COMMAND_DEFINITIONS.map(command => ({
    key: command.key,
    name: command.name,
    args: command.argsKey ? t(command.argsKey) : command.args || '',
    description: t(command.descriptionKey),
    insertText: command.insertText,
    opensSkillPicker: command.opensSkillPicker,
    opensBundlePicker: command.opensBundlePicker,
    opensBundleCreator: command.opensBundleCreator,
  }))
)

const slashActive = ref(false)
const slashQuery = ref('')
const slashActiveIndex = ref(0)
const skillCategories = ref<SkillCategory[]>([])
const showSkillPicker = ref(false)
const skillSearch = ref('')
const skillPickerLoading = ref(false)
let skillsLoadedKey = ''
let skillsLoadRequest: Promise<void> | null = null
const bundles = ref<SkillBundleInfo[]>([])
const showBundlePicker = ref(false)
const showBundleCreator = ref(false)
const bundleSearch = ref('')
const bundlePickerLoading = ref(false)
const deletingBundleCommand = ref('')
let bundlesLoadedKey = ''
let bundlesLoadRequest: Promise<void> | null = null
let bundlesLoadRequestKey = ''
const isBridgeSession = computed(() => {
  const session = chatStore.activeSession
  if (!session) return chatStore.runtimeMode !== 'global_agent'
  return session.source === 'cli'
})
const isCodingAgentSession = computed(() => {
  const session = chatStore.activeSession
  return !!session && (
    session.source === 'coding_agent'
    || !!session.codingAgentId
    || session.agent === 'claude'
    || session.agent === 'codex'
    || session.agent === 'claude-code'
    || session.agent === 'pi'
    || session.agent === 'grok'
    || session.agent === 'opencode'
  )
})
const isForkCommandSession = computed(() => !!chatStore.activeSession && chatStore.activeSession.source !== 'coding_agent')
const skillPickerItems = computed(() => {
  const byName = new Map<string, SkillInfo>()
  for (const category of skillCategories.value) {
    for (const skill of category.skills || []) {
      if (skill.enabled === false) continue
      if (!byName.has(skill.name)) byName.set(skill.name, skill)
    }
  }
  return [...byName.values()].map(skill => {
    const commandName = skillCommandName(skill.name)
    return {
      key: `skill:${commandName}`,
      name: skill.name,
      commandName,
      description: skill.description || skill.name,
    }
  })
})
const filteredBridgeCommands = computed(() => {
  const query = slashQuery.value.trim().toLowerCase()
  const commands = isBridgeSession.value
    ? bridgeCommands.value
    : isCodingAgentSession.value
      ? bridgeCommands.value.filter(command => CODING_AGENT_SLASH_COMMANDS.includes(command.name)
        && !(command.name === 'compact' && (chatStore.activeSession?.codingAgentId === 'opencode' || chatStore.activeSession?.agent === 'opencode')))
      : isForkCommandSession.value
        ? bridgeCommands.value.filter(command => command.name === 'fork')
        : []
  if (!query) return commands
  return commands.filter((command) => {
    const name = command.name.toLowerCase()
    const insertText = command.insertText?.toLowerCase()
    const description = command.description.toLowerCase()
    return name.startsWith(query) || insertText?.startsWith(query) || description.includes(query)
  })
})
const filteredSkillPickerItems = computed(() => {
  const query = skillSearch.value.trim().toLowerCase()
  if (!query) return skillPickerItems.value
  return skillPickerItems.value.filter(skill =>
    skill.name.toLowerCase().includes(query)
    || skill.commandName.includes(query)
    || skill.description.toLowerCase().includes(query),
  )
})
const filteredBundles = computed(() => {
  const query = bundleSearch.value.trim().toLowerCase()
  if (!query) return bundles.value
  return bundles.value.filter(bundle =>
    bundle.name.toLowerCase().includes(query)
    || bundle.commandName.includes(query)
    || bundle.description.toLowerCase().includes(query)
    || bundle.skills.some(skill => skill.toLowerCase().includes(query)),
  )
})

function skillCommandName(name: string) {
  return name
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/_/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
}

function currentSkillsKey() {
  return chatStore.activeSession?.profile || profilesStore.activeProfileName || 'default'
}

async function loadSkills() {
  if (!isBridgeSession.value) return
  const key = currentSkillsKey()
  if (skillsLoadedKey === key || skillsLoadRequest) return skillsLoadRequest
  skillsLoadRequest = (async () => {
    try {
      const data = await fetchSkills(key)
      if (currentSkillsKey() !== key) return
      skillCategories.value = data.categories || []
      skillsLoadedKey = key
    } catch {
      if (currentSkillsKey() !== key) return
      skillCategories.value = []
      skillsLoadedKey = key
    } finally {
      skillsLoadRequest = null
    }
  })()
  return skillsLoadRequest
}

async function loadBundles() {
  if (!isBridgeSession.value) return
  const key = currentSkillsKey()
  if (bundlesLoadedKey === key) return
  if (bundlesLoadRequest && bundlesLoadRequestKey === key) return bundlesLoadRequest
  const request = (async () => {
    try {
      const data = await fetchSkillBundles(key)
      if (currentSkillsKey() !== key) return
      bundles.value = data
      bundlesLoadedKey = key
    } catch {
      if (currentSkillsKey() !== key) return
      bundles.value = []
      bundlesLoadedKey = ''
    } finally {
      if (bundlesLoadRequestKey === key) {
        bundlesLoadRequest = null
        bundlesLoadRequestKey = ''
      }
    }
  })()
  bundlesLoadRequest = request
  bundlesLoadRequestKey = key
  return request
}

// 自定义高度拖拽
const textareaHeight = ref<number | null>(null) // null = auto
const inputWrapperStyle = computed(() => {
  const height = textareaHeight.value ?? configuredTextareaHeight.value
  if (height === null) return {}
  return { minHeight: `${height + 71}px` }
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
  el.style.height = `${Math.min(el.scrollHeight, 100)}px`
}

function focusTextareaFromInputWrapper(event: MouseEvent) {
  if (event.defaultPrevented) return

  const target = event.target instanceof Element ? event.target : null
  if (!target) return

  const interactiveTarget = target.closest([
    'button',
    'input',
    'textarea',
    '[role="button"]',
    '.context-limit-editable',
    '.input-toolbar',
    '.resize-handle',
  ].join(','))

  if (interactiveTarget) return

  textareaRef.value?.focus()
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
  // 如果当前是 auto，用实际 clientHeight 作为起始值
  const startHeight = el.clientHeight
  const startY = e.clientY

  function onMouseMove(e: MouseEvent) {
    const deltaY = e.clientY - startY
    // 往上拖 (deltaY < 0) → 高度增加
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

const inputSettingsOptions = computed<DropdownOption[]>(() => [
  {
    label: t('realtimeVoice.mode'),
    key: 'voiceMode',
    icon: () => h('span', {
      class: 'settings-voice-mode-icon',
      'aria-hidden': 'true',
    }, '◉'),
  },
  {
    label: t('chat.showToolCalls'),
    key: 'toolTrace',
    icon: () => h('span', {
      class: ['settings-check', { active: toolTraceVisible.value }],
      'aria-hidden': 'true',
    }, toolTraceVisible.value ? '✓' : ''),
  },
  {
    label: t('chat.pushEnabled'),
    key: 'pushEnabled',
    disabled: !chatStore.activeSessionId,
    icon: () => h('span', {
      class: ['settings-check', { active: Boolean(chatStore.activeSession?.pushEnabled) }],
      'aria-hidden': 'true',
    }, chatStore.activeSession?.pushEnabled ? '✓' : ''),
  },
])

function readDraftMap(): DraftMap {
  try {
    const parsed = JSON.parse(localStorage.getItem(DRAFT_STORAGE_KEY) || '{}')
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

function getActiveDraftSessionId() {
  return chatStore.activeSessionId || chatStore.activeSession?.id || ''
}

function loadDraftForActiveSession() {
  const sessionId = getActiveDraftSessionId()
  inputText.value = sessionId ? readDraftMap()[sessionId] || '' : ''
}

function saveDraftForActiveSession(value: string) {
  const sessionId = getActiveDraftSessionId()
  if (!sessionId) return
  const drafts = readDraftMap()
  if (value) {
    drafts[sessionId] = value
  } else {
    delete drafts[sessionId]
  }
  if (Object.keys(drafts).length > 0) {
    localStorage.setItem(DRAFT_STORAGE_KEY, JSON.stringify(drafts))
  } else {
    localStorage.removeItem(DRAFT_STORAGE_KEY)
  }
}

// 从 localStorage 读取设置
onMounted(() => {
  if (props.initialText) inputText.value = props.initialText
  else if (props.persistDraft) loadDraftForActiveSession()
  syncViewport()
  window.addEventListener('resize', syncViewport)
  nextTick(() => {
    applyConfiguredTextareaHeight()
    if (props.initialText) focusComposer()
  })
})

async function handleInputSettingsSelect(key: string | number) {
  if (key === 'voiceMode') {
    if (chatStore.activeSessionId) emit('voiceClick')
    return
  }

  if (key === 'toolTrace') {
    toggleToolTraceVisible()
    return
  }

  if (key === 'pushEnabled') {
    const sessionId = chatStore.activeSessionId
    if (!sessionId) return
    const nextEnabled = !Boolean(chatStore.activeSession?.pushEnabled)
    if (nextEnabled) {
      try {
        const platforms = await fetchSocialMessagePlatforms()
        const pushReady = platforms.some(platform => (
          platform.active && platform.configured && platform.pushReady
        ))
        if (!pushReady) {
          message.warning(t('chat.pushNotConfigured'))
          return
        }
      } catch {
        message.warning(t('chat.pushNotConfigured'))
        return
      }
    }
    await chatStore.setSessionPushEnabled(sessionId, nextEnabled)
  }
}

watch(inputText, (value) => {
  if (props.persistDraft) saveDraftForActiveSession(value)
})

watch(() => chatStore.activeSession?.id, () => {
  if (props.persistDraft) loadDraftForActiveSession()
  else inputText.value = props.initialText
  nextTick(() => {
    applyConfiguredTextareaHeight()
  })
})

watch(configuredTextareaHeight, () => {
  applyConfiguredTextareaHeight()
})

watch(() => settingsStore.display.chat_input_height, () => {
  manualTextareaResize.value = false
  applyConfiguredTextareaHeight()
})

watch(
  () => [chatStore.activeSession?.profile, profilesStore.activeProfileName],
  () => {
    skillsLoadedKey = ''
    skillCategories.value = []
    bundlesLoadedKey = ''
    bundles.value = []
  },
)

const canSend = computed(() => !isSubmitting.value && (
  inputText.value.trim().length > 0
  || attachments.value.length > 0
  || activeResponseAnnotations.value.length > 0
))
const sendButtonIsStop = computed(() => chatStore.isStreaming && !canSend.value)

function scrollCommandIntoView() {
  nextTick(() => {
    if (!commandDropdownRef.value) return
    const active = commandDropdownRef.value.querySelector('.active') as HTMLElement | null
    active?.scrollIntoView({ block: 'nearest', behavior: 'instant' })
  })
}

function updateSlashState() {
  if (!isBridgeSession.value && !isCodingAgentSession.value && !isForkCommandSession.value) {
    slashActive.value = false
    return
  }
  const el = textareaRef.value
  if (!el) return
  const cursorPos = el.selectionStart
  const beforeCursor = inputText.value.slice(0, cursorPos)
  if (!beforeCursor.startsWith('/') || beforeCursor.includes(' ') || beforeCursor.includes('\n')) {
    slashActive.value = false
    return
  }
  slashQuery.value = beforeCursor.slice(1)
  slashActiveIndex.value = 0
  slashActive.value = filteredBridgeCommands.value.length > 0
}

function selectBridgeCommand(command: SlashCommandOption) {
  if (command.opensSkillPicker) {
    slashActive.value = false
    void openSkillPicker()
    return
  }
  if (command.opensBundlePicker) {
    slashActive.value = false
    void openBundlePicker()
    return
  }
  if (command.opensBundleCreator) {
    slashActive.value = false
    openBundleCreator()
    return
  }
  inputText.value = `/${command.insertText || command.name} `
  slashActive.value = false
  nextTick(() => {
    const el = textareaRef.value
    if (!el) return
    const pos = inputText.value.length
    el.setSelectionRange(pos, pos)
    el.focus()
  })
}

async function openSkillPicker() {
  if (!isBridgeSession.value) return
  slashActive.value = false
  skillSearch.value = ''
  showSkillPicker.value = true
  skillPickerLoading.value = true
  try {
    await loadSkills()
  } finally {
    skillPickerLoading.value = false
  }
}

function selectSkill(skill: { commandName: string }) {
  inputText.value = `/skill ${skill.commandName} `
  showSkillPicker.value = false
  nextTick(() => {
    const el = textareaRef.value
    if (!el) return
    const pos = inputText.value.length
    el.setSelectionRange(pos, pos)
    el.focus()
  })
}

async function openBundlePicker() {
  if (!isBridgeSession.value) return
  slashActive.value = false
  bundleSearch.value = ''
  showBundlePicker.value = true
  bundlePickerLoading.value = true
  try {
    await loadBundles()
  } finally {
    bundlePickerLoading.value = false
  }
}

function openBundleCreator() {
  if (!isBridgeSession.value) return
  slashActive.value = false
  showBundlePicker.value = false
  showBundleCreator.value = true
}

function selectBundle(bundle: SkillBundleInfo) {
  inputText.value = `/bundles ${bundle.commandName} `
  showBundlePicker.value = false
  nextTick(() => {
    const el = textareaRef.value
    if (!el) return
    const pos = inputText.value.length
    el.setSelectionRange(pos, pos)
    el.focus()
  })
}

function handleBundleCreated(bundle: SkillBundleInfo) {
  showBundleCreator.value = false
  bundlesLoadedKey = ''
  bundles.value = [bundle, ...bundles.value.filter(item => item.commandName !== bundle.commandName)]
  selectBundle(bundle)
}

function confirmDeleteBundle(bundle: SkillBundleInfo) {
  const profile = currentSkillsKey()
  dialog.warning({
    title: t('chat.bundlePicker.deleteTitle'),
    content: t('chat.bundlePicker.deleteConfirm', { name: bundle.name }),
    positiveText: t('common.delete'),
    negativeText: t('common.cancel'),
    onPositiveClick: async () => {
      deletingBundleCommand.value = bundle.commandName
      try {
        await deleteSkillBundleApi(profile, bundle.commandName)
        if (currentSkillsKey() === profile) {
          bundles.value = bundles.value.filter(item => item.commandName !== bundle.commandName)
        } else {
          bundlesLoadedKey = ''
        }
        message.success(t('chat.bundlePicker.deleted'))
      } catch (err: any) {
        message.error(`${t('chat.bundlePicker.deleteFailed')}: ${err?.message || ''}`)
        return false
      } finally {
        deletingBundleCommand.value = ''
      }
    },
  })
}

// --- Context info ---

const contextLength = ref(256000)
const FALLBACK_CONTEXT = 256000
let contextLengthLoadedKey = ''
let contextLengthRequestKey = ''
let contextLengthRequest: Promise<void> | null = null

// Context length editing
const showContextEditModal = ref(false)
const editingContextLimit = ref(256000)
const isSavingContextLimit = ref(false)

async function handleEditContextLimit() {
  editingContextLimit.value = contextLength.value
  showContextEditModal.value = true
}

async function saveContextLimit() {
  if (!editingContextLimit.value || editingContextLimit.value <= 0) {
    message.error(t('chat.contextEditInvalid'))
    return
  }

  isSavingContextLimit.value = true
  try {
    const provider = chatStore.activeSession?.provider || appStore.selectedProvider || ''
    const model = chatStore.activeSession?.model || appStore.selectedModel || ''

    if (!provider || !model) {
      message.error(t('chat.contextEditFailed'))
      return
    }

    await setModelContext(provider, model, editingContextLimit.value)
    contextLength.value = editingContextLimit.value
    contextLengthLoadedKey = currentContextLengthKey()
    showContextEditModal.value = false
    message.success(t('chat.contextEditSuccess'))
  } catch (err: any) {
    message.error(`${t('chat.contextEditFailed')}: ${err.message || ''}`)
  } finally {
    isSavingContextLimit.value = false
  }
}

function currentContextLengthParams() {
  const activeSession = chatStore.activeSession
  return {
    profile: activeSession?.profile || profilesStore.activeProfileName || undefined,
    provider: activeSession?.provider || undefined,
    model: activeSession?.model || undefined,
  }
}

function currentContextLengthKey() {
  const params = currentContextLengthParams()
  return `${params.profile || ''}|${params.provider || ''}|${params.model || ''}`
}

async function loadContextLength() {
  const key = currentContextLengthKey()
  if (key === contextLengthLoadedKey) return
  if (key === contextLengthRequestKey && contextLengthRequest) return contextLengthRequest

  contextLengthRequestKey = key
  contextLengthRequest = (async () => {
    const params = currentContextLengthParams()
    try {
      const value = await fetchContextLength(params.profile, params.provider, params.model)
      if (currentContextLengthKey() !== key) return
      contextLength.value = value
      contextLengthLoadedKey = key
    } catch {
      if (currentContextLengthKey() !== key) return
      contextLength.value = FALLBACK_CONTEXT
      contextLengthLoadedKey = key
    } finally {
      if (contextLengthRequestKey === key) {
        contextLengthRequest = null
        contextLengthRequestKey = ''
      }
    }
  })()
  return contextLengthRequest
}

onMounted(loadContextLength)
watch(
  () => [
    profilesStore.activeProfileName,
    appStore.selectedProvider,
    appStore.selectedModel,
    chatStore.activeSession?.id,
    chatStore.activeSession?.profile,
    chatStore.activeSession?.provider,
    chatStore.activeSession?.model,
    chatStore.activeSession?.source,
  ],
  loadContextLength,
  { flush: 'post' },
)

const totalTokens = computed(() => {
  const context = chatStore.activeSession?.contextTokens
  if (typeof context === 'number' && Number.isFinite(context) && context > 0) return context
  const input = chatStore.activeSession?.inputTokens ?? 0
  const output = chatStore.activeSession?.outputTokens ?? 0
  return input + output
})
const showContextUsage = computed(() => !!chatStore.activeSession)

const remainingTokens = computed(() => Math.max(0, contextLength.value - totalTokens.value))

const usagePercent = computed(() =>
  Math.min((totalTokens.value / contextLength.value) * 100, 100),
)

function formatTokens(n: number): string {
  if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M'
  if (n >= 1000) return (n / 1000).toFixed(1) + 'k'
  return String(n)
}

// --- File attachment helpers ---

function addFile(file: File) {
  if (attachments.value.find(a => a.name === file.name)) return
  const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
  const url = URL.createObjectURL(file)
  attachments.value.push({
    id,
    name: file.name,
    type: file.type,
    size: file.size,
    url,
    file,
  })
  if (!isVideoFile(file)) return

  let job: Promise<void>
  job = extractRepresentativeVideoFrames(file)
    .then((frames) => {
      if (!attachments.value.some(attachment => attachment.id === id)) return
      for (const frame of frames) {
        attachments.value.push({
          id: `${id}-frame-${attachments.value.length}`,
          name: frame.name,
          type: frame.type,
          size: frame.size,
          url: URL.createObjectURL(frame),
          file: frame,
          videoFrameFor: id,
        })
      }
    })
    .catch(() => {
      // Keep the original video attachment. Coding agents can still inspect its local path.
    })
    .finally(() => {
      pendingVideoFrameJobs.delete(job)
      isPreparingAttachments.value = pendingVideoFrameJobs.size > 0
    })
  pendingVideoFrameJobs.add(job)
  isPreparingAttachments.value = true
}

function addFiles(files: File[]) {
  for (const file of files) addFile(file)
  if (files.length > 0) textareaRef.value?.focus()
}

function handleAttachClick() {
  fileInputRef.value?.click()
}

function handleFileChange(e: Event) {
  const input = e.target as HTMLInputElement
  if (!input.files) return
  addFiles(Array.from(input.files))
  input.value = ''
}

// --- Paste files ---

function handlePaste(e: ClipboardEvent) {
  const files = extractClipboardFiles(e.clipboardData)
  if (!files.length) return
  e.preventDefault()
  addFiles(files)
}

// --- Drag and drop ---

function handleDragOver(e: DragEvent) {
  e.preventDefault()
}

function handleDragEnter(e: DragEvent) {
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
  e.preventDefault()
  dragCounter.value = 0
  isDragging.value = false
  const files = Array.from(e.dataTransfer?.files || [])
  if (!files.length) return
  addFiles(files)
}

/**
 * Put the caret in the composer so the next keystroke lands in the message box.
 * Refused on a phone, where taking focus raises the on-screen keyboard over the
 * conversation the user just opened.
 */
function focusComposer() {
  if (isMobileViewport.value) return
  nextTick(() => textareaRef.value?.focus())
}

defineExpose({ addFiles, focusComposer })

// --- Send ---

function responseAnnotationDraftSignature(sessionId: string) {
  return JSON.stringify((annotationsStore.annotationsForSession(sessionId) ?? []).map(annotation => ({
    ...annotation,
    pendingFiles: (annotationsStore.pendingFilesForAnnotation(annotation.id) ?? []).map(file => ({
      name: file.name,
      size: file.size,
      type: file.type,
      lastModified: file.lastModified,
    })),
  })))
}

async function handleSend() {
  if (isSubmitting.value) return
  const originSessionId = activeAnnotationSessionId.value
  if (isPreparingAttachments.value) {
    if (sendAwaitingAttachments) return
    sendAwaitingAttachments = true
    try {
      while (pendingVideoFrameJobs.size > 0) {
        await Promise.allSettled([...pendingVideoFrameJobs])
      }
    } finally {
      sendAwaitingAttachments = false
    }
  }
  if (originSessionId && activeAnnotationSessionId.value !== originSessionId) return
  const text = inputText.value.trim()
  const annotations = activeResponseAnnotations.value.map(annotation => ({
    ...annotation,
    files: annotation.files.map(file => ({ ...file })),
  }))
  const allAttachments = [...attachments.value, ...responseAnnotationAttachments.value]
  if (!text && allAttachments.length === 0 && annotations.length === 0) return
  if (annotations.length === 0 && isBridgeSession.value && text === '/skill' && allAttachments.length === 0) {
    void openSkillPicker()
    return
  }
  if (annotations.length === 0 && isBridgeSession.value && allAttachments.length === 0 && /^\/bundles$/i.test(text)) {
    void openBundlePicker()
    return
  }
  if (annotations.length === 0 && isBridgeSession.value && allAttachments.length === 0 && /^\/bundles\s+create$/i.test(text)) {
    openBundleCreator()
    return
  }

  const annotationDraftSignature = originSessionId
    ? responseAnnotationDraftSignature(originSessionId)
    : '[]'
  const submittedInputDraft = inputText.value
  const submittedAttachmentIds = new Set(attachments.value.map(attachment => attachment.id))
  isSubmitting.value = true
  let submitted = false
  try {
    submitted = annotations.length > 0
      ? await chatStore.sendMessage(
          text,
          allAttachments.length > 0 ? allAttachments : undefined,
          annotations,
        )
      : await chatStore.sendMessage(
          text,
          allAttachments.length > 0 ? allAttachments : undefined,
        )
  } finally {
    isSubmitting.value = false
  }
  if (submitted === false) return
  if (originSessionId && responseAnnotationDraftSignature(originSessionId) === annotationDraftSignature) {
    annotationsStore.clearAnnotations(originSessionId)
  }
  if (originSessionId && activeAnnotationSessionId.value !== originSessionId) return
  const inputUnchanged = inputText.value === submittedInputDraft
  if (inputUnchanged) {
    inputText.value = ''
    saveDraftForActiveSession('')
    slashActive.value = false
    if (textareaRef.value) textareaRef.value.style.height = 'auto'
  } else {
    saveDraftForActiveSession(inputText.value)
    updateSlashState()
  }
  attachments.value = attachments.value.filter(attachment => !submittedAttachmentIds.has(attachment.id))
  if (previewAttachment.value && submittedAttachmentIds.has(previewAttachment.value.id)) {
    previewAttachment.value = null
  }
}

function handleCompositionStart() {
  isComposing.value = true
}

function handleCompositionEnd() {
  requestAnimationFrame(() => {
    isComposing.value = false
    updateSlashState()
  })
}

function isImeEnter(e: KeyboardEvent): boolean {
  return isComposing.value || e.isComposing || e.keyCode === 229
}

function handleKeydown(e: KeyboardEvent) {
  if (slashActive.value && filteredBridgeCommands.value.length > 0) {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      slashActiveIndex.value = (slashActiveIndex.value + 1) % filteredBridgeCommands.value.length
      scrollCommandIntoView()
      return
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault()
      slashActiveIndex.value = (slashActiveIndex.value - 1 + filteredBridgeCommands.value.length) % filteredBridgeCommands.value.length
      scrollCommandIntoView()
      return
    }
    if (e.key === 'Enter' || e.key === 'Tab') {
      e.preventDefault()
      selectBridgeCommand(filteredBridgeCommands.value[slashActiveIndex.value])
      return
    }
    if (e.key === 'Escape') {
      e.preventDefault()
      slashActive.value = false
      return
    }
  }

  if (e.key !== 'Enter' || e.shiftKey) return
  if (isImeEnter(e)) return

  e.preventDefault()
  handleSend()
}

function handleInput(e: Event) {
  const el = e.target as HTMLTextAreaElement
  if (!isComposing.value) updateSlashState()
  // 用户手动拖拽自定义高度时，不覆盖
  if (textareaHeight.value !== null) return
  autoSizeTextarea(el)
}

function handleCommandHover(index: number) {
  slashActiveIndex.value = index
}

function onDocumentMousedown(e: MouseEvent) {
  if (!slashActive.value) return
  const target = e.target as HTMLElement
  if (!target.closest('.slash-command-dropdown') && !target.closest('.input-wrapper')) {
    slashActive.value = false
  }
}

onMounted(() => {
  document.addEventListener('mousedown', onDocumentMousedown)
})

onUnmounted(() => {
  document.removeEventListener('mousedown', onDocumentMousedown)
  window.removeEventListener('resize', syncViewport)
})

function removeAttachment(id: string) {
  const removedIds = new Set([id])
  for (const attachment of attachments.value) {
    if (attachment.videoFrameFor === id) removedIds.add(attachment.id)
  }
  const removed = attachments.value.filter(attachment => removedIds.has(attachment.id))
  if (previewAttachment.value && removedIds.has(previewAttachment.value.id)) {
    previewAttachment.value = null
  }
  for (const attachment of removed) URL.revokeObjectURL(attachment.url)
  attachments.value = attachments.value.filter(attachment => !removedIds.has(attachment.id))
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
    <ResponseAnnotationComposer
      v-if="activeAnnotationSessionId"
      :session-id="activeAnnotationSessionId"
    />
    <!-- Attachment previews -->
    <div v-if="attachments.some(att => !att.videoFrameFor)" class="attachment-previews">
      <div
        v-for="att in attachments.filter(item => !item.videoFrameFor)"
        :key="att.id"
        class="attachment-preview"
        :class="{ image: isImage(att.type), 'has-context': !!att.context }"
      >
        <template v-if="isImage(att.type)">
          <button
            type="button"
            class="attachment-thumb-button"
            :aria-label="att.name"
            @click="openAttachmentPreview(att)"
          >
            <img :src="att.url" :alt="att.name" class="attachment-thumb" />
          </button>
        </template>
        <template v-else>
          <div class="attachment-file">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
            <span class="file-name">{{ att.name }}</span>
            <span class="file-size">{{ formatSize(att.size) }}</span>
          </div>
        </template>
        <details v-if="att.context" class="attachment-context">
          <summary>{{ t('browser.selectionData') }}</summary>
          <pre>{{ att.context }}</pre>
        </details>
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
      @mousedown="focusTextareaFromInputWrapper"
    >
      <input
        ref="fileInputRef"
        type="file"
        multiple
        class="file-input-hidden"
        @change="handleFileChange"
      />
      <div
        class="resize-handle"
        :title="t('chat.inputHeightResizeHint')"
        @mousedown="startResize"
        @dblclick="resetTextareaHeight"
      ></div>
      <div v-if="showContextUsage" class="context-usage-row">
        <span class="context-info" :class="{ 'context-warning': usagePercent > 80 }">
          {{ formatTokens(totalTokens) }} /
          <NTooltip trigger="hover" :disabled="isMobileViewport">
            <template #trigger>
              <span class="context-limit-editable" @click="handleEditContextLimit">
                {{ formatTokens(contextLength) }}
              </span>
            </template>
            <span>{{ t('chat.contextClickToEdit') }}</span>
          </NTooltip>
          · {{ t('chat.contextRemaining') }} {{ formatTokens(remainingTokens) }}
        </span>
        <div class="context-bar">
          <div
            class="context-bar-fill"
            :class="{
              'context-bar-warn': usagePercent > 60 && usagePercent <= 80,
              'context-bar-danger': usagePercent > 80,
            }"
            :style="{ width: `${usagePercent}%` }"
          />
        </div>
      </div>
      <textarea
        ref="textareaRef"
        v-model="inputText"
        class="input-textarea"
        dir="auto"
        :style="textareaHeight ? { height: textareaHeight + 'px' } : {}"
        :placeholder="t('chat.inputPlaceholder')"
        rows="1"
        @keydown="handleKeydown"
        @compositionstart="handleCompositionStart"
        @compositionend="handleCompositionEnd"
        @input="handleInput"
        @paste="handlePaste"
      ></textarea>
      <div class="input-toolbar">
        <!-- Bottom bar: attach + input settings + actions -->
        <div class="input-top-bar">
          <NTooltip trigger="hover" :disabled="isMobileViewport">
            <template #trigger>
              <NButton quaternary size="tiny" @click="handleAttachClick" circle class="toolbar-icon-button">
                <template #icon>
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M12 5v14"/><path d="M5 12h14"/></svg>
                </template>
              </NButton>
            </template>
            {{ t('chat.attachFiles') }}
          </NTooltip>

          <NPopover
            v-if="!isMoaSession && !isGlobalCodingAgentSession"
            trigger="click"
            placement="top-start"
          >
            <template #trigger>
              <NTooltip trigger="hover" :disabled="isMobileViewport">
                <template #trigger>
                  <NButton
                    quaternary
                    size="tiny"
                    class="reasoning-effort-button"
                    :class="{ active: !!currentReasoningEffort }"
                    :style="reasoningEffortAccentStyle"
                    :aria-label="`${t('chat.reasoningEffort.tooltip')}: ${reasoningEffortLabel}`"
                  >
                    <template #icon>
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
                        <path d="M9.5 2A2.5 2.5 0 0 1 12 4.5v15a2.5 2.5 0 0 1-4.96.44 2.5 2.5 0 0 1-2.96-3.08 3 3 0 0 1-.34-5.58 2.5 2.5 0 0 1 1.32-4.24 2.5 2.5 0 0 1 1.98-3A2.5 2.5 0 0 1 9.5 2Z"/>
                        <path d="M14.5 2A2.5 2.5 0 0 0 12 4.5v15a2.5 2.5 0 0 0 4.96.44 2.5 2.5 0 0 0 2.96-3.08 3 3 0 0 0 .34-5.58 2.5 2.5 0 0 0-1.32-4.24 2.5 2.5 0 0 0-1.98-3A2.5 2.5 0 0 0 14.5 2Z"/>
                      </svg>
                    </template>
                    <span class="reasoning-effort-label">{{ reasoningEffortLabel }}</span>
                    <svg class="toolbar-chevron" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m6 9 6 6 6-6"/></svg>
                  </NButton>
                </template>
                {{ t('chat.reasoningEffort.tooltip') }}: {{ reasoningEffortLabel }}
              </NTooltip>
            </template>

            <div class="reasoning-effort-slider-popover" :style="reasoningEffortAccentStyle">
              <div class="reasoning-effort-slider-heading">
                <span>{{ t('chat.reasoningEffort.tooltip') }}</span>
                <strong>{{ reasoningEffortLabel }}</strong>
              </div>
              <NSlider
                class="reasoning-effort-slider"
                :class="{ 'reasoning-effort-slider--max': currentReasoningEffort === 'max' }"
                :value="reasoningEffortSliderValue"
                :min="0"
                :max="reasoningEffortOptions.length - 1"
                :step="1"
                :format-tooltip="reasoningEffortSliderLabel"
                @update:value="onReasoningEffortSliderChange"
              />
              <div class="reasoning-effort-slider-range" aria-hidden="true">
                <span>{{ reasoningEffortOptions[0].label }}</span>
                <span>{{ reasoningEffortOptions[reasoningEffortOptions.length - 1].label }}</span>
              </div>
              <div class="reasoning-effort-slider-hint">
                {{ t('chat.reasoningEffort.dragHint', { count: reasoningEffortOptions.length }) }}
              </div>
            </div>
          </NPopover>

          <NDropdown
            trigger="click"
            :options="inputSettingsOptions"
            :show-arrow="true"
            @select="handleInputSettingsSelect"
          >
            <NTooltip trigger="hover" :disabled="isMobileViewport">
              <template #trigger>
                <NButton
                  quaternary
                  size="tiny"
                  class="input-settings-button"
                  :aria-label="t('sidebar.settings')"
                >
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

          <NTooltip trigger="hover" :disabled="isMobileViewport">
            <template #trigger>
              <NButton
                quaternary
                size="tiny"
                class="input-model-button"
                :disabled="props.modelDisabled"
                :title="isMobileViewport ? undefined : props.modelLabel || t('models.selectModel')"
                :aria-label="props.modelLabel || t('models.selectModel')"
                @click="handleModelButtonClick"
              >
                <template #icon>
                  <svg
                    width="15"
                    height="15"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="1.8"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                  >
                    <circle cx="12" cy="12" r="3" />
                    <path d="M12 1v4" />
                    <path d="M12 19v4" />
                    <path d="M1 12h4" />
                    <path d="M19 12h4" />
                    <path d="M4.22 4.22l2.83 2.83" />
                    <path d="M16.95 16.95l2.83 2.83" />
                    <path d="M4.22 19.78l2.83-2.83" />
                    <path d="M16.95 7.05l2.83-2.83" />
                  </svg>
                </template>
                <span class="input-model-label">{{ compactModelLabel }}</span>
                <svg class="toolbar-chevron" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m6 9 6 6 6-6"/></svg>
              </NButton>
            </template>
            {{ props.modelLabel || t('models.selectModel') }}
          </NTooltip>

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
            :class="{ 'send-button--stop': sendButtonIsStop }"
            :disabled="sendButtonIsStop ? chatStore.isAborting : !canSend"
            :aria-label="sendButtonIsStop ? 'Stop' : 'Send'"
            @click="sendButtonIsStop ? chatStore.stopStreaming() : handleSend()"
          >
            <template #icon>
              <svg
                v-if="sendButtonIsStop"
                width="18"
                height="18"
                viewBox="0 0 24 24"
                aria-hidden="true"
              >
                <rect x="6" y="6" width="12" height="12" rx="2.5" fill="currentColor" />
              </svg>
              <svg v-else width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5"/><path d="m5 12 7-7 7 7"/></svg>
            </template>
            <span class="visually-hidden">{{ sendButtonIsStop ? t('chat.stop') : t('chat.send') }}</span>
          </NButton>
        </div>
      </div>
      <Transition name="dropdown-fade">
        <div
          v-if="slashActive && filteredBridgeCommands.length > 0"
          ref="commandDropdownRef"
          class="slash-command-dropdown"
        >
          <div
            v-for="(command, i) in filteredBridgeCommands"
            :key="command.key"
            class="slash-command-item"
            :class="{ active: i === slashActiveIndex }"
            @mousedown.prevent="selectBridgeCommand(command)"
            @mouseenter="handleCommandHover(i)"
          >
            <span class="slash-command-name">/{{ command.name }}</span>
            <span v-if="command.args" class="slash-command-args">{{ command.args }}</span>
            <span class="slash-command-desc">{{ command.description }}</span>
          </div>
        </div>
      </Transition>
    </div>

    <NModal
      v-model:show="showSkillPicker"
      :title="t('skills.title')"
      :mask-closable="true"
      preset="card"
      style="width: min(620px, calc(100vw - 32px))"
    >
      <div v-if="showSkillPicker" class="skill-picker-modal">
        <input
          v-model="skillSearch"
          class="skill-picker-search"
          :placeholder="t('skills.searchPlaceholder')"
          type="search"
        />
        <div class="skill-picker-list">
          <div v-if="skillPickerLoading" class="skill-picker-empty">
            {{ t('common.loading') }}
          </div>
          <template v-else>
            <div
              v-for="skill in filteredSkillPickerItems"
              :key="skill.key"
              role="button"
              tabindex="0"
              class="skill-picker-item"
              @click="selectSkill(skill)"
              @keydown.enter.prevent="selectSkill(skill)"
              @keydown.space.prevent="selectSkill(skill)"
            >
              <div class="skill-picker-command">/skill {{ skill.commandName }}</div>
              <div class="skill-picker-name">{{ skill.name }}</div>
              <div class="skill-picker-desc">{{ skill.description }}</div>
            </div>
          </template>
          <div v-if="!skillPickerLoading && filteredSkillPickerItems.length === 0" class="skill-picker-empty">
            {{ skillSearch ? t('skills.noMatch') : t('skills.noSkills') }}
          </div>
        </div>
      </div>
    </NModal>

    <NModal
      v-model:show="showBundlePicker"
      :title="t('chat.bundlePicker.title')"
      :mask-closable="true"
      preset="card"
      style="width: min(620px, calc(100vw - 32px))"
    >
      <div v-if="showBundlePicker" class="skill-picker-modal">
        <div class="bundle-picker-toolbar">
          <input
            v-model="bundleSearch"
            class="skill-picker-search"
            :placeholder="t('chat.bundlePicker.searchPlaceholder')"
            type="search"
          />
          <NButton type="primary" @click="openBundleCreator">
            {{ t('chat.bundlePicker.create') }}
          </NButton>
        </div>
        <div class="skill-picker-list">
          <div v-if="bundlePickerLoading" class="skill-picker-empty">
            {{ t('common.loading') }}
          </div>
          <template v-else>
            <div
              v-for="bundle in filteredBundles"
              :key="bundle.commandName"
              class="skill-picker-item bundle-picker-item"
            >
              <button type="button" class="bundle-picker-select" @click="selectBundle(bundle)">
                <span class="skill-picker-command">/bundles {{ bundle.commandName }}</span>
                <span class="skill-picker-name">{{ bundle.name }}</span>
                <span v-if="bundle.description" class="skill-picker-desc">
                  {{ bundle.description }}
                </span>
                <span class="bundle-picker-skills">
                  {{ t('chat.bundlePicker.skillsLabel') }}:
                  {{ bundle.skills.length > 0 ? bundle.skills.join(', ') : t('chat.bundlePicker.noSkills') }}
                </span>
              </button>
              <button
                type="button"
                class="bundle-picker-delete"
                :disabled="deletingBundleCommand === bundle.commandName"
                :aria-label="t('chat.bundlePicker.deleteBundle', { name: bundle.name })"
                :title="t('chat.bundlePicker.deleteBundle', { name: bundle.name })"
                @mousedown.stop
                @click.stop="confirmDeleteBundle(bundle)"
              >
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                  <path d="M3 6h18" />
                  <path d="M8 6V4h8v2" />
                  <path d="M19 6l-1 14H6L5 6" />
                  <path d="M10 11v5M14 11v5" />
                </svg>
              </button>
            </div>
          </template>
          <div v-if="!bundlePickerLoading && filteredBundles.length === 0" class="skill-picker-empty">
            {{ bundleSearch ? t('chat.bundlePicker.noMatch') : t('chat.bundlePicker.noBundles') }}
          </div>
        </div>
      </div>
    </NModal>

    <BundleCreateModal
      v-if="showBundleCreator"
      :key="currentSkillsKey()"
      :profile="currentSkillsKey()"
      @close="showBundleCreator = false"
      @created="handleBundleCreated"
    />

    <!-- Context Length Edit Modal -->
    <NModal
      v-model:show="showContextEditModal"
      :title="t('chat.contextEditTitle')"
      :mask-closable="true"
      preset="card"
      style="width: 400px"
    >
      <div class="context-edit-content">
        <p style="margin-bottom: 16px; color: #666;">
          {{ t('chat.contextEditDesc') }}
        </p>
        <NInputNumber
          v-model:value="editingContextLimit"
          :min="1000"
          :max="10000000"
          :step="1000"
          :show-button="false"
          :placeholder="t('chat.contextEditPlaceholder')"
          style="width: 100%"
        >
          <template #suffix>
            <span style="color: #999;">tokens</span>
          </template>
        </NInputNumber>
        <div style="margin-top: 12px; font-size: 12px; color: #999;">
          {{ t('chat.contextEditHint') }}
        </div>
      </div>
      <template #footer>
        <div style="display: flex; justify-content: flex-end; gap: 8px;">
          <NButton @click="showContextEditModal = false" :disabled="isSavingContextLimit">
            {{ t('chat.contextEditCancel') }}
          </NButton>
          <NButton type="primary" @click="saveContextLimit" :loading="isSavingContextLimit">
            {{ t('chat.contextEditSave') }}
          </NButton>
        </div>
      </template>
    </NModal>
  </div>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;

.chat-input-area {
  position: relative;
  z-index: 80;
  padding: 8px 20px 14px;
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
  padding: 0 0 0 2px;
  margin-inline-start: 0;

  .switch-label {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 16px;
    height: 16px;
    color: #999999;
    font-size: 12px;

    svg {
      opacity: 1;
    }
  }

  :deep(.n-switch),
  :deep(.n-switch__rail) {
    margin-inline-end: 0;
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
  opacity: 1;

  :deep(.n-button__state-border),
  :deep(.n-button__border),
  :deep(.n-button__ripple) {
    display: none;
  }

  .tool-trace-icon {
    display: block;
    flex: 0 0 16px;
    width: 16px;
    height: 16px;
  }

  &.active {
    color: #999999;
    opacity: 1;
  }

  &:hover {
    color: #999999;
    opacity: 1;
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

.input-model-button {
  color: $text-secondary;
  border-radius: 999px;
  max-width: 190px;
  padding: 0 4px 0 6px;

  :deep(.n-button__content) {
    gap: 4px;
    min-width: 0;
  }

  :deep(.n-button__state-border),
  :deep(.n-button__border),
  :deep(.n-button__ripple) {
    display: none;
  }
}

.input-model-label {
  display: inline-block;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  vertical-align: top;
  white-space: nowrap;
}

.reasoning-effort-button {
  color: $text-secondary;
  border-radius: 999px;
  padding: 0 4px 0 6px;

  &.active {
    color: var(--reasoning-effort-accent-color);
  }

  :deep(.n-button__content) {
    gap: 4px;
    min-width: 0;
  }
}

.reasoning-effort-label {
  display: inline-block;
  max-width: 96px;
  overflow: hidden;
  text-overflow: ellipsis;
  vertical-align: top;
  white-space: nowrap;
}

.reasoning-effort-slider-popover {
  width: min(320px, calc(100vw - 64px));
  padding: 4px 2px 2px;
}

.reasoning-effort-slider-heading,
.reasoning-effort-slider-range {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
}

.reasoning-effort-slider-hint {
  margin-top: 6px;
  color: $text-muted;
  font-size: 11px;
  text-align: center;
}

.reasoning-effort-slider-heading {
  margin-bottom: 10px;
  color: $text-secondary;
  font-size: 12px;

  strong {
    color: var(--reasoning-effort-accent-color);
    font-weight: 600;
  }
}

.reasoning-effort-slider {
  --n-handle-size: 24px !important;
  --n-rail-height: 10px !important;
  --reasoning-effort-gradient-width: min(314px, calc(100vw - 70px));
  margin: 0 3px;

  :deep(.n-slider-rail) {
    background: rgba(255, 255, 255, 0.14);
  }

  :deep(.n-slider-rail__fill) {
    background: linear-gradient(
      90deg,
      #38bdf8 0%,
      #22d3ee 20%,
      #34d399 40%,
      #facc15 62%,
      #fb923c 82%,
      #ef4444 100%
    );
    background-position: left center;
    background-repeat: no-repeat;
    background-size: var(--reasoning-effort-gradient-width) 100%;
    box-shadow: 0 0 8px rgba(56, 189, 248, 0.24);
  }

  :deep(.n-slider-handle) {
    border: 2px solid rgba(255, 255, 255, 0.92);
    background: #f8fafc;
    box-shadow: 0 2px 8px rgba(24, 18, 44, 0.38);
  }
}

.reasoning-effort-slider--max {
  :deep(.n-slider-handle) {
    position: relative;
    overflow: hidden;
    isolation: isolate;
    border-radius: 50%;
    border-color: rgba(255, 255, 255, 0.96);
    background:
      radial-gradient(circle at 24% 24%, #38bdf8 0 14%, transparent 34%),
      radial-gradient(circle at 78% 22%, #facc15 0 15%, transparent 36%),
      radial-gradient(circle at 78% 78%, #ef4444 0 16%, transparent 38%),
      radial-gradient(circle at 22% 76%, #34d399 0 15%, transparent 36%),
      conic-gradient(from 30deg, #22d3ee, #34d399, #facc15, #fb923c, #ef4444, #a855f7, #38bdf8, #22d3ee);
    background-size: 150% 150%, 145% 145%, 155% 155%, 145% 145%, 180% 180%;
    box-shadow:
      0 0 0 1px rgba(255, 255, 255, 0.38),
      0 0 12px rgba(239, 68, 68, 0.46),
      0 3px 9px rgba(24, 18, 44, 0.44);
    animation: reasoning-effort-max-liquid 3.6s ease-in-out infinite;
  }

  :deep(.n-slider-handle::after) {
    content: '';
    position: absolute;
    inset: 2px 5px 11px 5px;
    border-radius: 999px;
    background: rgba(255, 255, 255, 0.5);
    filter: blur(1px);
    animation: reasoning-effort-max-highlight 2.8s ease-in-out infinite;
  }
}

@keyframes reasoning-effort-max-liquid {
  0%, 100% {
    background-position: 0% 20%, 100% 0%, 100% 100%, 0% 100%, 50% 50%;
    background-size: 150% 150%, 145% 145%, 155% 155%, 145% 145%, 180% 180%;
  }

  33% {
    background-position: 65% 0%, 55% 70%, 30% 100%, 0% 35%, 100% 35%;
    background-size: 175% 135%, 135% 175%, 165% 140%, 140% 165%, 210% 170%;
  }

  66% {
    background-position: 100% 70%, 20% 100%, 0% 35%, 75% 0%, 0% 70%;
    background-size: 135% 175%, 170% 140%, 140% 170%, 170% 135%, 170% 210%;
  }
}

@keyframes reasoning-effort-max-highlight {
  0%, 100% {
    opacity: 0.72;
    transform: translate(-1px, -1px) rotate(0deg);
  }

  50% {
    opacity: 0.42;
    transform: translate(3px, 2px) rotate(180deg);
  }
}

@media (prefers-reduced-motion: reduce) {
  .reasoning-effort-slider--max {
    :deep(.n-slider-handle),
    :deep(.n-slider-handle::after) {
      animation: none;
    }
  }
}

.reasoning-effort-slider-range {
  margin-top: 4px;
  color: $text-muted;
  font-size: 10px;
}

.toolbar-chevron {
  flex: 0 0 12px;
  color: $text-muted;
}

.context-usage-row {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 7px;
  position: absolute;
  top: 9px;
  right: 14px;
  z-index: 1;
  min-width: 0;
  max-width: calc(100% - 28px);
  padding: 0;
  color: $text-muted;
  pointer-events: auto;
}

.context-info {
  font-size: 11px;
  color: inherit;
  min-width: 0;
  white-space: nowrap;

  &.context-warning {
    color: #e8a735;
  }
}

.context-limit-editable {
  cursor: pointer;
  border-bottom: 1px dashed transparent;
  transition: all 0.2s ease;
  padding: 0 2px;

  &:hover {
    border-bottom-color: $text-muted;
    background: rgba(128, 128, 128, 0.1);
    border-radius: 2px;
  }
}

.context-bar {
  width: 60px;
  height: 4px;
  margin-inline-start: -4px;
  background: rgba(var(--text-muted-rgb), 0.2);
  border-radius: 2px;
  overflow: hidden;
}

.context-bar-fill {
  height: 100%;
  background: linear-gradient(
    90deg,
    rgba(var(--text-muted-rgb), 0.45),
    rgba(var(--text-muted-rgb), 0.85)
  );
  border-radius: 2px;
  transition: width 0.3s ease;

  &.context-bar-warn {
    background: linear-gradient(90deg, #c98a1a, #e8a735);
  }

  &.context-bar-danger {
    background: linear-gradient(90deg, #c43a2a, #e85d4a);
  }
}

.dark .context-limit-editable {
  color: var(--text-secondary);

  &:hover {
    border-bottom-color: var(--text-muted);
    background: rgba(var(--text-muted-rgb), 0.1);
  }
}

.dark .context-bar {
  background: rgba(var(--text-muted-rgb), 0.2);
}

.dark .context-bar-fill {
  background: linear-gradient(
    90deg,
    rgba(var(--text-muted-rgb), 0.5),
    rgba(var(--text-muted-rgb), 0.9)
  );

  &.context-bar-warn {
    background: linear-gradient(90deg, #d99d35, #f0bc58);
  }

  &.context-bar-danger {
    background: linear-gradient(90deg, #d95445, #ff7a68);
  }
}

@media (max-width: 768px) {
  .chat-input-area {
    --voice-overlay-mobile-bottom-offset: 146px;
    padding: 8px 12px 12px;
  }

  .input-top-bar {
    gap: 5px;
  }

  .reasoning-effort-label,
  .auto-play-speech-switch {
    display: none;
  }

  .reasoning-effort-slider-popover {
    width: min(220px, calc(100vw - 96px));
  }

  .reasoning-effort-slider {
    --reasoning-effort-gradient-width: min(214px, calc(100vw - 102px));
  }

  .input-model-button {
    min-width: 35px;
    max-width: 35px;
    padding: 0 4px 0 6px;
  }

  .input-model-label {
    display: none;
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

  .context-info {
    overflow: hidden;
    text-overflow: ellipsis;
    font-size: 10px;
    line-height: 14px;
  }

  .context-bar {
    width: 42px;
    flex-shrink: 0;
  }
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

  &.image.has-context {
    width: min(420px, 100%);
    height: auto;
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

.attachment-preview.has-context .attachment-thumb {
  display: block;
  width: 100%;
  height: auto;
  max-height: 220px;
  object-fit: contain;
  background: #fff;
}

.attachment-preview.has-context .attachment-thumb-button {
  height: auto;
}

.attachment-context {
  padding: 7px 9px;
  border-top: 1px solid $border-color;
  font-size: 11px;
  color: $text-secondary;

  summary { cursor: pointer; user-select: none; }
  pre { max-height: 180px; margin: 8px 0 0; overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere; font: 10px/1.45 monospace; }
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

.input-wrapper {
  display: flex;
  flex-direction: column;
  align-items: stretch;
  gap: 8px;
  width: 100%;
  min-height: 150px;
  background-color: $bg-card;
  border: 1px solid var(--input-border-color);
  border-radius: 18px;
  padding: 22px 12px 9px;
  position: relative;
  cursor: text;
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
    background-color: #333333;
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
  flex: 1 1 auto;
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
  min-height: 44px;
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
  flex: 0 0 26px;
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
  margin-top: auto;
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

.slash-command-dropdown {
  position: absolute;
  left: 12px;
  right: 12px;
  bottom: calc(100% + 8px);
  max-height: 240px;
  overflow-y: auto;
  background: $bg-primary;
  border: 1px solid $border-color;
  border-radius: $radius-sm;
  box-shadow: 0 10px 28px rgba(0, 0, 0, 0.16);
  z-index: 20;
  padding: 4px;

  .dark & {
    background: #2a2a2a;
  }
}

.slash-command-item {
  display: grid;
  grid-template-columns: auto auto 1fr;
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
  border-radius: $radius-sm;
  cursor: pointer;
  min-height: 36px;

  &.active,
  &:hover {
    background: rgba(var(--accent-primary-rgb), 0.1);
  }

}

.slash-command-name {
  font-family: $font-code;
  font-size: 13px;
  color: $accent-primary;
  white-space: nowrap;
}

.slash-command-args {
  font-family: $font-code;
  font-size: 12px;
  color: $text-muted;
  white-space: nowrap;
}

.slash-command-desc {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: $text-secondary;
  font-size: 12px;
}

.skill-picker-modal {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.bundle-picker-toolbar {
  display: flex;
  align-items: center;
  gap: 8px;

  .skill-picker-search {
    min-width: 0;
    flex: 1;
  }
}

.skill-picker-search {
  width: 100%;
  height: 34px;
  padding: 0 10px;
  border: 1px solid $border-color;
  border-radius: $radius-sm;
  background: $bg-input;
  color: $text-primary;
  outline: none;
  font-family: $font-ui;
  font-size: 13px;

  &:focus {
    border-color: $accent-primary;
  }
}

.skill-picker-list {
  max-height: min(420px, 52vh);
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.skill-picker-item {
  display: block;
  flex: 0 0 76px;
  width: 100%;
  height: 76px;
  box-sizing: border-box;
  padding: 7px 10px;
  border: 1px solid $border-color;
  border-radius: $radius-sm;
  background: $bg-secondary;
  color: $text-primary;
  text-align: start;
  cursor: pointer;
  overflow: hidden;
  outline: none;

  &:focus-visible,
  &:hover {
    border-color: rgba(var(--accent-primary-rgb), 0.5);
    background: rgba(var(--accent-primary-rgb), 0.08);
  }
}

.bundle-picker-item {
  position: relative;
  height: 96px;
  flex-basis: 96px;
  padding: 0;
  cursor: default;
}

.bundle-picker-select {
  display: block;
  width: 100%;
  height: 100%;
  padding: 7px 42px 7px 10px;
  border: 0;
  background: transparent;
  color: inherit;
  text-align: start;
  cursor: pointer;
  outline: none;
}

.bundle-picker-delete {
  position: absolute;
  top: 8px;
  right: 8px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  padding: 0;
  border: 0;
  border-radius: 7px;
  background: transparent;
  color: $text-muted;
  cursor: pointer;

  &:hover,
  &:focus-visible {
    background: rgba(239, 68, 68, 0.12);
    color: #ef4444;
    outline: none;
  }

  &:disabled {
    cursor: wait;
    opacity: 0.45;
  }
}

.skill-picker-command {
  display: block;
  width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  font-family: $font-code;
  font-size: 12px;
  line-height: 16px;
  color: $accent-primary;
  white-space: nowrap;
}

.skill-picker-name,
.skill-picker-desc {
  display: block;
  width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.bundle-picker-skills {
  display: block;
  width: 100%;
  margin-top: 3px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: $text-muted;
  font-size: 11px;
  line-height: 16px;
}

.skill-picker-name {
  margin-top: 3px;
  font-size: 13px;
  line-height: 18px;
  color: $text-primary;
}

.skill-picker-desc {
  margin-top: 3px;
  font-size: 12px;
  line-height: 16px;
  color: $text-secondary;
}

.skill-picker-empty {
  padding: 18px 10px;
  text-align: center;
  color: $text-muted;
  font-size: 13px;
}

@media (max-width: 768px) {
  .skill-picker-item {
    height: 76px;
  }

  .bundle-picker-item {
    height: 96px;
  }

  .input-wrapper {
    min-height: 118px;
  }

  .input-textarea::placeholder {
    font-size: 13px;
    line-height: 1.35;
  }
}

.dropdown-fade-enter-active,
.dropdown-fade-leave-active {
  transition: opacity 0.12s ease, transform 0.12s ease;
}

.dropdown-fade-enter-from,
.dropdown-fade-leave-to {
  opacity: 0;
  transform: translateY(4px);
}

</style>
