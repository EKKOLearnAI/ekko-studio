<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import type { Message } from '@/stores/hermes/chat'

interface OutlineItem {
  id: string
  type: 'user' | 'outline'
  content: string
  messageId: string
  level: number
  anchorId: string
}

const props = defineProps<{
  messages: Message[]
}>()

const emit = defineEmits<{
  navigate: [target: { messageId: string; anchorId: string }]
}>()

const { t } = useI18n()

function extractAllHeadings(text: string, messageId: string): OutlineItem[] {
  const items: OutlineItem[] = []
  let cleanedText = text.replace(/<think>[\s\S]*?<\/think>/g, '')
  const lines = cleanedText.split('\n')
  
  let headingIndex = 0
  for (const line of lines) {
    const trimmed = line.trim()
    const h1Match = trimmed.match(/^#\s+(.+)/)
    const h2Match = trimmed.match(/^##\s+(.+)/)
    const h3Match = trimmed.match(/^###\s+(.+)/)
    
    if (h1Match) {
      headingIndex++
      items.push({
        id: `outline-${messageId}-h${headingIndex}`,
        type: 'outline',
        content: h1Match[1].trim(),
        messageId,
        level: 1,
        anchorId: `msg-${messageId}-heading-${headingIndex}`
      })
    } else if (h2Match) {
      headingIndex++
      items.push({
        id: `outline-${messageId}-h${headingIndex}`,
        type: 'outline',
        content: h2Match[1].trim(),
        messageId,
        level: 2,
        anchorId: `msg-${messageId}-heading-${headingIndex}`
      })
    } else if (h3Match) {
      headingIndex++
      items.push({
        id: `outline-${messageId}-h${headingIndex}`,
        type: 'outline',
        content: h3Match[1].trim(),
        messageId,
        level: 3,
        anchorId: `msg-${messageId}-heading-${headingIndex}`
      })
    }
  }
  
  return items
}

function extractUserQuestion(text: string): string {
  const cleanedText = text.replace(/<think>[\s\S]*?<\/think>/g, '')
  const firstLine = cleanedText.split('\n')[0] || ''
  if (firstLine.length > 50) {
    return firstLine.slice(0, 50) + '...'
  }
  return firstLine || t('chat.outlineUserQuestion')
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
      while (i < filteredMessages.length && filteredMessages[i].role !== 'assistant') {
        i++
      }
      if (i < filteredMessages.length) {
        const assistantMsg = filteredMessages[i]
        const headings = extractAllHeadings(assistantMsg.content || '', assistantMsg.id)
        items.push(...headings)
      }
    }
    i++
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
  background-color: var(--theme-content-bg, $bg-main-surface);
  border-inline-start: var(--border-width, 1px) solid $border-color;
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
  padding: calc(16px * var(--spacing-scale, 1));
  border-bottom: var(--border-width, 1px) solid $border-color;
  flex-shrink: 0;
}

.outline-title {
  font-size: calc(var(--font-size-base, 14px) * 14 / 14);
  font-weight: 600;
  color: $text-primary;
}

.outline-content {
  flex: 1;
  overflow-y: auto;
  padding: calc(12px * var(--spacing-scale, 1));
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

.user-question {
  background-color: $bg-secondary;
  color: $text-primary;
  padding: calc(8px * var(--spacing-scale, 1)) calc(12px * var(--spacing-scale, 1));
  border-radius: var(--radius-component, 8px);
  display: flex;
  align-items: flex-start;
  gap: calc(6px * var(--spacing-scale, 1));

  .dark & {
    background-color: var(--theme-input-bg, $bg-input);
  }

  .q-label {
    font-weight: 600;
    flex-shrink: 0;
    font-size: calc(var(--font-size-base, 14px) * 13 / 14);
    line-height: var(--line-height, 1.4);
  }

  .q-text {
    font-size: calc(var(--font-size-base, 14px) * 13 / 14);
    line-height: var(--line-height, 1.4);
    word-break: break-word;
  }
}

.outline-heading-item {
  &.level-1 {
    padding-inline-start: 0;
  }

  &.level-2 {
    padding-inline-start: calc(12px * var(--spacing-scale, 1));
  }

  &.level-3 {
    padding-inline-start: calc(24px * var(--spacing-scale, 1));
  }
}

.heading-item {
  display: flex;
  align-items: flex-start;
  gap: calc(6px * var(--spacing-scale, 1));
  padding: calc(4px * var(--spacing-scale, 1)) calc(8px * var(--spacing-scale, 1));
  border-radius: var(--radius-component, 4px);
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
      font-size: calc(var(--font-size-base, 14px) * 12 / 14);
    }
  }
}

.heading-text {
  font-size: calc(var(--font-size-base, 14px) * 13 / 14);
  line-height: var(--line-height, 1.4);
  word-break: break-word;
}

.outline-empty {
  text-align: center;
  color: $text-muted;
  font-size: calc(var(--font-size-base, 14px) * 13 / 14);
  padding: calc(20px * var(--spacing-scale, 1)) 0;
}
</style>
