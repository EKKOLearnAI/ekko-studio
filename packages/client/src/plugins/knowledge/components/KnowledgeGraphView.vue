<script setup lang="ts">
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import {
  NCard,
  NEmpty,
  NSelect,
} from 'naive-ui'
import type { KnowledgeVault, KnowledgeDocument } from '../api'
import { useKnowledgeGraph, computeGraphLayout, type PositionedNode } from '../composables/useKnowledgeGraph'

const { t } = useI18n()

const props = defineProps<{
  vaults: readonly KnowledgeVault[]
  documents: readonly KnowledgeDocument[]
}>()

const emit = defineEmits<{
  (e: 'select-document', doc: KnowledgeDocument): void
}>()

const selectedVaultFilter = ref<number | string | null>('__all__')

const vaultOptions = computed<Array<{ label: string; value: number | string }>>(() => [
  { label: t('knowledge.graph.allVaults'), value: '__all__' },
  ...props.vaults.map(v => ({ label: v.name, value: v.id })),
])

const filteredVaults = computed(() => {
  if (selectedVaultFilter.value === '__all__') return props.vaults
  return props.vaults.filter(v => v.id === selectedVaultFilter.value)
})

const filteredDocuments = computed(() => {
  if (selectedVaultFilter.value === '__all__') return props.documents
  return props.documents.filter(d => d.vault_id === selectedVaultFilter.value)
})

const graphData = useKnowledgeGraph(
  () => filteredVaults.value,
  () => filteredDocuments.value,
)

const layout = computed(() => computeGraphLayout(graphData.value))

const viewBox = computed(() => {
  const nodes = layout.value.positionedNodes
  if (!nodes.length) return '0 0 800 400'
  const padding = 60
  const minX = Math.min(...nodes.map(n => n.x)) - padding
  const maxX = Math.max(...nodes.map(n => n.x)) + padding
  const minY = Math.min(...nodes.map(n => n.y)) - padding
  const maxY = Math.max(...nodes.map(n => n.y)) + padding
  return `${minX} ${minY} ${maxX - minX} ${maxY - minY}`
})

function docIdFromNodeId(nodeId: string): number | null {
  const parts = nodeId.split('-')
  const n = parseInt(parts[1] ?? '', 10)
  return Number.isFinite(n) ? n : null
}

function nodeFill(node: PositionedNode): string {
  if (node.type === 'vault') return '#2080f0'
  const status = node.status ?? 'pending'
  const colors: Record<string, string> = {
    indexed: '#18a058',
    indexing: '#2080f0',
    pending: '#f0a020',
    failed: '#d03050',
    metadata_only: '#909399',
  }
  return colors[status] ?? '#909399'
}

function nodeStroke(node: PositionedNode): string {
  return node.type === 'vault' ? '#1060c0' : '#00000020'
}

function onNodeClick(node: PositionedNode): void {
  if (node.type !== 'document') return
  const docId = docIdFromNodeId(node.id)
  if (docId == null) return
  const doc = props.documents.find(d => d.id === docId)
  if (doc) emit('select-document', doc)
}
</script>

<template>
  <NCard :title="t('knowledge.graph.title')" size="small" class="knowledge-graph-view">
    <template #header-extra>
      <NSelect
        v-model:value="selectedVaultFilter"
        :options="vaultOptions"
        size="small"
        style="width: 180px"
      />
    </template>

    <div v-if="layout.positionedNodes.length" class="graph-container">
      <svg :viewBox="viewBox" class="graph-svg">
        <g class="edges">
          <line
            v-for="edge in layout.positionedEdges"
            :key="edge.id"
            :x1="edge.sourceX"
            :y1="edge.sourceY"
            :x2="edge.targetX"
            :y2="edge.targetY"
            class="graph-edge"
          />
        </g>
        <g class="nodes">
          <g
            v-for="node in layout.positionedNodes"
            :key="node.id"
            :transform="`translate(${node.x}, ${node.y})`"
            class="graph-node"
            :class="{ 'is-vault': node.type === 'vault' }"
            @click="onNodeClick(node)"
          >
            <circle
              :r="node.size"
              :fill="nodeFill(node)"
              :stroke="nodeStroke(node)"
              stroke-width="2"
            />
            <text
              :y="(node.size || 20) + 14"
              text-anchor="middle"
              class="graph-node-label"
            >
              {{ node.label.length > 16 ? node.label.slice(0, 14) + '…' : node.label }}
            </text>
          </g>
        </g>
      </svg>
    </div>
    <NEmpty v-else :description="t('knowledge.graph.empty')" />

    <div class="graph-legend">
      <span class="legend-item">
        <span class="legend-dot" style="background:var(--accent-info)"></span>
        {{ t('knowledge.graph.legend.vault') }}
      </span>
      <span class="legend-item">
        <span class="legend-dot" style="background:var(--success)"></span>
        {{ t('knowledge.graph.legend.document') }}
      </span>
    </div>
  </NCard>
</template>

<style scoped>
.knowledge-graph-view {
  margin-bottom: 0;
}
.graph-container {
  width: 100%;
  height: 480px;
  overflow: hidden;
  background: var(--card-color-2, rgba(var(--text-primary-rgb), 0.02));
  border-radius: 6px;
}
.graph-svg {
  width: 100%;
  height: 100%;
  display: block;
}
.graph-edge {
  stroke: var(--border-color, rgba(var(--text-primary-rgb), 0.15));
  stroke-width: 1.5;
}
.graph-node {
  cursor: pointer;
  transition: transform 0.15s ease;
}
.graph-node:hover {
  transform-origin: center;
}
.graph-node.is-vault {
  cursor: default;
}
.graph-node-label {
  font-size: 12px;
  fill: var(--text-color, rgba(var(--text-primary-rgb), 0.85));
  pointer-events: none;
}
.graph-legend {
  margin-top: 12px;
  display: flex;
  justify-content: center;
  gap: 24px;
  font-size: 12px;
  opacity: 0.75;
}
.legend-item {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
.legend-dot {
  display: inline-block;
  width: 10px;
  height: 10px;
  border-radius: 50%;
}
</style>