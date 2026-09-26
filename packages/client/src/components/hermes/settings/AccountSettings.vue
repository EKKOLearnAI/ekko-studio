<script setup lang="ts">
import { ref, onMounted } from "vue";
import { storeToRefs } from "pinia";
import { useAccountStore } from "@/stores/account";
import { NButton, NInput, NModal, NForm, NFormItem, NPopconfirm, useMessage } from "naive-ui";
import { useI18n } from "vue-i18n";
import { changePassword, changeUsername, fetchLockedIps, unlockSpecificIp, unlockAllIps, updateMyAvatar, resetMyAvatar } from "@/api/studio/auth";
import type { LockedIp } from "@/api/studio/auth";
import ProfileAvatar from "@/components/hermes/profiles/ProfileAvatar.vue";
import boring from "boring-avatars-vanilla";

const { t } = useI18n();
const message = useMessage();

const accountStore = useAccountStore();
const { username, avatar } = storeToRefs(accountStore);
const loading = ref(false);

// User avatar
const avatarFileInput = ref<HTMLInputElement | null>(null);
const avatarSaving = ref(false);

function compressImage(file: File, maxBytes: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const img = new Image()
      img.onload = () => {
        const canvas = document.createElement('canvas')
        canvas.width = img.width
        canvas.height = img.height
        const ctx = canvas.getContext('2d')!
        ctx.drawImage(img, 0, 0)
        const tryCompress = (quality: number) => {
          const result = canvas.toDataURL('image/jpeg', quality)
          if (result.length <= maxBytes || quality <= 0.3) resolve(result)
          else tryCompress(quality - 0.1)
        }
        tryCompress(0.8)
      }
      img.onerror = reject
      img.src = reader.result as string
    }
    reader.onerror = reject
    reader.readAsDataURL(file)
  })
}

async function handleAvatarUpload(event: Event) {
  const target = event.target as HTMLInputElement
  const file = target.files?.[0]
  if (!file) return
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) {
    message.error(t('settings.userAvatar.invalidType'))
    target.value = ''
    return
  }
  if (file.size > 1024 * 1024) {
    message.error(t('settings.userAvatar.tooLarge'))
    target.value = ''
    return
  }
  avatarSaving.value = true
  try {
    let dataUrl: string
    if (file.size > 500 * 1024) {
      dataUrl = await compressImage(file, 500 * 1024)
    } else {
      dataUrl = await new Promise<string>((resolve, reject) => {
        const r = new FileReader()
        r.onload = () => resolve(r.result as string)
        r.onerror = reject
        r.readAsDataURL(file)
      })
    }
    await updateMyAvatar({ type: 'image', dataUrl })
    avatar.value = { type: 'image', dataUrl }
    message.success(t('settings.userAvatar.saveSuccess'))
  } catch (err: any) {
    message.error(err.message || t('settings.userAvatar.saveFailed'))
  } finally {
    avatarSaving.value = false
    target.value = ''
  }
}

async function handleRandomAvatar() {
  avatarSaving.value = true
  try {
    const randomPart = typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID()
      : Math.random().toString(36).slice(2)
    const seed = `${username.value || 'default'}-${Date.now()}-${randomPart}`
    const svg = boring({ name: seed, variant: 'beam' })
    const dataUrl = 'data:image/svg+xml;base64,' + btoa(unescape(encodeURIComponent(svg)))
    await updateMyAvatar({ type: 'image', dataUrl, seed })
    avatar.value = { type: 'image', dataUrl, seed }
    message.success(t('settings.userAvatar.saveSuccess'))
  } catch (err: any) {
    message.error(err.message || t('settings.userAvatar.saveFailed'))
  } finally {
    avatarSaving.value = false
  }
}

async function handleResetAvatar() {
  avatarSaving.value = true
  try {
    await resetMyAvatar()
    avatar.value = { type: 'default', seed: username.value || 'default' }
    message.success(t('settings.userAvatar.resetSuccess'))
  } catch (err: any) {
    message.error(err.message || t('settings.userAvatar.resetFailed'))
  } finally {
    avatarSaving.value = false
  }
}

// Change password form
const showChangePasswordModal = ref(false);
const currentPasswordForPwd = ref("");
const newPasswordVal = ref("");
const newPasswordConfirm = ref("");

// Change username form
const showChangeUsernameModal = ref(false);
const currentPasswordForName = ref("");
const newUsernameVal = ref("");

onMounted(() => { void accountStore.loadAccount(); });

async function handleChangePassword() {
  if (newPasswordVal.value !== newPasswordConfirm.value) {
    message.error(t("login.passwordMismatch"));
    return;
  }
  if (newPasswordVal.value.length < 6) {
    message.error(t("login.passwordTooShort"));
    return;
  }
  loading.value = true;
  try {
    await changePassword(currentPasswordForPwd.value, newPasswordVal.value);
    showChangePasswordModal.value = false;
    currentPasswordForPwd.value = "";
    newPasswordVal.value = "";
    newPasswordConfirm.value = "";
    message.success(t("login.passwordChanged"));
  } catch (err: any) {
    message.error(err.message || t("common.saveFailed"));
  } finally {
    loading.value = false;
  }
}

async function handleChangeUsername() {
  if (newUsernameVal.value.trim().length < 2) {
    message.error(t("login.usernameTooShort"));
    return;
  }
  loading.value = true;
  try {
    await changeUsername(currentPasswordForName.value, newUsernameVal.value.trim());
    username.value = newUsernameVal.value.trim();
    showChangeUsernameModal.value = false;
    currentPasswordForName.value = "";
    newUsernameVal.value = "";
    message.success(t("login.usernameChanged"));
  } catch (err: any) {
    message.error(err.message || t("common.saveFailed"));
  } finally {
    loading.value = false;
  }
}

function openChangePasswordModal() {
  currentPasswordForPwd.value = "";
  newPasswordVal.value = "";
  newPasswordConfirm.value = "";
  showChangePasswordModal.value = true;
}

function openChangeUsernameModal() {
  currentPasswordForName.value = "";
  newUsernameVal.value = "";
  showChangeUsernameModal.value = true;
}

// Locked IPs management
const lockedIps = ref<LockedIp[]>([]);
const loadingLocks = ref(false);

async function loadLockedIps() {
  loadingLocks.value = true;
  try {
    lockedIps.value = await fetchLockedIps();
  } catch { /* ignore */ }
  finally {
    loadingLocks.value = false;
  }
}

async function handleUnlockIp(ip: string) {
  try {
    await unlockSpecificIp(ip);
    message.success(t("settings.lockedIps.unlocked"));
    await loadLockedIps();
  } catch (err: any) {
    message.error(err.message || t("common.saveFailed"));
  }
}

async function handleUnlockAll() {
  try {
    const count = await unlockAllIps();
    message.success(t("settings.lockedIps.allUnlocked", { count }));
    await loadLockedIps();
  } catch (err: any) {
    message.error(err.message || t("common.saveFailed"));
  }
}

function formatTime(ts: number): string {
  const remaining = Math.max(0, Math.round((ts - Date.now()) / 60000));
  return remaining > 0 ? `${remaining} min` : t("common.expired");
}

function lockedIpTypeLabel(type: LockedIp["type"]): string {
  return t(`settings.lockedIps.type.${type}`);
}

onMounted(() => { loadLockedIps(); });
</script>

<template>
  <div class="account-settings">
    <p class="section-desc">{{ t("login.setupDescription") }}</p>

    <!-- User Avatar -->
    <div class="avatar-section">
      <h3 class="section-title">{{ t('settings.userAvatar.title') }}</h3>
      <div class="avatar-row">
        <div class="avatar-display">
          <ProfileAvatar
            :name="username || 'default'"
            :avatar="avatar?.type === 'image' && avatar.dataUrl ? { type: 'image', dataUrl: avatar.dataUrl } : null"
            :size="80"
          />
        </div>
        <div class="avatar-actions">
          <p class="avatar-hint">{{ t('settings.userAvatar.hint') }}</p>
          <div class="action-buttons">
            <NButton @click="avatarFileInput?.click()">{{ t('settings.userAvatar.upload') }}</NButton>
            <NButton @click="handleRandomAvatar" :loading="avatarSaving">{{ t('settings.userAvatar.random') }}</NButton>
            <NButton @click="handleResetAvatar" :loading="avatarSaving">{{ t('settings.userAvatar.reset') }}</NButton>
          </div>
          <input
            ref="avatarFileInput"
            type="file"
            accept=".png,.jpg,.jpeg,.webp"
            style="display: none"
            @change="handleAvatarUpload"
          />
        </div>
      </div>
    </div>

    <div class="configured-section">
      <div class="action-row">
        <span class="action-label">{{ t("login.passwordLoginConfigured", { username }) }}</span>
        <div class="action-buttons">
          <NButton @click="openChangePasswordModal">{{ t("login.changePassword") }}</NButton>
          <NButton @click="openChangeUsernameModal">{{ t("login.changeUsername") }}</NButton>
        </div>
      </div>
    </div>

    <!-- Locked IPs management -->
    <div class="locked-ips-section">
      <h3 class="section-title">{{ t("settings.lockedIps.title") }}</h3>
      <div class="action-row" style="margin-bottom: 12px;">
        <span class="action-label">{{ t("settings.lockedIps.count", { count: lockedIps.length }) }}</span>
        <div class="action-buttons">
          <NButton size="small" :loading="loadingLocks" @click="loadLockedIps">{{ t("common.retry") }}</NButton>
          <NPopconfirm v-if="lockedIps.length > 0" @positive-click="handleUnlockAll">
            <template #trigger>
              <NButton size="small" type="warning">{{ t("settings.lockedIps.unlockAll") }}</NButton>
            </template>
            {{ t("settings.lockedIps.unlockAllConfirm") }}
          </NPopconfirm>
        </div>
      </div>
      <div v-if="lockedIps.length > 0" class="locked-list">
        <div v-for="lock in lockedIps" :key="lock.ip + lock.type" class="locked-item">
          <div class="locked-info">
            <span class="locked-ip">{{ lock.ip }}</span>
            <span class="locked-badge">{{ lockedIpTypeLabel(lock.type) }}</span>
            <span class="locked-ttl">{{ formatTime(lock.lockedUntil) }}</span>
          </div>
          <NButton size="tiny" type="error" ghost @click="handleUnlockIp(lock.ip)">{{ t("settings.lockedIps.unlock") }}</NButton>
        </div>
      </div>
      <p v-else class="empty-hint">{{ t("settings.lockedIps.empty") }}</p>
    </div>

    <!-- Change password modal -->
    <NModal v-model:show="showChangePasswordModal" preset="dialog" :title="t('login.changePassword')">
      <NForm label-placement="top">
        <NFormItem :label="t('login.currentPassword')">
          <NInput v-model:value="currentPasswordForPwd" type="password" show-password-on="click" :placeholder="t('login.currentPassword')" />
        </NFormItem>
        <NFormItem :label="t('login.newPassword')">
          <NInput v-model:value="newPasswordVal" type="password" show-password-on="click" :placeholder="t('login.newPassword')" />
        </NFormItem>
        <NFormItem :label="t('login.confirmPassword')">
          <NInput v-model:value="newPasswordConfirm" type="password" show-password-on="click" :placeholder="t('login.confirmPassword')" @keyup.enter="handleChangePassword" />
        </NFormItem>
      </NForm>
      <template #action>
        <NButton @click="showChangePasswordModal = false">{{ t("common.cancel") }}</NButton>
        <NButton type="primary" :loading="loading" @click="handleChangePassword">{{ t("common.save") }}</NButton>
      </template>
    </NModal>

    <!-- Change username modal -->
    <NModal v-model:show="showChangeUsernameModal" preset="dialog" :title="t('login.changeUsername')">
      <NForm label-placement="top">
        <NFormItem :label="t('login.currentPassword')">
          <NInput v-model:value="currentPasswordForName" type="password" show-password-on="click" :placeholder="t('login.currentPassword')" />
        </NFormItem>
        <NFormItem :label="t('login.newUsername')">
          <NInput v-model:value="newUsernameVal" :placeholder="t('login.usernamePlaceholder')" @keyup.enter="handleChangeUsername" />
        </NFormItem>
      </NForm>
      <template #action>
        <NButton @click="showChangeUsernameModal = false">{{ t("common.cancel") }}</NButton>
        <NButton type="primary" :loading="loading" @click="handleChangeUsername">{{ t("common.save") }}</NButton>
      </template>
    </NModal>
  </div>
</template>

<style scoped lang="scss">
@use "@/styles/variables" as *;

.account-settings {
  padding: 8px 0;
}

.section-desc {
  font-size: 13px;
  color: $text-muted;
  margin: 0 0 20px;
  line-height: 1.6;
}

.action-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
}

.action-label {
  font-size: 14px;
  color: $text-secondary;
}

.action-buttons {
  display: flex;
  gap: 8px;
  flex-shrink: 0;
}

.locked-ips-section {
  margin-top: 32px;
  padding-top: 20px;
  border-top: 1px solid $border-color;
}

.section-title {
  font-size: 15px;
  font-weight: 600;
  color: $text-primary;
  margin: 0 0 16px;
}

.locked-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.locked-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 12px;
  border: 1px solid $border-color;
  border-radius: $radius-sm;
  background: $bg-input;
}

.locked-info {
  display: flex;
  align-items: center;
  gap: 8px;
}

.locked-ip {
  font-family: $font-code;
  font-size: 13px;
  color: $text-primary;
}

.locked-badge {
  font-size: 11px;
  padding: 2px 6px;
  border-radius: 3px;
  background: rgba($error, 0.1);
  color: $error;
}

.locked-ttl {
  font-size: 12px;
  color: $text-muted;
}

.empty-hint {
  font-size: 13px;
  color: $text-muted;
  margin: 0;
}

.avatar-section {
  margin-bottom: 32px;
  padding-bottom: 20px;
  border-bottom: 1px solid $border-color;
}

.avatar-row {
  display: flex;
  align-items: center;
  gap: 24px;
}

.avatar-display {
  flex-shrink: 0;
}

.avatar-actions {
  flex: 1;
}

.avatar-hint {
  font-size: 12px;
  color: $text-muted;
  margin: 0 0 12px;
}
</style>
