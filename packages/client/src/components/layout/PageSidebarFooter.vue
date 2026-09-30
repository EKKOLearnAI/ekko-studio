<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, useId, watch } from 'vue'
import { NPopover } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import { useRoute } from 'vue-router'
import { useAccountStore } from '@/stores/account'
import ProfileAvatar from '@/components/hermes/profiles/ProfileAvatar.vue'
import SidebarAccountControls from './SidebarAccountControls.vue'
import { useNavigationRail } from '@/composables/useNavigationRail'

const props = defineProps<{ collapsed?: boolean; rail?: boolean }>()
const hasNavigationRail = useNavigationRail()

const route = useRoute()
const { t } = useI18n()
const accountStore = useAccountStore()
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
})
watch(footer, (element) => {
  sidebarObserver?.disconnect()
  if (!element?.parentElement) return
  syncSidebarWidth()
  sidebarObserver = new ResizeObserver(syncSidebarWidth)
  sidebarObserver.observe(element.parentElement)
}, { flush: 'post' })
onBeforeUnmount(() => { sidebarObserver?.disconnect() })
watch(() => route.fullPath, () => { showMenu.value = false })
watch(hasNavigationRail, () => { showMenu.value = false })

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

</script>

<template>
  <div v-if="rail || !hasNavigationRail" ref="footer" class="page-sidebar-bottom" :class="{ 'is-collapsed': collapsed }">
    <NPopover
      v-model:show="showMenu"
      class="sidebar-account-popover"
      trigger="click"
      :placement="rail ? 'right-start' : 'top'"
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

.page-sidebar-account-btn {
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
</style>
