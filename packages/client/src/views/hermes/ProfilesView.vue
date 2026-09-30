<script setup lang="ts">
import PageLoading from '@/components/common/PageLoading.vue'
import PageHeader from '@/components/layout/PageHeader.vue'
import { ref, onMounted } from 'vue'
import { NButton } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import ProfilesPanel from '@/components/hermes/profiles/ProfilesPanel.vue'
import ProfileCreateModal from '@/components/hermes/profiles/ProfileCreateModal.vue'
import ProfileRenameModal from '@/components/hermes/profiles/ProfileRenameModal.vue'
import ProfileImportModal from '@/components/hermes/profiles/ProfileImportModal.vue'
import { useProfilesStore } from '@/stores/hermes/profiles'

const { t } = useI18n()
const profilesStore = useProfilesStore()

const showCreateModal = ref(false)
const showImportModal = ref(false)
const renamingProfile = ref<string | null>(null)

onMounted(() => {
  profilesStore.fetchHermesProfiles()
})

function handleCreated() {
  showCreateModal.value = false
}

function handleRenamed() {
  renamingProfile.value = null
}

function handleImported() {
  showImportModal.value = false
}
</script>

<template>
  <PageLoading :show="profilesStore.loading && profilesStore.profiles.length === 0" class="profiles-view">
    <PageHeader>
    <header class="page-header">
      <h2 class="header-title">{{ t('profiles.title') }}</h2>
      <div class="header-actions">
        <NButton size="small" @click="showImportModal = true">
          <template #icon>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
              <polyline points="17 8 12 3 7 8" />
              <line x1="12" y1="3" x2="12" y2="15" />
            </svg>
          </template>
          {{ t('profiles.import') }}
        </NButton>
        <NButton type="primary" size="small" @click="showCreateModal = true">
          <template #icon>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <line x1="12" y1="5" x2="12" y2="19" />
              <line x1="5" y1="12" x2="19" y2="12" />
            </svg>
          </template>
          {{ t('profiles.create') }}
        </NButton>
      </div>
    </header>
    </PageHeader>

    <div class="profiles-content">
      <div>
        <ProfilesPanel @rename="renamingProfile = $event" />
      </div>
    </div>

    <ProfileCreateModal
      v-if="showCreateModal"
      @close="showCreateModal = false"
      @saved="handleCreated"
    />
    <ProfileRenameModal
      v-if="renamingProfile"
      :profile-name="renamingProfile"
      @close="renamingProfile = null"
      @saved="handleRenamed"
    />
    <ProfileImportModal
      v-if="showImportModal"
      @close="showImportModal = false"
      @saved="handleImported"
    />
  </PageLoading>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;

.profiles-view {
  height: 100%;
  display: flex;
  flex-direction: column;
}

.header-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}

.profiles-content {
  flex: 1;
  overflow-y: auto;
  padding: 20px;
}
</style>
