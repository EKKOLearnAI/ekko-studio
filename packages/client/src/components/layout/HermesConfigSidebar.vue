<script setup lang="ts">
import PageSidebar from "./PageSidebar.vue"
import { usePageSidebarState } from "@/composables/usePageSidebar"
import { computed, watch } from "vue";
import { useRoute } from "vue-router";
import { useI18n } from "vue-i18n";
import PluginIcon from "@/components/common/PluginIcon.vue";
import RouteLinkItem from "@/components/common/RouteLinkItem.vue";
import { useAppStore } from "@/stores/hermes/app";

const { t } = useI18n();
const route = useRoute();
const appStore = useAppStore();
const { expanded, isMobile } = usePageSidebarState()
watch(expanded, value => appStore.setPageSidebarExpanded(value), { immediate: true })

const activeRoute = computed(() => route.name as string);

function setExpanded(value: boolean) {
  expanded.value = value;
  appStore.setPageSidebarExpanded(value);
}

function handleNavClick(event: MouseEvent) {
  if (!isMobile.value) return;
  const target = event.target instanceof Element ? event.target : null;
  if (target?.closest(".route-link-item")) setExpanded(false);
}

</script>

<template>
  <PageSidebar>
  <aside
    class="hermes-config-sidebar"
    :class="{ open: expanded, collapsed: !isMobile && appStore.sidebarCollapsed }"
  >
    <nav class="hermes-config-nav" @click="handleNavClick">
      <RouteLinkItem
        class="hermes-config-nav-item"
        :to="{ name: 'hermes.jobs' }"
        :active="activeRoute === 'hermes.jobs'"
      >
        <svg
          width="17"
          height="17"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="1.7"
          stroke-linecap="round"
          stroke-linejoin="round"
        >
          <rect x="3" y="4" width="18" height="18" rx="2" />
          <path d="M16 2v4M8 2v4M3 10h18" />
        </svg>
        <span>{{ t("sidebar.jobs") }}</span>
      </RouteLinkItem>
      <RouteLinkItem
        class="hermes-config-nav-item"
        :to="{ name: 'hermes.kanban' }"
        :active="activeRoute === 'hermes.kanban'"
      >
        <svg
          width="17"
          height="17"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="1.7"
          stroke-linejoin="round"
        >
          <rect x="3" y="3" width="5" height="18" rx="1" />
          <rect x="10" y="3" width="5" height="12" rx="1" />
          <rect x="17" y="3" width="4" height="16" rx="1" />
        </svg>
        <span>{{ t("sidebar.kanban") }}</span>
      </RouteLinkItem>
      <RouteLinkItem
        class="hermes-config-nav-item"
        :to="{ name: 'hermes.channels' }"
        :active="activeRoute === 'hermes.channels'"
      >
        <svg
          width="17"
          height="17"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="1.7"
          stroke-linecap="round"
          stroke-linejoin="round"
        >
          <path d="M4 4h16v12H7l-3 3V4Z" />
          <path d="M8 9h8M8 12h5" />
        </svg>
        <span>{{ t("sidebar.channels") }}</span>
      </RouteLinkItem>
      <RouteLinkItem
        class="hermes-config-nav-item"
        :to="{ name: 'hermes.skills' }"
        :active="activeRoute === 'hermes.skills'"
      >
        <svg
          width="17"
          height="17"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="1.7"
          stroke-linecap="round"
          stroke-linejoin="round"
        >
          <path d="m12 2 9 5-9 5-9-5 9-5Z" />
          <path d="m3 12 9 5 9-5M3 17l9 5 9-5" />
        </svg>
        <span>{{ t("sidebar.skills") }}</span>
      </RouteLinkItem>
      <RouteLinkItem
        class="hermes-config-nav-item"
        :to="{ name: 'hermes.plugins' }"
        :active="activeRoute === 'hermes.plugins'"
      >
        <PluginIcon />
        <span>{{ t("sidebar.plugins") }}</span>
      </RouteLinkItem>
      <RouteLinkItem
        class="hermes-config-nav-item"
        :to="{ name: 'hermes.mcp' }"
        :active="activeRoute === 'hermes.mcp'"
      >
        <svg
          width="17"
          height="17"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="1.7"
          stroke-linecap="round"
          stroke-linejoin="round"
        >
          <rect x="3" y="5" width="18" height="10" rx="2" />
          <path d="M8 19h8M12 15v4M8 10h.01M12 10h4" />
        </svg>
        <span>{{ t("sidebar.mcp") }}</span>
      </RouteLinkItem>
      <RouteLinkItem
        class="hermes-config-nav-item"
        :to="{ name: 'hermes.memory' }"
        :active="activeRoute === 'hermes.memory'"
      >
        <svg
          width="17"
          height="17"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="1.7"
          stroke-linecap="round"
          stroke-linejoin="round"
        >
          <path
            d="M9 18h6M10 22h4M12 2a7 7 0 0 0-4 12.7V17h8v-2.3A7 7 0 0 0 12 2Z"
          />
        </svg>
        <span>{{ t("sidebar.memory") }}</span>
      </RouteLinkItem>
      <RouteLinkItem
        class="hermes-config-nav-item"
        :to="{ name: 'hermes.journey' }"
        :active="activeRoute === 'hermes.journey'"
      >
        <svg
          width="17"
          height="17"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="1.7"
          stroke-linecap="round"
          stroke-linejoin="round"
        >
          <path d="M12 3.5a8.5 8.5 0 1 0 8.5 8.5" />
          <path d="M4.4 15.4c3.2 1.1 7.4.4 10.8-2.1 3.1-2.3 4.9-5.5 4.5-8.1" />
          <circle
            cx="19.5"
            cy="4.5"
            r="1.2"
            fill="currentColor"
            stroke="none"
          />
        </svg>
        <span>{{ t("sidebar.journey") }}</span>
      </RouteLinkItem>
      <RouteLinkItem
        class="hermes-config-nav-item"
        :to="{ name: 'hermes.configSettings' }"
        :active="activeRoute === 'hermes.configSettings'"
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

    <footer class="hermes-config-footer" @click="handleNavClick">
      <RouteLinkItem
        class="hermes-config-nav-item hermes-config-return"
        :to="{ name: 'hermes.agentManager' }"
      >
        <svg
          width="17"
          height="17"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="1.8"
          stroke-linecap="round"
          stroke-linejoin="round"
        >
          <path d="m15 18-6-6 6-6" />
          <path d="M9 12h11" />
        </svg>
        <span>{{ t("sidebar.backToChat") }}</span>
      </RouteLinkItem>
      <button
        class="hermes-config-collapse"
        type="button"
        :title="
          appStore.sidebarCollapsed
            ? t('sidebar.expand')
            : t('sidebar.collapse')
        "
        @click="appStore.toggleSidebarCollapsed()"
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
    </footer>
  </aside>
  </PageSidebar>
</template>

<style scoped lang="scss">
@use "@/styles/agent-config-sidebar" as agent-config-sidebar;

@include agent-config-sidebar.layout("hermes");
</style>
