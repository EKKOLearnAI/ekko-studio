<script setup lang="ts">
import { computed } from "vue";
import { useRoute, useRouter } from "vue-router";
import { useI18n } from "vue-i18n";
import { useAppStore } from "@/stores/hermes/app";
import RouteLinkItem from "@/components/common/RouteLinkItem.vue";
import PageSidebarFooter from "@/components/layout/PageSidebarFooter.vue";
import { isStoredSuperAdmin } from "@/api/client";

const { t } = useI18n();
const route = useRoute();
const router = useRouter();
const appStore = useAppStore();
const selectedKey = computed(() => {
  return route.name as string;
});
const isSuperAdmin = computed(() => isStoredSuperAdmin());
const isVersionPreview = import.meta.env.VITE_HERMES_PREVIEW === "1";
const isDesktopShell = computed(
  () =>
    (window as typeof window & { hermesDesktop?: { isDesktop?: boolean } })
      .hermesDesktop?.isDesktop === true,
);

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

    <PageSidebarFooter :collapsed="appStore.sidebarCollapsed" class="sidebar-account-footer" />

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

.sidebar-account-footer {
  padding: 10px 0 0;
  border-top: 1px solid $border-color;
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

</style>
