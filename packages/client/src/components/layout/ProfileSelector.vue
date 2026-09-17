<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { NButton, NModal, NSpin, useMessage } from 'naive-ui'
import { useProfilesStore } from '@/stores/hermes/profiles'
import {
  fetchProfileRuntimeStatusesWithMeta,
  restartProfileGateway,
  restartProfileRuntime,
  type HermesProfile,
  type ProfileAvatar,
  type ProfileRuntimeStatus,
} from '@/api/hermes/profiles'
import ProfileAvatarView from '@/components/hermes/profiles/ProfileAvatar.vue'
import { profileDisplayLabel } from '@/lib/profileDisplay'
import { useI18n } from 'vue-i18n'

const emit = defineEmits<{
  'modal-show-change': [show: boolean]
}>()

const { t } = useI18n()
const message = useMessage()
const profilesStore = useProfilesStore()

const activeName = computed(() => profilesStore.activeProfileName ?? '')
const displayName = computed(() => activeName.value || 'default')
const activeProfile = computed(() => profilesStore.profiles.find(profile => profile.name === displayName.value))
const activeProfileTitle = computed(() => profileDisplayLabel(activeProfile.value ?? { name: displayName.value }))
const runtimeStatuses = ref<ProfileRuntimeStatus[]>([])
const runtimeLoading = ref(false)
const showProfileModal = ref(false)
const showAvatarModal = ref(false)
const editingProfile = ref<HermesProfile | null>(null)
const avatarSaving = ref(false)
const fileInputRef = ref<HTMLInputElement | null>(null)
const gatewayRestarting = ref<Record<string, boolean>>({})
const profileRestarting = ref<Record<string, boolean>>({})
const profileSwitching = ref<Record<string, boolean>>({})
const statusByProfile = computed(() => new Map(runtimeStatuses.value.map(status => [status.profile, status])))
let runtimeRefreshToken = 0

function setProfileModalShow(show: boolean) {
  showProfileModal.value = show
  emit('modal-show-change', show)
}

async function loadRuntimeStatuses(options: { background?: boolean } = {}): Promise<boolean> {
  const token = ++runtimeRefreshToken
  if (!options.background) {
    runtimeLoading.value = runtimeStatuses.value.length === 0
  }
  try {
    const res = await fetchProfileRuntimeStatusesWithMeta({ refresh: !options.background })
    if (token !== runtimeRefreshToken) return false
    runtimeStatuses.value = res.profiles
    return !!res.refreshing
  } catch {
    runtimeStatuses.value = []
    return false
  } finally {
    if (token === runtimeRefreshToken) {
      runtimeLoading.value = false
    }
  }
}

function openProfileModal() {
  setProfileModalShow(true)
  void loadRuntimeStatuses().then((refreshing) => {
    if (refreshing) scheduleRuntimeStatusPoll()
  })
}

function scheduleRuntimeStatusPoll(attempt = 0) {
  if (attempt >= 12 || typeof window === 'undefined') return
  window.setTimeout(() => {
    if (!showProfileModal.value) return
    void loadRuntimeStatuses({ background: true }).then((refreshing) => {
      if (refreshing) scheduleRuntimeStatusPoll(attempt + 1)
    })
  }, attempt === 0 ? 700 : 1200)
}

function handleProfileModalShowChange(show: boolean) {
  setProfileModalShow(show)
}

function openAvatarModal(profile: HermesProfile) {
  editingProfile.value = profile
  showAvatarModal.value = true
}

function randomSeed() {
  return `profile-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

async function saveAvatar(avatar: ProfileAvatar) {
  if (!editingProfile.value) return
  avatarSaving.value = true
  try {
    await profilesStore.updateAvatar(editingProfile.value.name, avatar)
    message.success(t('profiles.avatar.saveSuccess'))
    showAvatarModal.value = false
  } catch (err: any) {
    message.error(err?.message || t('profiles.avatar.saveFailed'))
  } finally {
    avatarSaving.value = false
  }
}

async function handleRandomAvatar() {
  await saveAvatar({ type: 'generated', seed: randomSeed() })
}

async function handleResetAvatar() {
  if (!editingProfile.value) return
  avatarSaving.value = true
  try {
    await profilesStore.deleteAvatar(editingProfile.value.name)
    message.success(t('profiles.avatar.resetSuccess'))
    showAvatarModal.value = false
  } catch (err: any) {
    message.error(err?.message || t('profiles.avatar.resetFailed'))
  } finally {
    avatarSaving.value = false
  }
}

function triggerAvatarUpload() {
  fileInputRef.value?.click()
}

async function handleAvatarFileChange(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (!file) return
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) {
    message.warning(t('profiles.avatar.invalidType'))
    return
  }
  if (file.size > 1024 * 1024) {
    message.warning(t('profiles.avatar.tooLarge'))
    return
  }
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result || ''))
    reader.onerror = () => reject(reader.error || new Error('Failed to read file'))
    reader.readAsDataURL(file)
  })
  await saveAvatar({ type: 'image', dataUrl })
}

function gatewayStatusText(running?: boolean) {
  if (running == null) return t('profiles.runtime.checking')
  return running ? t('profiles.runtime.running') : t('profiles.runtime.stopped')
}

function bridgeStatusText(running?: boolean) {
  if (running == null) return t('profiles.runtime.checking')
  return running ? t('profiles.runtime.active') : t('profiles.runtime.idle')
}

async function handleRestartGateway(name: string) {
  gatewayRestarting.value = { ...gatewayRestarting.value, [name]: true }
  try {
    const gateway = await restartProfileGateway(name)
    const current = statusByProfile.value.get(name)
    if (current) {
      runtimeStatuses.value = runtimeStatuses.value.map(status => (
        status.profile === name ? { ...status, gateway } : status
      ))
    }
    message.success(t('profiles.runtime.gatewayRestarted', { name }))
  } catch (err: any) {
    message.error(err?.message || t('profiles.runtime.gatewayRestartFailed'))
  } finally {
    gatewayRestarting.value = { ...gatewayRestarting.value, [name]: false }
  }
}

async function handleRestartProfile(name: string) {
  profileRestarting.value = { ...profileRestarting.value, [name]: true }
  try {
    const status = await restartProfileRuntime(name)
    runtimeStatuses.value = runtimeStatuses.value.map(item => (
      item.profile === name ? status : item
    ))
    message.success(t('profiles.runtime.profileRestarted', { name }))
  } catch (err: any) {
    message.error(err?.message || t('profiles.runtime.profileRestartFailed'))
  } finally {
    profileRestarting.value = { ...profileRestarting.value, [name]: false }
  }
}

async function handleSwitchProfile(name: string) {
  if (name === displayName.value) return
  profileSwitching.value = { ...profileSwitching.value, [name]: true }
  try {
    const ok = await profilesStore.switchProfile(name)
    if (!ok) throw new Error(t('profiles.switchFailed'))
    message.success(t('profiles.switchSuccess', { name }))
    window.location.reload()
  } catch (err: any) {
    message.error(err?.message || t('profiles.switchFailed'))
  } finally {
    profileSwitching.value = { ...profileSwitching.value, [name]: false }
  }
}

onMounted(() => {
  if (profilesStore.profiles.length === 0) {
    profilesStore.fetchProfiles()
  }
})
</script>

<template>
  <div class="profile-selector">
    <div class="selector-label">{{ t('sidebar.profiles') }}</div>
    <div class="profile-display" data-testid="profile-selector-select" @click="openProfileModal">
      <ProfileAvatarView class="profile-avatar" :name="displayName" :avatar="activeProfile?.avatar" :size="24" />
      <span class="profile-name">{{ activeProfileTitle }}</span>
    </div>

    <NModal
      :show="showProfileModal"
      preset="card"
      :bordered="false"
      :style="{ width: '720px', maxWidth: 'calc(100vw - 32px)' }"
      class="profile-manager-modal"
      @update:show="handleProfileModalShowChange"
    >
      <template #header>
        <div class="profile-modal-header">
          <div class="profile-popover-title">
            <span class="profile-popover-name">{{ t('sidebar.profiles') }}</span>
            <span class="profile-popover-subtitle">{{ t('profiles.runtime.activeProfile', { name: activeProfileTitle }) }}</span>
          </div>
        </div>
      </template>

      <NSpin :show="runtimeLoading" size="small">
        <div class="profile-runtime-list">
          <div
            v-for="profile in profilesStore.profiles"
            :key="profile.name"
            class="profile-runtime-item"
            :class="{ active: profile.name === displayName }"
          >
            <div class="profile-runtime-main">
              <ProfileAvatarView class="profile-runtime-avatar" :name="profile.name" :avatar="profile.avatar" :size="34" />
              <div class="profile-runtime-info">
                <div class="profile-runtime-name-row">
                  <span class="profile-runtime-name">{{ profileDisplayLabel(profile) }}</span>
                  <span v-if="profile.displayName && profile.displayName !== profile.name" class="profile-runtime-id">{{ profile.name }}</span>
                  <span v-if="profile.name === displayName" class="active-badge">{{ t('profiles.runtime.activeTag') }}</span>
                </div>
                <div class="runtime-status-grid">
                  <div class="runtime-row compact">
                    <span class="runtime-label">{{ t('profiles.runtime.bridgeWorker') }}</span>
                    <span class="runtime-value" :class="{ running: statusByProfile.get(profile.name)?.bridge.running }">
                      <span class="runtime-dot" />
                      {{ bridgeStatusText(statusByProfile.get(profile.name)?.bridge.running) }}
                    </span>
                  </div>
                  <div class="runtime-row compact">
                    <span class="runtime-label">{{ t('profiles.runtime.gateway') }}</span>
                    <span class="runtime-value" :class="{ running: statusByProfile.get(profile.name)?.gateway.running }">
                      <span class="runtime-dot" />
                      {{ gatewayStatusText(statusByProfile.get(profile.name)?.gateway.running) }}
                    </span>
                  </div>
                </div>
                <div
                  v-if="!statusByProfile.get(profile.name)?.gateway.running && (statusByProfile.get(profile.name)?.gateway.diagnostics?.reason || statusByProfile.get(profile.name)?.gateway.error)"
                  class="runtime-detail"
                >
                  {{ statusByProfile.get(profile.name)?.gateway.diagnostics?.reason || statusByProfile.get(profile.name)?.gateway.error }}
                </div>
              </div>
            </div>
            <div class="profile-runtime-actions">
              <NButton
                size="small"
                type="primary"
                @click="openAvatarModal(profile)"
              >
                {{ t('profiles.avatar.customize') }}
              </NButton>
              <NButton
                size="small"
                type="primary"
                :loading="gatewayRestarting[profile.name]"
                @click="handleRestartGateway(profile.name)"
              >
                {{ t('profiles.runtime.restartGateway') }}
              </NButton>
              <NButton
                size="small"
                type="primary"
                :loading="profileRestarting[profile.name]"
                @click="handleRestartProfile(profile.name)"
              >
                {{ t('profiles.runtime.restartProfile') }}
              </NButton>
              <NButton
                size="small"
                type="primary"
                :disabled="profile.name === displayName"
                :loading="profileSwitching[profile.name]"
                @click="handleSwitchProfile(profile.name)"
              >
                {{ t('profiles.runtime.switchProfile') }}
              </NButton>
            </div>
          </div>
        </div>
      </NSpin>
    </NModal>

    <NModal
      v-model:show="showAvatarModal"
      preset="card"
      :title="t('profiles.avatar.title')"
      :bordered="false"
      :style="{ width: '420px', maxWidth: 'calc(100vw - 32px)' }"
    >
      <div v-if="editingProfile" class="avatar-editor">
        <ProfileAvatarView :name="editingProfile.name" :avatar="editingProfile.avatar" :size="72" />
        <div class="avatar-editor-meta">
          <div class="avatar-editor-name">{{ editingProfile.name }}</div>
          <div class="avatar-editor-hint">{{ t('profiles.avatar.hint') }}</div>
        </div>
        <input
          ref="fileInputRef"
          class="avatar-file-input"
          type="file"
          accept="image/png,image/jpeg,image/webp"
          @change="handleAvatarFileChange"
        >
        <div class="avatar-editor-actions">
          <NButton type="primary" :loading="avatarSaving" @click="triggerAvatarUpload">
            {{ t('profiles.avatar.upload') }}
          </NButton>
          <NButton type="primary" :loading="avatarSaving" @click="handleRandomAvatar">
            {{ t('profiles.avatar.random') }}
          </NButton>
          <NButton :loading="avatarSaving" @click="handleResetAvatar">
            {{ t('profiles.avatar.reset') }}
          </NButton>
        </div>
      </div>
    </NModal>
  </div>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;

.profile-selector {
  padding: 0 12px;
  margin-bottom: 8px;
}

.selector-label {
  font-size: 11px;
  font-weight: 600;
  color: $text-muted;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  margin-bottom: 6px;
}

.profile-display {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  height: 34px;
  padding: 4px 6px;
  border-radius: 8px;
  background: $bg-secondary;
  border: 1px solid $border-color;
  cursor: pointer;
}

.profile-avatar {
  background: $bg-card;
}

.profile-name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 13px;
  font-weight: 600;
  color: $text-primary;
}

.profile-popover {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.profile-popover-header {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
}

.profile-popover-avatar {
  width: 36px;
  height: 36px;
  border-radius: 50%;
  overflow: hidden;
  background: $bg-secondary;
  flex: 0 0 auto;

  :deep(svg) {
    width: 100%;
    height: 100%;
    display: block;
  }
}

.profile-popover-title {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.profile-popover-name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 14px;
  font-weight: 700;
  color: $text-primary;
}

.profile-popover-subtitle,
.runtime-label,
.runtime-detail {
  font-size: 12px;
  color: $text-muted;
}

.runtime-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-height: 62px;
}

.profile-runtime-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
  max-height: 420px;
  min-height: 96px;
  overflow-y: auto;
}

.profile-runtime-item {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px;
  border: 1px solid $border-color;
  border-radius: 8px;
  background: $bg-card;

  &.active {
    border-color: $accent-muted;
    background: $bg-card-hover;
  }
}

.profile-runtime-main {
  display: flex;
  gap: 10px;
  min-width: 0;
}

.profile-runtime-avatar {
  background: $bg-secondary;
}

.profile-runtime-info {
  min-width: 0;
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 5px;
}

.profile-runtime-name-row {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}

.profile-runtime-name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 13px;
  font-weight: 700;
  color: $text-primary;
}

.profile-runtime-id {
  flex: 0 0 auto;
  font-size: 11px;
  font-weight: 500;
  color: $text-secondary;
  font-family: ui-monospace, Menlo, Consolas, monospace;
}

.active-badge {
  flex: 0 0 auto;
  padding: 1px 5px;
  border-radius: 999px;
  background: color-mix(in srgb, $success 16%, transparent);
  color: $success;
  font-size: 10px;
  font-weight: 700;
}

.profile-runtime-actions {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 6px;

  :deep(.n-button) {
    min-width: 88px;
  }
}

.runtime-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;

  &.compact {
    gap: 8px;
  }
}

.runtime-value {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  color: $text-secondary;
  font-size: 12px;
  font-weight: 600;

  &.running {
    color: $success;

    .runtime-dot {
      background: $success;
    }
  }
}

.runtime-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: $text-muted;
}

.runtime-detail {
  line-height: 1.4;
  word-break: break-word;
}

.avatar-editor {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 14px;
}

.avatar-editor-meta {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  min-width: 0;
}

.avatar-editor-name {
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 15px;
  font-weight: 700;
  color: $text-primary;
}

.avatar-editor-hint {
  font-size: 12px;
  color: $text-muted;
  text-align: center;
}

.avatar-file-input {
  display: none;
}

.avatar-editor-actions {
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  gap: 8px;
}

@media (max-width: 520px) {
  .profile-runtime-actions {
    justify-content: flex-start;
    gap: 5px;

    :deep(.n-button) {
      min-width: 0;
      --n-height: 26px !important;
      --n-font-size: 12px !important;
      --n-padding: 0 8px !important;
    }
  }

  .avatar-editor-actions {
    gap: 6px;

    :deep(.n-button) {
      --n-height: 28px !important;
      --n-font-size: 12px !important;
      --n-padding: 0 9px !important;
    }
  }
}
</style>
