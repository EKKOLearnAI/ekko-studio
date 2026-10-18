<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import type { RoomAgentSummary } from '@/api/studio/group-chat'
import ProfileAvatar from '@/components/hermes/profiles/ProfileAvatar.vue'
import { groupAgentAvatar } from '@/utils/group-agent-avatar'

const { t } = useI18n()
const props = defineProps<{
    agents: RoomAgentSummary[]
    activeAgentIds: string[]
    label: string
}>()

const visibleAgents = computed(() => (
    props.agents.length > 4 ? props.agents.slice(0, 3) : props.agents.slice(0, 4)
))
const hiddenAgents = computed(() => (
    props.agents.length > 4 ? props.agents.slice(3) : []
))
const activeAgentIds = computed(() => new Set(props.activeAgentIds))
const visibleCount = computed(() => (
    props.agents.length > 4 ? 4 : props.agents.length
))
const avatarSize = computed(() => {
    if (visibleCount.value <= 1) return 28
    if (visibleCount.value === 2) return 17
    return 15
})
const hasActiveAgent = computed(() => (
    props.agents.some(agent => activeAgentIds.value.has(agent.id))
))
const rosterNames = computed(() => props.agents.map(agent => agent.name).join(', '))
const runningNames = computed(() => (
    props.agents
        .filter(agent => activeAgentIds.value.has(agent.id))
        .map(agent => agent.name)
        .join(', ')
))
const accessibleSummary = computed(() => {
    if (!props.agents.length) {
        return t('groupChat.roomAgentAvatarEmpty', { room: props.label })
    }
    if (!runningNames.value) {
        return t('groupChat.roomAgentAvatarIdle', {
            room: props.label,
            agents: rosterNames.value,
        })
    }
    return t('groupChat.roomAgentAvatarRunning', {
        room: props.label,
        agents: rosterNames.value,
        running: runningNames.value,
    })
})
</script>

<template>
    <div
        class="room-agent-grid"
        :class="{ 'is-active': hasActiveAgent }"
        :data-agent-count="visibleCount"
        role="img"
        :aria-label="accessibleSummary"
        :title="accessibleSummary"
        :aria-busy="hasActiveAgent"
    >
        <span
            v-if="agents.length === 0"
            class="room-agent-grid-cell room-agent-grid-neutral"
            aria-hidden="true"
        >
            <span />
            <span />
            <span />
            <span />
        </span>
        <span
            v-for="agent in visibleAgents"
            v-else
            :key="agent.id"
            class="room-agent-grid-cell agent"
            :data-agent-id="agent.id"
            :title="agent.name"
            :aria-label="agent.name"
        >
            <ProfileAvatar
                :name="agent.agent || agent.name"
                :avatar="groupAgentAvatar(agent)"
                :size="avatarSize"
            />
        </span>
        <span
            v-if="hiddenAgents.length"
            class="room-agent-grid-cell room-agent-grid-overflow"
            :title="hiddenAgents.map(agent => agent.name).join(', ')"
            :aria-label="hiddenAgents.map(agent => agent.name).join(', ')"
        >
            +{{ hiddenAgents.length }}
        </span>
    </div>
</template>

<style scoped lang="scss">
@use "@/styles/variables" as *;

.room-agent-grid {
    position: relative;
    display: block;
    flex: 0 0 36px;
    width: 36px;
    height: 36px;
    overflow: visible;
    box-sizing: border-box;
    border: var(--border-width, 1px) solid $border-color;
    border-radius: var(--radius-component, 8px);
    background: $bg-secondary;

    &.is-active::after {
        position: absolute;
        z-index: 2;
        inset: -4px;
        border-radius: var(--radius-component, 12px);
        box-shadow:
            0 0 0 2px #ff6b6b,
            0 0 10px rgba(255, 107, 107, 0.4),
            0 0 20px rgba(255, 107, 107, 0.2);
        content: '';
        animation: room-avatar-rainbow-glow 4s linear infinite;
        pointer-events: none;
    }
}

.room-agent-grid-cell {
    position: absolute;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    overflow: visible;
    box-sizing: border-box;
    border-radius: var(--radius-component, 5px);

    :deep(.profile-avatar-view) {
        border-radius: var(--radius-component, 4px);
    }

}

.room-agent-grid[data-agent-count='0'] .room-agent-grid-cell,
.room-agent-grid[data-agent-count='1'] .room-agent-grid-cell {
    inset: 4px;
    width: 28px;
    height: 28px;
}

.room-agent-grid[data-agent-count='2'] {
    .room-agent-grid-cell {
        width: 17px;
        height: 17px;

        &:nth-child(1) {
            top: 2px;
            left: 2px;
        }

        &:nth-child(2) {
            right: 2px;
            bottom: 2px;
        }
    }
}

.room-agent-grid[data-agent-count='3'] {
    .room-agent-grid-cell {
        width: 15px;
        height: 15px;

        &:nth-child(1) {
            top: 2px;
            left: 10px;
        }

        &:nth-child(2) {
            bottom: 2px;
            left: 2px;
        }

        &:nth-child(3) {
            right: 2px;
            bottom: 2px;
        }
    }
}

.room-agent-grid[data-agent-count='4'] {
    .room-agent-grid-cell {
        width: 15px;
        height: 15px;

        &:nth-child(1) {
            top: 2px;
            left: 2px;
        }

        &:nth-child(2) {
            top: 2px;
            right: 2px;
        }

        &:nth-child(3) {
            bottom: 2px;
            left: 2px;
        }

        &:nth-child(4) {
            right: 2px;
            bottom: 2px;
        }
    }
}

.room-agent-grid-overflow {
    background: var(--theme-content-bg, $bg-main-surface);
    color: $text-secondary;
    font-size: calc(var(--font-size-base, 14px) * 9 / 14);
    font-weight: 700;
    line-height: var(--line-height, 1);
}

.room-agent-grid-neutral {
    display: grid;
    grid-template-columns: repeat(2, 6px);
    grid-template-rows: repeat(2, 6px);
    gap: calc(2px * var(--spacing-scale, 1));
    background: rgba(var(--text-muted-rgb), 0.08);

    span {
        border-radius: var(--radius-component, 2px);
        background: rgba(var(--text-muted-rgb), 0.42);
    }
}

@keyframes room-avatar-rainbow-glow {
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
    .room-agent-grid.is-active::after {
        animation: none;
    }
}
</style>
