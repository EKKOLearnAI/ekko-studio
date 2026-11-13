<script setup lang="ts">
import { NCard, NGi, NGrid, NStatistic } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import type { KnowledgeHealth } from '../api'

const { t } = useI18n()

defineProps<{
  health: KnowledgeHealth | null
}>()
</script>

<template>
  <NCard v-if="health" size="small" class="knowledge-health-card" data-theme-surface="card">
    <NGrid :cols="4" :x-gap="12" responsive="screen">
      <NGi>
        <NStatistic :label="t('knowledge.health.vaults')" :value="health.vaults.total" />
      </NGi>
      <NGi>
        <NStatistic :label="t('knowledge.health.documents')" :value="health.documents.total" />
      </NGi>
      <NGi>
        <NStatistic :label="t('knowledge.health.chunks')" :value="health.chunks.total" />
      </NGi>
      <NGi>
        <NStatistic :label="t('knowledge.health.vectors')" :value="health.vecIndex.vectorCount" />
      </NGi>
    </NGrid>
  </NCard>
</template>

<style scoped>
.knowledge-health-card {
  margin-bottom: 0;
}
</style>