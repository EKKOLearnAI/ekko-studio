<script setup lang="ts">
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { NTooltip } from 'naive-ui'
import type { Message } from '@/stores/hermes/chat'
import { mapHermesMessages } from '@/stores/hermes/chat'
import { fetchHermesSession } from '@/api/studio/sessions'

interface OutlineItem {
  id: string
  type: 'user' | 'outline'
  content: string
  messageId: string
  level: number
  anchorId: string
  isAnswer?: boolean
}

const props = defineProps<{
  messages: Message[]
  sessionId?: string
  sessionProfile?: string | null
  showLoadAll?: boolean
}>()

const emit = defineEmits<{
  navigate: [target: { messageId: string; anchorId: string }]
  messagesLoaded: [messages: Message[]]
}>()

const { t } = useI18n()
const localFetching = ref(false)

async function handleLoadAll() {
  if (!props.sessionId) return

  localFetching.value = true
  try {
    const sessionDetail = await fetchHermesSession(props.sessionId, props.sessionProfile)
    if (sessionDetail && sessionDetail.messages) {
      const mapped = mapHermesMessages(sessionDetail.messages)
      emit('messagesLoaded', mapped)
    }
  } finally {
    localFetching.value = false
  }
}

// 清洗内联 markdown：链接→文字、加粗/斜体/代码标记去掉、
// 去掉行首的列表符号和 emoji/符号（✅ ⚠️ 📌 等）
function cleanOutlineText(text: string): string {
  let out = text
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')        // [text](url) → text
    .replace(/[*_`~]{1,3}([^*_`~]+)[*_`~]{1,3}/g, '$1') // **b** / *i* / `c`
    .replace(/^[#>\-\*\+\s\u200b]+/, '')              // 行首列表/引用符号
    .replace(/^[\p{Extended_Pictographic}\u2600-\u27bf\u2b00-\u2bff\ufe0f\s]+/u, '') // 行首 emoji
    .trim()
  return out
}

// 用户消息可能是 multimodal JSON 数组，提取纯文本
function extractMessageText(content: string): string {
  if (!content) return ''
  const t = content.trim()
  if (t.startsWith('[') || t.startsWith('{')) {
    try {
      const parsed = JSON.parse(t)
      const parts = Array.isArray(parsed) ? parsed : [parsed]
      const texts = parts
        .filter((p: any) => p && (p.type === 'text' || typeof p.text === 'string'))
        .map((p: any) => String(p.text || '').trim())
        .filter(Boolean)
      if (texts.length) return texts.join('\n')
    } catch {
      // 不是合法 JSON，按原文处理
    }
  }
  return content
}

function extractUserQuestion(text: string): string {
  const cleanedText = extractMessageText(text).replace(/<think>[\s\S]*?<\/think>/g, '')
  const lines = cleanedText.split('\n')
  for (const rawLine of lines) {
    const line = cleanOutlineText(rawLine)
    if (!line) continue
    if (line.length > 50) {
      return line.slice(0, 50) + '...'
    }
    return line
  }
  return t('chat.outlineUserQuestion')
}

function extractAnswerSummary(text: string): string {
  const cleanedText = text.replace(/<think>[\s\S]*?<\/think>/g, '')
  const lines = cleanedText.split('\n')
  for (const rawLine of lines) {
    const line = rawLine.trim()
    if (!line) continue
    // 跳过 markdown 标题/列表/引用符号，取第一条真正的正文行
    if (/^#{1,6}\s/.test(line)) continue
    const stripped = cleanOutlineText(line)
    if (!stripped) continue
    if (stripped.length > 50) {
      return stripped.slice(0, 50) + '...'
    }
    return stripped
  }
  return t('chat.outlineAnswer')
}

const outlineItems = computed<OutlineItem[]>(() => {
  const items: OutlineItem[] = []
  let i = 0
  const filteredMessages = props.messages.filter(m => m.role === 'user' || m.role === 'assistant')
  
  while (i < filteredMessages.length) {
    const msg = filteredMessages[i]
    if (msg.role === 'user') {
      items.push({
        id: `user-${msg.id}`,
        type: 'user',
        content: extractUserQuestion(msg.content || ''),
        messageId: msg.id,
        level: 0,
        anchorId: `message-${msg.id}`
      })
      i++
      // 一次回答可能拆成多条 assistant 行（tool-call 空行 + 正文行），
      // 扫完整个连续 assistant 段，取首条非空正文行作为 A 摘要。
      // 大纲只展示 Q&A 对，不混入回答里的 markdown 标题。
      let answerShown = false
      while (i < filteredMessages.length && filteredMessages[i].role === 'assistant') {
        const assistantMsg = filteredMessages[i]
        if (assistantMsg.content && assistantMsg.content.trim() && !answerShown) {
          items.push({
            id: `answer-${assistantMsg.id}`,
            type: 'outline',
            content: extractAnswerSummary(assistantMsg.content),
            messageId: assistantMsg.id,
            level: 1,
            anchorId: `message-${assistantMsg.id}`,
            isAnswer: true,
          })
          answerShown = true
        }
        i++
      }
    } else {
      i++
    }
  }
  return items
})

function scrollToTarget(item: OutlineItem) {
  emit('navigate', {
    messageId: item.messageId,
    anchorId: item.anchorId,
  })
}
</script>

<template>
  <div class="outline-panel">
    <div class="outline-header">
      <span class="outline-title">{{ t('chat.outlineTitle') }}</span>
      <NTooltip v-if="showLoadAll" trigger="hover" placement="top">
        <template #trigger>
          <button
            type="button"
            class="load-all-btn"
            :disabled="localFetching"
            @click="handleLoadAll"
          >
            <svg
              v-if="localFetching"
              width="12"
              height="12"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              class="load-all-spinner"
            >
              <path d="M21 12a9 9 0 11-6.219-8.56" />
            </svg>
            <svg
              v-else
              width="12"
              height="12"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
            >
              <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4" />
              <polyline points="7 10 12 15 17 10" />
              <line x1="12" y1="15" x2="12" y2="3" />
            </svg>
          </button>
        </template>
        {{ t('chat.loadAllMessages') }}
      </NTooltip>
    </div>
    <div class="outline-content">
      <template v-if="outlineItems.length > 0">
        <template v-for="item in outlineItems" :key="item.id">
          <div
            v-if="item.type === 'user'"
            class="outline-item user-item"
            @click="scrollToTarget(item)"
          >
            <div class="user-question">
              <span class="q-label">Q:</span>
              <span class="q-text" dir="auto">{{ item.content }}</span>
            </div>
          </div>
          <div
            v-else-if="item.isAnswer"
            class="outline-item answer-item"
            @click="scrollToTarget(item)"
          >
            <div class="user-question">
              <span class="q-label a-label">A:</span>
              <span class="q-text" dir="auto">{{ item.content }}</span>
            </div>
          </div>
          <div
            v-else
            class="outline-item outline-heading-item"
            :class="`level-${item.level}`"
            @click="scrollToTarget(item)"
          >
            <div class="heading-item">
              <span class="heading-text" dir="auto">{{ item.content }}</span>
            </div>
          </div>
        </template>
      </template>
      <div v-else class="outline-empty">{{ t('chat.outlineEmpty') }}</div>
    </div>
  </div>
</template>

<style scoped lang="scss">
@use "@/styles/variables" as *;

.outline-panel {
  display: flex;
  flex-direction: column;
  height: 100%;
  background-color: $bg-main-surface;
  border-inline-start: 1px solid $border-color;
  width: 280px;
  flex-shrink: 0;

  @media (max-width: $breakpoint-mobile) {
    position: absolute;
    top: 0;
    right: 0;
    bottom: 0;
    width: min(280px, 86vw);
    z-index: 8;
    box-shadow: -4px 0 16px rgba(0, 0, 0, 0.12);
  }
}

.outline-header {
  padding: 16px;
  border-bottom: 1px solid $border-color;
  flex-shrink: 0;
  display: flex;
  align-items: center;
  gap: 8px;
}

.outline-title {
  flex: 1;
  font-size: 14px;
  font-weight: 600;
  color: $text-primary;
}

.outline-content {
  flex: 1;
  overflow-y: auto;
  padding: 12px;
}

.outline-item {
  margin-bottom: 4px;
  cursor: pointer;
  transition: opacity 0.2s ease;

  &:hover {
    opacity: 0.8;
  }
}

.user-item {
  margin-bottom: 6px;
}

.answer-item {
  margin-bottom: 10px;
  margin-top: 2px;

  .user-question {
    background-color: rgba(var(--success-rgb), 0.12);
    padding: 8px 12px;

    .dark & {
      background-color: rgba(var(--success-rgb), 0.14);
    }

    .a-label {
      color: $success;
    }
  }
}

.user-question {
  background-color: $bg-secondary;
  color: $text-primary;
  padding: 8px 12px;
  border-radius: 8px;
  display: flex;
  align-items: flex-start;
  gap: 6px;

  .dark & {
    background-color: $bg-input;
  }

  .q-label {
    font-weight: 600;
    flex-shrink: 0;
    font-size: 13px;
    line-height: 1.4;
  }

  .q-text {
    font-size: 13px;
    line-height: 1.4;
    word-break: break-word;
  }
}

.outline-heading-item {
  &.level-1 {
    padding-inline-start: 0;
  }

  &.level-2 {
    padding-inline-start: 12px;
  }

  &.level-3 {
    padding-inline-start: 24px;
  }
}

.heading-item {
  display: flex;
  align-items: flex-start;
  gap: 6px;
  padding: 4px 8px;
  border-radius: 4px;
  transition: background-color 0.15s ease;

  &:hover {
    background-color: rgba(0, 0, 0, 0.04);

    .dark & {
      background-color: rgba(255, 255, 255, 0.06);
    }
  }

  .level-1 & {
    .heading-marker {
      color: $text-primary;
      font-weight: 600;
    }
    .heading-text {
      color: $text-primary;
      font-weight: 500;
    }
  }

  .level-2 & {
    .heading-marker {
      color: $text-secondary;
    }
    .heading-text {
      color: $text-secondary;
    }
  }

  .level-3 & {
    .heading-marker {
      color: $text-muted;
    }
    .heading-text {
      color: $text-muted;
      font-size: 12px;
    }
  }
}

.heading-text {
  font-size: 13px;
  line-height: 1.4;
  word-break: break-word;
}

.outline-empty {
  text-align: center;
  color: $text-muted;
  font-size: 13px;
  padding: 20px 0;
}

.load-all-btn {
  all: unset;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 2px 6px;
  border-radius: 4px;
  font-size: 11px;
  color: $text-muted;
  background: transparent;
  transition: all 0.15s ease;
  white-space: nowrap;

  &:hover {
    color: $text-primary;
    background: $bg-secondary;

    .dark & {
      background: $bg-input;
    }
  }

  &:active {
    opacity: 0.7;
  }

  &:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
}

.load-all-spinner {
  animation: spin 1s linear infinite;
}

@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}
</style>
