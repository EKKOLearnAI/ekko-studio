<script setup lang="ts">
import {
  formatReferencedContentForDisplay,
  parseMessageReference,
  type Message,
  type ContentBlock,
} from "@/stores/hermes/chat";
import { computed, defineAsyncComponent, onBeforeUnmount, onMounted, ref, watchEffect } from "vue";
import { useI18n } from "vue-i18n";
import { useMessage } from "naive-ui";
import { downloadFile, getDownloadUrl } from "@/api/studio/download";
import { copyToClipboard } from "@/utils/clipboard";
import { parseThinking, countThinkingChars } from "@/utils/thinking-parser";
import { useChatStore } from "@/stores/hermes/chat";
import { useFilesStore } from "@/stores/hermes/files";
import { useToolPanelStore } from "@/stores/hermes/tool-panel";
import { useSettingsStore } from "@/stores/hermes/settings";
import { chatSessionAgentAvatar, type ChatAgentAvatar } from "@/utils/chat-agent-avatar";
import TaskPlanCard from './TaskPlanCard.vue';
import ToolChangeCard from "./ToolChangeCard.vue";
import {
  copyTextToClipboard,
  extractUnifiedDiffPayload,
  handleCodeBlockCopyClick,
  inferStructuredLanguage,
  renderHighlightedCodeBlock,
} from "./highlight";
import { useGlobalSpeech } from "@/composables/useSpeech";
import { useVoiceSettings } from "@/composables/useVoiceSettings";
import { speedToEdgeRate, hzToEdgePitch } from "@/utils/ttsHelpers";
import { formatChatTimestamp } from "@/utils/chat-timestamp";
import { openSubagentStream, subagentIdFromToolCall } from "@/utils/hermes/subagent-stream";
import type { WorkspaceRunChangeSummary } from "@/api/studio/sessions";
import { isServerTtsProvider } from "@/api/studio/tts";
import type { ProfileAvatar as ProfileAvatarData } from "@/api/hermes/profiles";
import ProfileAvatar from "@/components/hermes/profiles/ProfileAvatar.vue";
import ImagePreviewOverlay from "./ImagePreviewOverlay.vue";
import ResponseAnnotationSource from "./ResponseAnnotationSource.vue";
import SentResponseAnnotations from "./SentResponseAnnotations.vue";
import { parseResponseAnnotationDisplayEnvelope } from "@/utils/chat-response-annotations";

const MarkdownRenderer = defineAsyncComponent(async () => (await import("./MarkdownRenderer.vue")).default);

const TOOL_PAYLOAD_DISPLAY_LIMIT = 1000;
const JSON_STRING_DISPLAY_LIMIT = 200;
const JSON_MAX_DEPTH = 6;
const JSON_MAX_NODES = 1000;
const JSON_MAX_KEYS_PER_OBJECT = 50;
const JSON_MAX_ITEMS_PER_ARRAY = 50;
const JSON_TRUNCATED_KEY = "__truncated__";

const props = withDefaults(defineProps<{
  message: Message
  highlight?: boolean
  headingIdPrefix?: string
  showForkAction?: boolean
  assistantAgent?: ChatAgentAvatar
  userProfileName?: string
  userProfileAvatar?: ProfileAvatarData | null
}>(), {
  userProfileName: "default",
  userProfileAvatar: null,
});
const { t } = useI18n();
const toast = useMessage();

const isSystem = computed(() => props.message.role === "system");
const isAgentError = computed(() => props.message.role === "assistant" && props.message.systemType === "error");

const effectiveHeadingIdPrefix = computed(() => props.headingIdPrefix || `msg-${props.message.id}`);
const isCommandMessage = computed(() => props.message.role === "command" || props.message.systemType === "command");
const isCommandError = computed(() => props.message.role === "command" && props.message.systemType === "error");
const isStatusCommand = computed(() =>
  isCommandMessage.value
  && props.message.commandAction === "status"
  && props.message.commandData?.type !== "goal"
);
const statusItems = computed(() => {
  const data = props.message.commandData || {};
  return [
    { key: "status", value: data.isWorking ? "running" : "idle" },
    { key: "source", value: data.source },
    { key: "profile", value: data.profile },
    { key: "model", value: data.model || "-" },
    { key: "queue", value: data.queueLength ?? 0 },
    { key: "run", value: data.runId || "-" },
  ];
});

type DisplayContentFile = {
  type: 'image' | 'video' | 'file'
  name: string
  path?: string
  url?: string
  context?: string
}

function getBlockText(block: any): string {
  if (!block || typeof block !== 'object') return ''
  if (block.type === 'text' || block.type === 'input_text') {
    return typeof block.text === 'string' ? block.text : ''
  }
  return ''
}

function getImageUrlFromBlock(block: any): string | null {
  if (!block || typeof block !== 'object') return null
  if (block.type !== 'input_image' && block.type !== 'image_url') return null
  const raw = block.image_url
  if (typeof raw === 'string') return raw
  if (raw && typeof raw === 'object' && typeof raw.url === 'string') return raw.url
  return null
}

function imageNameFromDataUrl(url: string, index: number): string {
  const match = url.match(/^data:image\/([^;,]+)/i)
  const ext = match?.[1] === 'jpeg' ? 'jpg' : match?.[1] || 'png'
  return `image-${index + 1}.${ext}`
}

function parseContentBlocks(content: string): Array<ContentBlock | Record<string, unknown>> | null {
  const trimmed = content.trim()
  if (!trimmed) return null

  const parse = (value: string) => {
    const parsed = JSON.parse(value)
    return Array.isArray(parsed) && parsed.length > 0 && 'type' in parsed[0]
      ? parsed as Array<ContentBlock | Record<string, unknown>>
      : null
  }

  try {
    return parse(trimmed)
  } catch {
    // Hermes Agent stored some multimodal user messages via Python str(list),
    // e.g. [{'type': 'text'}, {'type': 'image_url', ...}]. Convert that
    // legacy repr into JSON for display only.
    if (!trimmed.startsWith("[{'") && !trimmed.startsWith('[{"')) return null
    try {
      return parse(
        trimmed
          .replace(/\bNone\b/g, 'null')
          .replace(/\bTrue\b/g, 'true')
          .replace(/\bFalse\b/g, 'false')
          .replace(/'/g, '"'),
      )
    } catch {
      return null
    }
  }
}

// Parse ContentBlock[] from JSON string
const contentBlocks = computed(() => {
  const content = props.message.content || '';
  return parseContentBlocks(content);
});

// Check if content is in ContentBlock[] format
const isContentBlockArray = computed(() => contentBlocks.value !== null);

// Extract text content from ContentBlock[] for display
const displayText = computed(() => {
  if (!isContentBlockArray.value) {
    return props.message.content || '';
  }

  // Extract text from blocks
  return contentBlocks.value!
    .map(block => getBlockText(block))
    .filter(Boolean)
    .join('\n');
});
const responseAnnotationMessage = computed(() =>
  props.message.role === 'user'
    ? parseResponseAnnotationDisplayEnvelope(displayText.value)
    : null,
)
const displayBodyText = computed(() => responseAnnotationMessage.value?.body ?? displayText.value)
const parsedMessageReference = computed(() =>
  props.message.role === 'user' ? parseMessageReference(displayBodyText.value) : null,
)
const referencedContentMarkdown = computed(() =>
  parsedMessageReference.value
    ? formatReferencedContentForDisplay(parsedMessageReference.value.content)
    : '',
)

// Extract files from ContentBlock[]
const contentFiles = computed<DisplayContentFile[] | null>(() => {
  if (!isContentBlockArray.value) return null;

  return contentBlocks.value!.flatMap<DisplayContentFile>((block, index) => {
    if (typeof (block as any).annotation_id === 'string') return []
    if ((block as any).video_frame === true) return []
    if (block.type === 'image') {
      return [{
        type: 'image' as const,
        name: String((block as any).name || `image-${index + 1}`),
        path: String((block as any).path || ''),
        context: typeof (block as any).context === 'string' ? (block as any).context : undefined,
      }].filter(file => file.path)
    }
    if (block.type === 'file') {
      const name = String((block as any).name || `file-${index + 1}`)
      const mediaType = String((block as any).media_type || '')
      return [{
        type: isVideo(mediaType, name) ? 'video' as const : 'file' as const,
        name,
        path: String((block as any).path || ''),
        context: typeof (block as any).context === 'string' ? (block as any).context : undefined,
      }].filter(file => file.path)
    }
    const imageUrl = getImageUrlFromBlock(block)
    if (imageUrl?.startsWith('data:image/')) {
      return [{
        type: 'image' as const,
        name: imageNameFromDataUrl(imageUrl, index),
        url: imageUrl,
      }]
    }
    return []
  });
});

function getContentFileUrl(file: DisplayContentFile): string {
  if (file.url) return file.url
  return file.path ? getDownloadUrl(file.path, file.name) : ''
}

const toolExpanded = ref(false);
const expandedWorkspaceChangeIds = ref(new Set<string>());
const previewUrl = ref<string | null>(null);
const selectedToolChangeFileId = ref<number | null>(null);

const chatStore = useChatStore();
const filesStore = useFilesStore();
const toolPanelStore = useToolPanelStore();
const settingsStore = useSettingsStore();
const speech = useGlobalSpeech();
const voiceSettings = useVoiceSettings();
const assistantAgent = computed(() => props.assistantAgent || chatSessionAgentAvatar(chatStore.activeSession));

// Copy entire bubble content
const copyableContent = computed(() => {
  if (props.message.role === 'tool') return null
  if (parsedMessageReference.value) {
    return [referencedContentMarkdown.value, parsedMessageReference.value.reply]
      .filter(Boolean)
      .join('\n\n')
  }
  const content = responseAnnotationMessage.value
    ? [
        displayBodyText.value,
        ...responseAnnotationMessage.value.annotations.map(annotation => annotation.selectedText),
      ].filter(Boolean).join('\n\n')
    : props.message.content || ''
  if (!content.trim()) return null
  return content
})

function forkFromCurrentTail() {
  if (!props.showForkAction || chatStore.isStreaming || chatStore.isForkPending) return
  chatStore.sendMessage('/fork')
}

async function copyBubbleContent() {
  const text = copyableContent.value
  if (!text) return
  const ok = await copyToClipboard(text)
  if (ok) {
    toast.success(t('chat.copiedBubble'))
    return
  }
  toast.error(t('chat.copyFailed'))
}

function referenceBubbleContent() {
  const content = quotableContent.value
  const sessionId = chatStore.activeSessionId
  if (!content || !sessionId) return
  chatStore.setMessageReference(sessionId, {
    id: props.message.id,
    role: props.message.role as 'user' | 'assistant',
    content,
    sender: props.message.role,
  })
}

const parsedThinking = computed(() =>
  parseThinking(props.message.content || "", { streaming: !!props.message.isStreaming }),
);
const assistantAnnotationBody = computed(() => {
  if (props.message.role !== 'assistant') return ''
  return parsedThinking.value.hasThinking
    ? parsedThinking.value.body
    : props.message.content || ''
})
const annotationSessionId = computed(() => chatStore.activeSessionId || '')
const canAnnotateAssistantBody = computed(() => Boolean(
  assistantAnnotationBody.value
  && annotationSessionId.value
  && !props.message.isStreaming
  && !isAgentError.value,
))
const showMessageBubble = computed(() => {
  if (props.message.role !== 'user' || !responseAnnotationMessage.value) return true
  return Boolean(
    displayBodyText.value.trim()
    || (contentFiles.value && contentFiles.value.length > 0)
    || (props.message.attachments && props.message.attachments.length > 0),
  )
})

function handleResponseAnnotationError(code: string) {
  toast.error(code === 'selection_unavailable'
    ? t('chat.annotations.sourceUnavailable')
    : t(`chat.annotations.errors.${code}`))
}

const quotableContent = computed(() => {
  if (props.message.role !== 'user' && props.message.role !== 'assistant') return null
  if (props.message.isStreaming || isAgentError.value) return null
  const content = props.message.role === 'assistant'
    ? parsedThinking.value.body.trim()
    : (parsedMessageReference.value?.reply || parsedMessageReference.value?.content || displayBodyText.value).trim()
  return content || null
})

// 优先使用来自 reasoning 字段/事件的思考文本；否则回退到从 content 解析的 <think> 标签。
// 若两者共存，则拼接展示（罕见，但保持信息不丢）。
const hasReasoningField = computed(() => !!(props.message.reasoning && props.message.reasoning.length > 0));

const hasThinking = computed(() => hasReasoningField.value || parsedThinking.value.hasThinking);

const thinkingFullText = computed(() => {
  const parts: string[] = [];
  if (props.message.reasoning) parts.push(props.message.reasoning);
  parts.push(...parsedThinking.value.segments);
  if (parsedThinking.value.pending) parts.push(parsedThinking.value.pending);
  return parts.join("\n\n");
});

const thinkingCharCount = computed(() => {
  let count = countThinkingChars(parsedThinking.value);
  if (props.message.reasoning) count += props.message.reasoning.length;
  return count;
});

// 流式思考态：仍有未闭合 <think> 标签，或 reasoning 有内容但正文尚未开始。
const thinkingStreamingNow = computed(() => {
  if (!props.message.isStreaming) return false;
  if (parsedThinking.value.pending !== null) return true;
  if (hasReasoningField.value && !props.message.content) return true;
  return false;
});

const thinkingOverride = ref<boolean | null>(null);

const thinkingExpanded = computed(() => {
  if (thinkingStreamingNow.value) return true;
  if (thinkingOverride.value !== null) return thinkingOverride.value;
  return !!settingsStore.display.show_reasoning;
});

function toggleThinking() {
  thinkingOverride.value = !thinkingExpanded.value;
}

const nowTick = ref(Date.now());
let tickTimer: number | null = null;

function ensureTick() {
  const ob = chatStore.getThinkingObservation(props.message.id);
  const shouldTick = !!(
    props.message.isStreaming &&
    ob?.startedAt !== undefined &&
    ob.endedAt === undefined
  );
  if (shouldTick && tickTimer === null) {
    tickTimer = window.setInterval(() => {
      nowTick.value = Date.now();
    }, 1000);
  } else if (!shouldTick && tickTimer !== null) {
    window.clearInterval(tickTimer);
    tickTimer = null;
  }
}

watchEffect(ensureTick);

onBeforeUnmount(() => {
  if (tickTimer !== null) window.clearInterval(tickTimer);
});

const thinkingDurationMs = computed<number | null>(() => {
  const ob = chatStore.getThinkingObservation(props.message.id);
  if (!ob?.startedAt) return null;
  const startedAt = ob.startedAt!; // Non-null assertion after check
  const end = ob?.endedAt ?? (props.message.isStreaming ? nowTick.value : startedAt);
  return Math.max(0, end - startedAt);
});

function formatDuration(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const r = s % 60;
  return r === 0 ? `${m}m` : `${m}m ${r}s`;
}

const timeStr = computed(() => formatChatTimestamp(props.message.timestamp));

function isImage(type: string): boolean {
  return type.startsWith("image/");
}

function isVideo(type: string, name: string): boolean {
  return type.startsWith("video/") || /\.(?:mp4|mov|m4v|webm)$/i.test(name);
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return bytes + " B";
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
  return (bytes / (1024 * 1024)).toFixed(1) + " MB";
}

/**
 * Extract the upload file path from message content for a given attachment.
 * Upload format in content: [File: name.txt](/tmp/hermes-uploads/abc123.txt)
 */
function getFilePathFromContent(attName: string): string | null {
  const content = props.message.content || "";

  // Try ContentBlock[] format first
  try {
    const parsed = JSON.parse(content);
    if (Array.isArray(parsed) && parsed.length > 0 && 'type' in parsed[0]) {
      const fileBlock = parsed.find((block: any) =>
        block.type === 'file' && block.name === attName
      );
      if (fileBlock && (fileBlock as any).path) {
        return (fileBlock as any).path;
      }
    }
  } catch {
    // Not valid JSON, continue to regex matching
  }

  // Fallback to markdown format: [File: name](path)
  const regex = /\[File:\s*([^\]]+)\]\(([^)]+)\)/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(content)) !== null) {
    if (match[1].trim() === attName.trim()) return match[2];
  }

  return null;
}

function handleAttachmentDownload(att: { name: string; url: string; type: string }) {
  const filePath = getFilePathFromContent(att.name);
  if (filePath) {
    toast.info(t("download.downloading"));
    downloadFile(filePath, att.name).catch((err: Error) => {
      toast.error(err.message || t("download.downloadFailed"));
    });
    return;
  }
  if (att.url && att.url.startsWith("blob:")) {
    const a = document.createElement("a");
    a.href = att.url;
    a.download = att.name;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  }
}

type ToolPayload = {
  full: string;
  display: string;
  language?: string;
};

function truncateLongString(value: string, marker: string): string {
  return value.length > JSON_STRING_DISPLAY_LIMIT
    ? value.slice(0, JSON_STRING_DISPLAY_LIMIT) + "\n" + marker
    : value;
}

function truncateJsonValue(value: unknown, marker: string): unknown {
  let nodeCount = 0;
  const seen = new WeakSet<object>();

  function stringifyLength(candidate: unknown): number {
    return JSON.stringify(candidate, null, 2).length;
  }

  function visit(current: unknown, depth: number): unknown {
    nodeCount += 1;
    if (nodeCount > JSON_MAX_NODES) {
      return marker;
    }

    if (typeof current === "string") return truncateLongString(current, marker);
    if (current === null || typeof current !== "object") return current;

    if (seen.has(current)) return `[Circular ${marker}]`;
    if (depth >= JSON_MAX_DEPTH) {
      return Array.isArray(current) ? `[Array ${marker}]` : `[Object ${marker}]`;
    }

    seen.add(current);

    if (Array.isArray(current)) {
      const result: unknown[] = [];
      const maxItems = Math.min(current.length, JSON_MAX_ITEMS_PER_ARRAY);
      for (let i = 0; i < maxItems; i += 1) {
        const remaining = current.length - i;
        result.push(visit(current[i], depth + 1));
        if (stringifyLength(result) > TOOL_PAYLOAD_DISPLAY_LIMIT) {
          result.pop();
          result.push(`${marker}: ${remaining} more items`);
          seen.delete(current);
          return result;
        }
      }
      if (current.length > maxItems) {
        result.push(`${marker}: ${current.length - maxItems} more items`);
      }
      seen.delete(current);
      return result;
    }

    const entries = Object.entries(current as Record<string, unknown>);
    const result: Record<string, unknown> = {};
    const maxKeys = Math.min(entries.length, JSON_MAX_KEYS_PER_OBJECT);
    for (let i = 0; i < maxKeys; i += 1) {
      const [key, val] = entries[i];
      const remaining = entries.length - i;
      result[key] = visit(val, depth + 1);
      if (stringifyLength(result) > TOOL_PAYLOAD_DISPLAY_LIMIT) {
        delete result[key];
        result[JSON_TRUNCATED_KEY] = `${marker}: ${remaining} more keys`;
        seen.delete(current);
        return result;
      }
    }
    if (entries.length > maxKeys) {
      result[JSON_TRUNCATED_KEY] = `${marker}: ${entries.length - maxKeys} more keys`;
    }
    seen.delete(current);
    return result;
  }

  const truncated = visit(value, 0);
  if (stringifyLength(truncated) <= TOOL_PAYLOAD_DISPLAY_LIMIT) return truncated;
  return { [JSON_TRUNCATED_KEY]: marker };
}

function normalizeToolPayload(raw: unknown): string {
  if (raw === null || raw === undefined || raw === "") return "";
  if (typeof raw === "string") return raw;
  try {
    const serialized = JSON.stringify(raw);
    if (serialized !== undefined) return serialized;
  } catch {
    // Fall through to String(raw) for non-serializable runtime payloads.
  }
  return String(raw);
}

function formatToolPayload(raw?: unknown, extractDiff = false): ToolPayload {
  const text = normalizeToolPayload(raw);
  if (!text) {
    return { full: "", display: "" };
  }

  const shouldParseJson = typeof raw !== "string" || /^[\[{]/.test(text.trim());
  if (shouldParseJson) {
    try {
      const parsed = JSON.parse(text);
      const full = JSON.stringify(parsed, null, 2);
      const extractedDiff = extractDiff ? extractUnifiedDiffPayload(parsed) : null;
      if (extractedDiff) {
        return {
          full,
          display: extractedDiff,
          language: "diff",
        };
      }
      const display = full.length > TOOL_PAYLOAD_DISPLAY_LIMIT
        ? JSON.stringify(truncateJsonValue(parsed, t("chat.truncated")), null, 2)
        : full;
      return {
        full,
        display,
        language: "json",
      };
    } catch {
      // Fall through to text rendering for non-JSON strings.
    }
  }

  const language = inferStructuredLanguage(text);
  return {
    full: text,
    display:
      language === "diff" || text.length <= TOOL_PAYLOAD_DISPLAY_LIMIT
        ? text
        : text.slice(0, TOOL_PAYLOAD_DISPLAY_LIMIT) + "\n" + t("chat.truncated"),
    language,
  };
}

function renderToolPayload(content: string, language?: string, options: { showCopyButton?: boolean } = {}): string {
  return renderHighlightedCodeBlock(content, language, t("common.copy"), {
    maxHighlightLength: TOOL_PAYLOAD_DISPLAY_LIMIT,
    formatDiffFoldLabel: (hiddenCount) => t("chat.unchangedLines", { count: hiddenCount }),
    showCopyButton: options.showCopyButton,
  });
}

async function handleToolDetailClick(event: MouseEvent): Promise<void> {
  const target = event.target;
  if (!(target instanceof HTMLElement)) return;

  const button = target.closest<HTMLElement>("[data-copy-code=\"true\"]");
  if (!button) return;

  event.preventDefault();

  const source = button.closest<HTMLElement>("[data-copy-source]")?.dataset.copySource;
  if (source === "tool-args" && fullToolArgs.value) {
    const ok = await copyTextToClipboard(fullToolArgs.value);
    if (ok) toast.success(t("common.copied"));
    else toast.error(t("chat.copyFailed"));
    return;
  }
  if (source === "tool-result" && fullToolResult.value) {
    const ok = await copyTextToClipboard(fullToolResult.value);
    if (ok) toast.success(t("common.copied"));
    else toast.error(t("chat.copyFailed"));
    return;
  }

  const copyResult = await handleCodeBlockCopyClick(event);
  if (copyResult) toast.success(t("common.copied"));
  else if (copyResult === false) toast.error(t("chat.copyFailed"));
}

const hasAttachments = computed(
  () => (props.message.attachments?.length ?? 0) > 0,
);

const toolArgsPayload = computed(() => formatToolPayload(props.message.toolArgs));
const toolResultPayload = computed(() => formatToolPayload(props.message.toolResult, true));
const workspaceChanges = computed(() => props.message.workspaceChanges || []);

function isWorkspaceChangeExpanded(changeId: string): boolean {
  return expandedWorkspaceChangeIds.value.has(changeId);
}

function toggleWorkspaceChange(changeId: string): void {
  const next = new Set(expandedWorkspaceChangeIds.value);
  if (next.has(changeId)) next.delete(changeId);
  else next.add(changeId);
  expandedWorkspaceChangeIds.value = next;
}

const hasToolDetails = computed(
  () => !!(
    props.message.reasoning?.trim()
    || toolArgsPayload.value.full
    || toolResultPayload.value.full
  ),
);
const isSubagentTool = computed(() => subagentIdFromToolCall(props.message.toolCallId) !== null);
const hasInlineToolDetails = computed(() => hasToolDetails.value && !isSubagentTool.value);

const fullToolArgs = computed(() => toolArgsPayload.value.full);
const formattedToolArgs = computed(() => toolArgsPayload.value.display);
const fullToolResult = computed(() => toolResultPayload.value.full);
const formattedToolResult = computed(() => toolResultPayload.value.display);

const renderedToolArgs = computed(() => {
  if (!formattedToolArgs.value) return "";
  return renderToolPayload(
    formattedToolArgs.value,
    toolArgsPayload.value.language,
  );
});

const renderedToolResult = computed(() => {
  if (!formattedToolResult.value) return "";
  return renderToolPayload(
    formattedToolResult.value,
    toolResultPayload.value.language,
  );
});

function handleToolLineClick() {
  if (isSubagentTool.value) {
    openSubagentStream(chatStore.activeSessionId, props.message.toolCallId);
    return;
  }
  if (hasInlineToolDetails.value) toolExpanded.value = !toolExpanded.value;
}

async function openAssistantWorkspaceChangeFile(
  file: { id: string | number; path: string; additions: number; deletions: number },
  change: WorkspaceRunChangeSummary,
): Promise<void> {
  const storedFile = change.files.find(candidate => String(candidate.id) === String(file.id));
  if (!storedFile) return;
  selectedToolChangeFileId.value = storedFile.id;
  filesStore.closePreview();
  await toolPanelStore.openWorkspaceDiff(storedFile, change.workspace || "");
}

// 语音播放相关
const canPlaySpeech = computed(() => {
  // 只有 assistant 消息可以播放
  if (props.message.role !== 'assistant') return false
  if (!copyableContent.value) return false
  // OpenAI / Custom / Edge / MiMo / Doubao 不依赖浏览器 Web Speech API
  if (isServerTtsProvider(voiceSettings.provider.value)) return true
  return speech.isSupported
})

const isPlayingThisMessage = computed(() => {
  // OpenAI / Custom / Edge / MiMo / Doubao 模式
  if (isServerTtsProvider(voiceSettings.provider.value)) {
    return speech.currentCustomMessageId.value === props.message.id && speech.isCustomPlaying.value
  }
  return speech.currentMessageId.value === props.message.id && speech.isPlaying.value
})

const isPausedThisMessage = computed(() => {
  // OpenAI / Custom / Edge / MiMo / Doubao 模式
  if (isServerTtsProvider(voiceSettings.provider.value)) {
    return speech.currentCustomMessageId.value === props.message.id && speech.isCustomPaused.value
  }
  return speech.currentMessageId.value === props.message.id && speech.isPaused.value
})

function handleSpeechToggle() {
  if (!canPlaySpeech.value) {
    return
  }
  const content = props.message.content || ''

  // OpenAI TTS 模式
  if (voiceSettings.provider.value === 'openai') {
    const apiUrl = voiceSettings.openaiBaseUrl.value
    if (!apiUrl) {
      console.warn('[MessageItem] OpenAI TTS 地址为空')
      return
    }
    speech.openaiToggle(props.message.id, content, {
      provider: 'openai',
      baseUrl: voiceSettings.openaiBaseUrl.value,
      apiKey: voiceSettings.openaiApiKey.value,
      model: voiceSettings.openaiModel.value,
      voice: voiceSettings.openaiVoice.value,
    })
    return
  }

  // 自定义端点模式（OpenAI 兼容，如 GPT-SoVITS）
  if (voiceSettings.provider.value === 'custom') {
    const apiUrl = voiceSettings.customUrl.value
    if (!apiUrl) {
      console.warn('[MessageItem] 自定义 TTS 地址为空')
      return
    }
    speech.openaiToggle(props.message.id, content, {
      provider: 'custom',
      baseUrl: voiceSettings.customUrl.value,
      apiKey: voiceSettings.customApiKey.value || undefined,
    })
    return
  }

  // Edge TTS 模式
  if (voiceSettings.provider.value === 'edge') {
    // URL 为空时使用内建后端代理
    const apiUrl = voiceSettings.edgeUrl.value || '/api/tts/proxy'
    speech.openaiToggle(props.message.id, content, {
      provider: 'edge',
      baseUrl: apiUrl,
      voice: voiceSettings.edgeVoice.value,
      rate: speedToEdgeRate(voiceSettings.edgeRate.value),
      pitch: hzToEdgePitch(voiceSettings.edgePitchHz.value),
    })
    return
  }

  // MiMo TTS 模式
  if (voiceSettings.provider.value === 'mimo') {
    const apiKey = voiceSettings.mimoApiKey.value
    speech.mimoToggle(props.message.id, content, {
      baseUrl: voiceSettings.mimoBaseUrl.value,
      apiKey: apiKey || undefined,
      authMode: voiceSettings.mimoAuthMode.value,
      model: voiceSettings.mimoModel.value,
      voiceMode: voiceSettings.mimoModel.value === 'mimo-v2.5-tts-voicedesign' ? 'voiceDesign' : voiceSettings.mimoModel.value === 'mimo-v2.5-tts-voiceclone' ? 'voiceClone' : 'preset',
      voice: voiceSettings.mimoVoice.value,
      voiceDesignDesc: voiceSettings.mimoVoiceDesignDesc.value || undefined,
      voiceCloneDataUri: voiceSettings.mimoVoiceCloneDataUri.value || undefined,
      voiceCloneFormat: voiceSettings.mimoVoiceCloneFormat.value,
      stylePrompt: voiceSettings.mimoStylePrompt.value || undefined,
    })
    return
  }

  if (voiceSettings.provider.value === 'doubao') {
    speech.openaiToggle(props.message.id, content, {
      provider: 'doubao',
      baseUrl: voiceSettings.doubaoBaseUrl.value,
      model: voiceSettings.doubaoModel.value,
      voice: voiceSettings.doubaoVoice.value,
      stylePrompt: voiceSettings.doubaoStylePrompt.value || undefined,
      speed: voiceSettings.doubaoSpeed.value || undefined,
    })
    return
  }

  if (isServerTtsProvider(voiceSettings.provider.value)) {
    speech.openaiToggle(props.message.id, content, {
      provider: voiceSettings.provider.value,
    })
    return
  }

  // Web Speech API 模式
  if (voiceSettings.provider.value === 'webspeech') {
    speech.toggleBrowser(props.message.id, content, {
      voiceName: voiceSettings.webspeechVoice.value || undefined,
    })
    return
  }

  // 后备（无 provider 匹配时）
  speech.toggle(props.message.id, content)
}

// 监听自动播放事件
let autoPlayHandler: ((e: Event) => void) | null = null

function handleAutoplayTtsError(err: unknown) {
  if (err instanceof Error && err.name === 'AbortError') return
  console.warn('[MessageItem] TTS autoplay failed:', err)
}

onMounted(() => {
  autoPlayHandler = (e: Event) => {
    const customEvent = e as CustomEvent<{ messageId: string; content: string }>
    if (customEvent.detail.messageId === props.message.id && canPlaySpeech.value) {
      const content = customEvent.detail.content || props.message.content || ''
      if (voiceSettings.provider.value === 'openai') {
        const apiUrl = voiceSettings.openaiBaseUrl.value
        if (apiUrl) void speech.openaiPlay(props.message.id, content, {
          provider: 'openai',
          baseUrl: voiceSettings.openaiBaseUrl.value,
          apiKey: voiceSettings.openaiApiKey.value,
          model: voiceSettings.openaiModel.value,
          voice: voiceSettings.openaiVoice.value,
        }).catch(handleAutoplayTtsError)
      } else if (voiceSettings.provider.value === 'custom') {
        const apiUrl = voiceSettings.customUrl.value
        if (apiUrl) void speech.openaiPlay(props.message.id, content, {
          provider: 'custom',
          baseUrl: voiceSettings.customUrl.value,
          apiKey: voiceSettings.customApiKey.value || undefined,
        }).catch(handleAutoplayTtsError)
      } else if (voiceSettings.provider.value === 'edge') {
        void speech.openaiPlay(props.message.id, content, {
          provider: 'edge',
          baseUrl: '/api/tts/proxy',
          voice: voiceSettings.edgeVoice.value,
          rate: speedToEdgeRate(voiceSettings.edgeRate.value),
          pitch: hzToEdgePitch(voiceSettings.edgePitchHz.value),
        }).catch(handleAutoplayTtsError)
      } else if (voiceSettings.provider.value === 'mimo') {
        const apiKey = voiceSettings.mimoApiKey.value
        void speech.mimoPlay(props.message.id, content, {
          baseUrl: voiceSettings.mimoBaseUrl.value,
          apiKey: apiKey || undefined,
          authMode: voiceSettings.mimoAuthMode.value,
          model: voiceSettings.mimoModel.value,
          voiceMode: voiceSettings.mimoModel.value === 'mimo-v2.5-tts-voicedesign' ? 'voiceDesign' : voiceSettings.mimoModel.value === 'mimo-v2.5-tts-voiceclone' ? 'voiceClone' : 'preset',
          voice: voiceSettings.mimoVoice.value,
          voiceDesignDesc: voiceSettings.mimoVoiceDesignDesc.value || undefined,
          voiceCloneDataUri: voiceSettings.mimoVoiceCloneDataUri.value || undefined,
          voiceCloneFormat: voiceSettings.mimoVoiceCloneFormat.value,
          stylePrompt: voiceSettings.mimoStylePrompt.value || undefined,
        }).catch(handleAutoplayTtsError)
      } else if (voiceSettings.provider.value === 'doubao') {
        void speech.openaiPlay(props.message.id, content, {
          provider: 'doubao',
          baseUrl: voiceSettings.doubaoBaseUrl.value,
          model: voiceSettings.doubaoModel.value,
          voice: voiceSettings.doubaoVoice.value,
          stylePrompt: voiceSettings.doubaoStylePrompt.value || undefined,
          speed: voiceSettings.doubaoSpeed.value || undefined,
        }).catch(handleAutoplayTtsError)
      } else if (isServerTtsProvider(voiceSettings.provider.value)) {
        void speech.openaiPlay(props.message.id, content, {
          provider: voiceSettings.provider.value,
        }).catch(handleAutoplayTtsError)
      } else if (voiceSettings.provider.value === 'webspeech') {
        const text = speech.extractReadableText(content)
        if (text) {
          speech.stop(false)
          speech.speakViaBrowser(props.message.id, text, {
            voiceName: voiceSettings.webspeechVoice.value || undefined,
          })
        }
      } else {
        speech.enqueue(props.message.id, content)
      }
    }
  }
  window.addEventListener('auto-play-speech', autoPlayHandler)
})

// 组件卸载时停止播放并清理事件监听
onBeforeUnmount(() => {
  if (autoPlayHandler) {
    window.removeEventListener('auto-play-speech', autoPlayHandler)
  }
  if (speech.currentMessageId.value === props.message.id || speech.currentCustomMessageId.value === props.message.id) {
    speech.stop();
  }
});
</script>

<template>
  <div
    class="message"
    :class="[message.role, { highlight }]"
    :id="`message-${message.id}`"
  >
    <TaskPlanCard v-if="message.taskPlan" :plan="message.taskPlan" />
    <template v-else-if="message.role === 'tool'">
      <div
        class="tool-line"
        :class="{ expandable: hasInlineToolDetails || isSubagentTool, 'subagent-entry': isSubagentTool }"
        :role="isSubagentTool ? 'button' : undefined"
        :tabindex="isSubagentTool ? 0 : undefined"
        :title="isSubagentTool ? t('subagent.open') : undefined"
        @click="handleToolLineClick"
        @keydown.enter.prevent="handleToolLineClick"
        @keydown.space.prevent="handleToolLineClick"
      >
        <svg
          v-if="hasInlineToolDetails || isSubagentTool"
          width="10"
          height="10"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          class="tool-chevron"
          :class="{ rotated: toolExpanded && !isSubagentTool }"
        >
          <polyline points="9 18 15 12 9 6" />
        </svg>
        <svg
          v-else
          width="12"
          height="12"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="1.5"
          class="tool-icon"
        >
          <path
            d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"
          />
        </svg>
        <span class="tool-name">{{ message.toolName }}</span>
        <span
          v-if="message.toolPreview && (!toolExpanded || isSubagentTool)"
          class="tool-preview"
          >{{ message.toolPreview }}</span
        >
        <span
          v-if="message.toolStatus === 'running'"
          class="tool-spinner"
        ></span>
        <svg
          v-if="message.toolStatus === 'done'"
          class="tool-status-icon tool-success-icon"
          width="15"
          height="15"
          viewBox="0 0 24 24"
          fill="none"
          :aria-label="t('subagent.completed')"
          role="img"
        >
          <circle cx="12" cy="12" r="10" fill="currentColor" fill-opacity="0.14" />
          <path
            d="m8 12 3 3 5-6"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
          />
        </svg>
        <svg
          v-if="message.toolStatus === 'error'"
          class="tool-error-badge tool-status-icon"
          width="15"
          height="15"
          viewBox="0 0 24 24"
          fill="none"
          :aria-label="t('subagent.failed')"
          role="img"
        >
          <circle cx="12" cy="12" r="10" fill="currentColor" fill-opacity="0.14" />
          <path
            d="m9 9 6 6m0-6-6 6"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
          />
        </svg>
      </div>
      <Transition name="tool-detail-expand">
        <div
          v-if="!isSubagentTool && toolExpanded && hasToolDetails"
          class="tool-details-expand"
        >
          <div class="tool-details" @click="handleToolDetailClick">
            <div v-if="message.reasoning?.trim()" class="tool-detail-section">
              <div class="tool-detail-label">{{ t("chat.thinkingLabel") }}</div>
              <div class="tool-detail-reasoning">
                <MarkdownRenderer :content="message.reasoning" />
              </div>
            </div>
            <div v-if="formattedToolArgs" class="tool-detail-section" data-copy-source="tool-args">
              <div class="tool-detail-label">{{ t("chat.arguments") }}</div>
              <div class="tool-detail-code-block" v-html="renderedToolArgs"></div>
            </div>
            <div v-if="formattedToolResult" class="tool-detail-section" data-copy-source="tool-result">
              <div class="tool-detail-label">{{ t("chat.result") }}</div>
              <div class="tool-detail-code-block" v-html="renderedToolResult"></div>
            </div>
          </div>
        </div>
      </Transition>
    </template>
    <template v-else>
      <div class="msg-body">
        <div class="msg-content" :class="message.role">
          <div v-if="message.role === 'user'" class="message-author user-message-author">
            <span class="message-author-name" dir="auto">{{ userProfileName }}</span>
            <ProfileAvatar
              class="user-profile-avatar"
              :name="userProfileName"
              :avatar="userProfileAvatar"
              :size="22"
            />
          </div>
          <div v-if="message.role === 'assistant'" class="message-author assistant-message-author">
            <img
              class="msg-avatar"
              :src="assistantAgent.src"
              :alt="assistantAgent.label"
              draggable="false"
            >
            <span class="message-author-name" dir="auto">{{ assistantAgent.label }}</span>
          </div>
          <SentResponseAnnotations
            v-if="responseAnnotationMessage && annotationSessionId"
            :session-id="annotationSessionId"
            :message-id="message.id"
            :annotations="responseAnnotationMessage.annotations"
          />
          <div
            v-if="showMessageBubble"
            class="message-bubble"
            :class="{
              system: isSystem,
              'agent-error': isAgentError,
              command: isCommandMessage,
              'command-error': isCommandError,
              'speech-playing': isPlayingThisMessage && !isPausedThisMessage,
            }"
          >
            <div v-if="hasAttachments" class="msg-attachments">
              <div
                v-for="att in message.attachments"
                :key="att.id"
                class="msg-attachment"
                :class="{
                  image: isImage(att.type),
                  video: message.role === 'user' && isVideo(att.type, att.name),
                  'has-context': !!att.context,
                }"
              >
                <template v-if="isImage(att.type) && att.url">
                  <img
                    :src="att.url"
                    :alt="att.name"
                    class="msg-attachment-thumb"
                    @click="previewUrl = att.url"
                  />
                </template>
                <template v-else-if="message.role === 'user' && isVideo(att.type, att.name) && att.url">
                  <video
                    class="msg-attachment-video"
                    :src="att.url"
                    controls
                    playsinline
                    preload="metadata"
                  ></video>
                  <div class="msg-attachment-video-footer">
                    <span class="att-name">{{ att.name }}</span>
                    <span class="att-size">{{ formatSize(att.size) }}</span>
                  </div>
                </template>
                <template v-else>
                  <div class="msg-attachment-file" @click="handleAttachmentDownload(att)" style="cursor: pointer;" :title="t('download.downloadFile')">
                    <svg
                      width="16"
                      height="16"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      stroke-width="1.5"
                    >
                      <path
                        d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"
                      />
                      <polyline points="14 2 14 8 20 8" />
                    </svg>
                    <span class="att-name">{{ att.name }}</span>
                    <span class="att-size">{{ formatSize(att.size) }}</span>
                    <svg class="att-download-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                      <polyline points="7 10 12 15 17 10" />
                      <line x1="12" y1="15" x2="12" y2="3" />
                    </svg>
                  </div>
                </template>
                <details v-if="att.context" class="msg-attachment-context">
                  <summary>{{ t('browser.selectionData') }}</summary>
                  <pre>{{ att.context }}</pre>
                </details>
              </div>
            </div>
            <div
              v-if="hasThinking"
              class="thinking-block"
              :class="{ expanded: thinkingExpanded }"
            >
              <div class="thinking-header" @click="toggleThinking">
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
                  {{
                    thinkingStreamingNow
                      ? t('chat.thinkingInProgress')
                      : t('chat.thinkingLabel')
                  }}
                </span>
                <span v-if="thinkingDurationMs !== null && thinkingDurationMs > 0" class="thinking-meta">
                  · {{ t('chat.thinkingDuration', { duration: formatDuration(thinkingDurationMs) }) }}
                </span>
                <span class="thinking-meta">
                  · {{ t('chat.thinkingChars', { count: thinkingCharCount }) }}
                </span>
              </div>
              <div v-if="thinkingExpanded" class="thinking-body">
                <MarkdownRenderer :content="thinkingFullText" />
              </div>
            </div>
            <ResponseAnnotationSource
              v-if="message.role === 'assistant' && canAnnotateAssistantBody"
              :session-id="annotationSessionId"
              :message-id="message.id"
              :source="assistantAnnotationBody"
              :enabled="true"
              @annotation-error="handleResponseAnnotationError"
            >
              <MarkdownRenderer
                :content="assistantAnnotationBody"
                :heading-id-prefix="effectiveHeadingIdPrefix"
              />
            </ResponseAnnotationSource>
            <MarkdownRenderer
              v-else-if="message.role === 'assistant' && assistantAnnotationBody"
              :content="assistantAnnotationBody"
              :heading-id-prefix="effectiveHeadingIdPrefix"
            />

            <!-- Render user message content -->
            <template v-if="message.role === 'user'">
              <!-- ContentBlock[] format -->
              <template v-if="isContentBlockArray">
                <div v-if="contentFiles && contentFiles.length > 0" class="msg-attachments">
                  <div
                    v-for="(file, idx) in contentFiles"
                    :key="idx"
                    class="msg-attachment"
                    :class="{
                      image: file.type === 'image',
                      video: file.type === 'video',
                      'has-context': !!file.context,
                    }"
                  >
                    <template v-if="file.type === 'image'">
                      <img
                        :src="getContentFileUrl(file)"
                        :alt="file.name"
                        class="msg-attachment-thumb"
                        @click="previewUrl = getContentFileUrl(file)"
                      />
                    </template>
                    <template v-else-if="file.type === 'video'">
                      <video
                        class="msg-attachment-video"
                        :src="getContentFileUrl(file)"
                        controls
                        playsinline
                        preload="metadata"
                      ></video>
                      <div class="msg-attachment-video-footer">
                        <span class="att-name">{{ file.name }}</span>
                      </div>
                    </template>
                    <template v-else>
                      <div
                        class="msg-attachment-file"
                        @click="file.path && downloadFile(file.path, file.name).catch(err => toast.error(err.message || t('download.downloadFailed')))"
                        style="cursor: pointer;"
                        :title="t('download.downloadFile')"
                      >
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                          <polyline points="14 2 14 8 20 8" />
                        </svg>
                        <span class="att-name">{{ file.name }}</span>
                      </div>
                    </template>
                    <details v-if="file.context" class="msg-attachment-context">
                      <summary>{{ t('browser.selectionData') }}</summary>
                      <pre>{{ file.context }}</pre>
                    </details>
                  </div>
                </div>
              </template>
              <template v-if="parsedMessageReference">
                <MarkdownRenderer :content="referencedContentMarkdown" />
                <MarkdownRenderer v-if="parsedMessageReference.reply" :content="parsedMessageReference.reply" />
              </template>
              <MarkdownRenderer v-else-if="displayBodyText" :content="displayBodyText" />
            </template>

            <ToolChangeCard
              v-for="change in workspaceChanges"
              :key="change.change_id"
              class="assistant-workspace-change"
              :files="change.files || []"
              :files-changed="change.files_changed || 0"
              :additions="change.additions || 0"
              :deletions="change.deletions || 0"
              :expanded="isWorkspaceChangeExpanded(change.change_id)"
              :selected-file-id="selectedToolChangeFileId"
              :title="t('chat.changesThisTurn')"
              @toggle="toggleWorkspaceChange(change.change_id)"
              @select="file => openAssistantWorkspaceChangeFile(file, change)"
            />

            <!-- Render system message content -->
            <MarkdownRenderer
              v-if="message.role === 'system' && message.content && !isCommandMessage"
              :content="message.content"
            />
            <div v-if="isStatusCommand" class="command-result command-status">
              <span class="command-result-icon">/</span>
              <div class="command-status-grid">
                <span
                  v-for="item in statusItems"
                  :key="item.key"
                  class="command-status-item"
                >
                  <span class="command-status-key">{{ item.key }}</span>
                  <span class="command-status-value">{{ item.value }}</span>
                </span>
              </div>
            </div>
            <div v-else-if="isCommandMessage && message.content" class="command-result">
              <span class="command-result-icon">/</span>
              <MarkdownRenderer :content="message.content" />
            </div>

            <span v-if="message.isStreaming && !message.content" class="streaming-dots">
              <span></span><span></span><span></span>
            </span>
          </div>
          <div class="message-meta">
            <button
              v-if="canPlaySpeech"
              class="speech-bubble-btn"
              :class="{ playing: isPlayingThisMessage, paused: isPausedThisMessage }"
              @click="handleSpeechToggle"
              :title="isPlayingThisMessage ? (isPausedThisMessage ? t('chat.resumeSpeech') : t('chat.pauseSpeech')) : t('chat.playSpeech')"
            >
              <svg v-if="!isPlayingThisMessage || isPausedThisMessage" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <polygon points="5 3 19 12 5 21 5 3"/>
              </svg>
              <svg v-else width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <rect x="6" y="4" width="4" height="16"/>
                <rect x="14" y="4" width="4" height="16"/>
              </svg>
            </button>
            <button
              v-if="copyableContent"
              class="copy-bubble-btn"
              @click="copyBubbleContent"
              :title="t('chat.copyBubble')"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <rect x="9" y="9" width="13" height="13" rx="2" ry="2"/>
                <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
              </svg>
            </button>
            <button
              v-if="quotableContent"
              class="reference-bubble-btn"
              @click="referenceBubbleContent"
              :title="t('chat.referenceMessage')"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M9 17l-5-5 5-5" />
                <path d="M20 18v-2a4 4 0 0 0-4-4H4" />
              </svg>
            </button>
            <button
              v-if="showForkAction"
              class="fork-bubble-btn"
              @click="forkFromCurrentTail"
              :title="t('chat.slashCommands.fork')"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <circle cx="6" cy="5" r="2.25" />
                <circle cx="18" cy="5" r="2.25" />
                <circle cx="12" cy="19" r="2.25" />
                <path d="M6 7.25v2.25a4 4 0 0 0 4 4h4a4 4 0 0 0 4-4V7.25" />
                <path d="M12 13.5v3.25" />
              </svg>
            </button>
            <span class="message-time">{{ timeStr }}</span>
          </div>
        </div>
      </div>
    </template>
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

.message {
  display: flex;
  flex-direction: column;
  position: relative;
  min-width: 0;
  max-width: 100%;

  &.user {
    align-items: flex-end;

    .msg-body {
      max-width: 75%;
      position: relative;
      z-index: 1;
    }

    .msg-content.user {
      align-items: flex-end;
    }

    .message-bubble {
      background-color: $msg-user-bg;
      border-radius: 10px;
    }
  }

  &.assistant {
    flex-direction: row;
    align-items: flex-start;
    gap: 8px;

    .msg-body {
      max-width: 80%;
      position: relative;
      z-index: 1;
    }

    .msg-avatar {
      width: 22px;
      height: 22px;
      flex-shrink: 0;
      box-sizing: border-box;
      border: 1px solid #fff;
      border-radius: 50%;
      object-fit: cover;
    }

    .message-bubble {
      background-color: $msg-assistant-bg;
      border-radius: 10px;
    }

    .message-bubble.agent-error {
      color: $error;
      background-color: rgba(var(--error-rgb), 0.06);
      border: 1px solid rgba(var(--error-rgb), 0.2);
    }
  }

  &.tool {
    align-items: flex-start;
  }

  &.system {
    align-items: flex-start;
  }

  &.command {
    align-items: flex-start;
  }

  &.highlight {
    .message-bubble {
      box-shadow: 0 0 0 1px rgba(var(--accent-primary-rgb), 0.45);
    }
  }
}

@keyframes gradient-flow {
  0% {
    background-position: 0% 50%;
  }
  50% {
    background-position: 100% 50%;
  }
  100% {
    background-position: 0% 50%;
  }
}

.msg-body {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  max-width: 85%;
  min-width: 0;
  box-sizing: border-box;
}

.msg-content {
  display: flex;
  flex-direction: column;
  min-width: 0;
  max-width: 100%;
  box-sizing: border-box;
}

.message-author {
  display: flex;
  align-items: center;
  gap: 6px;
  max-width: 100%;
  margin-bottom: 6px;
  color: $text-secondary;
  font-size: 12px;
  line-height: 22px;
}

.user-message-author {
  align-self: flex-end;
  justify-content: flex-end;
}

.assistant-message-author {
  align-self: flex-start;
  justify-content: flex-start;
}

.message-author-name {
  min-width: 0;
  max-width: 240px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.user-profile-avatar {
  box-sizing: border-box;
  border: 1px solid #fff;
}

.message-bubble {
  padding: 10px 14px;
  font-size: var(--font-size-base);
  line-height: 1.65;
  word-break: break-word;
  overflow-wrap: anywhere;
  border-radius: 10px;
  max-width: 100%;
  min-width: 0;
  position: relative;
  box-sizing: border-box;

  &.system {
    border-inline-start: 3px solid $warning;
    border-radius: $radius-sm;
    max-width: 80%;
    background-color: rgba(var(--warning-rgb), 0.06);
  }

  &.command {
    border-inline-start: none;
    border: 1px solid rgba(var(--accent-primary-rgb), 0.12);
    background-color: rgba(var(--accent-primary-rgb), 0.04);
    color: $text-secondary;
    max-width: min(100%, 960px);
    padding: 8px 10px;
  }

  &.command-error {
    border-color: rgba(var(--warning-rgb), 0.28);
    background-color: rgba(var(--warning-rgb), 0.06);
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

  &.speech-playing {
    box-shadow:
      0 0 0 2px #ff6b6b,
      0 0 10px rgba(255, 107, 107, 0.4),
      0 0 20px rgba(255, 107, 107, 0.2);
    animation: rainbow-glow 4s linear infinite;
  }
}

:global(html.theme-has-custom-background .message.user .message-bubble:not(.system):not(.command):not(.agent-error)),
:global(html.theme-has-custom-background .message.assistant .message-bubble:not(.system):not(.command):not(.agent-error)) {
  background-color: rgba(var(--bg-main-surface-rgb), 0.78);
  border: 1px solid rgba(var(--text-primary-rgb), 0.18);
  -webkit-backdrop-filter: blur(8px) saturate(110%);
  backdrop-filter: blur(8px) saturate(110%);
}

.command-result {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  min-width: 0;

  :deep(.markdown-body) {
    min-width: 0;
  }

  :deep(.markdown-body p) {
    margin: 0;
  }
}

.command-status {
  align-items: center;
}

.command-status-grid {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  overflow-x: auto;
  white-space: nowrap;
  scrollbar-width: thin;
}

.command-status-item {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  flex: 0 0 auto;
  padding: 2px 7px;
  border: 1px solid rgba(var(--accent-primary-rgb), 0.1);
  border-radius: 999px;
  background: rgba(var(--accent-primary-rgb), 0.035);
  line-height: 1.4;
}

.command-status-key {
  color: $text-muted;
  font-size: 11px;
}

.command-status-value {
  color: $text-primary;
  font-family: $font-code;
  font-size: 11px;
}

.command-result-icon {
  width: 18px;
  height: 18px;
  flex: 0 0 18px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 50%;
  background: rgba(var(--accent-primary-rgb), 0.1);
  color: $accent-primary;
  font-family: $font-code;
  font-size: 12px;
  line-height: 1;
  margin-top: 2px;
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

.msg-attachments {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-bottom: 8px;
}

.msg-attachment {
  border-radius: $radius-sm;
  overflow: hidden;
  background-color: rgba(0, 0, 0, 0.04);
  border: 1px solid $border-light;

  &.image {
    max-width: 200px;
  }

  &.image.has-context {
    max-width: 420px;
  }

  &.video {
    width: min(360px, 100%);
    background: #000;
  }
}

.msg-attachment-thumb {
  display: block;
  max-width: 200px;
  max-height: 160px;
  object-fit: contain;
  cursor: pointer;
}

.msg-attachment.has-context .msg-attachment-thumb {
  max-width: 420px;
  max-height: 280px;
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
  background: rgba(0, 0, 0, 0.04);
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

.msg-attachment-context {
  max-width: 420px;
  padding: 7px 9px;
  border-top: 1px solid $border-light;
  color: $text-secondary;
  font-size: 11px;

  summary { cursor: pointer; user-select: none; }
  pre { max-height: 200px; margin: 8px 0 0; overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere; font: 10px/1.45 monospace; }
}

.msg-attachment-file {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 10px;
  font-size: 12px;
  color: $text-secondary;

  .att-name {
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    max-width: 160px;
  }

  .att-size {
    color: $text-muted;
    font-size: 11px;
    flex-shrink: 0;
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

    :deep(p) { margin: 0.3em 0; }
  }
}

.message-meta {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 4px;
  padding: 0 4px;
  color: $text-muted;
  opacity: 0;
  transition: opacity 0.15s ease;

  .message:hover & {
    opacity: 1;
  }

  // 移动端一直显示按钮
  @media (max-width: 768px) {
    opacity: 1;
  }
}

.copy-bubble-btn,
.reference-bubble-btn,
.speech-bubble-btn,
.fork-bubble-btn {
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

@keyframes pulse {
  0%, 100% {
    opacity: 1;
  }
  50% {
    opacity: 0.5;
  }
}

.message-time {
  font-size: 11px;
  color: inherit;
  user-select: none;
}

.tool-line {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
  color: $text-muted;
  padding: 2px 4px;
  border-radius: $radius-sm;
  min-width: 0;
  max-width: 100%;
  box-sizing: border-box;

  &.subagent-entry {
    display: inline-flex;
    width: fit-content;
    max-width: min(560px, calc(100% - 8px));

    .tool-preview {
      flex-grow: 0;
    }
  }

  &.expandable {
    cursor: pointer;

    &:hover,
    &:focus-visible {
      outline: none;
      background: rgba(0, 0, 0, 0.03);
    }
  }

  .tool-name {
    font-family: $font-code;
    flex: 0 1 auto;
    min-width: 0;
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

}

.tool-chevron {
  flex-shrink: 0;
  transition: transform 0.15s ease;

  &.rotated {
    transform: rotate(90deg);
  }
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

.tool-status-icon {
  flex: 0 0 auto;
  margin-inline-start: 4px;
}

.tool-success-icon {
  color: $success;
}

.tool-error-badge {
  color: $error;
}

.tool-details-expand {
  display: grid;
  grid-template-rows: 1fr;
  opacity: 1;
  transform: translateY(0);
}

.tool-details {
  min-height: 0;
  overflow: hidden;
  margin-inline-start: 16px;
  margin-top: 2px;
  border-inline-start: 2px solid $border-light;
  padding-inline-start: 10px;
}

.tool-detail-expand-enter-active,
.tool-detail-expand-leave-active {
  transition:
    grid-template-rows 220ms cubic-bezier(0.22, 1, 0.36, 1),
    opacity 150ms ease,
    transform 220ms cubic-bezier(0.22, 1, 0.36, 1);
}

.tool-detail-expand-enter-from,
.tool-detail-expand-leave-to {
  grid-template-rows: 0fr;
  opacity: 0;
  transform: translateY(-4px);
}

@media (prefers-reduced-motion: reduce) {
  .tool-detail-expand-enter-active,
  .tool-detail-expand-leave-active {
    transition: none;
  }
}

.tool-detail-section {
  margin-bottom: 6px;
}

.tool-detail-label {
  font-size: 10px;
  font-weight: 600;
  color: $text-muted;
  text-transform: uppercase;
  letter-spacing: 0.3px;
  margin-bottom: 2px;
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

  :deep(.hljs-unified-diff code.hljs) {
    max-height: none;
    overflow-y: visible;
    white-space: pre;
    word-break: normal;
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

.tool-change-loading {
  color: $text-muted;
  font-size: 11px;
}

.assistant-workspace-change {
  margin-top: 10px;
}

@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}

.streaming-cursor {
  display: inline-block;
  width: 2px;
  height: 1em;
  background-color: $text-muted;
  margin-inline-start: 2px;
  vertical-align: text-bottom;
  animation: blink 0.8s infinite;
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

@keyframes blink {
  0%,
  50% {
    opacity: 1;
  }
  51%,
  100% {
    opacity: 0;
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
  .message.user .msg-body {
    max-width: 100%;
  }

  .message.assistant .msg-body {
    max-width: 100%;
  }

  .message.system .msg-body {
    max-width: 100%;
  }

  :global(.tool-change-drawer-header) {
    padding-inline-start: 12px !important;
    padding-inline-end: 12px !important;
  }

  :global(.tool-change-drawer-body-content) {
    padding-inline-start: 8px !important;
    padding-inline-end: 8px !important;
  }
}
</style>
