<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { NBadge, NButton, NScrollbar, NSpace, NTag } from 'naive-ui'
import type { KnowledgeVault, KnowledgeDocument } from '../api'

const { t } = useI18n()

const props = defineProps<{
  vaults: readonly KnowledgeVault[]
  documents: readonly KnowledgeDocument[]
  selectedVaultId: number | null
}>()

const emit = defineEmits<{
  (e: 'select', vaultId: number | null): void
}>()

const docCountByVault = computed(() => {
  const map = new Map<number, number>()
  for (const doc of props.documents) {
    map.set(doc.vault_id, (map.get(doc.vault_id) || 0) + 1)
  }
  return map
})

const allCount = computed(() => props.documents.length)
</script>

<template>
  <div class="knowledge-vault-tree">
    <h4 class="tree-title">{{ t('knowledge.sidebar.vaults') }}</h4>
    <NScrollbar style="max-height: 280px">
      <ul class="tree-list">
        <li
          class="tree-item tree-item--all"
          :class="{ 'is-active': props.selectedVaultId === null }"
          @click="emit('select', null)"
        >
          <span class="tree-item-label">{{ t('knowledge.sidebar.allVaults') }}</span>
          <NBadge :value="allCount" :max="999" />
        </li>
        <li
          v-for="vault in props.vaults"
          :key="vault.id"
          class="tree-item"
          :class="{ 'is-active': props.selectedVaultId === vault.id }"
          @click="emit('select', vault.id)"
        >
          <div class="tree-item-row">
            <span class="tree-item-label" :title="vault.name">{{ vault.name }}</span>
            <NBadge :value="docCountByVault.get(vault.id) || 0" :max="999" />
          </div>
          <div class="tree-item-meta">
            <NTag size="tiny" :type="vault.watch ? 'success' : 'warning'">
              {{ vault.watch ? t('knowledge.vaults.watching') : t('knowledge.vaults.offline') }}
            </NTag>
          </div>
        </li>
      </ul>
    </NScrollbar>
    <NSpace v-if="!props.vaults.length" justify="center" class="tree-empty">
      <NButton size="tiny" tertiary @click="emit('select', null)">
        {{ t('knowledge.sidebar.noVaults') }}
      </NButton>
    </NSpace>
  </div>
</template>

<style scoped>
.knowledge-vault-tree {
  padding: 12px 0;
}
.tree-title {
  margin: 0 0 8px;
  padding: 0 12px;
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  opacity: 0.6;
}
.tree-list {
  list-style: none;
  margin: 0;
  padding: 0;
}
.tree-item {
  padding: 8px 12px;
  cursor: pointer;
  border-radius: 6px;
  margin: 2px 6px;
  transition: background 0.15s ease;
}
.tree-item:hover {
  background: var(--hover-color, rgba(var(--text-primary-rgb), 0.04));
}
.tree-item.is-active {
  background: var(--primary-color-suppl, rgba(var(--accent-info-rgb), 0.12));
  color: var(--primary-color, var(--accent-info));
}
.tree-item--all {
  font-weight: 500;
}
.tree-item-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 8px;
}
.tree-item-label {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 13px;
}
.tree-item-meta {
  margin-top: 4px;
}
.tree-empty {
  padding: 8px 12px;
}
</style>