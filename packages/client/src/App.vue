<script setup lang="ts">
import {
  computed,
  defineAsyncComponent,
  onMounted,
  onUnmounted,
  provide,
  ref,
  shallowRef,
  toRef,
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
import { navigationRailKey } from "@/composables/useNavigationRail";
import { pageHeaderTargetKey } from "@/composables/usePageHeader";
import { mobileNavigationKey } from "@/composables/usePageSidebar";
import HeaderSidebarToggle from "@/components/layout/HeaderSidebarToggle.vue";

const StudioNavigationRail = defineAsyncComponent(
  async () => (await import("@/components/layout/StudioNavigationRail.vue")).default,
);
const MobileNavigationDrawer = defineAsyncComponent(
  async () => (await import("@/components/layout/MobileNavigationDrawer.vue")).default,
);

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
const wideViewportQuery = window.matchMedia('(min-width: 769px)');
const isWideViewport = ref(wideViewportQuery.matches);
const hasNavigationRail = computed(() =>
  !isLoginPage.value && !isStandaloneChatPage.value && route.name !== 'desktop.pet',
);
const showNavigationRail = computed(() => isWideViewport.value && hasNavigationRail.value);
provide(navigationRailKey, hasNavigationRail);
const mobileNavigationOpen = toRef(appStore, 'sidebarOpen');
const mobileSidebarHost = shallowRef<HTMLElement | null>(null);
provide(mobileNavigationKey, {
  open: mobileNavigationOpen,
  target: computed(() => !isWideViewport.value && hasNavigationRail.value ? mobileSidebarHost.value : null),
});
const hasMobileContextSidebar = computed(() =>
  !['hermes.connections', 'hermes.agentManager', 'hermes.models'].includes(String(route.name)),
);
watch([hasNavigationRail, isWideViewport], () => { mobileNavigationOpen.value = false; });
watch(sessionSearchOpen, (open) => { if (open) mobileNavigationOpen.value = false; });
watch(() => route.name, () => {
  if (!hasMobileContextSidebar.value) mobileNavigationOpen.value = false;
});
const pageHeaderHost = shallowRef<HTMLElement | null>(null);
provide(pageHeaderTargetKey, computed(() => showNavigationRail.value ? pageHeaderHost.value : null));
function handleWideViewportChange(event: MediaQueryListEvent) {
  isWideViewport.value = event.matches;
}
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
const usesShellSidebar = computed(() =>
  showAppSidebar.value || usesHermesConfigSidebar.value || usesEkkoConfigSidebar.value || usesCodingAgentConfigSidebar.value,
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
const hasCustomWindowControls = computed(
  () => isDesktopShell.value && ["win32", "linux"].includes(desktopPlatform.value),
);
const isDesktopChatWindow = computed(
  () => desktopBridge()?.windowKind === "chat",
);
const showDesktopTitleBar = computed(
  () => hasCustomWindowControls.value && !isDesktopChatWindow.value,
);
const desktopTitleBarLeft = computed(() => {
  if (isLoginPage.value) return 10;
  if (showNavigationRail.value) return 64;
  if (showAppSidebar.value) return appStore.sidebarCollapsed ? 64 : 240;
  if (usesHermesConfigSidebar.value)
    return appStore.sidebarCollapsed ? 64 : 240;
  if (usesEkkoConfigSidebar.value)
    return appStore.sidebarCollapsed ? 64 : 240;
  if (usesCodingAgentConfigSidebar.value)
    return appStore.sidebarCollapsed ? 64 : 240;
  return appStore.pageSidebarExpanded ? 240 : 10;
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
  mobileNavigationOpen.value = true;
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
  wideViewportQuery.addEventListener('change', handleWideViewportChange);
  if (!isInviteOnlyPage.value) {
    void syncThemeFromServer().catch(() => undefined);
  }
  const bridge = desktopBridge();
  if (
    !bridge?.isDesktop ||
    (!hasCustomWindowControls.value && bridge.windowKind !== "chat")
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
  wideViewportQuery.removeEventListener('change', handleWideViewportChange);
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
                'app-shell--navigation-rail': showNavigationRail,
              },
            ]"
          >
            <DesktopTitleBar
              v-if="showDesktopTitleBar && !showNavigationRail"
              :standalone="isLoginPage || isDesktopChatWindow"
              :left-offset="desktopTitleBarLeft"
            />
            <StudioNavigationRail v-if="showNavigationRail" />
            <MobileNavigationDrawer
              v-if="hasNavigationRail && !isWideViewport"
              v-model:show="mobileNavigationOpen"
              :has-sidebar="hasMobileContextSidebar"
              @target="mobileSidebarHost = $event"
            />
            <div
              v-show="showNavigationRail"
              ref="pageHeaderHost"
              class="studio-page-header"
              :class="{ 'studio-page-header--shell-sidebar': usesShellSidebar }"
            >
              <DesktopTitleBar
                v-if="showDesktopTitleBar && showNavigationRail"
                flush
              />
              <HeaderSidebarToggle
                v-if="showNavigationRail && usesShellSidebar"
                class="header-sidebar-toggle"
                :expanded="!appStore.sidebarCollapsed"
                @toggle="appStore.toggleSidebarCollapsed()"
              />
            </div>
            <div class="app-box">
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
                  :aria-expanded="mobileNavigationOpen"
                  @click="handleMobileMenuClick"
                >
                  <img
                    src="/logo.png"
                    alt="Menu"
                    style="width: 24px; height: 24px"
                  />
                </button>
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

.app-box {
  position: relative;
  z-index: 1;
  display: flex;
  flex: 1;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  width: 100%;
  overflow: hidden;
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

.app-shell--navigation-rail {
  --studio-header-height: 40px;
  --studio-header-inset: #{$navigation-rail-width};
  --studio-content-gutter: 5px;
  --studio-content-radius: #{$radius-lg};
  --desktop-window-controls-width: 139px;
  flex-direction: row;
  background-color: $bg-sidebar;

  .studio-page-header {
    position: absolute;
    z-index: 1001;
    top: 0;
    left: var(--studio-header-inset);
    right: 0;
    height: var(--studio-header-height);
    min-width: 0;
    display: flex;
    align-items: center;
    -webkit-app-region: drag;

    > :deep(:not(.header-sidebar-control):not(.desktop-titlebar)) {
      box-sizing: border-box;
      display: flex;
      align-items: center;
      justify-content: space-between;
      flex-wrap: nowrap;
      gap: 12px;
      // The sidebar control is a sibling on configuration pages.
      flex: 1 1 0%;
      width: 0;
      container: studio-page-header / inline-size;
      min-width: 0;
      height: 100%;
      min-height: 0;
      margin: 0;
      padding: 0 16px;
      border: 0;
      background: transparent;
      overflow-x: auto;
      scrollbar-width: none;

      &::-webkit-scrollbar { display: none; }

      &:has(.header-sidebar-control--outer) {
        padding-inline-start: 0;
      }
    }

    &--shell-sidebar {
      > :deep(:not(.header-sidebar-control):not(.desktop-titlebar)) {
        padding-inline-start: 0;
      }

      :deep(.header-sidebar-control--collapsed) {
        flex-basis: $sidebar-collapsed-width;
      }
    }

    :deep(.header-title),
    :deep(h1),
    :deep(.header-session-title),
    :deep(.header-workflow-title),
    :deep(.room-title-text) {
      font-size: 13px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    :deep(.header-workflow-title) {
      margin-inline-start: 0;
    }

    :deep(.header-left) {
      gap: 0;
    }

    :deep(button),
    :deep(a),
    :deep(input),
    :deep(textarea),
    :deep(select),
    :deep([role="button"]),
    :deep([role="tab"]),
    :deep(.n-base-selection) {
      -webkit-app-region: no-drag;
    }

    :deep(.header-actions),
    :deep(.skills-usage-toolbar),
    :deep(.period-selector) {
      flex-wrap: nowrap;
      flex-shrink: var(--header-actions-shrink, 0);
    }

    :deep(.header-heading),
    :deep(.header-text) {
      display: flex;
      align-items: center;
      gap: 8px;
      min-width: 0;

      p {
        margin: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
    }
  }

  // Three 46px window buttons and their 1px separator.
  &.desktop-platform-win32 .studio-page-header,
  &.desktop-platform-linux .studio-page-header {
    padding-right: var(--desktop-window-controls-width); // rtl-physical: window controls stay on the physical right in every locale.
  }

  .app-box {
    padding-top: var(--studio-header-height);

    &::before {
      content: "";
      position: absolute;
      inset: 0 0 auto;
      height: var(--studio-header-height);
      background-color: $bg-sidebar;
      pointer-events: none;
    }
  }
  .app-layout {
    width: auto;
    margin: 0 var(--studio-content-gutter) var(--studio-content-gutter) 0;
    border-radius: var(--studio-content-radius);
  }
  .app-layout.no-sidebar { display: flex; }

  .app-main--card,
  :deep(.chat-panel > .chat-main),
  :deep(.history-panel > .page-loading-content > .chat-main),
  :deep(.workflow-view > .page-loading-content > .workflow-main),
  :deep(.group-chat-panel > .chat-main) {
    margin: 0;
    border: none;
    border-radius: 0;
    box-shadow: none;
  }
}

.app-shell--custom-background {
  &.app-shell--navigation-rail .app-box::before {
    --cutout-width: calc(100% - var(--studio-content-gutter));
    --cutout-height: calc(100% - var(--studio-header-height) - var(--studio-content-gutter));
    --corner-size: calc(2 * var(--studio-content-radius));
    --corner-mask: radial-gradient(circle closest-side, #000 calc(100% - 0.5px), transparent);
    inset: 0;
    height: auto;
    // One glass sheet covers the header, gutters and rounded corners. Subtract
    // the content rectangle (two strips and four circles) to avoid double tinting.
    mask:
      linear-gradient(#000 0 0),
      linear-gradient(#000 0 0) left var(--studio-content-radius) top var(--studio-header-height) /
        calc(var(--cutout-width) - var(--corner-size)) var(--cutout-height) no-repeat,
      linear-gradient(#000 0 0) left 0 top calc(var(--studio-header-height) + var(--studio-content-radius)) /
        var(--cutout-width) calc(var(--cutout-height) - var(--corner-size)) no-repeat,
      var(--corner-mask) left 0 top var(--studio-header-height) /
        var(--corner-size) var(--corner-size) no-repeat,
      var(--corner-mask) right var(--studio-content-gutter) top var(--studio-header-height) /
        var(--corner-size) var(--corner-size) no-repeat,
      var(--corner-mask) left 0 bottom var(--studio-content-gutter) /
        var(--corner-size) var(--corner-size) no-repeat,
      var(--corner-mask) right var(--studio-content-gutter) bottom var(--studio-content-gutter) /
        var(--corner-size) var(--corner-size) no-repeat;
    mask-composite: subtract, add, add, add, add, add, add;
  }

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

  &.app-shell--navigation-rail .app-box::before,
  :deep(.sidebar),
  :deep(.studio-navigation-rail),
  :deep(.hermes-config-sidebar),
  :deep(.ekko-config-sidebar),
  :deep(.coding-agent-config-sidebar),
  :deep(.chat-panel > .session-list),
  :deep(.history-panel > .page-loading-content > .session-list),
  :deep(.group-chat-panel > .room-sidebar),
  :deep(.workflow-view > .page-loading-content > .workflow-sidebar) {
    background-color: rgba(var(--bg-sidebar-surface-rgb), 0.72);
    -webkit-backdrop-filter: blur(8px) saturate(110%);
    backdrop-filter: blur(8px) saturate(110%);
  }

  :deep(.history-panel > .page-loading-content > .chat-main),
  :deep(.workflow-view > .page-loading-content > .workflow-main) {
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

  :deep(.desktop-titlebar:not(.desktop-titlebar--flush)),
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

  :deep(.chat-input-area .context-usage-row),
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
.app-shell.desktop-platform-win32,
.app-shell.desktop-platform-linux:not(.desktop-chat-window) {
  &::before {
    content: "";
    position: absolute;
    z-index: 1000;
    top: 0;
    left: var(--studio-header-inset, 0px);
    right: 0;
    height: var(--studio-header-height, 10px);
    -webkit-app-region: drag;
  }

  :deep(.page-header),
  :deep(.chat-header),
  :deep(.terminal-header),
  .studio-page-header {
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

.app-shell.desktop-platform-win32,
.app-shell.desktop-platform-linux:not(.desktop-chat-window) {
  overflow: hidden;

  &:not(.app-shell--navigation-rail) {
    .app-main--card,
    :deep(.chat-panel > .chat-main),
    :deep(.history-panel > .page-loading-content > .chat-main),
    :deep(.workflow-view > .page-loading-content > .workflow-main),
    :deep(.group-chat-panel > .chat-main) {
      margin-top: 50px;
    }
  }

  :deep(.chat-panel > .session-list > .page-sidebar-top),
  :deep(.history-panel > .page-loading-content > .session-list > .page-sidebar-top),
  :deep(.workflow-view > .page-loading-content > .workflow-sidebar > .page-sidebar-top),
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
  // Native macOS traffic lights remain on the physical left in RTL locales.
  &.app-shell--navigation-rail:dir(rtl) {
    flex-direction: row-reverse;
  }

  :deep(.studio-navigation-rail) {
    padding-top: 44px;

    &::before {
      content: "";
      position: absolute;
      top: 0;
      left: 0;
      right: 0;
      height: 44px;
      -webkit-app-region: drag;
    }
  }
}

.app-shell.desktop-platform-darwin:not(.app-shell--navigation-rail) {
  .app-layout > :deep(.sidebar),
  .app-layout > :deep(.hermes-config-sidebar),
  .app-layout > :deep(.ekko-config-sidebar),
  .app-layout > :deep(.coding-agent-config-sidebar) {
    padding-top: 40px;
  }

  :deep(.chat-panel > .session-list > .page-sidebar-top),
  :deep(.history-panel > .page-loading-content > .session-list > .page-sidebar-top),
  :deep(.workflow-view > .page-loading-content > .workflow-sidebar > .page-sidebar-top),
  :deep(.group-chat-panel > .room-sidebar > .sidebar-header) {
    padding-top: 44px;
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
  .app-shell--navigation-rail .app-main,
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
