<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, useId, watch } from 'vue'
import { NPopover } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import { useRoute, useRouter } from 'vue-router'
import { useAccountStore } from '@/stores/account'
import { useAppStore } from '@/stores/hermes/app'
import ProfileAvatar from '@/components/hermes/profiles/ProfileAvatar.vue'
import SidebarAccountControls from './SidebarAccountControls.vue'

const props = defineProps<{ collapsed?: boolean }>()

const router = useRouter()
const route = useRoute()
const { t } = useI18n()
const accountStore = useAccountStore()
const appStore = useAppStore()
const showMenu = ref(false)
const footer = ref<HTMLElement | null>(null)
const sidebarWidth = ref<number>()
let sidebarObserver: ResizeObserver | undefined
const trigger = ref<HTMLButtonElement | null>(null)
const panel = ref<HTMLElement | null>(null)
const menuId = useId()
const displayName = computed(() => accountStore.username || t('settings.tabs.account'))

function syncSidebarWidth() {
  const sidebar = footer.value?.parentElement
  if (!sidebar || !footer.value) return
  sidebarWidth.value = props.collapsed
    ? sidebarWidth.value || parseFloat(getComputedStyle(footer.value).getPropertyValue('--account-menu-width'))
    : sidebar.getBoundingClientRect().width
}

onMounted(() => {
  void accountStore.loadAccount()
  syncSidebarWidth()
  if (footer.value?.parentElement) {
    sidebarObserver = new ResizeObserver(syncSidebarWidth)
    sidebarObserver.observe(footer.value.parentElement)
  }
})
onBeforeUnmount(() => { sidebarObserver?.disconnect() })
watch(() => route.fullPath, () => { showMenu.value = false })

function closeMenu() {
  showMenu.value = false
}

function handleEscape() {
  closeMenu()
  trigger.value?.focus()
}

async function focusMenu() {
  showMenu.value = true
  await nextTick()
  panel.value?.focus()
}

function openSettingsPage() {
  closeMenu()
  if (window.matchMedia('(max-width: 768px)').matches) appStore.closeSidebar()
  void router.push({ name: 'hermes.settings' })
}
</script>

<template>
  <div ref="footer" class="page-sidebar-bottom" :class="{ 'is-collapsed': collapsed }">
    <NPopover
      v-model:show="showMenu"
      class="sidebar-account-popover"
      trigger="click"
      placement="top"
      display-directive="show"
      :show-arrow="false"
      :width="sidebarWidth"
      :style="{ maxWidth: 'calc(100vw - 24px)', padding: '0' }"
    >
      <template #trigger>
        <button
          ref="trigger"
          class="page-sidebar-account-btn"
          :class="{ active: showMenu }"
          type="button"
          :title="displayName"
          :aria-label="displayName"
          aria-haspopup="dialog"
          :aria-expanded="showMenu"
          :aria-controls="menuId"
          @keydown.esc.stop.prevent="handleEscape"
          @keydown.up.prevent="focusMenu"
          @keydown.down.prevent="focusMenu"
        >
          <ProfileAvatar :name="accountStore.username || 'default'" :avatar="accountStore.profileAvatar" :size="30" />
          <span class="account-name">{{ displayName }}</span>
          <svg class="account-chevron" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <polyline points="6 14 12 8 18 14" />
          </svg>
        </button>
      </template>
      <section
        :id="menuId"
        ref="panel"
        class="sidebar-account-menu"
        role="dialog"
        :aria-label="t('settings.tabs.account')"
        tabindex="-1"
        @keydown.esc.stop.prevent="handleEscape"
      >
        <div class="account-menu-heading">
          <ProfileAvatar :name="accountStore.username || 'default'" :avatar="accountStore.profileAvatar" :size="34" />
          <div class="account-menu-identity">
            <span class="account-name" :title="displayName">{{ displayName }}</span>
            <span class="account-label">{{ t('settings.tabs.account') }}</span>
          </div>
        </div>
        <SidebarAccountControls @open-modal="closeMenu" />
        <div class="account-menu-settings">
          <button class="account-settings-btn" type="button" @click="openSettingsPage">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
              <circle cx="12" cy="12" r="3" />
              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
            </svg>
            <span>{{ t('sidebar.settings') }}</span>
          </button>
        </div>
      </section>
    </NPopover>
  </div>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;

.page-sidebar-bottom {
  --account-menu-width: #{$sidebar-width};
  flex-shrink: 0;
  padding: 10px 12px;
}

.page-sidebar-account-btn,
.account-settings-btn {
  width: 100%;
  min-width: 0;
  border: none;
  border-radius: $radius-sm;
  background: transparent;
  color: $text-secondary;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 10px;
  cursor: pointer;
  text-align: start;
  font: inherit;
  font-size: 13px;
  transition: background-color $transition-fast, color $transition-fast;

  &:hover,
  &.active {
    background: rgba(var(--accent-primary-rgb), 0.06);
    color: $text-primary;
  }

  &:focus-visible {
    outline: 2px solid $accent-primary;
    outline-offset: -2px;
  }
}

.account-name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 13px;
  font-weight: 500;
  color: $text-primary;
}

.page-sidebar-account-btn .account-name { flex: 1; }
.account-chevron { flex-shrink: 0; color: $text-muted; }
.page-sidebar-account-btn.active .account-chevron { transform: rotate(180deg); }

.is-collapsed {
  padding-inline: 0;

  .page-sidebar-account-btn { justify-content: center; padding-inline: 4px; }
  .account-name,
  .account-chevron { display: none; }
}

.sidebar-account-menu {
  max-height: calc(100dvh - 88px);
  overflow-y: auto;
  overscroll-behavior: contain;
  padding: 8px;
  outline: none;
}

.account-menu-heading {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 12px 14px;
  margin-bottom: 12px;
  border-bottom: 1px solid $border-color;
}

.account-menu-identity { display: flex; flex-direction: column; min-width: 0; gap: 2px; }
.account-label { font-size: 11px; color: $text-muted; }
.account-menu-settings { border-top: 1px solid $border-color; margin-top: 8px; padding-top: 6px; }
.account-settings-btn { padding: 10px 12px; }
</style>
