<script setup lang="ts">
import { computed, ref, onUnmounted } from 'vue'
import { NPopconfirm, NCheckbox, NTooltip } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import type { Session } from '@/stores/hermes/chat'
import { useAppStore } from '@/stores/hermes/app'
import { useProfilesStore } from '@/stores/hermes/profiles'
import ProfileAvatar from '@/components/hermes/profiles/ProfileAvatar.vue'
import PinIcon from '@/components/common/PinIcon.vue'
import { formatTimestampMs } from '@/shared/session-display'
import { chatSessionAgentAvatar } from '@/utils/chat-agent-avatar'
import { resolveSessionNavigation } from './session-list-item-navigation'

const props = withDefaults(defineProps<{
  session: Session
  active: boolean
  pinned: boolean
  canDelete: boolean
  streaming?: boolean
  completedUnread?: boolean
  selectable?: boolean
  selected?: boolean
  showProfile?: boolean
  categoryLabel?: string
  to?: string
  interceptModifiedNavigation?: boolean
}>(), {
  showProfile: true,
})

const emit = defineEmits<{
  select: []
  contextmenu: [event: MouseEvent]
  delete: []
  'toggle-select': []
  'open-new': []
}>()

const { t } = useI18n()
const appStore = useAppStore()
const profilesStore = useProfilesStore()
const profileName = computed(() => props.session.profile || 'default')
const profileAvatar = computed(() => profilesStore.profiles.find(profile => profile.name === profileName.value)?.avatar)
const profileHasModels = computed(() => {
  const profileModels = appStore.profileModelGroups.find(profile => profile.profile === profileName.value)
  return !!profileModels?.groups?.some(group => group.models.length > 0)
})
const profileModelsMissing = computed(() =>
  appStore.profileModelGroups.length > 0 && !profileHasModels.value,
)
const isGlobalAgentSession = computed(() => props.session.source === 'global_agent')
const sessionAgentLogo = computed(() => chatSessionAgentAvatar(props.session))

let longPressTimer: ReturnType<typeof setTimeout> | null = null
const longPressTriggered = ref(false)

function onTouchStart(e: TouchEvent) {
  longPressTriggered.value = false
  longPressTimer = setTimeout(() => {
    longPressTriggered.value = true
    const touch = e.touches[0]
    const syntheticEvent = new MouseEvent('contextmenu', {
      clientX: touch.clientX,
      clientY: touch.clientY,
      bubbles: true,
    })
    emit('contextmenu', syntheticEvent)
  }, 500)
}

function onTouchEnd() {
  if (longPressTimer) {
    clearTimeout(longPressTimer)
    longPressTimer = null
  }
}

function onTouchMove() {
  if (longPressTimer) {
    clearTimeout(longPressTimer)
    longPressTimer = null
  }
}

function onClick(event?: MouseEvent) {
  if (longPressTriggered.value) {
    longPressTriggered.value = false
    event?.preventDefault()
    return
  }
  const navigationAction = resolveSessionNavigation(event, !!props.interceptModifiedNavigation)
  if (navigationAction === 'native') return
  if (navigationAction === 'open-new') {
    event?.preventDefault()
    emit('open-new')
    return
  }
  if (props.to && !props.selectable) event?.preventDefault()
  emit('select')
}

onUnmounted(() => {
  if (longPressTimer) clearTimeout(longPressTimer)
})
</script>

<template>
  <component
    :is="selectable || !to ? 'button' : 'a'"
    class="session-item"
    :class="{ active, 'batch-mode': selectable, 'missing-models': profileModelsMissing }"
    :aria-current="active ? 'page' : undefined"
    :href="!selectable ? to : undefined"
    :type="selectable || !to ? 'button' : undefined"
    @click="onClick"
    @contextmenu="emit('contextmenu', $event)"
    @touchstart="onTouchStart"
    @touchend="onTouchEnd"
    @touchmove="onTouchMove"
  >
    <div v-if="selectable" class="session-item-checkbox">
      <NCheckbox :checked="selected" @click.stop="emit('toggle-select')" />
    </div>
    <div class="session-item-content">
      <span class="session-item-title-row">
        <span class="session-item-title-main">
          <span v-if="pinned" class="session-item-pin" aria-hidden="true">
            <PinIcon width="13" height="13" filled />
          </span>
          <span v-if="completedUnread" class="session-item-unread-dot" aria-hidden="true" />
          <span class="session-item-title" dir="auto">
            {{ session.title }}
          </span>
          <NTooltip v-if="profileModelsMissing" trigger="click" placement="top">
            <template #trigger>
              <button class="session-item-warning" type="button" @click.stop.prevent>
                !
              </button>
            </template>
            {{ t('chat.profileMissingModelsTip', { profile: profileName }) }}
          </NTooltip>
        </span>
        <span class="session-item-time">{{ formatTimestampMs(session.createdAt) }}</span>
      </span>
      <span class="session-item-agent-row">
        <span class="session-item-agent-logo-wrap" :class="{ streaming }">
          <img
            class="session-item-agent-logo"
            :src="sessionAgentLogo.src"
            :alt="sessionAgentLogo.label"
          >
        </span>
        <span v-if="props.showProfile" class="session-item-profile">
          <ProfileAvatar class="session-item-profile-avatar" :name="profileName" :avatar="profileAvatar" :size="16" />
          <span class="session-item-profile-name">{{ profileName }}</span>
        </span>
        <span
          v-if="props.categoryLabel"
          class="session-item-category-tag"
          :title="props.categoryLabel"
        >
          {{ props.categoryLabel }}
        </span>
      </span>
    </div>
    <svg
      v-if="isGlobalAgentSession"
      class="session-item-global-icon"
      :aria-label="t('sidebar.globalAgent')"
      :title="t('sidebar.globalAgent')"
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="1.8"
      stroke-linecap="round"
      stroke-linejoin="round"
    >
      <rect x="7" y="7" width="10" height="10" rx="2" />
      <path d="M9 1v4M15 1v4M9 19v4M15 19v4M1 9h4M1 15h4M19 9h4M19 15h4" />
      <path d="M10 10h4v4h-4z" />
    </svg>
    <NPopconfirm v-if="canDelete && !selectable" @positive-click="emit('delete')">
      <template #trigger>
        <button class="session-item-delete" @click.stop.prevent>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        </button>
      </template>
      {{ t('chat.deleteSession') }}
    </NPopconfirm>
  </component>
</template>

<style scoped>
.session-item {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: space-between;
  width: 100%;
  padding: 8px 10px;
  border: none;
  background: none;
  border-radius: var(--radius-sm);
  cursor: pointer;
  text-align: start;
  text-decoration: none;
  color: var(--text-secondary);
  transition: all var(--transition-fast);
  margin-bottom: 2px;
}

.session-item:hover {
  background: rgba(var(--accent-primary-rgb), 0.06);
  color: var(--text-primary);
}

.session-item:hover .session-item-delete {
  opacity: 1;
  pointer-events: auto;
}

.session-item:focus-within .session-item-delete {
  opacity: 1;
  pointer-events: auto;
}

.session-item.active {
  background: rgba(var(--accent-primary-rgb), 0.12);
  color: var(--text-primary);
  font-weight: 500;
  border-radius: 6px;
}

.session-item.active .session-item-title {
  color: var(--text-primary);
}

.session-item.missing-models {
  color: #b42318;
  background: rgba(220, 38, 38, 0.08);
}

.session-item.missing-models .session-item-title,
.session-item.missing-models .session-item-profile-name,
.session-item.missing-models .session-item-time {
  color: #b42318;
}

.session-item.missing-models:hover {
  background: rgba(220, 38, 38, 0.12);
}

.session-item-content {
  flex: 1;
  min-width: 0;
  overflow: visible;
}

.session-item-title-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  min-width: 0;
}

.session-item-title-main {
  display: flex;
  align-items: center;
  gap: 6px;
  flex: 1 1 auto;
  min-width: 0;
}

.session-item-title {
  display: block;
  flex: 1 1 auto;
  min-width: 0;
  font-size: 13px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.session-item-pin {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  color: var(--accent-primary);
}

.session-item-unread-dot {
  flex: 0 0 auto;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--accent-primary);
  box-shadow: 0 0 0 3px rgba(var(--accent-primary-rgb), 0.12);
}

.session-item-time {
  flex: 0 0 auto;
  font-size: 11px;
  color: var(--text-muted);
}

.session-item-global-icon {
  position: absolute;
  top: 5px;
  right: 5px;
  color: #d6a019;
  pointer-events: none;
}

.session-item-delete {
  flex-shrink: 0;
  opacity: 0;
  pointer-events: none;
  padding: 2px;
  border: none;
  background: none;
  color: var(--text-muted);
  cursor: pointer;
  border-radius: 3px;
  transition: all var(--transition-fast);
}

.session-item-delete:hover {
  color: var(--error);
  background: rgba(var(--error-rgb), 0.1);
}

@media (hover: none) {
  .session-item-delete {
    opacity: 0.5;
    pointer-events: auto;
  }
}

.session-item-profile {
  display: flex;
  align-items: center;
  gap: 5px;
  flex: 0 1 auto;
  min-width: 0;
}

.session-item-profile-avatar {
  background: var(--bg-secondary);
}

.session-item-profile-name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 11px;
  line-height: 16px;
  color: var(--text-muted);
}

.session-item-category-tag {
  flex: 0 1 auto;
  min-width: 0;
  max-width: 45%;
  overflow: hidden;
  padding: 1px 6px;
  border-radius: 4px;
  background: rgba(127, 127, 127, 0.12);
  color: var(--text-muted);
  font-size: 10px;
  line-height: 16px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.session-item-warning {
  flex-shrink: 0;
  width: 16px;
  height: 16px;
  border: 1px solid rgba(180, 35, 24, 0.35);
  border-radius: 50%;
  background: rgba(220, 38, 38, 0.1);
  color: #b42318;
  font-size: 11px;
  font-weight: 700;
  line-height: 14px;
  cursor: pointer;
}

.session-item-agent-row {
  display: flex;
  align-items: center;
  gap: 4px;
  min-width: 0;
  margin-top: 3px;
  padding: 3px 0;
}

.session-item-agent-logo-wrap {
  position: relative;
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  border-radius: 50%;
}

.session-item-agent-logo-wrap.streaming::before {
  content: "";
  position: absolute;
  inset: -1px;
  box-sizing: border-box;
  border-radius: 50%;
  box-shadow:
    0 0 0 2px #ff6b6b,
    0 0 10px rgba(255, 107, 107, 0.4),
    0 0 20px rgba(255, 107, 107, 0.2);
  animation: rainbow-glow 4s linear infinite;
}

.session-item-agent-logo {
  position: relative;
  z-index: 1;
  width: 18px;
  height: 18px;
  box-sizing: border-box;
  border: 1px solid #fff;
  border-radius: inherit;
  object-fit: cover;
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
</style>
