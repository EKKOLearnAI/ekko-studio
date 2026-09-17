<script setup lang="ts">
import { ref, computed } from 'vue'
import { useRouter } from 'vue-router'
import { NButton, NTag, NSpin, useMessage, useDialog } from 'naive-ui'
import type { HermesProfile, HermesProfileDetail } from '@/api/hermes/profiles'
import { useProfilesStore } from '@/stores/hermes/profiles'
import { useI18n } from 'vue-i18n'
import ProfileAvatar from './ProfileAvatar.vue'
import { profileDisplayLabel } from '@/lib/profileDisplay'

const props = defineProps<{ profile: HermesProfile }>()
const emit = defineEmits<{}>()

const { t } = useI18n()
const profilesStore = useProfilesStore()
const message = useMessage()
const dialog = useDialog()
const router = useRouter()

const expanded = ref(false)
const detailLoading = ref(false)
const exporting = ref(false)
const switching = ref(false)
const detail = ref<HermesProfileDetail | null>(null)

const isDefault = computed(() => props.profile.name === 'default')
const profileTitle = computed(() => profileDisplayLabel(props.profile))

async function toggleDetail() {
  if (expanded.value) {
    expanded.value = false
    return
  }
  expanded.value = true
  detailLoading.value = true
  try {
    detail.value = await profilesStore.fetchProfileDetail(props.profile.name)
  } finally {
    detailLoading.value = false
  }
}

async function handleSwitch() {
  dialog.warning({
    title: t('profiles.switchTo'),
    content: t('profiles.switchConfirm', { name: props.profile.name }),
    positiveText: t('profiles.switchTo'),
    negativeText: t('common.cancel'),
    onPositiveClick: performHermesSwitch,
  })
}

async function performHermesSwitch() {
  switching.value = true
  try {
    const ok = await profilesStore.switchHermesProfile(props.profile.name)
    if (ok) {
      message.success(t('profiles.switchSuccess', { name: props.profile.name }))
      // Reload to refresh all profile-dependent data
      setTimeout(() => window.location.reload(), 500)
    } else {
      message.error(t('profiles.switchFailed'))
    }
  } finally {
    switching.value = false
  }
}

function handleDelete() {
  dialog.warning({
    title: t('profiles.delete'),
    content: t('profiles.deleteConfirm', { name: props.profile.name }),
    positiveText: t('common.delete'),
    negativeText: t('common.cancel'),
    onPositiveClick: async () => {
      const ok = await profilesStore.deleteProfile(props.profile.name)
      if (ok) {
        message.success(t('profiles.deleteSuccess'))
      } else {
        message.error(t('profiles.deleteFailed'))
      }
    },
  })
}

async function handleExport() {
  exporting.value = true
  try {
    const res = await profilesStore.exportProfile(props.profile.name)
    if (res.success) {
      message.success(t('profiles.exportSuccess'))
    } else if (res.code === 'archive_timeout') {
      message.error(t('profiles.exportTimeout'), { duration: 8000 })
    } else {
      message.error(res.error || t('profiles.exportFailed'))
    }
  } finally {
    exporting.value = false
  }
}

function handleEditConfig() {
  void router.push({
    name: 'hermes.files',
    query: {
      profile: props.profile.name,
      file: 'config.yaml',
    },
  })
}
</script>

<template>
  <div class="profile-card" :class="{ active: profile.active }">
    <div class="card-header">
      <div class="profile-title">
        <ProfileAvatar :name="profile.name" :avatar="profile.avatar" :size="28" />
        <h3 class="profile-name">{{ profileTitle }}</h3>
        <span v-if="profile.displayName && profile.displayName !== profile.name" class="profile-id">{{ profile.name }}</span>
      </div>
      <NTag v-if="profile.active" size="tiny" type="primary" :bordered="false">
        {{ t('profiles.active') }}
      </NTag>
    </div>

    <div class="card-body">
      <div class="info-row">
        <span class="info-label">{{ t('profiles.model') }}</span>
        <code class="info-value mono">{{ profile.model }}</code>
      </div>
    </div>

    <div class="card-detail-toggle" @click="toggleDetail">
      <svg
        width="14" height="14" viewBox="0 0 24 24" fill="none"
        stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"
        class="toggle-icon"
        :class="{ expanded }"
      >
        <polyline points="6 9 12 15 18 9" />
      </svg>
      <span class="toggle-text">{{ expanded ? t('common.collapse') : t('common.expand') }}</span>
    </div>

    <div v-if="expanded" class="card-detail">
      <NSpin :show="detailLoading" size="small">
        <template v-if="detail">
          <div class="info-row">
            <span class="info-label">{{ t('profiles.provider') }}</span>
            <span class="info-value">{{ detail.provider }}</span>
          </div>
          <div class="info-row">
            <span class="info-label">{{ t('profiles.path') }}</span>
            <code class="info-value mono detail-path">{{ detail.path }}</code>
          </div>
          <div class="info-row">
            <span class="info-label">{{ t('profiles.skills') }}</span>
            <span class="info-value">{{ detail.skills }}</span>
          </div>
          <div class="info-row">
            <span class="info-label">{{ t('profiles.hasEnv') }}</span>
            <span class="info-value">{{ detail.hasEnv ? 'Yes' : 'No' }}</span>
          </div>
          <div class="info-row">
            <span class="info-label">{{ t('profiles.hasSoulMd') }}</span>
            <span class="info-value">{{ detail.hasSoulMd ? 'Yes' : 'No' }}</span>
          </div>
        </template>
      </NSpin>
    </div>

    <div class="card-actions">
      <NButton size="tiny" quaternary @click="handleEditConfig">
        {{ t('profiles.editConfig') }}
      </NButton>
      <NButton
        v-if="profilesStore.hermesAvailable && !profile.active"
        data-testid="switch-hermes-profile"
        size="tiny"
        :loading="switching"
        quaternary
        type="primary"
        @click="handleSwitch"
      >
        {{ t('profiles.switchTo') }}
      </NButton>
      <NButton
        size="tiny"
        quaternary
        type="error"
        :disabled="isDefault || profile.active"
        @click="handleDelete"
      >
        {{ t('common.delete') }}
      </NButton>
      <NButton size="tiny" quaternary :loading="exporting" @click="handleExport">
        {{ t('profiles.export') }}
      </NButton>
    </div>
  </div>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;

.profile-card {
  background-color: $bg-card;
  border: 1px solid $border-color;
  border-radius: $radius-md;
  padding: 16px;
  transition: border-color $transition-fast;

  &:hover {
    border-color: rgba(var(--accent-primary-rgb), 0.3);
  }

  &.active {
    border-color: rgba(var(--accent-primary-rgb), 0.4);
  }
}

.card-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  margin-bottom: 12px;
}

.profile-title {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px 8px;
  min-width: 0;
}

.profile-id {
  font-size: 11px;
  font-weight: 500;
  color: $text-secondary;
  font-family: ui-monospace, Menlo, Consolas, monospace;
}

.profile-name {
  font-size: 15px;
  font-weight: 600;
  color: $text-primary;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 100%;
  margin: 0;
}

.card-body {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-bottom: 8px;
}

.card-detail-toggle {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 6px 0;
  cursor: pointer;
  color: $text-muted;
  font-size: 12px;
  user-select: none;

  &:hover {
    color: $text-secondary;
  }
}

.toggle-icon {
  transition: transform 0.2s;

  &.expanded {
    transform: rotate(180deg);
  }
}

.card-detail {
  padding: 8px 0;
  border-top: 1px solid $border-light;
  margin-bottom: 8px;
}

.info-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 2px 0;
}

.info-label {
  font-size: 12px;
  color: $text-muted;
  flex-shrink: 0;
  margin-inline-end: 12px;
}

.info-value {
  font-size: 12px;
  color: $text-secondary;
  text-align: end;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.mono {
  font-family: $font-code;
  font-size: 12px;
}

.detail-path {
  max-width: 260px;
}

.card-actions {
  display: flex;
  gap: 8px;
  border-top: 1px solid $border-light;
  padding-top: 10px;
  flex-wrap: wrap;
}
</style>
