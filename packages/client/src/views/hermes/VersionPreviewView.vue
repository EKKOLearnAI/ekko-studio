<script setup lang="ts">
import PageLoading from '@/components/common/PageLoading.vue'
import PageHeader from '@/components/layout/PageHeader.vue'
import { useI18n } from 'vue-i18n'
import GithubPreviewSettings from '@/components/hermes/settings/GithubPreviewSettings.vue'

const { t } = useI18n()
</script>

<template>
  <PageLoading :show="false" class="version-preview-view">
    <PageHeader>
    <header class="page-header">
      <h2 class="header-title">{{ t('githubPreview.title') }}</h2>
    </header>
    </PageHeader>

    <div class="page-content">
      <GithubPreviewSettings />
    </div>
  </PageLoading>
</template>

<style scoped lang="scss">
@use "@/styles/variables" as *;

.version-preview-view {
  height: 100%;
  display: flex;
  flex-direction: column;
}

.page-content {
  flex: 1;
  overflow-y: auto;
  padding: 20px;
}
</style>
