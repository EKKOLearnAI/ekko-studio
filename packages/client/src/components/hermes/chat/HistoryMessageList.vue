<script lang="ts">
import type { MessageViewportScrollSnapshot } from "./message-scroll-position";

const historySessionScrollPositions = new Map<string, MessageViewportScrollSnapshot>();
</script>

<script setup lang="ts">
import { ref, computed, nextTick, onBeforeUnmount, onMounted, watch } from "vue";
import { useI18n } from "vue-i18n";
import VirtualMessageList from "./VirtualMessageList.vue";
import MessageItem from "./MessageItem.vue";
import { positionTaskPlansAtTurnEnd } from "@/utils/task-plan";
import ToolRunCard from "./ToolRunCard.vue";
import { useChatStore } from "@/stores/hermes/chat";
import { useToolTraceVisibility } from "@/composables/useToolTraceVisibility";
import type { Session } from "@/stores/hermes/chat";
import { messageScrollPositionKey, rememberMessageScrollPosition } from "./message-scroll-position";
import { chatSessionAgentAvatar } from "@/utils/chat-agent-avatar";
import { groupCompletedToolsByRun } from "./tool-run-grouping";

const props = withDefaults(defineProps<{
  session?: Session | null; // Optional: use this session instead of chatStore.activeSession
  loadOlder?: (sessionId: string) => Promise<boolean>;
  scrollScope?: string;
}>(), {
  scrollScope: "history",
});

const chatStore = useChatStore();
const { toolTraceVisible } = useToolTraceVisibility();
const { t } = useI18n();
const listRef = ref<InstanceType<typeof VirtualMessageList> | null>(null);
const pendingInitialScrollKey = ref<string | null>(null);
const showScrollBottomButton = ref(false);
const activeSession = computed(() => props.session || null);
const assistantAgent = computed(() => chatSessionAgentAvatar(activeSession.value));
const activeSessionScrollKey = computed(() =>
  messageScrollPositionKey(props.scrollScope, activeSession.value),
);
const listInstanceKey = computed(() => activeSessionScrollKey.value || "history-empty");

const displayMessages = computed(() =>
  groupCompletedToolsByRun(positionTaskPlansAtTurnEnd((activeSession.value?.messages || []).filter((m) => {
    // Tool messages without a name are internal use only and remain hidden.
    if (m.taskPlan) return true
    if (m.role === 'tool') return toolTraceVisible.value && !!m.toolName
    // Filter out messages with empty content.
    if (!m.content?.trim()) return false
    return true
  }))),
);

function isNearBottom(threshold = 200): boolean {
  return listRef.value?.isNearBottom(threshold) ?? true;
}

function scrollToBottom() {
  listRef.value?.scrollToBottom();
  showScrollBottomButton.value = false;
}

function scrollToMessage(messageId: string) {
  listRef.value?.scrollToMessage(messageId);
}

function scrollToAnchor(messageId: string, anchorId: string) {
  listRef.value?.scrollToAnchor(messageId, anchorId);
}

function updateScrollBottomButton() {
  showScrollBottomButton.value = displayMessages.value.length > 0 && !isNearBottom(1000);
}

function handleListScroll() {
  updateScrollBottomButton();
}

function handleScrollBottomClick() {
  scrollToBottom();
}

function saveSessionScrollPosition(scrollKey: string | null | undefined) {
  if (!scrollKey) return;
  const snapshot = listRef.value?.captureViewportPosition() ?? null;
  if (snapshot) rememberMessageScrollPosition(historySessionScrollPositions, scrollKey, snapshot);
}

function applyInitialSessionScroll(scrollKey: string) {
  if (activeSessionScrollKey.value !== scrollKey) return;
  if (chatStore.focusMessageId) {
    pendingInitialScrollKey.value = null;
    scrollToMessage(chatStore.focusMessageId);
    return;
  }

  const snapshot = historySessionScrollPositions.get(scrollKey);
  if (snapshot) {
    pendingInitialScrollKey.value = null;
    if (snapshot.wasNearBottom) {
      scrollToBottom();
    } else {
      listRef.value?.restoreViewportPosition(snapshot);
    }
    return;
  }

  scrollToBottom();
  if ((activeSession.value?.messages.length || 0) > 0) pendingInitialScrollKey.value = null;
}

async function handleTopReach() {
  const session = activeSession.value;
  if (!session?.hasMoreBefore || session.isLoadingOlderMessages || !props.loadOlder) return;
  const snapshot = listRef.value?.captureScrollPosition() ?? null;
  const loaded = await props.loadOlder(session.id);
  if (!loaded) return;
  await nextTick();
  listRef.value?.restoreScrollPosition(snapshot);
  updateScrollBottomButton();
}

watch(
  activeSessionScrollKey,
  async (scrollKey, previousScrollKey) => {
    saveSessionScrollPosition(previousScrollKey);
    if (!scrollKey) return;
    pendingInitialScrollKey.value = scrollKey;
    await nextTick();
    applyInitialSessionScroll(scrollKey);
  },
  { immediate: true },
);

watch(
  () => chatStore.focusMessageId,
  (messageId) => {
    if (!messageId) return;
    scrollToMessage(messageId);
  },
);

// During streaming, only auto-scroll if the user is already near the bottom
watch(
  () => (activeSession.value?.messages || [])[((activeSession.value?.messages || []).length - 1)]?.content,
  (content) => {
    if (pendingInitialScrollKey.value === activeSessionScrollKey.value) return;
    if (!content) return
    if (!isNearBottom()) return;
    scrollToBottom();
  },
);

watch(
  () => (activeSession.value?.messages || []).length,
  (length) => {
    if (length === 0) return
    const scrollKey = activeSessionScrollKey.value
    if (scrollKey && pendingInitialScrollKey.value === scrollKey) {
      applyInitialSessionScroll(scrollKey);
      return;
    }
    if (!isNearBottom()) return;
    scrollToBottom();
    void nextTick(updateScrollBottomButton);
  },
  { flush: "post" },
);

watch(
  () => displayMessages.value.length,
  () => {
    void nextTick(updateScrollBottomButton);
  },
  { flush: "post" },
);

onBeforeUnmount(() => {
  saveSessionScrollPosition(activeSessionScrollKey.value);
});

onMounted(() => {
  void nextTick(updateScrollBottomButton);
});

defineExpose({
  scrollToBottom,
  scrollToMessage,
  scrollToAnchor,
});
</script>

<template>
  <div class="history-message-list-shell">
    <VirtualMessageList
      :key="listInstanceKey"
      ref="listRef"
      :messages="displayMessages"
      @scroll="handleListScroll"
      @top-reach="handleTopReach"
    >
      <template #empty>
        <div class="empty-state">
          <img :src="assistantAgent.src" :alt="assistantAgent.label" class="empty-logo" />
          <p>{{ t("chat.emptyState") }}</p>
        </div>
      </template>
      <template #before>
        <div
          v-if="activeSession?.hasMoreBefore || activeSession?.isLoadingOlderMessages"
          class="history-loader"
        >
          <span v-if="activeSession?.isLoadingOlderMessages" class="history-loader-spinner"></span>
        </div>
      </template>
      <template #item="{ message: msg }">
        <ToolRunCard
          v-if="msg.systemType === 'tool-run' && msg.toolRunId && msg.toolMessages"
          :run-id="msg.toolRunId"
          :tools="msg.toolMessages"
        />
        <MessageItem
          v-else
          :message="msg"
          :assistant-agent="assistantAgent"
          :highlight="chatStore.focusMessageId === msg.id"
        />
      </template>
    </VirtualMessageList>
    <button
      v-if="showScrollBottomButton"
      type="button"
      class="scroll-bottom-button"
      :aria-label="t('chat.scrollToBottom')"
      :title="t('chat.scrollToBottom')"
      @click="handleScrollBottomClick"
    >
      <svg
        class="scroll-bottom-icon"
        viewBox="0 0 24 24"
        aria-hidden="true"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
      >
        <path d="m7 10 5 5 5-5" />
        <path d="M6 19h12" />
      </svg>
    </button>
  </div>
</template>

<style scoped lang="scss">
@use "@/styles/variables" as *;

.history-message-list-shell {
  flex: 1;
  min-height: 0;
  min-width: 0;
  position: relative;
  display: flex;
  animation: history-message-surface-fade-in 1.5s ease both;
}

@keyframes history-message-surface-fade-in {
  from {
    opacity: 0;
  }

  to {
    opacity: 1;
  }
}

.empty-state {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  color: $text-muted;
  gap: 12px;

  .empty-logo {
    width: 48px;
    height: 48px;
    opacity: 0.25;
  }

  p {
    font-size: 14px;
  }
}

.history-loader {
  height: 28px;
  display: flex;
  align-items: center;
  justify-content: center;
  flex: 0 0 auto;
}

.history-loader-spinner {
  width: 14px;
  height: 14px;
  border: 2px solid rgba(0, 0, 0, 0.16);
  border-top-color: $accent-primary;
  border-radius: 50%;
  animation: spin 0.7s linear infinite;

  .dark & {
    border-color: rgba(255, 255, 255, 0.18);
    border-top-color: $accent-primary;
  }
}

.scroll-bottom-button {
  position: absolute;
  right: 18px;
  bottom: 18px;
  z-index: 7;
  width: 38px;
  height: 38px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 999px;
  border: 1px solid rgba(var(--accent-primary-rgb), 0.24);
  background: rgba(255, 255, 255, 0.94);
  color: var(--accent-primary);
  box-shadow: 0 10px 28px rgba(0, 0, 0, 0.16);
  padding: 0;
  cursor: pointer;

  .dark & {
    background: rgba(38, 38, 38, 0.94);
  }
}

.scroll-bottom-button:hover {
  background: rgba(var(--accent-primary-rgb), 0.1);
}

.scroll-bottom-icon {
  width: 19px;
  height: 19px;
}

@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}

.fade-enter-active,
.fade-leave-active {
  transition: opacity 0.4s ease;
}
.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}
</style>
