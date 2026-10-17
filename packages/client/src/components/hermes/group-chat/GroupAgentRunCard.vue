<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import ProfileAvatar from '@/components/hermes/profiles/ProfileAvatar.vue'
import { formatChatTimestamp } from '@/utils/chat-timestamp'
import type { ChatMessage, MemberInfo, RoomAgent } from '@/api/studio/group-chat'
import { groupMessageAgent, parseStoredAvatar } from '@/utils/group-agent-avatar'
import GroupMessageItem from './GroupMessageItem.vue'
import ToolRunSummary from '../chat/ToolRunSummary.vue'
import RunUsageCard from '../chat/RunUsageCard.vue'
import GroupAgentMessageAvatar from './GroupAgentMessageAvatar.vue'
import GroupAgentRobotIcon from './GroupAgentRobotIcon.vue'

const props = withDefaults(defineProps<{
    message: ChatMessage
    agents: RoomAgent[]
    members?: MemberInfo[]
    currentUserId?: string
    allowSpeech?: boolean
    active?: boolean
}>(), {
    allowSpeech: true,
    active: false,
})

const emit = defineEmits<{
    mentionAgent: [agent: RoomAgent]
}>()

const { t } = useI18n()
const items = computed(() =>
    props.message.runItems?.length ? props.message.runItems : [props.message]
)
const runToolItems = computed(() =>
    items.value.filter(item => item.role === 'tool').reverse()
)
const toolsActive = computed(() => !!props.message.isStreaming || runToolItems.value.some(item => item.toolStatus === 'running'))
const transcriptItems = computed(() =>
    items.value.filter(item => !item.runUsage && (runToolItems.value.length === 0 || item.role !== 'tool'))
)
const runUsage = computed(() => [...items.value].reverse().find(item => item.runUsage)?.runUsage)
const runUsageMessageId = computed(() => {
    const replies = transcriptItems.value.filter(item => item.role === 'assistant' && !item.taskPlan)
    return replies.find(item => item.id === runUsage.value?.assistantMessageId)?.id || replies.at(-1)?.id
})
const stableAgentId = computed(() =>
    props.message.senderAgentRecordId || props.message.senderId
)
const activeAgentInfo = computed(() => props.agents.find(agent =>
    !agent.historical && (
        agent.id === props.message.senderAgentRecordId
        || agent.agentId === props.message.senderId
        || (!props.message.senderAgentRecordId && agent.name === props.message.senderName)
    )
))
const agentInfo = computed(() => groupMessageAgent(props.message, props.agents))
const isAssistantMessage = computed(() => Boolean(agentInfo.value) || props.message.role === 'agent_run')
const memberInfo = computed(() => {
    if (agentInfo.value) return null
    return props.members?.find(member =>
        member.userId === props.message.senderId ||
        member.name === props.message.senderName
    ) || null
})
const agentOwnerInfo = computed(() => {
    const ownerMemberId = agentInfo.value?.ownerMemberId
    if (!ownerMemberId) return null
    return props.members?.find(member => member.userId === ownerMemberId) || null
})
const senderAvatar = computed(() => parseStoredAvatar(memberInfo.value?.avatar))
const lastTimestamp = computed(() => items.value.at(-1)?.timestamp || props.message.timestamp)
const timeText = computed(() => formatChatTimestamp(lastTimestamp.value))

function handleToolListWheel(event: WheelEvent): void {
    const element = event.currentTarget as HTMLElement | null
    if (!element || event.deltaY === 0) return
    const canScrollUp = event.deltaY < 0 && element.scrollTop > 0
    const canScrollDown = event.deltaY > 0 &&
        element.scrollTop + element.clientHeight < element.scrollHeight
    if (!canScrollUp && !canScrollDown) return
    event.preventDefault()
    event.stopPropagation()
    element.scrollTop += event.deltaY
}
</script>

<template>
    <div class="group-agent-run" :data-run-id="message.run_id || undefined">
        <div class="run-column">
            <div class="run-header">
                <div
                    class="run-avatar"
                    :class="{ 'run-avatar-active': active }"
                    :aria-busy="active"
                >
                    <GroupAgentMessageAvatar
                        v-if="agentInfo"
                        :agent="agentInfo"
                        :owner="agentOwnerInfo"
                        :mentionable="!!activeAgentInfo"
                        :size="22"
                        @mention="emit('mentionAgent', $event)"
                    />
                    <ProfileAvatar
                        v-else
                        :name="message.senderName || message.senderId || 'user'"
                        :avatar="senderAvatar"
                        :size="22"
                    />
                </div>
                <span class="run-agent-name">{{ message.senderName }}</span>
                <GroupAgentRobotIcon v-if="agentInfo" class="run-agent-icon" />
            </div>
            <div
                v-if="transcriptItems.length || runToolItems.length || (runUsage && !message.isStreaming)"
                class="run-card group-run-bubble"
                :class="{
                    streaming: message.isStreaming,
                    'group-run-bubble--assistant': isAssistantMessage,
                    'group-run-bubble--user': !isAssistantMessage,
                }"
            >
                <ToolRunSummary
                    v-if="runToolItems.length"
                    class="run-tools"
                    :run-id="message.run_id || message.id"
                    :tools="runToolItems"
                    :active="toolsActive"
                >
                    <div
                        class="run-tool-list"
                        tabindex="0"
                        role="region"
                        :aria-label="t('chat.showToolCalls')"
                        :data-agent-id="stableAgentId"
                        :data-run-id="message.run_id || undefined"
                        @wheel="handleToolListWheel"
                    >
                        <div
                            v-for="item in runToolItems"
                            :key="item.id"
                            class="run-tool-item"
                            :data-message-id="item.id"
                        >
                            <GroupMessageItem
                                :message="item"
                                :agents="agents"
                                :members="members"
                                :current-user-id="currentUserId"
                                :allow-speech="props.allowSpeech"
                                embedded
                            />
                        </div>
                    </div>
                </ToolRunSummary>
                <div v-if="transcriptItems.length" class="run-transcript">
                    <div
                        v-for="item in transcriptItems"
                        :key="item.id"
                        class="run-transcript-item"
                        :data-message-id="item.id"
                    >
                        <GroupMessageItem
                            :message="item"
                            :agents="agents"
                            :members="members"
                            :current-user-id="currentUserId"
                            :allow-speech="props.allowSpeech"
                            embedded
                        >
                            <template v-if="runUsage && !message.isStreaming && item.id === runUsageMessageId" #before-workspace-changes>
                                <RunUsageCard :usage="runUsage" />
                            </template>
                        </GroupMessageItem>
                    </div>
                </div>
                <div v-if="runUsage && !message.isStreaming && !runUsageMessageId" class="run-usage-only">
                    <RunUsageCard :usage="runUsage" />
                </div>
            </div>
            <span class="run-time">{{ timeText }}</span>
        </div>
    </div>
</template>

<style scoped lang="scss">
@use "@/styles/variables" as *;

.group-agent-run {
    display: flex;
    align-items: flex-start;
    min-width: 0;
    max-width: 100%;
    padding: calc(2px * var(--spacing-scale, 1)) 0;
    box-sizing: border-box;
}

.run-avatar {
    position: relative;
    width: 22px;
    height: 22px;
    flex: 0 0 22px;
    overflow: visible;
    border-radius: 50%;
}

.run-avatar-active::before {
    position: absolute;
    z-index: 0;
    inset: -4px;
    border-radius: 50%;
    box-shadow:
        0 0 0 2px #ff6b6b,
        0 0 10px rgba(255, 107, 107, 0.4),
        0 0 20px rgba(255, 107, 107, 0.2);
    content: '';
    animation: run-avatar-rainbow-glow 4s linear infinite;
    pointer-events: none;
}

@keyframes run-avatar-rainbow-glow {
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

@media (prefers-reduced-motion: reduce) {
    .run-avatar-active::before {
        animation: none;
    }
}

.run-column {
    display: flex;
    flex-direction: column;
    min-width: min(500px, 100%);
    width: fit-content;
    max-width: min(85%, 920px);
}

.run-header {
    display: flex;
    align-items: center;
    gap: calc(6px * var(--spacing-scale, 1));
    padding-bottom: calc(6px * var(--spacing-scale, 1));
    color: $text-secondary;
    font-size: calc(var(--font-size-base, 14px) * 12 / 14);
    line-height: var(--line-height, calc(var(--font-size-base, 14px) * 22 / 14));
}

.run-agent-name {
    min-width: 0;
    max-width: 240px;
    overflow: hidden;
    color: inherit;
    font-size: inherit;
    font-weight: 400;
    text-overflow: ellipsis;
    white-space: nowrap;
}

.run-agent-icon {
    flex: 0 0 auto;
    width: 14px;
    height: 14px;
}

.run-card {
    position: relative;
    min-width: 0;
    overflow: visible;
    box-sizing: border-box;
    border: none;
    border-radius: var(--radius-component, 10px);
    background: rgba(var(--accent-primary-rgb), 0.055);
    box-shadow: 0 4px 14px rgba(0, 0, 0, 0.035);

    > :deep(.group-message + .group-message),
    .run-transcript-item + .run-transcript-item {
        border-top: var(--border-width, 1px) solid rgba(var(--text-primary-rgb), 0.08);
    }
}

.run-tools {
    box-sizing: border-box;
    width: 100%;
    padding: calc(6px * var(--spacing-scale, 1));
}

.run-tool-list {
    display: flex;
    flex-direction: column;
    width: 100%;
    min-width: 0;
    max-height: 360px;
    overflow-y: auto;
    scrollbar-width: thin;

    &:focus-visible {
        outline: 2px solid rgba(var(--accent-primary-rgb), 0.45);
        outline-offset: -2px;
        border-radius: var(--radius-component, 10px);
    }

    .run-tool-item + .run-tool-item {
        border-top: var(--border-width, 1px) solid rgba(var(--text-primary-rgb), 0.08);
    }
}

.run-transcript,
.run-tool-item,
.run-transcript-item {
    min-width: 0;
}

.run-tools + .run-transcript {
    border-top: var(--border-width, 1px) solid rgba(var(--text-primary-rgb), 0.08);
}

.run-time {
    align-self: flex-start;
    padding: calc(3px * var(--spacing-scale, 1)) calc(4px * var(--spacing-scale, 1)) 0;
    color: var(--text-muted);
    font-size: calc(var(--font-size-base, 14px) * 12 / 14);
    opacity: 0.6;
    user-select: none;
}

.run-usage-only {
    min-width: 0;
    padding: 0 calc(14px * var(--spacing-scale, 1)) calc(10px * var(--spacing-scale, 1));
}

:global(html.theme-has-custom-background .group-run-bubble) {
    background: var(--message-theme-bg, rgba(var(--bg-main-surface-rgb), 0.78));
    -webkit-backdrop-filter: var(--message-theme-filter, blur(8px) saturate(110%));
    backdrop-filter: var(--message-theme-filter, blur(8px) saturate(110%));
}

@media (max-width: $breakpoint-mobile) {
    .run-column {
        min-width: 0;
        width: 100%;
        max-width: 100%;
    }
}
</style>
