<script setup lang="ts">
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { NButton, NModal, useMessage, NTag, type GlobalThemeOverrides } from 'naive-ui'
import { useAppStore } from '@/stores/hermes/app'
import ModelSelector from '@/components/layout/ModelSelector.vue'
import ProfileSelector from '@/components/layout/ProfileSelector.vue'
import LanguageSwitch from '@/components/layout/LanguageSwitch.vue'
import ThemeSwitch from '@/components/layout/ThemeSwitch.vue'
import { changelog } from '@/data/changelog'
import { getStoredUserId } from '@/api/client'
import { clearThemeBackgroundCache } from '@/api/studio/theme'

const emit = defineEmits<{ 'open-modal': [] }>()
const { t } = useI18n()
const message = useMessage()
const appStore = useAppStore()
const showChangelog = ref(false)
const showDockerUpdateTip = ref(false)
const isDockerRuntime = computed(() => appStore.isDocker)
const languageThemeOverrides: GlobalThemeOverrides['Select'] = {
  peers: {
    InternalSelection: {
      heightSmall: 'var(--account-selector-height)',
      fontSizeSmall: '13px',
      borderRadius: 'var(--account-selector-radius)',
      paddingSingle: '0 9px',
      arrowSize: '12px',
      arrowColor: 'var(--text-muted)',
      color: 'var(--bg-input)',
      colorActive: 'var(--bg-input)',
      textColor: 'var(--text-primary)',
      border: '1px solid var(--border-color)',
      borderHover: '1px solid var(--accent-muted)',
    },
  },
}

function handleModalShow(show: boolean) {
  if (show) emit('open-modal')
}

async function handleUpdate() {
  const ok = await appStore.doUpdate();
  if (ok) {
    message.success(t("sidebar.updateSuccess"), { duration: 5000 });
  } else {
    message.error(t("sidebar.updateFailed"));
  }
}

function handleReloadClient() {
  appStore.reloadClient();
}

async function handleLogout() {
  const userId = getStoredUserId();
  if (userId) await clearThemeBackgroundCache(userId);
  localStorage.clear();
  window.location.reload();
}

function openChangelog() {
  emit('open-modal');
  showChangelog.value = true;
}

function handleDockerUpdateTip() {
  emit('open-modal');
  showDockerUpdateTip.value = true;
}

function handleUpdateClick() {
  if (isDockerRuntime.value) {
    handleDockerUpdateTip();
    return;
  }
  void handleUpdate();
}
</script>

<template>
  <div class="sidebar-account-controls">
    <ProfileSelector @modal-show-change="handleModalShow" />
    <ModelSelector @modal-show-change="handleModalShow" />
    <div class="language-row">
      <span class="language-label">{{ t("language.label") }}</span>
      <LanguageSwitch size="small" :theme-overrides="languageThemeOverrides" />
    </div>

    <div class="sidebar-footer">
      <div class="logout-row">
        <button class="nav-item logout-item" @click="handleLogout">
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="1.5"
            stroke-linecap="round"
            stroke-linejoin="round"
          >
            <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
            <polyline points="16 17 21 12 16 7" />
            <line x1="21" y1="12" x2="9" y2="12" />
          </svg>
          <span>{{ t("sidebar.logout") }}</span>
        </button>
        <div
          class="status-indicator"
          :class="{
            connected: appStore.connected,
            disconnected: !appStore.connected,
          }"
        >
          <span class="status-dot"></span>
          <span class="status-text">{{
            appStore.connected
              ? t("sidebar.connected")
              : t("sidebar.disconnected")
          }}</span>
        </div>
      </div>
      <div class="version-info">
        <div class="version-links">
          <a
            class="sidebar-footer-link"
            href="https://github.com/EKKOLearnAI/ekko-studio"
            target="_blank"
            rel="noopener noreferrer"
            title="GitHub"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
              <path
                d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0024 12c0-6.63-5.37-12-12-12z"
              />
            </svg>
          </a>
          <a
            class="sidebar-footer-link"
            href="https://ekkostudio.xyz/"
            target="_blank"
            rel="noopener noreferrer"
            title="Website"
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
            >
              <circle cx="12" cy="12" r="10" />
              <line x1="2" y1="12" x2="22" y2="12" />
              <path
                d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"
              />
            </svg>
          </a>
        </div>
        <button
          class="version-text"
          type="button"
          @click="openChangelog"
          @keydown.enter="openChangelog"
          @keydown.space.prevent="openChangelog"
        >
          Studio v{{ appStore.serverVersion || "—" }}
        </button>
        <ThemeSwitch />
      </div>
      <NButton
        v-if="appStore.clientOutdated"
        type="warning"
        size="tiny"
        block
        class="update-btn"
        @click="handleReloadClient"
      >
        {{
          t("sidebar.reloadClientVersion", { version: appStore.serverVersion })
        }}
      </NButton>
      <NButton
        v-else-if="appStore.updateAvailable"
        type="primary"
        size="tiny"
        block
        class="update-btn"
        :loading="!isDockerRuntime && appStore.updating"
        @click="handleUpdateClick"
      >
        {{
          !isDockerRuntime && appStore.updating
            ? t("sidebar.updating")
            : t("sidebar.updateVersion", { version: appStore.latestVersion })
        }}
      </NButton>
    </div>

    <NModal
      v-model:show="showChangelog"
      preset="dialog"
      :title="t('sidebar.changelog')"
      style="width: min(520px, calc(100vw - 32px))"
    >
      <div class="changelog-list">
        <div
          v-for="entry in changelog"
          :key="entry.version"
          class="changelog-version-block"
        >
          <div class="changelog-version-header">
            <span class="changelog-version-tag">v{{ entry.version }}</span>
            <span class="changelog-date">{{ entry.date }}</span>
          </div>
          <ul class="changelog-changes">
            <li v-for="(change, idx) in entry.changes" :key="idx">
              {{ t(change) }}
            </li>
          </ul>
        </div>
      </div>
    </NModal>
    <NModal
      v-model:show="showDockerUpdateTip"
      preset="dialog"
      :title="t('sidebar.dockerUpdateTitle')"
      style="width: min(480px, calc(100vw - 32px))"
    >
      <div class="docker-update-modal">
        <p>{{ t("sidebar.dockerUpdateGuide") }}</p>
        <div class="docker-update-commands">
          <code class="docker-command">docker compose pull</code>
          <code class="docker-command"
            >docker compose up -d --force-recreate</code
          >
        </div>
        <p class="docker-update-note">
          <NTag size="small" type="info" :bordered="false">{{
            t("sidebar.dockerUpdateNote")
          }}</NTag>
        </p>
      </div>
    </NModal>
  </div>
</template>

<style scoped lang="scss">
@use "@/styles/variables" as *;

.sidebar-account-controls {
  --account-selector-height: 30px;
  --account-selector-radius: #{$radius-sm};
  min-width: 0;
}

.sidebar-account-controls :deep(.profile-selector),
.sidebar-account-controls :deep(.model-selector) {
  padding-inline: 0;
}

.language-row {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-bottom: 8px;
}

.language-label {
  display: flex;
  align-items: center;
  min-height: 20px;
  font-size: 11px;
  font-weight: 600;
  color: $text-muted;
  text-transform: uppercase;
  letter-spacing: 0.5px;
}

.language-row :deep(.language-switch) { width: 100%; }
.sidebar-account-controls :deep(.model-trigger) { height: var(--account-selector-height); }

.nav-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 12px;
  border: none;
  background: none;
  appearance: none;
  text-decoration: none;
  color: $text-secondary;
  font-size: 14px;
  border-radius: $radius-sm;
  cursor: pointer;
  transition: all $transition-fast;
  width: 100%;
  text-align: start;

  &:hover {
    background-color: rgba(var(--accent-primary-rgb), 0.06);
    color: $text-primary;
  }

  &.active {
    background-color: rgba(var(--accent-primary-rgb), 0.12);
    color: $accent-primary;
  }

  .beta-tag {
    font-size: 10px;
    color: $text-muted;
    margin-inline-start: 2px;
  }
}

.sidebar-footer {
  padding-top: 10px;
  border-top: 1px solid $border-color;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.logout-item {
  width: auto;
  min-width: 0;
  color: $text-secondary;

  &:hover {
    color: $error;
  }

  > svg { flex-shrink: 0; }

  > span {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
}

.logout-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding-inline-end: 12px;
}

.status-indicator {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  margin-inline-start: auto;
  font-size: 12px;
  color: $text-secondary;

  &.connected .status-dot {
    background-color: $success;
    box-shadow: 0 0 6px rgba(var(--success-rgb), 0.5);
  }

  &.disconnected .status-dot {
    background-color: $error;
  }
}

.status-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex-shrink: 0;
}

.status-text {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.version-info {
  padding: 8px 12px;
  font-size: 11px;
  color: $text-muted;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
  overflow: hidden;
}

.version-links {
  display: flex;
  align-items: center;
  flex-shrink: 0;
  gap: 6px;
}

.sidebar-footer-link {
  color: $text-muted;
  display: flex;
  align-items: center;
  transition: color $transition-fast;

  &:hover {
    color: $text-primary;
  }
}

.version-text {
  border: 0;
  background: transparent;
  padding: 0;
  font: inherit;
  color: inherit;
  flex: 0 0 auto;
  overflow: visible;
  white-space: nowrap;
  cursor: pointer;
  transition: color $transition-fast;

  &:hover {
    color: $accent-primary;
  }
}

.version-info :deep(.theme-switch-container) {
  flex-shrink: 0;
}

.update-btn {
  margin: 4px 0 0;
  border-radius: $radius-sm;
}

.changelog-list {
  max-height: min(70vh, 640px);
  overflow-y: auto;
}

.changelog-version-block {
  margin-bottom: 20px;

  &:last-child {
    margin-bottom: 0;
  }
}

.changelog-version-header {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 8px;
}

.changelog-version-tag {
  font-weight: 600;
  font-size: 14px;
  color: $text-primary;
  font-family: $font-code;
}

.changelog-date {
  font-size: 12px;
  color: $text-muted;
}

.changelog-changes {
  list-style: none;
  padding: 0;
  margin: 0;

  li {
    font-size: 13px;
    color: $text-secondary;
    padding: 4px 0 4px 16px;
    position: relative;

    &::before {
      content: "";
      position: absolute;
      left: 0;
      top: 12px;
      width: 6px;
      height: 6px;
      border-radius: 50%;
      background: $text-muted;
    }
  }
}

.docker-update-modal {
  p {
    margin: 12px 0;
    font-size: 14px;
    line-height: 1.6;
    color: $text-secondary;
  }

  .docker-update-commands {
    display: flex;
    flex-direction: column;
    gap: 8px;
    margin: 16px 0;
  }

  .docker-command {
    display: block;
    padding: 10px 14px;
    background: $code-bg;
    border-radius: $radius-sm;
    font-family: $font-code;
    font-size: 13px;
    color: $text-primary;
    user-select: all;
    cursor: text;
    border: 1px solid $border-color;
  }

  .docker-update-note {
    margin-top: 16px;
  }
}
</style>
