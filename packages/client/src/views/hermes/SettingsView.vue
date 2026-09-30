<script setup lang="ts">
import PageLoading from '@/components/common/PageLoading.vue'
import PageHeader from '@/components/layout/PageHeader.vue'
import { computed, onMounted, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import {
  NTabs,
  NTabPane,
} from "naive-ui";
import { useI18n } from "vue-i18n";
import { useSettingsStore } from "@/stores/hermes/settings";
import DisplaySettings from "@/components/hermes/settings/DisplaySettings.vue";
import ProxySettings from "@/components/hermes/settings/ProxySettings.vue";
import CompressionSettings from "@/components/hermes/settings/CompressionSettings.vue";
import PrivacySettings from "@/components/hermes/settings/PrivacySettings.vue";
import ModelSettings from "@/components/hermes/settings/ModelSettings.vue";
import AccountSettings from "@/components/hermes/settings/AccountSettings.vue";
import UserManagementSettings from "@/components/hermes/settings/UserManagementSettings.vue";
import WebhookSettings from "@/components/hermes/settings/WebhookSettings.vue";
import { isStoredSuperAdmin } from "@/api/client";
import { useProfilesStore } from "@/stores/hermes/profiles";

const settingsStore = useSettingsStore();
const profilesStore = useProfilesStore();
const { t } = useI18n();
const canManageUsers = isStoredSuperAdmin();
const route = useRoute();
const router = useRouter();
const activeTab = ref("account");

const validTabs = computed(() => new Set([
  "account",
  ...(canManageUsers ? ["users"] : []),
  ...(canManageUsers ? ["webhooks"] : []),
  "display",
  "proxy",
  "compression",
  "privacy",
  "models",
]));

function normalizeTab(value: unknown): string {
  const tab = typeof value === "string" ? value : "";
  return validTabs.value.has(tab) ? tab : "account";
}

function handleTabUpdate(tab: string) {
  activeTab.value = normalizeTab(tab);
  router.replace({
    query: {
      ...route.query,
      tab: activeTab.value === "account" ? undefined : activeTab.value,
    },
  });
}

watch(() => route.query.tab, (tab) => {
  if (tab === "agent" || tab === "memory" || tab === "session" || tab === "gateway") {
    void router.replace({
      name: "hermes.configSettings",
      query: {
        ...route.query,
        tab: tab === "agent" || tab === "gateway" ? undefined : tab,
      },
    });
    return;
  }
  if (tab === "voice") {
    void router.replace({
      name: "hermes.models",
      query: {
        ...route.query,
        tab: "tts",
      },
    });
    return;
  }
  activeTab.value = normalizeTab(tab);
}, { immediate: true });

async function loadSettingsForProfile() {
  if (!profilesStore.activeProfileName || profilesStore.profiles.length === 0) {
    await profilesStore.fetchProfiles();
  }
  await settingsStore.fetchSettings();
}

const initializing = ref(true)

onMounted(() => {
  void loadSettingsForProfile().finally(() => { initializing.value = false });
});
</script>

<template>
  <PageLoading :show="initializing || settingsStore.loading" class="settings-view">
    <PageHeader>
    <header class="page-header">
      <h2 class="header-title">{{ t("settings.title") }}</h2>
    </header>
    </PageHeader>

    <div class="settings-content">
      <div>
        <NTabs v-model:value="activeTab" type="line" animated @update:value="handleTabUpdate">
          <NTabPane name="account" :tab="t('settings.tabs.account')">
            <AccountSettings />
          </NTabPane>
          <NTabPane v-if="canManageUsers" name="users" :tab="t('settings.tabs.users')">
            <UserManagementSettings />
          </NTabPane>
          <NTabPane v-if="canManageUsers" name="webhooks" :tab="t('settings.tabs.webhooks')">
            <WebhookSettings />
          </NTabPane>
          <NTabPane name="display" :tab="t('settings.tabs.display')">
            <DisplaySettings />
          </NTabPane>
          <NTabPane name="proxy" :tab="t('settings.tabs.proxy')">
            <ProxySettings />
          </NTabPane>
          <NTabPane name="compression" :tab="t('settings.tabs.compression')">
            <CompressionSettings />
          </NTabPane>
          <NTabPane name="privacy" :tab="t('settings.tabs.privacy')">
            <PrivacySettings />
          </NTabPane>
          <NTabPane name="models" :tab="t('settings.tabs.models')">
            <ModelSettings />
          </NTabPane>
        </NTabs>
      </div>
    </div>
  </PageLoading>
</template>

<style scoped lang="scss">
@use "@/styles/variables" as *;

.settings-view {
  height: 100%;
  display: flex;
  flex-direction: column;
}

.settings-content {
  flex: 1;
  overflow-y: auto;
  padding: 20px;
}
</style>
