<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { NButton, NTag } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import { desktopBridge, type DesktopComputerUsePermission, type DesktopComputerUsePermissions, type DesktopComputerUsePermissionStatus } from '@/utils/desktop-bridge'

const { t } = useI18n()
const desktop = desktopBridge()
const bridge = desktop?.isDesktop && desktop.platform === 'darwin' && !desktop.remoteMode ? desktop.computerUsePermissions : undefined
const status = ref<DesktopComputerUsePermissions | null>(null)
const checking = ref(false)
const opening = ref<DesktopComputerUsePermission | null>(null)
const error = ref('')
const permissions = ['accessibility', 'screenRecording'] as const
const complete = computed(() => status.value?.supported && permissions.every(key => status.value?.supported && status.value[key] === 'granted'))
let disposed = false

function permissionStatus(key: DesktopComputerUsePermission): DesktopComputerUsePermissionStatus {
  return status.value?.supported ? status.value[key] : 'unknown'
}

function statusLabel(key: DesktopComputerUsePermission): string {
  if (checking.value && !status.value) return t('computerUsePermissions.checking')
  const value = permissionStatus(key)
  return t(`computerUsePermissions.${value === 'granted' ? 'granted' : value === 'restricted' ? 'restricted' : value === 'unknown' ? 'unknown' : 'needed'}`)
}

async function refresh() {
  if (!bridge || checking.value || disposed || document.visibilityState === 'hidden') return
  checking.value = true
  error.value = ''
  try {
    const next = await bridge.getStatus()
    if (!disposed) status.value = next
  } catch {
    if (!disposed) {
      status.value = null
      error.value = t('computerUsePermissions.checkFailed')
    }
  } finally {
    checking.value = false
  }
}

async function request(key: DesktopComputerUsePermission) {
  if (!bridge || opening.value) return
  opening.value = key
  error.value = ''
  try {
    await bridge.request(key)
    await refresh()
  } catch {
    if (!disposed) error.value = t('computerUsePermissions.openFailed')
  } finally {
    opening.value = null
  }
}

onMounted(() => {
  if (!bridge) return
  void refresh()
  window.addEventListener('focus', refresh)
  document.addEventListener('visibilitychange', refresh)
})
onBeforeUnmount(() => {
  disposed = true
  window.removeEventListener('focus', refresh)
  document.removeEventListener('visibilitychange', refresh)
})
</script>

<template>
  <section v-if="bridge && status?.supported !== false" class="permissions" data-theme-surface="card" data-testid="computer-use-permissions" :aria-label="t('computerUsePermissions.title')">
    <div class="permissions-header">
      <div>
        <h3>{{ t('computerUsePermissions.title') }}</h3>
        <p>{{ t(complete ? 'computerUsePermissions.complete' : 'computerUsePermissions.intro') }}</p>
      </div>
      <NButton class="permission-action" size="small" quaternary :loading="checking" :disabled="!!opening" data-testid="permissions-refresh" @click="refresh">{{ t('computerUsePermissions.refresh') }}</NButton>
    </div>
    <div v-for="key in permissions" :key="key" class="permission-row" :data-testid="`permission-${key}`">
      <div class="permission-info">
        <div class="permission-title">
          <span>{{ t(`computerUsePermissions.${key}`) }}</span>
          <NTag size="small" :bordered="false" :type="permissionStatus(key) === 'granted' ? 'success' : permissionStatus(key) === 'unknown' ? 'default' : 'warning'" role="status">{{ statusLabel(key) }}</NTag>
        </div>
        <p>{{ t(`computerUsePermissions.${key}Hint`) }}</p>
      </div>
      <NButton v-if="permissionStatus(key) !== 'granted'" class="permission-action" size="small" secondary :loading="opening === key" :disabled="checking || !!opening" :aria-label="`${t('computerUsePermissions.authorize')} · ${t(`computerUsePermissions.${key}`)}`" @click="request(key)">{{ t('computerUsePermissions.authorize') }}</NButton>
    </div>
    <p v-if="!complete" class="permissions-guide">{{ t('computerUsePermissions.guide') }}</p>
    <p v-if="!complete" class="permissions-note">{{ t('computerUsePermissions.restartHint') }}</p>
    <p v-if="error" class="permissions-error" role="alert">{{ error }}</p>
  </section>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;
.permissions { margin: 12px 0; padding: 16px; border: var(--border-width, 1px) solid $border-light; border-radius: var(--radius-component, 8px); color: $text-primary; }
.permissions-header, .permission-row { display: flex; align-items: center; justify-content: space-between; gap: 16px; }
.permissions-header { align-items: flex-start; margin-bottom: 4px; }
h3 { margin: 0; font-size: 14px; font-weight: 600; }
p { margin: 4px 0 0; font-size: 12px; line-height: 1.65; color: $text-secondary; }
.permission-row { padding: 14px 0; border-bottom: var(--border-width, 1px) solid $border-light; }
.permissions-header > div, .permission-info { flex: 1; min-width: 0; }
.permission-action { flex-shrink: 0; }
.permission-title { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; font-size: 13px; }
.permissions-guide { margin-top: 12px; color: $text-secondary; }
.permissions-error { color: $error; }
@media (max-width: $breakpoint-mobile) {
  .permissions { padding: 12px; }
  .permissions-header, .permission-row { gap: 8px; }
}
</style>
