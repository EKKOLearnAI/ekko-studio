<script setup lang="ts">
import { onMounted } from 'vue'
import { NSpin } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import { useSettingsStore } from '@/stores/hermes/settings'
import { useProfilesStore } from '@/stores/hermes/profiles'
import PlatformSettings from '@/components/hermes/settings/PlatformSettings.vue'
import IncomingWebhookSettings from '@/components/hermes/settings/IncomingWebhookSettings.vue'

const settingsStore = useSettingsStore()
const profilesStore = useProfilesStore()
const { t } = useI18n()

async function loadSettingsForProfile() {
  if (!profilesStore.activeProfileName || profilesStore.profiles.length === 0) {
    await profilesStore.fetchProfiles()
  }
  await settingsStore.fetchSettings()
}

onMounted(() => {
  void loadSettingsForProfile()
})
</script>

<template>
  <div class="channels-view">
    <header class="page-header">
      <h2 class="header-title">{{ t('sidebar.channels') }}</h2>
    </header>

    <div class="channels-content">
      <NSpin :show="settingsStore.loading || settingsStore.saving" size="large" :description="t('common.loading')">
        <PlatformSettings v-if="!settingsStore.loading" />
        <IncomingWebhookSettings v-if="!settingsStore.loading" />
      </NSpin>
    </div>
  </div>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;

.channels-view {
  height: calc(100 * var(--vh));
  display: flex;
  flex-direction: column;
}

.channels-content {
  flex: 1;
  overflow-y: auto;
  padding: 20px;
  position: relative;
}
</style>
