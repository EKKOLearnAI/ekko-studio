<script setup lang="ts">
import { computed, onMounted, onBeforeUnmount, ref, watch, nextTick } from 'vue'
import { NButton, NCheckbox, NDropdown, NModal, NSpin } from 'naive-ui'
import { desktopBridge } from '@/utils/desktop-bridge'
import type { ChatMessage } from '@/api/studio/group-chat'
import { useGroupMessageSelection } from './useGroupMessageSelection'
import { useI18n } from 'vue-i18n'
import { groupAgentRunMessages, useGroupChatStore } from '@/stores/hermes/group-chat'
import type { RoomAgentHandoffChain } from '@/api/studio/group-chat'
import { handoffErrorTranslationKey, isPresentableHandoffChain } from './handoff-presentation'
import { useToolTraceVisibility } from '@/composables/useToolTraceVisibility'
import GroupMessageItem from './GroupMessageItem.vue'
import GroupAgentRunCard from './GroupAgentRunCard.vue'
import VirtualMessageList from '../chat/VirtualMessageList.vue'

const store = useGroupChatStore()
const props = withDefaults(defineProps<{
    allowSpeech?: boolean
    canManageHandoff?: boolean
    allowMessageDeletion?: boolean
}>(), {
    allowSpeech: true,
    canManageHandoff: false,
    allowMessageDeletion: false,
})
const emit = defineEmits<{
    mentionAgent: [agent: import('@/api/studio/group-chat').RoomAgent]
    continueHandoff: [chainId: string]
    adjustHandoffSettings: []
}>()
const { t } = useI18n()
const { toolTraceVisible } = useToolTraceVisibility()
const listRef = ref<InstanceType<typeof VirtualMessageList> | null>(null)
const showScrollBottomButton = ref(false)
const emptyStateAgents = [
    { name: 'Hermes', src: '/coding-agents/hermes.png' },
    { name: 'Ekko', src: '/coding-agents/ekko-agent.png' },
    { name: 'Codex', src: '/coding-agents/codex-openai.png' },
    { name: 'Claude', src: '/coding-agents/claude-code.svg' },
    { name: 'Pi', src: '/coding-agents/pi.svg' },
    { name: 'Grok', src: '/coding-agents/grok.svg' },
    { name: 'OpenCode', src: '/coding-agents/opencode.png' },
    { name: 'DeepSeek Harness', src: '/coding-agents/deepseek.svg' },
]
const displayMessages = computed(() => groupAgentRunMessages(store.sortedMessages.filter(msg =>
    msg.role !== 'tool' ||
    toolTraceVisible.value ||
    msg.toolStatus === 'running',
)))
const supportsMessageSelection = computed(() => props.allowMessageDeletion && !store.inviteGuest)
const {
    selecting, loading: selectionLoading, deleting: deletingMessages, selected: selectedMessages,
    unavailable: selectionUnavailable, groupFor,
    start: startSelection, cancel: cancelSelection, toggle: toggleSelection, remove: deleteSelectedMessages,
} = useGroupMessageSelection(displayMessages, supportsMessageSelection)
const showDeleteConfirmation = ref(false)
watch(selecting, value => { if (!value) showDeleteConfirmation.value = false })
const selectionMenu = ref({ show: false, x: 0, y: 0 });
const selectionMenuOptions = computed(() => [{
  key: 'select-messages', label: t('chat.selectMessages'), disabled: selectionUnavailable.value,
}]);
const desktopMessageMenu = desktopBridge()?.isDesktop ? desktopBridge()?.messageContextMenu : undefined;
let selectionMenuGeneration = 0;
let nativeSelectionMenuOpen = false;
function closeSelectionMenu() {
  selectionMenuGeneration += 1;
  selectionMenu.value.show = false;
  if (nativeSelectionMenuOpen) {
    nativeSelectionMenuOpen = false;
    void desktopMessageMenu?.close().catch(() => undefined);
  }
}
async function openSelectionMenu(event: MouseEvent) {
  if (!supportsMessageSelection.value || selecting.value) return;
  const target = event.target instanceof Element ? event.target : null;
  // Child menus and editable fields retain their own native editing actions.
  if (event.defaultPrevented
    || target?.closest('input, textarea, select')
    || (target instanceof HTMLElement && target.isContentEditable)) {
    closeSelectionMenu();
    return;
  }
  const hasSelection = !!window.getSelection()?.toString();
  if (desktopMessageMenu) {
    event.preventDefault();
    event.stopPropagation();
    selectionMenu.value.show = false;
    const generation = ++selectionMenuGeneration;
    nativeSelectionMenuOpen = true;
    try {
      const action = await desktopMessageMenu.show({
        label: t('chat.selectMessages'), enabled: !selectionUnavailable.value, hasSelection,
      });
      if (generation !== selectionMenuGeneration) return;
      nativeSelectionMenuOpen = false;
      if (action === 'select-messages' && supportsMessageSelection.value && !selectionUnavailable.value && !selecting.value) {
        window.getSelection()?.removeAllRanges();
        void startSelection();
      }
    } catch (error) {
      console.warn('[group-chat] Could not open native message menu', error);
      if (generation === selectionMenuGeneration && !hasSelection) {
        selectionMenu.value = { show: true, x: event.clientX, y: event.clientY };
      }
    } finally {
      if (generation === selectionMenuGeneration) nativeSelectionMenuOpen = false;
    }
    return;
  }
  // On the web (and older desktop shells), preserve the browser Copy menu.
  if (hasSelection) {
    selectionMenu.value.show = false;
    return;
  }
  event.preventDefault();
  event.stopPropagation();
  selectionMenu.value = { show: true, x: event.clientX, y: event.clientY };
}
function selectFromMenu() {
  selectionMenu.value.show = false;
  void startSelection();
}

function handleSelectionRowClick(event: MouseEvent, message: ChatMessage) {
    if (!selecting.value) return
    if (event.target instanceof Element && event.target.closest('.message-selection-checkbox')) return
    event.preventDefault()
    event.stopPropagation()
    if (window.getSelection()?.toString()) return
    const group = groupFor(message)
    if (!group || group.deleteBlockedReason || selectionUnavailable.value) return
    toggleSelection(group.id, !selectedMessages.value.has(group.id))
}
watch([() => store.currentRoomId, supportsMessageSelection, selectionUnavailable, selecting], closeSelectionMenu, { flush: 'sync' })
onBeforeUnmount(closeSelectionMenu)

const summaryAnchorMessageId = computed(() => {
    const roomId = store.currentRoomId
    return roomId ? String(store.roomSummaryStates.get(roomId)?.summaryThroughMessageId || '') : ''
})
const listPadding = computed(() => store.activePendingApproval ? '16px 20px 260px' : '16px 20px')
let pendingInitialBottomRoomId: string | null = store.currentRoomId

type BottomScrollOptions = number | {
    frames?: number
    keepAliveMs?: number
}

function scrollToBottom(options?: BottomScrollOptions): void {
    const list = listRef.value as (InstanceType<typeof VirtualMessageList> & {
        scrollToBottom: (options?: BottomScrollOptions) => void
    }) | null
    list?.scrollToBottom(options)
    showScrollBottomButton.value = false
}

function containsSummaryAnchor(message: import('@/api/studio/group-chat').ChatMessage): boolean {
    const anchorId = summaryAnchorMessageId.value
    return !!anchorId && (message.runItems || [message]).some(item => item.id === anchorId)
}

function handoffChainFor(message: import('@/api/studio/group-chat').ChatMessage): RoomAgentHandoffChain | null {
    const messageIds = new Set((message.runItems || [message]).map(item => item.id))
    return [...store.handoffChains.values()].find(chain =>
        isPresentableHandoffChain(chain) && messageIds.has(chain.sourceMessageId)
    ) || null
}

function targetAgentName(chain: RoomAgentHandoffChain): string {
    return store.messageAgents.find(agent => agent.agentId === chain.targetAgentId)?.name || chain.targetAgentId || '—'
}

function handoffErrorText(error: string | null | undefined): string {
    const key = handoffErrorTranslationKey(error)
    return key ? t(key) : ''
}

function routingDecision(message: import('@/api/studio/group-chat').ChatMessage) { return store.messageRoutingDecisions.get(message.id) }

function isOtherMemberMessage(message: import('@/api/studio/group-chat').ChatMessage): boolean {
    if (!store.userId || message.senderId === store.userId) return false
    return store.members.some(member =>
        member.userId === message.senderId ||
        member.name === message.senderName
    )
}

function stableMessageAgentId(message: import('@/api/studio/group-chat').ChatMessage): string {
    if (message.senderAgentRecordId) return message.senderAgentRecordId
    return store.messageAgents.find(agent => agent.agentId === message.senderId)?.id
        || message.senderId
}

function updateScrollBottomButton(): void {
    showScrollBottomButton.value = displayMessages.value.length > 0 && !(listRef.value?.isNearBottom(1000) ?? true)
}

function handleListScroll(): void {
    updateScrollBottomButton()
}

function handleScrollBottomClick(): void {
    scrollToBottom({ frames: 4, keepAliveMs: 600 })
}

async function handleTopReach(): Promise<void> {
    if (!store.hasMoreBefore || store.isLoadingOlderMessages) return
    const snapshot = listRef.value?.captureViewportPosition() ?? null
    const loaded = await store.loadOlderMessages()
    if (!loaded) return
    await nextTick()
    listRef.value?.restoreViewportPosition(snapshot, 30)
    updateScrollBottomButton()
}

function retryOlderMessages(): void {
    void handleTopReach()
}

watch(() => store.currentRoomId, (roomId) => {
    pendingInitialBottomRoomId = roomId
})

watch(() => displayMessages.value.map(msg =>
    (msg.runItems || [msg]).map(item => [
        item.id,
        item.content?.length ?? 0,
        item.reasoning?.length ?? 0,
        item.reasoning_content?.length ?? 0,
        item.toolStatus ?? '',
    ].join(':')).join(','),
).join('|'), async () => {
    const shouldForceInitialBottom = !!store.currentRoomId &&
        pendingInitialBottomRoomId === store.currentRoomId &&
        displayMessages.value.length > 0
    const shouldScroll = shouldForceInitialBottom || (listRef.value?.isNearBottom(200) ?? true)
    await nextTick()
    if (shouldScroll) {
        scrollToBottom(shouldForceInitialBottom ? { frames: 5, keepAliveMs: 700 } : { frames: 1, keepAliveMs: 120 })
        if (shouldForceInitialBottom) pendingInitialBottomRoomId = null
    }
    updateScrollBottomButton()
})

onMounted(async () => {
    if (!store.currentRoomId || displayMessages.value.length === 0) return
    pendingInitialBottomRoomId = null
    await nextTick()
    scrollToBottom({ frames: 5, keepAliveMs: 700 })
    updateScrollBottomButton()
})

defineExpose({ scrollToBottom })
</script>

<template>
    <div class="group-message-list-shell">
        <NDropdown trigger="manual" placement="bottom-start" :show="selectionMenu.show"
            :x="selectionMenu.x" :y="selectionMenu.y" :options="selectionMenuOptions"
            @select="selectFromMenu" @clickoutside="selectionMenu.show = false" @update:show="selectionMenu.show = $event" />
        <NSpin v-if="selectionLoading" size="small" />
        <NModal v-if="selecting" type="warning" v-model:show="showDeleteConfirmation" preset="dialog" :style="{ width: 'min(460px, calc(100vw - 32px))' }"
            :title="t('chat.deleteSelectedMessages')" :content="t('chat.deleteMessagesConfirm', { count: selectedMessages.size })"
            :positive-text="t('common.delete')" :negative-text="t('common.cancel')"
            :positive-button-props="{ loading: deletingMessages, disabled: selectionUnavailable }"
            :negative-button-props="{ disabled: deletingMessages }" :mask-closable="!deletingMessages" :closable="!deletingMessages"
            @positive-click="deleteSelectedMessages" />
        <div class="group-message-scroll-region">
            <VirtualMessageList
                class="group-message-list"
                ref="listRef"
                :messages="displayMessages"
                :virtualized="false"
                :estimated-item-height="170"
                :row-gap="12"
                :padding="listPadding"
                @scroll="handleListScroll"
                @top-reach="handleTopReach"
            >
                <template #empty>
                    <div class="empty-state">
                        <div class="empty-agent-avatars">
                            <span
                                v-for="agent in emptyStateAgents"
                                :key="agent.name"
                                class="empty-agent-avatar"
                            >
                                <img :src="agent.src" :alt="agent.name" />
                            </span>
                        </div>
                        <p>{{ t('groupChat.emptyState') }}</p>
                    </div>
                </template>
                <template #before>
                    <div
                        v-if="store.olderMessagesError"
                        class="history-load-error"
                        role="alert"
                    >
                        <span>{{ t('groupChat.olderMessagesLoadFailed') }}</span>
                        <button type="button" @click="retryOlderMessages">
                            {{ t('groupChat.retryOlderMessages') }}
                        </button>
                    </div>
                    <div
                        v-else-if="store.hasMoreBefore || store.isLoadingOlderMessages"
                        class="history-loader"
                    >
                        <span v-if="store.isLoadingOlderMessages" class="history-loader-spinner" role="status" :aria-label="t('common.loading')"></span>
                    </div>
                </template>
                <template #item="{ message: msg }">
                    <div :data-group-message-id="msg.id"
                        :class="{
                            'message-selection-row': selecting,
                            'message-selection-user': selecting && !!store.userId && msg.senderId === store.userId,
                            'is-selected': selecting && groupFor(msg) && selectedMessages.has(groupFor(msg)!.id),
                            'is-locked': selecting && (!groupFor(msg) || groupFor(msg)!.deleteBlockedReason),
                        }"
                        @contextmenu="openSelectionMenu" @click.capture="handleSelectionRowClick($event, msg)">
                        <NCheckbox v-if="selecting" class="message-selection-checkbox"
                            :checked="!!groupFor(msg) && selectedMessages.has(groupFor(msg)!.id)"
                            :disabled="selectionUnavailable || !groupFor(msg) || !!groupFor(msg)!.deleteBlockedReason"
                            :aria-disabled="selectionUnavailable || !groupFor(msg) || !!groupFor(msg)!.deleteBlockedReason"
                            :aria-label="t(groupFor(msg)?.kind === 'run' ? 'chat.selectAgentRun' : 'chat.selectSingleMessage')"
                            @update:checked="groupFor(msg) && toggleSelection(groupFor(msg)!.id, $event)" />
                        <div class="message-selection-body">
                        <GroupAgentRunCard
                            v-if="msg.runItems?.length || isOtherMemberMessage(msg)"
                            :message="msg"
                            :agents="store.messageAgents"
                            :members="store.members"
                            :current-user-id="store.userId"
                            :allow-speech="props.allowSpeech"
                            :active="store.isAgentRunActive(
                                msg.roomId,
                                stableMessageAgentId(msg),
                                msg.run_id,
                            )"
                            @mention-agent="emit('mentionAgent', $event)"
                        />
                        <GroupMessageItem
                            v-else
                            :message="msg"
                            :agents="store.messageAgents"
                            :members="store.members"
                            :current-user-id="store.userId"
                            :allow-speech="props.allowSpeech"
                            @mention-agent="emit('mentionAgent', $event)"
                        />
                        <div v-if="selecting && groupFor(msg)?.deleteBlockedReason" class="message-selection-locked-hint">
                            {{ t(groupFor(msg)!.deleteBlockedReason === 'summarized' ? 'groupChat.messageAlreadySummarized' : 'groupChat.messageSummaryBoundaryUnknown') }}
                        </div>
                        <div v-if="routingDecision(msg)?.status === 'suggested' && routingDecision(msg)?.targetAgentName" class="routing-suggestion" role="status">
                            <span>{{ t('groupChat.routingSuggested', { agent: routingDecision(msg)!.targetAgentName }) }}</span>
                            <button type="button" @click="store.acceptRoutingSuggestion(msg.id)">{{ t('groupChat.routingUseSuggestion') }}</button>
                        </div>
                        <div v-else-if="routingDecision(msg)?.status === 'queued'" class="routing-suggestion" role="status">{{ t('groupChat.routingAutoQueued', { agent: routingDecision(msg)!.targetAgentName }) }}</div>
                        <div v-if="routingDecision(msg)?.handoffComplete === false" class="routing-suggestion routing-warning" role="status">{{ t('groupChat.routingHandoffIncomplete') }}</div>
                        <div v-if="routingDecision(msg)?.loopDetected === true" class="routing-suggestion routing-warning" role="status">{{ t('groupChat.routingLoopDetected') }}</div>
                        <div
                            v-if="handoffChainFor(msg)"
                            class="handoff-stop-card"
                            role="status"
                            :data-handoff-chain-id="handoffChainFor(msg)!.chainId"
                        >
                            <strong>{{ t(handoffChainFor(msg)!.status === 'outcome_unknown' ? 'groupChat.agentHandoffOutcomeUnknownTitle' : 'groupChat.agentHandoffStopped') }}</strong>
                            <span>{{ t('groupChat.agentHandoffDepthState', { current: handoffChainFor(msg)!.currentDepth, max: handoffChainFor(msg)!.unlimited ? '∞' : handoffChainFor(msg)!.maxDepth }) }}</span>
                            <span>{{ t('groupChat.agentHandoffTarget', { target: targetAgentName(handoffChainFor(msg)!) }) }}</span>
                            <span v-if="handoffChainFor(msg)!.status === 'outcome_unknown'">{{ t('groupChat.agentHandoffOutcomeUnknownDescription') }}</span>
                            <span v-else-if="handoffChainFor(msg)!.lastError">{{ handoffErrorText(handoffChainFor(msg)!.lastError) }}</span>
                            <div v-if="props.canManageHandoff && handoffChainFor(msg)!.status === 'stopped' && !handoffChainFor(msg)!.continueUsed" class="handoff-stop-actions">
                                <button type="button" @click="emit('continueHandoff', handoffChainFor(msg)!.chainId)">
                                    {{ t('groupChat.agentHandoffContinue') }}
                                </button>
                                <button type="button" @click="emit('adjustHandoffSettings')">
                                    {{ t('groupChat.agentHandoffAdjustSettings') }}
                                </button>
                            </div>
                            <span v-else-if="handoffChainFor(msg)!.status !== 'stopped' || handoffChainFor(msg)!.continueUsed">{{ t('groupChat.agentHandoffContinueState', { state: handoffChainFor(msg)!.status, updated: new Date(handoffChainFor(msg)!.updatedAt).toLocaleString() }) }}</span>
                        </div>
                        <div
                            v-if="containsSummaryAnchor(msg)"
                            class="summary-anchor-divider"
                            role="separator"
                            :aria-label="t('groupChat.summaryMessagesAbove')"
                            :data-summary-anchor-message-id="summaryAnchorMessageId"
                        >
                            <div class="summary-anchor-divider-line" aria-hidden="true"></div>
                            <div class="summary-anchor-divider-pill">
                                <span class="summary-anchor-divider-icon" aria-hidden="true">
                                    <svg viewBox="0 0 24 24" focusable="false">
                                        <path d="M6 3h12a2 2 0 0 1 2 2v16l-8-4-8 4V5a2 2 0 0 1 2-2z" />
                                        <path d="m8.5 10.5 2 2 5-5" />
                                    </svg>
                                </span>
                                <span class="summary-anchor-divider-text">{{ t('groupChat.summaryMessagesAbove') }}</span>
                            </div>
                            <div class="summary-anchor-divider-line" aria-hidden="true"></div>
                        </div>
                        </div>
                    </div>
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
        <div v-if="selecting" class="message-selection-toolbar">
            <span class="message-selection-count" role="status">{{ t('chat.messagesSelected', { count: selectedMessages.size }) }}</span>
            <NButton size="small" type="error" :loading="deletingMessages" :disabled="selectionUnavailable || !selectedMessages.size" @click="showDeleteConfirmation = true">
                {{ t('chat.deleteSelectedMessages') }}
            </NButton>
            <NButton size="small" :disabled="deletingMessages" @click="cancelSelection">{{ t('common.cancel') }}</NButton>
            <span class="message-selection-hint">{{ t('groupChat.messageSelectionHint') }}</span>
        </div>
    </div>
</template>

<style scoped lang="scss">
@use "@/styles/variables" as *;

.group-message-list-shell,
.group-message-scroll-region {
    flex: 1;
    min-height: 0;
    min-width: 0;
    position: relative;
    display: flex;
    flex-direction: column;
}

.group-message-list {
    min-width: 0;
    max-width: 100%;
}

.handoff-stop-card {
    display: grid;
    gap: calc(4px * var(--spacing-scale, 1));
    margin: 6px 0 0 46px;
    padding: calc(10px * var(--spacing-scale, 1)) calc(12px * var(--spacing-scale, 1));
    max-width: min(85%, 720px);
    border: var(--border-width, 1px) solid rgba(var(--warning-rgb), 0.3);
    border-radius: var(--radius-component, 10px);
    background: rgba(var(--warning-rgb), 0.08);
    color: var(--text-color);
    font-size: calc(var(--font-size-base, 14px) * 12 / 14);
}

.handoff-stop-actions {
    display: flex;
    gap: calc(12px * var(--spacing-scale, 1));
    margin-top: 4px;

    button {
        border: 0;
        padding: 0;
        background: transparent;
        color: var(--primary-color);
        cursor: pointer;
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
    border: var(--border-width, 1px) solid rgba(var(--accent-primary-rgb), 0.24);
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

.empty-state {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: calc(12px * var(--spacing-scale, 1));
    color: $text-muted;

    p {
        margin: 0;
        font-size: calc(var(--font-size-base, 14px) * 14 / 14);
    }
}

.empty-agent-avatars {
    display: flex;
    align-items: center;
    justify-content: center;
    padding-inline-start: calc(8px * var(--spacing-scale, 1));
}

.empty-agent-avatar {
    width: 44px;
    height: 44px;
    margin-inline-start: -8px;
    overflow: hidden;
    box-sizing: border-box;
    border: var(--border-width, 1px) solid #fff;
    border-radius: 50%;
    box-shadow: 0 4px 14px rgba(0, 0, 0, 0.12);

    img {
        display: block;
        width: 100%;
        height: 100%;
        object-fit: cover;
    }
}

.summary-anchor-divider {
    display: grid;
    grid-template-columns: minmax(24px, 1fr) auto minmax(24px, 1fr);
    align-items: center;
    gap: calc(12px * var(--spacing-scale, 1));
    width: min(760px, 100%);
    margin: 12px auto 4px;
    color: var(--text-secondary);
}

.summary-anchor-divider-line {
    height: 1px;
    background: linear-gradient(90deg, transparent, rgba(var(--accent-primary-rgb), 0.26), transparent);
}

.summary-anchor-divider-pill {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: calc(8px * var(--spacing-scale, 1));
    padding: calc(7px * var(--spacing-scale, 1)) calc(12px * var(--spacing-scale, 1));
    border: var(--border-width, 1px) solid rgba(var(--accent-primary-rgb), 0.22);
    border-radius: 999px;
    background: var(--theme-card-bg, var(--bg-card));
    box-shadow: 0 8px 24px rgba(15, 23, 42, 0.05);
    font-size: calc(var(--font-size-base, 14px) * 12 / 14);
    line-height: var(--line-height, 1.35);
}

.summary-anchor-divider-icon {
    display: inline-flex;
    flex: 0 0 auto;
    align-items: center;
    justify-content: center;
    width: 14px;
    height: 14px;
    color: var(--accent-primary);

    svg {
        width: 14px;
        height: 14px;
        fill: none;
        stroke: currentColor;
        stroke-width: 2;
        stroke-linecap: round;
        stroke-linejoin: round;
    }
}

.summary-anchor-divider-text {
    font-weight: 600;
    letter-spacing: 0.02em;
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

.history-loader {
    height: 28px;
    display: flex;
    align-items: center;
    justify-content: center;
    flex: 0 0 auto;
}


.history-load-error {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: calc(8px * var(--spacing-scale, 1));
    padding-bottom: calc(8px * var(--spacing-scale, 1));
}

.history-load-error button {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-height: 28px;
    padding: calc(5px * var(--spacing-scale, 1)) calc(10px * var(--spacing-scale, 1));
    border: var(--border-width, 1px) solid rgba(var(--accent-info-rgb), 0.22);
    border-radius: 999px;
    background: rgba(var(--accent-info-rgb), 0.08);
    color: var(--accent-primary);
    font-size: calc(var(--font-size-base, 14px) * 12 / 14);
    font-weight: 600;
    line-height: var(--line-height, 1.3);
    text-decoration: none;
    text-align: center;
}

.history-load-error {
    color: $text-secondary;
    font-size: calc(var(--font-size-base, 14px) * 12 / 14);
}

.history-load-error button {
    cursor: pointer;
}


@media (max-width: 640px) {
    .summary-anchor-divider {
        grid-template-columns: 1fr;
        gap: calc(8px * var(--spacing-scale, 1));
    }

    .summary-anchor-divider-line {
        display: none;
    }
}
@keyframes spin {
    to {
        transform: rotate(360deg);
    }
}
.message-selection-toolbar {
  display: flex;
  flex-shrink: 0;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  padding: 8px 20px;
  margin-bottom: 4px;
}

.message-selection-count {
  margin-inline-end: auto;
}

.message-selection-hint {
  flex-basis: 100%;
  color: $text-secondary;
  font-size: 12px;
}

.message-selection-row {
  display: grid;
  grid-template-columns: 20px minmax(0, 1fr);
  grid-template-areas: 'checkbox body';
  align-items: center;
  gap: 12px;
  // Selection boundaries remain visible even when the content surface is transparent.
  border: 1px dashed color-mix(in srgb, var(--accent-primary) 40%, transparent);
  border-radius: var(--radius-component, 8px);
  padding: 12px;
  cursor: pointer;

  &.is-locked {
    cursor: not-allowed;
  }

  &.is-selected {
    border-style: solid;
    border-color: var(--accent-primary);
  }

  &.message-selection-user {
    grid-template-columns: minmax(0, 1fr) 20px;
    grid-template-areas: 'body checkbox';
  }

  .message-selection-checkbox {
    grid-area: checkbox;
    justify-self: center;
  }

  .message-selection-body {
    grid-area: body;
    min-width: 0;
  }

  .message-selection-content + .message-selection-content {
    margin-top: 16px;
  }
}

.message-selection-locked-hint {
  margin-top: 8px;
  color: $text-secondary;
  font-size: 12px;
}


</style>

<style scoped>.routing-suggestion{margin:4px 12px 10px;padding:calc(8px * var(--spacing-scale, 1)) calc(10px * var(--spacing-scale, 1));border:var(--border-width, 1px) solid var(--border-color);border-radius: var(--radius-component, 8px);display:flex;gap:calc(8px * var(--spacing-scale, 1));align-items:center}.routing-warning{border-color:#f0a020}.routing-suggestion button{border:0;background:transparent;color:var(--primary-color);cursor:pointer}</style>
