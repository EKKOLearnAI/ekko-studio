<script setup lang="ts">
import {
  computed,
  defineAsyncComponent,
  onMounted,
  onUnmounted,
  ref,
  watch,
} from "vue";
import { useRoute } from "vue-router";
import {
  darkTheme,
  NConfigProvider,
  NMessageProvider,
  NDialogProvider,
  NNotificationProvider,
} from "naive-ui";
import { useI18n } from "vue-i18n";
import { getThemeOverrides } from "@/styles/theme";
import { useTheme } from "@/composables/useTheme";
import { useKeyboard } from "@/composables/useKeyboard";
import { useSessionSearch } from "@/composables/useSessionSearch";
import { watchServerTtsSettingsHydration } from "@/composables/useTtsSettingsHydration";
import { useAppStore } from "@/stores/hermes/app";
import { useProfilesStore } from "@/stores/hermes/profiles";
import { isStoredSuperAdmin } from "@/api/client";
import AuthEventListener from "@/components/auth/AuthEventListener.vue";
import { desktopBridge } from "@/utils/desktop-bridge";
import { naiveLocaleFor } from "@/constants/naiveLocale";
import { naiveRtlFor } from "@/constants/naiveRtl";

const AppSidebar = defineAsyncComponent(
  async () => (await import("@/components/layout/AppSidebar.vue")).default,
);
const HermesConfigSidebar = defineAsyncComponent(
  async () =>
    (await import("@/components/layout/HermesConfigSidebar.vue")).default,
);
const EkkoConfigSidebar = defineAsyncComponent(
  async () =>
    (await import("@/components/layout/EkkoConfigSidebar.vue")).default,
);
const CodingAgentConfigSidebar = defineAsyncComponent(
  async () =>
    (await import("@/components/layout/CodingAgentConfigSidebar.vue")).default,
);
const DesktopTitleBar = defineAsyncComponent(
  async () => (await import("@/components/layout/DesktopTitleBar.vue")).default,
);
const SessionSearchModal = defineAsyncComponent(
  async () =>
    (await import("@/components/hermes/chat/SessionSearchModal.vue")).default,
);
const DefaultCredentialPrompt = defineAsyncComponent(
  async () =>
    (await import("@/components/auth/DefaultCredentialPrompt.vue")).default,
);
const ProviderConfigurationPrompt = defineAsyncComponent(
  async () =>
    (await import("@/components/hermes/models/ProviderConfigurationPrompt.vue"))
      .default,
);
const WebPet = defineAsyncComponent(
  async () => (await import("@/components/hermes/pets/WebPet.vue")).default,
);
const GlobalPendingActions = defineAsyncComponent(
  async () =>
    (await import("@/components/layout/GlobalPendingActions.vue")).default,
);
const RuntimeRestartPrompt = defineAsyncComponent(
  async () =>
    (await import("@/components/layout/RuntimeRestartPrompt.vue")).default,
);
const StudioAnnouncementPrompt = defineAsyncComponent(
  async () => (await import('@/components/layout/StudioAnnouncementPrompt.vue')).default,
);

const {
  isDark,
  isComic,
  customization,
  hasBackgroundImage,
  syncThemeFromServer,
} = useTheme();
const { t, locale } = useI18n();
const naiveLocale = computed(() => naiveLocaleFor(locale.value));
const naiveRtl = computed(() => naiveRtlFor(locale.value));
const appStore = useAppStore();
const profilesStore = useProfilesStore();
const route = useRoute();
const { sessionSearchOpen } = useSessionSearch();

const themeOverrides = computed(() =>
  getThemeOverrides(isDark.value, isComic.value, customization.value),
);
const naiveTheme = computed(() => (isDark.value ? darkTheme : null));

const isLoginPage = computed(() => route.name === "login");
watchServerTtsSettingsHydration({
  isLoginPage: () => isLoginPage.value,
  activeProfileName: () => profilesStore.activeProfileName,
});
const isStandaloneChatPage = computed(
  () => route.meta?.standaloneChat === true,
);
const isInviteOnlyPage = computed(() => route.meta?.inviteOnly === true);
const usesPageSidebar = computed(() =>
  [
    "hermes.chat",
    "hermes.session",
    "hermes.connections",
    "hermes.agentManager",
    "hermes.models",
    "hermes.history",
    "hermes.historySession",
    "hermes.globalAgent",
    "hermes.globalAgentSession",
    "hermes.groupChat",
    "hermes.groupChatRoom",
    "hermes.workflow",
  ].includes(route.name as string),
);
const usesHermesConfigSidebar = computed(
  () => route.meta?.hermesConfig === true,
);
const usesEkkoConfigSidebar = computed(
  () => route.meta?.ekkoConfig === true,
);
const usesCodingAgentConfigSidebar = computed(
  () => route.meta?.codingAgentConfig === true,
);
const showAppSidebar = computed(
  () =>
    !isLoginPage.value &&
    !isStandaloneChatPage.value &&
    !usesPageSidebar.value &&
    !usesHermesConfigSidebar.value &&
    !usesEkkoConfigSidebar.value &&
    !usesCodingAgentConfigSidebar.value,
);
const showMobileMenuButton = computed(
  () =>
    !isLoginPage.value &&
    !isStandaloneChatPage.value &&
    (showAppSidebar.value ||
      usesPageSidebar.value ||
      usesHermesConfigSidebar.value ||
      usesEkkoConfigSidebar.value ||
      usesCodingAgentConfigSidebar.value),
);

const nodeVersionLow = computed(() => {
  const v = appStore.nodeVersion;
  const major = parseInt(v.split(".")[0], 10);
  return !isNaN(major) && major < 23;
});

const isDesktopShell = computed(() => desktopBridge()?.isDesktop === true);
const desktopPlatform = computed(() => desktopBridge()?.platform || "");
const isDesktopWindows = computed(
  () => isDesktopShell.value && desktopPlatform.value === "win32",
);
const isDesktopChatWindow = computed(
  () => desktopBridge()?.windowKind === "chat",
);
const showDesktopTitleBar = computed(
  () => isDesktopWindows.value && !isDesktopChatWindow.value,
);
const desktopTitleBarLeft = computed(() => {
  if (isLoginPage.value) return 10;
  if (showAppSidebar.value) return appStore.sidebarCollapsed ? 84 : 260;
  if (usesHermesConfigSidebar.value)
    return appStore.sidebarCollapsed ? 84 : 260;
  if (usesEkkoConfigSidebar.value)
    return appStore.sidebarCollapsed ? 84 : 260;
  if (usesCodingAgentConfigSidebar.value)
    return appStore.sidebarCollapsed ? 84 : 260;
  return appStore.pageSidebarExpanded ? 260 : 10;
});
const isDesktopPetRoute = computed(() => route.name === "desktop.pet");
const showWebPet = computed(
  () =>
    !isLoginPage.value &&
    !isStandaloneChatPage.value &&
    !isDesktopShell.value &&
    !isDesktopPetRoute.value,
);
const desktopPlatformClass = computed(() =>
  desktopPlatform.value ? `desktop-platform-${desktopPlatform.value}` : "",
);
const isDesktopWindowMaximized = ref(false);
let stopWindowStateListener: (() => void) | undefined;

function handleMobileMenuClick() {
  if (usesPageSidebar.value || usesHermesConfigSidebar.value || usesEkkoConfigSidebar.value || usesCodingAgentConfigSidebar.value) {
    window.dispatchEvent(new CustomEvent("hermes:open-page-sidebar"));
    return;
  }
  appStore.toggleSidebar();
}

watch(
  [isLoginPage, isInviteOnlyPage],
  ([loginPage, inviteOnlyPage]) => {
    if (loginPage || inviteOnlyPage) {
      appStore.stopHealthPolling();
      return;
    }
    appStore.loadModels();
    appStore.startHealthPolling();
  },
  {
    immediate: true,
  },
);

onMounted(() => {
  if (!isInviteOnlyPage.value) {
    void syncThemeFromServer().catch(() => undefined);
  }
  const bridge = desktopBridge();
  if (
    !bridge?.isDesktop ||
    (desktopPlatform.value !== "win32" && bridge.windowKind !== "chat")
  )
    return;
  bridge
    .getWindowState?.()
    .then((state) => {
      isDesktopWindowMaximized.value = !!state.isMaximized;
    })
    .catch(() => undefined);
  stopWindowStateListener = bridge.onWindowStateChange?.((state) => {
    isDesktopWindowMaximized.value = !!state.isMaximized;
  });
});

onUnmounted(() => {
  stopWindowStateListener?.();
  appStore.stopHealthPolling();
});

useKeyboard();
</script>

<template>
  <NConfigProvider
    :theme="naiveTheme"
    :theme-overrides="themeOverrides"
    :locale="naiveLocale.locale"
    :date-locale="naiveLocale.dateLocale"
    :rtl="naiveRtl"
  >
    <NMessageProvider>
      <AuthEventListener />
      <NDialogProvider>
        <NNotificationProvider>
          <router-view v-if="isDesktopPetRoute" />
          <div
            v-else
            class="app-shell"
            :class="[
              desktopPlatformClass,
              {
                desktop: isDesktopShell,
                'desktop-chat-window': isDesktopChatWindow,
                'desktop-window-maximized': isDesktopWindowMaximized,
                'app-shell--custom-background': hasBackgroundImage,
              },
            ]"
          >
            <DesktopTitleBar
              v-if="showDesktopTitleBar"
              :standalone="isLoginPage || isDesktopChatWindow"
              :left-offset="desktopTitleBarLeft"
            />
            <div
              v-if="nodeVersionLow && !isStandaloneChatPage"
              class="node-warning-bar"
            >
              {{
                t("sidebar.nodeVersionWarning", {
                  version: appStore.nodeVersion,
                })
              }}
            </div>
            <div
              class="app-layout"
              :class="{
                'no-sidebar': isLoginPage || !showAppSidebar,
                'has-hermes-config-sidebar': usesHermesConfigSidebar,
                'has-ekko-config-sidebar': usesEkkoConfigSidebar,
                'has-coding-agent-config-sidebar': usesCodingAgentConfigSidebar,
              }"
            >
              <button
                v-if="showMobileMenuButton"
                class="hamburger-btn"
                @click="handleMobileMenuClick"
              >
                <img
                  src="/logo.png"
                  alt="Menu"
                  style="width: 24px; height: 24px"
                />
              </button>
              <div
                v-if="!isLoginPage && showAppSidebar && appStore.sidebarOpen"
                class="mobile-backdrop"
                @click="appStore.closeSidebar"
              />
              <AppSidebar v-if="!isLoginPage && showAppSidebar" />
              <HermesConfigSidebar
                v-if="!isLoginPage && usesHermesConfigSidebar"
              />
              <EkkoConfigSidebar
                v-if="!isLoginPage && usesEkkoConfigSidebar"
              />
              <CodingAgentConfigSidebar
                v-if="!isLoginPage && usesCodingAgentConfigSidebar"
              />
              <main
                class="app-main"
                :class="{
                  'app-main--card': showAppSidebar || usesHermesConfigSidebar || usesEkkoConfigSidebar || usesCodingAgentConfigSidebar,
                }"
              >
                <router-view />
              </main>
            </div>
          </div>
          <WebPet v-if="showWebPet" />
          <SessionSearchModal
            v-if="
              !isDesktopPetRoute && !isStandaloneChatPage && sessionSearchOpen
            "
          />
          <DefaultCredentialPrompt
            v-if="!isDesktopPetRoute && !isStandaloneChatPage"
          />
          <ProviderConfigurationPrompt
            v-if="!isDesktopPetRoute && !isStandaloneChatPage"
          />
          <GlobalPendingActions
            v-if="!isLoginPage && !isDesktopPetRoute && !isStandaloneChatPage"
          />
          <RuntimeRestartPrompt
            v-if="!isLoginPage && !isDesktopPetRoute && !isStandaloneChatPage && isStoredSuperAdmin()"
          />
          <StudioAnnouncementPrompt
            v-if="!isLoginPage && !isInviteOnlyPage && !isDesktopPetRoute && !isStandaloneChatPage"
          />
        </NNotificationProvider>
      </NDialogProvider>
    </NMessageProvider>
  </NConfigProvider>
</template>

<style scoped lang="scss">
@use "@/styles/variables" as *;

.app-shell {
  position: relative;
  height: calc(100 * var(--vh));
  width: 100%;
  max-width: 100%;
  overflow: hidden;
  display: flex;
  flex-direction: column;
  background-color: $bg-primary;

  &::after {
    content: "";
    position: absolute;
    z-index: 0;
    inset: 0;
    background-image: var(--app-background-image, none);
    background-position: center;
    background-repeat: no-repeat;
    background-size: cover;
    opacity: 0;
    pointer-events: none;
    transition: opacity 0.3s ease;
  }

  &--custom-background::after {
    opacity: 1;
  }
}

.app-layout {
  position: relative;
  z-index: 1;
  display: flex;
  flex: 1;
  min-height: 0;
  width: 100%;
  max-width: 100%;
  overflow: hidden;
  background-color: $bg-card;

  &.no-sidebar {
    display: block;

    &.has-hermes-config-sidebar {
      display: flex;
    }

    &.has-ekko-config-sidebar {
      display: flex;
    }

    &.has-coding-agent-config-sidebar {
      display: flex;
    }
  }
}

.app-main {
  flex: 1;
  min-width: 0;
  min-height: 0;
  overflow-y: auto;
  background-color: $bg-primary;

  .no-sidebar:not(.has-hermes-config-sidebar):not(.has-ekko-config-sidebar):not(.has-coding-agent-config-sidebar) & {
    height: 100%;
  }

  &--card {
    margin: 10px 10px 10px 0;
    background-color: $bg-main-surface;
    border: 1px solid $border-color;
    border-radius: 14px;
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.1);
  }
}

.app-shell--custom-background {
  .app-layout {
    background-color: transparent;
  }

  .app-main {
    background-color: transparent;

    &--card {
      background-color: rgba(var(--bg-main-surface-rgb), 0.72);
      -webkit-backdrop-filter: blur(8px) saturate(110%);
      backdrop-filter: blur(8px) saturate(110%);
    }
  }

  :deep(.chat-panel),
  :deep(.history-panel),
  :deep(.group-chat-panel),
  :deep(.workflow-view),
  :deep(.petdex-view) {
    background-color: transparent;
  }

  :deep(.sidebar),
  :deep(.hermes-config-sidebar),
  :deep(.ekko-config-sidebar),
  :deep(.coding-agent-config-sidebar),
  :deep(.chat-panel > .session-list),
  :deep(.history-panel > .session-list),
  :deep(.group-chat-panel > .room-sidebar),
  :deep(.workflow-view > .workflow-sidebar) {
    background-color: rgba(var(--bg-sidebar-surface-rgb), 0.72);
    -webkit-backdrop-filter: blur(8px) saturate(110%);
    backdrop-filter: blur(8px) saturate(110%);
  }

  @media (max-width: $breakpoint-mobile) {
    :deep(.sidebar),
    :deep(.hermes-config-sidebar),
    :deep(.ekko-config-sidebar),
    :deep(.chat-panel > .session-list),
    :deep(.history-panel > .session-list),
    :deep(.group-chat-panel > .room-sidebar),
    :deep(.workflow-view > .workflow-sidebar) {
      background-color: var(--bg-sidebar-surface);
      -webkit-backdrop-filter: none;
      backdrop-filter: none;
    }
  }

  :deep(.history-panel > .chat-main),
  :deep(.workflow-view > .workflow-main) {
    background-color: rgba(var(--bg-main-surface-rgb), 0.72);
    -webkit-backdrop-filter: blur(8px) saturate(110%);
    backdrop-filter: blur(8px) saturate(110%);
  }

  :deep(.chat-panel > .chat-main),
  :deep(.group-chat-panel > .chat-main) {
    background-color: transparent;
    -webkit-backdrop-filter: none;
    backdrop-filter: none;
  }

  :deep(.desktop-titlebar),
  :deep(.chat-panel > .chat-main > .chat-header),
  :deep(.group-chat-panel > .chat-main > .chat-header) {
    background-color: rgba(var(--bg-main-surface-rgb), 0.72);
    -webkit-backdrop-filter: blur(8px) saturate(110%);
    backdrop-filter: blur(8px) saturate(110%);
  }

  :deep(.chat-input-area),
  :deep(.agent-manager-panel) {
    background-color: transparent;
  }

  :deep(.chat-main-content),
  :deep(.group-chat-surface) {
    background-color: rgba(var(--bg-main-surface-rgb), 0.42);
    -webkit-backdrop-filter: none;
    backdrop-filter: none;
  }

  :deep(.virtual-message-list),
  :deep(.group-message-shell) {
    background-color: transparent;
    -webkit-backdrop-filter: none;
    backdrop-filter: none;
  }

  :deep(.chat-input-area .input-wrapper) {
    background-color: rgba(var(--bg-main-surface-rgb), 0.72);
    -webkit-backdrop-filter: blur(8px) saturate(110%);
    backdrop-filter: blur(8px) saturate(110%);
  }

  :deep(.browser-settings-page > .settings-card) {
    background-color: transparent;
  }
}

.app-shell.desktop-platform-darwin,
.app-shell.desktop-platform-win32 {
  &::before {
    content: "";
    position: absolute;
    z-index: 1000;
    top: 0;
    left: 0;
    right: 0;
    height: 10px;
    -webkit-app-region: drag;
  }

  :deep(.page-header),
  :deep(.chat-header),
  :deep(.terminal-header) {
    -webkit-app-region: drag;

    button,
    a,
    input,
    textarea,
    select,
    [role="button"],
    [role="tab"],
    .n-base-selection {
      -webkit-app-region: no-drag;
    }
  }
}

.app-shell.desktop-platform-win32 {
  overflow: hidden;

  .app-main--card,
  :deep(.chat-panel > .chat-main),
  :deep(.history-panel > .chat-main),
  :deep(.workflow-view > .workflow-main),
  :deep(.group-chat-panel > .chat-main) {
    margin-top: 50px;
  }

  :deep(.chat-panel > .session-list > .page-sidebar-top),
  :deep(.history-panel > .session-list > .page-sidebar-top),
  :deep(.workflow-view > .workflow-sidebar > .page-sidebar-top),
  :deep(.group-chat-panel > .room-sidebar > .sidebar-header) {
    -webkit-app-region: drag;

    button,
    a,
    input,
    textarea,
    select,
    [role="button"],
    [role="tab"],
    .n-base-selection {
      -webkit-app-region: no-drag;
    }
  }
}

.app-shell.desktop-platform-darwin {
   .app-layout > :deep(.sidebar),
   .app-layout > :deep(.hermes-config-sidebar),
   .app-layout > :deep(.ekko-config-sidebar),
   .app-layout > :deep(.coding-agent-config-sidebar),
  :deep(.chat-panel > .session-list),
  :deep(.history-panel > .session-list),
  :deep(.workflow-view > .workflow-sidebar),
  :deep(.group-chat-panel > .room-sidebar) {
    position: relative;

    &::before {
      content: "";
      position: absolute;
      z-index: 1;
      top: 0;
      left: 0;
      right: 0;
      height: 32px;
      -webkit-app-region: drag;
    }
  }

   .app-layout > :deep(.sidebar),
   .app-layout > :deep(.hermes-config-sidebar),
   .app-layout > :deep(.ekko-config-sidebar),
   .app-layout > :deep(.coding-agent-config-sidebar) {
    padding-top: 40px;
  }

  :deep(.chat-panel > .session-list > .page-sidebar-top),
  :deep(.history-panel > .session-list > .page-sidebar-top),
  :deep(.workflow-view > .workflow-sidebar > .page-sidebar-top),
  :deep(.group-chat-panel > .room-sidebar > .sidebar-header) {
    padding-top: 32px;
  }
}

.app-shell.desktop-chat-window {
  :deep(.chat-panel--standalone > .chat-main) {
    margin: 10px;
  }
}

.app-shell.desktop-chat-window.desktop-platform-darwin,
.app-shell.desktop-chat-window.desktop-platform-win32 {
  &::before {
    top: 0;
    height: 46px;
  }

  .app-layout {
    padding-top: 46px;
  }

  :deep(.chat-panel--standalone > .chat-main) {
    margin-top: 0;
  }
}

@media (min-width: 769px) {
  .app-main--card {
    overflow: hidden;

    :deep(> *) {
      height: 100% !important;
      max-height: 100%;
    }
  }
}

@media (max-width: $breakpoint-mobile) {
  .app-main--card {
    margin: 0;
    border: none;
    border-radius: 0;
    box-shadow: none;
  }
}

.node-warning-bar {
  position: relative;
  flex: 0 0 auto;
  width: 100%;
  z-index: 100;
  padding: 4px 16px;
  font-size: 12px;
  font-weight: 500;
  color: #b45309;
  background-color: #fef3c7;
  border-bottom: 1px solid #fde68a;
  text-align: center;
  line-height: 1.4;
}
</style>
