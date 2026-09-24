<script setup lang="ts">
import { computed, ref } from "vue";
import { useRoute, useRouter } from "vue-router";
import { useI18n } from "vue-i18n";
import { NButton, NModal, useMessage, NTag } from "naive-ui";
import { useAppStore } from "@/stores/hermes/app";
import RouteLinkItem from "@/components/common/RouteLinkItem.vue";
import ModelSelector from "@/components/layout/ModelSelector.vue";
import ProfileSelector from "@/components/layout/ProfileSelector.vue";
import LanguageSwitch from "@/components/layout/LanguageSwitch.vue";
import ThemeSwitch from "@/components/layout/ThemeSwitch.vue";
import { changelog } from "@/data/changelog";
import {
  getStoredUserId,
  getStoredUsername,
  isStoredSuperAdmin,
} from "@/api/client";
import { clearThemeBackgroundCache } from "@/api/studio/theme";

const { t } = useI18n();
const message = useMessage();
const route = useRoute();
const router = useRouter();
const appStore = useAppStore();
const selectedKey = computed(() => {
  return route.name as string;
});
const isSuperAdmin = computed(() => isStoredSuperAdmin());
const currentUsername = computed(() => getStoredUsername());
const isVersionPreview = import.meta.env.VITE_HERMES_PREVIEW === "1";
const isDesktopShell = computed(
  () =>
    (window as typeof window & { hermesDesktop?: { isDesktop?: boolean } })
      .hermesDesktop?.isDesktop === true,
);
const showChangelog = ref(false);
const showDockerUpdateTip = ref(false);
const isDockerRuntime = computed(() => appStore.isDocker);

function hasRoute(name: string): boolean {
  return router.hasRoute(name);
}

function handleSidebarClick(event: MouseEvent) {
  const target = event.target instanceof Element ? event.target : null;

  if (!target?.closest(".route-link-item")) {
    return;
  }

  if (
    typeof window !== "undefined" &&
    window.matchMedia("(max-width: 768px)").matches
  ) {
    appStore.closeSidebar();
  }
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
  showChangelog.value = true;
}

function handleDockerUpdateTip() {
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
  <aside
    class="sidebar"
    :class="{
      open: appStore.sidebarOpen,
      collapsed: appStore.sidebarCollapsed,
    }"
    @click="handleSidebarClick"
  >
    <nav class="sidebar-nav">
      <RouteLinkItem
        class="nav-item"
        :to="{ name: 'hermes.logs' }"
        :active="selectedKey === 'hermes.logs'"
      >
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
          <path
            d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"
          />
          <polyline points="14 2 14 8 20 8" />
          <line x1="16" y1="13" x2="8" y2="13" />
          <line x1="16" y1="17" x2="8" y2="17" />
          <polyline points="10 9 9 9 8 9" />
        </svg>
        <span>{{ t("sidebar.logs") }}</span>
      </RouteLinkItem>
      <RouteLinkItem
        class="nav-item"
        :to="{ name: 'hermes.usage' }"
        :active="selectedKey === 'hermes.usage'"
      >
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
          <rect x="3" y="12" width="4" height="9" rx="1" />
          <rect x="10" y="7" width="4" height="14" rx="1" />
          <rect x="17" y="3" width="4" height="18" rx="1" />
        </svg>
        <span>{{ t("sidebar.usage") }}</span>
      </RouteLinkItem>
      <RouteLinkItem
        v-if="isSuperAdmin"
        class="nav-item"
        :to="{ name: 'hermes.performance' }"
        :active="selectedKey === 'hermes.performance'"
      >
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
          <polyline points="22 12 18 12 15 21 9 3 6 12 2 12" />
        </svg>
        <span>{{ t("sidebar.performance") }}</span>
      </RouteLinkItem>
      <RouteLinkItem
        class="nav-item"
        :to="{ name: 'hermes.skillsUsage' }"
        :active="selectedKey === 'hermes.skillsUsage'"
      >
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
          <path d="M21.21 15.89A10 10 0 1 1 8.11 2.79" />
          <path d="M22 12A10 10 0 0 0 12 2v10z" />
        </svg>
        <span>{{ t("sidebar.skillsUsage") }}</span>
      </RouteLinkItem>
      <RouteLinkItem
        v-if="isDesktopShell && hasRoute('hermes.browser')"
        class="nav-item"
        :to="{ name: 'hermes.browser' }"
        :active="selectedKey === 'hermes.browser'"
      >
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
          <circle cx="12" cy="12" r="9" />
          <path d="M3 9h18" />
          <path d="M9 3c-2 5-2 13 0 18" />
          <path d="M15 3c2 5 2 13 0 18" />
        </svg>
        <span>{{ t("sidebar.browser") }}</span>
      </RouteLinkItem>
      <RouteLinkItem
        v-if="
          hasRoute('hermes.versionPreview') && isSuperAdmin && !isVersionPreview
        "
        class="nav-item"
        :to="{ name: 'hermes.versionPreview' }"
        :active="selectedKey === 'hermes.versionPreview'"
      >
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
          <path
            d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"
          />
          <polyline points="7.5 4.21 12 6.81 16.5 4.21" />
          <polyline points="7.5 19.79 7.5 14.6 3 12" />
          <polyline points="21 12 16.5 14.6 16.5 19.79" />
          <polyline points="3.27 6.96 12 12.01 20.73 6.96" />
          <line x1="12" y1="22.08" x2="12" y2="12" />
        </svg>
        <span>{{ t("sidebar.versionPreview") }}</span>
      </RouteLinkItem>
      <RouteLinkItem
        class="nav-item"
        :to="{ name: 'hermes.theme' }"
        :active="selectedKey === 'hermes.theme'"
      >
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
          <circle cx="13.5" cy="6.5" r="2.5" />
          <circle cx="17.5" cy="10.5" r="2.5" />
          <circle cx="8.5" cy="7.5" r="2.5" />
          <path
            d="M12 3a9 9 0 1 0 9 9c0-1.1-.9-2-2-2h-1.2a2.8 2.8 0 0 1-2.8-2.8V5c0-1.1-.9-2-2-2h-1z"
          />
        </svg>
        <span>{{ t("sidebar.theme") }}</span>
      </RouteLinkItem>
      <RouteLinkItem
        class="nav-item"
        :to="{ name: 'hermes.petdex' }"
        :active="selectedKey === 'hermes.petdex'"
      >
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
          <path d="M12 3l7 4v6c0 4-3 7-7 8-4-1-7-4-7-8V7l7-4z" />
          <path d="M9 11h.01" />
          <path d="M15 11h.01" />
          <path d="M9.5 15c1.6 1.1 3.4 1.1 5 0" />
        </svg>
        <span>{{ t("sidebar.petdex") }}</span>
      </RouteLinkItem>
      <RouteLinkItem
        v-if="isSuperAdmin"
        class="nav-item"
        :to="{ name: 'hermes.profiles' }"
        :active="selectedKey === 'hermes.profiles'"
      >
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
          <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
          <circle cx="12" cy="7" r="4" />
        </svg>
        <span>{{ t("sidebar.profiles") }}</span>
      </RouteLinkItem>
      <RouteLinkItem
        class="nav-item"
        :to="{ name: 'hermes.settings' }"
        :active="selectedKey === 'hermes.settings'"
      >
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
          <circle cx="12" cy="12" r="3" />
          <path
            d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"
          />
        </svg>
        <span>{{ t("sidebar.settings") }}</span>
      </RouteLinkItem>
    </nav>

    <ProfileSelector />
    <ModelSelector />

    <div class="sidebar-footer">
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
        <span
          v-if="currentUsername"
          class="logout-username"
          :title="currentUsername"
          >{{ currentUsername }}</span
        >
      </button>
      <div class="status-row">
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
        <LanguageSwitch />
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
        <span
          class="version-text"
          role="button"
          tabindex="0"
          @click="openChangelog"
          @keydown.enter="openChangelog"
          @keydown.space.prevent="openChangelog"
        >
          Studio v{{ appStore.serverVersion || "0.1.0" }}
        </span>
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

    <div class="sidebar-top-actions">
      <RouteLinkItem
        class="nav-item sidebar-return-tab"
        :to="{ name: 'hermes.chat' }"
        :title="t('sidebar.backToChat')"
      >
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="1.7"
          stroke-linecap="round"
          stroke-linejoin="round"
        >
          <polyline points="15 18 9 12 15 6" />
          <line x1="9" y1="12" x2="21" y2="12" />
        </svg>
        <span>{{ t("sidebar.backToChat") }}</span>
      </RouteLinkItem>
      <button
        class="collapse-btn"
        @click="appStore.toggleSidebarCollapsed()"
        :title="
          appStore.sidebarCollapsed
            ? t('sidebar.expand')
            : t('sidebar.collapse')
        "
      >
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
        >
          <polyline v-if="appStore.sidebarCollapsed" points="9 18 15 12 9 6" />
          <polyline v-else points="15 18 9 12 15 6" />
        </svg>
      </button>
    </div>

    <NModal
      v-model:show="showChangelog"
      preset="dialog"
      :title="t('sidebar.changelog')"
      style="width: 520px"
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
      style="width: 480px"
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
  </aside>
</template>

<style scoped lang="scss">
@use "@/styles/variables" as *;

.sidebar {
  position: relative;
  width: $sidebar-width;
  height: auto;
  min-height: 0;
  align-self: stretch;
  margin: 10px;
  background-color: $bg-sidebar-surface;
  border: 1px solid $border-color;
  border-radius: 14px;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.1);
  display: flex;
  flex-direction: column;
  padding: 8px 12px 20px;
  overflow: hidden;
  flex-shrink: 0;
  transition: width $transition-normal;
}

.sidebar-nav {
  flex: 1;
  display: flex;
  padding-top: 8px;
  flex-direction: column;
  gap: 6px;
  overflow-y: auto;
  min-height: 0;
  scrollbar-width: none;

  &::-webkit-scrollbar {
    display: none;
  }
}

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

.sidebar-top-actions {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 8px;
  padding-top: 8px;
  border-top: 1px solid $border-color;
}

.sidebar-return-tab {
  flex: 1;
  min-width: 0;
  padding: 8px 10px;
  font-size: 13px;
}

.sidebar-footer {
  padding-top: 10px;
  border-top: 1px solid $border-color;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.logout-item {
  color: $text-secondary;

  &:hover {
    color: $error;
  }

  > span:not(.logout-username) {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
}

.logout-username {
  margin-inline-start: auto;
  max-width: 96px;
  color: $text-muted;
  font-size: 12px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.status-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 2px 0 4px;
}

.status-indicator {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  padding-inline-start: 12px;
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
  padding: 2px 0 8px 12px;
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

// ─── Collapsed sidebar (icon-rail mode) ─────────────────────────

.sidebar.collapsed {
  width: $sidebar-collapsed-width;
  padding: 8px 8px 12px;
  overflow: hidden;

  .collapse-btn {
    display: flex;
    margin: 0;
  }

  .sidebar-top-actions {
    flex-direction: column;
    gap: 6px;
    margin-top: 8px;
    padding-top: 8px;
  }

  .sidebar-return-tab {
    width: 100%;
    flex: 0 0 auto;
    padding: 10px 4px;
  }

  .nav-item {
    justify-content: center;
    padding: 10px 4px;
    gap: 0;

    span {
      display: none;
    }

    svg {
      flex-shrink: 0;
    }
  }

  :deep(.model-selector) {
    display: none;
  }

  :deep(.profile-selector) {
    display: flex;
    justify-content: center;
    padding: 8px 0;
  }

  :deep(.profile-selector .selector-label),
  :deep(.profile-selector .profile-name) {
    display: none;
  }

  :deep(.profile-selector .profile-display) {
    width: 40px;
    justify-content: center;
    padding: 4px;
  }

  .sidebar-footer {
    align-items: center;
    gap: 6px;
    padding-top: 8px;
  }

  .status-row,
  .version-info,
  .update-btn {
    display: none;
  }
}

// ─── Collapse button ────────────────────────────────────────────

.collapse-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border: none;
  background: none;
  appearance: none;
  text-decoration: none;
  color: $text-muted;
  border-radius: $radius-sm;
  cursor: pointer;
  flex-shrink: 0;
  margin: 0;
  transition: all $transition-fast;

  &:hover {
    color: $text-primary;
    background-color: rgba(var(--accent-primary-rgb), 0.08);
  }
}

@media (max-width: $breakpoint-mobile) {
  .sidebar {
    position: fixed;
    left: 10px;
    top: 10px;
    bottom: 10px;
    margin: 0;
    height: auto;
    z-index: 1000;
    transform: translateX(calc(-100% - 10px));
    transition: transform $transition-normal;
    padding-top: env(safe-area-inset-top, 0px);

    &.open {
      transform: translateX(0);
    }

    .collapse-btn {
      display: flex;
    }

    // Override global utility — sidebar is always 240px wide
    .input-sm {
      width: 90px;
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
