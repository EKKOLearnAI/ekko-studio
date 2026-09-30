<script setup lang="ts">
import PageLoading from '@/components/common/PageLoading.vue'
import PageHeader from '@/components/layout/PageHeader.vue'
import { onMounted, ref } from 'vue'

import { useI18n } from 'vue-i18n'
import { useSettingsStore } from '@/stores/hermes/settings'
import { useProfilesStore } from '@/stores/hermes/profiles'
import PlatformSettings from '@/components/hermes/settings/PlatformSettings.vue'

const settingsStore = useSettingsStore()
const profilesStore = useProfilesStore()
const { t } = useI18n()

async function loadSettingsForProfile() {
  if (!profilesStore.activeProfileName || profilesStore.profiles.length === 0) {
    await profilesStore.fetchProfiles()
  }
  await settingsStore.fetchSettings()
}

const initializing = ref(true)

onMounted(() => {
  void loadSettingsForProfile().finally(() => { initializing.value = false })
})
</script>

<template>
  <PageLoading :show="initializing || settingsStore.loading" class="channels-view">
    <PageHeader>
    <header class="page-header">
      <h2 class="header-title">{{ t('sidebar.channels') }}</h2>
    </header>
    </PageHeader>

    <div class="channels-content">
      <div>
        <PlatformSettings v-if="!settingsStore.loading" />
      </div>
    </div>
  </PageLoading>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;

.channels-view {
  height: 100%;
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
