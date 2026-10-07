<script setup lang="ts">
import PageLoading from '@/components/common/PageLoading.vue'
import PageHeader from '@/components/layout/PageHeader.vue'
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import {
  NButton, NDrawer, NDrawerContent, NEmpty, NInput, NModal,
  NPopconfirm, NSelect, NTag, useMessage,
} from 'naive-ui'
import { Handle, MarkerType, Position, VueFlow, useVueFlow } from '@vue-flow/core'
import { Background } from '@vue-flow/background'
import { Controls } from '@vue-flow/controls'
import { MiniMap } from '@vue-flow/minimap'
import { useI18n } from 'vue-i18n'
import {
  deleteEkkoMemory, fetchEkkoMemory, updateEkkoMemory,
  type EkkoMemoryNode, type EkkoMemoryStatus,
} from '@/api/ekko/memory'
import {
  buildEkkoMemoryGraphEdges, ekkoMemoryNeighborIds, layoutEkkoMemoryGraph,
  type EkkoMemoryGraphEdge, type EkkoMemoryRelationshipKind,
} from '@/utils/ekko/memory-graph'

import '@vue-flow/core/dist/style.css'
import '@vue-flow/core/dist/theme-default.css'
import '@vue-flow/controls/dist/style.css'
import '@vue-flow/minimap/dist/style.css'

type MemoryViewMode = 'graph' | 'list'
type MemoryStatusFilter = 'all' | EkkoMemoryStatus

interface MemoryFlowNodeData {
  memory: EkkoMemoryNode
  color: string
  degree: number
  scope: string
  status: string
  active: boolean
  related: boolean
  dimmed: boolean
}

const SCOPE_COLORS = { profile: '#4f8cff', context: '#9b6cff', session: '#38c976' } as const
const RELATION_COLORS: Record<EkkoMemoryRelationshipKind, string> = {
  revision: '#f59e42', source: '#4f8cff', entity: '#9b6cff',
}

const { t } = useI18n()
const message = useMessage()
const { fitView } = useVueFlow('ekko-memory')
const loading = ref(true)
const saving = ref(false)
const query = ref('')
const status = ref<MemoryStatusFilter>('active')
const viewMode = ref<MemoryViewMode>('graph')
const memories = ref<EkkoMemoryNode[]>([])
const editing = ref<EkkoMemoryNode | null>(null)
const draftTitle = ref('')
const draftContent = ref('')
const draftTags = ref('')
const graphWrapRef = ref<HTMLElement | null>(null)
const graphHeight = ref(640)
const selectedId = ref('')
const hoverId = ref('')
const detailDrawerOpen = ref(false)

let disposed = false
let loadGeneration = 0
const statusOptions = computed(() => [
  { label: t('ekkoConfig.allStatuses'), value: 'all' },
  { label: t('ekkoConfig.statusActive'), value: 'active' },
  { label: t('ekkoConfig.statusSuperseded'), value: 'superseded' },
  { label: t('ekkoConfig.statusExpired'), value: 'expired' },
  { label: t('ekkoConfig.statusDeleted'), value: 'deleted' },
])
const memoryById = computed(() => new Map(memories.value.map(memory => [memory.id, memory])))
const graphEdges = computed(() => buildEkkoMemoryGraphEdges(memories.value))
const focusId = computed(() => selectedId.value || hoverId.value)
const focusedNeighborIds = computed(() =>
  focusId.value ? ekkoMemoryNeighborIds(focusId.value, graphEdges.value) : new Set<string>(),
)
const selectedMemory = computed(() => memoryById.value.get(selectedId.value) || null)
const relationCounts = computed(() => ({
  revision: graphEdges.value.filter(edge => edge.kinds.includes('revision')).length,
  source: graphEdges.value.filter(edge => edge.kinds.includes('source')).length,
  entity: graphEdges.value.filter(edge => edge.kinds.includes('entity')).length,
}))
const selectedRelations = computed(() => {
  if (!selectedId.value) return []
  return graphEdges.value.flatMap((edge) => {
    const neighborId = edge.source === selectedId.value
      ? edge.target
      : edge.target === selectedId.value ? edge.source : ''
    const memory = neighborId ? memoryById.value.get(neighborId) : undefined
    return memory ? [{ edge, memory }] : []
  })
})
const flowNodes = computed(() => {
  const maxRows = Math.max(3, Math.min(7, Math.floor((graphHeight.value - 90) / 142)))
  const layout = layoutEkkoMemoryGraph(memories.value, graphEdges.value, { maxRows })
  const hasFocus = Boolean(focusId.value)
  return layout.map((layoutNode) => {
    const memory = memoryById.value.get(layoutNode.id)!
    const active = focusId.value === memory.id
    const related = focusedNeighborIds.value.has(memory.id)
    return {
      id: memory.id,
      type: 'memory-card',
      position: layoutNode.position,
      draggable: false,
      selectable: false,
      connectable: false,
      focusable: false,
      sourcePosition: Position.Right,
      targetPosition: Position.Left,
      style: {
        width: '270px', pointerEvents: 'all' as const,
        zIndex: active ? 4 : related ? 3 : 1,
      },
      data: {
        memory, color: scopeColor(memory), degree: layoutNode.degree,
        scope: scopeLabel(memory), status: statusLabel(memory.status),
        active, related, dimmed: hasFocus && !active && !related,
      } satisfies MemoryFlowNodeData,
    }
  })
})

const flowEdges = computed(() => graphEdges.value.map((edge) => {
  const kind = primaryRelationshipKind(edge)
  const active = Boolean(focusId.value && (edge.source === focusId.value || edge.target === focusId.value))
  const color = RELATION_COLORS[kind]
  return {
    id: edge.id, source: edge.source, target: edge.target, type: 'smoothstep',
    selectable: false, focusable: false,
    animated: active && kind === 'revision', interactionWidth: 0,
    ...(kind === 'revision' ? {
      markerEnd: { type: MarkerType.ArrowClosed, color, width: active ? 18 : 14, height: active ? 18 : 14 },
    } : {}),
    style: {
      stroke: color, strokeWidth: active ? 2.5 : 1.35,
      strokeDasharray: kind === 'source' ? '7 5' : kind === 'entity' ? '2 5' : undefined,
      opacity: active ? 0.95 : focusId.value ? 0.09 : 0.42,
    },
    zIndex: active ? 3 : 0,
  }
}))

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

async function fitMemoryGraph() {
  await nextTick()
  if (disposed || viewMode.value !== 'graph' || !flowNodes.value.length) return
  try {
    await fitView({ padding: 0.18, minZoom: 0.28, maxZoom: 1, duration: 220 })
  } catch {
    // The graph can disappear while the route is being unmounted.
  }
}

async function loadMemory() {
  const generation = ++loadGeneration
  loading.value = true
  try {
    const nextMemories = await fetchEkkoMemory({
      query: query.value.trim(),
      status: status.value === 'all' ? undefined : status.value,
    })
    if (disposed || generation !== loadGeneration) return
    memories.value = nextMemories
    if (selectedId.value && !nextMemories.some(memory => memory.id === selectedId.value)) {
      selectedId.value = ''
      detailDrawerOpen.value = false
    }
    void fitMemoryGraph()
  } catch (error) {
    if (!disposed && generation === loadGeneration) {
      message.error(`${t('ekkoConfig.loadFailed')}: ${errorMessage(error)}`)
    }
  } finally {
    if (!disposed && generation === loadGeneration) loading.value = false
  }
}

function openDetails(id: string) {
  selectedId.value = id
  hoverId.value = ''
  detailDrawerOpen.value = true
}

function clearGraphSelection() {
  selectedId.value = ''
  hoverId.value = ''
  detailDrawerOpen.value = false
}

function handleDrawerShow(show: boolean) {
  detailDrawerOpen.value = show
  if (!show) selectedId.value = ''
}

function openEditor(memory: EkkoMemoryNode) {
  editing.value = memory
  draftTitle.value = memory.title
  draftContent.value = memory.content
  draftTags.value = memory.tags.join(', ')
}

async function saveMemory() {
  if (!editing.value) return
  saving.value = true
  try {
    const saved = await updateEkkoMemory(editing.value.id, {
      expectedRevision: editing.value.revision,
      title: draftTitle.value.trim(), content: draftContent.value.trim(),
      tags: draftTags.value.split(',').map(tag => tag.trim()).filter(Boolean),
    })
    editing.value = null
    selectedId.value = saved.id
    await loadMemory()
    if (memoryById.value.has(saved.id)) detailDrawerOpen.value = true
    message.success(t('common.saved'))
  } catch (error) {
    message.error(`${t('common.saveFailed')}: ${errorMessage(error)}`)
  } finally {
    saving.value = false
  }
}

async function removeMemory(memory: EkkoMemoryNode) {
  try {
    await deleteEkkoMemory(memory.id, memory.revision)
    if (selectedId.value === memory.id) clearGraphSelection()
    await loadMemory()
    message.success(t('ekkoConfig.deleted'))
  } catch (error) {
    message.error(`${t('common.deleteFailed')}: ${errorMessage(error)}`)
  }
}

function formatDate(value: string): string { return new Date(value).toLocaleString() }
function statusLabel(value: EkkoMemoryStatus): string {
  return t({ active: 'ekkoConfig.statusActive', superseded: 'ekkoConfig.statusSuperseded',
    expired: 'ekkoConfig.statusExpired', deleted: 'ekkoConfig.statusDeleted' }[value])
}
function statusTagType(value: EkkoMemoryStatus): 'success' | 'warning' | 'error' | 'default' {
  if (value === 'active') return 'success'
  if (value === 'expired') return 'warning'
  if (value === 'deleted') return 'error'
  return 'default'
}
function scopeType(memory: EkkoMemoryNode): 'profile' | 'context' | 'session' {
  return memory.scope?.type || 'profile'
}
function scopeColor(memory: EkkoMemoryNode): string { return SCOPE_COLORS[scopeType(memory)] }
function scopeLabel(memory: EkkoMemoryNode): string {
  const scope = memory.scope || { type: 'profile' as const }
  if (scope.type === 'profile') return 'profile'
  if (scope.type === 'session') return `session · ${scope.id}`
  return `${scope.namespace} · ${scope.id}`
}
function categoryLabel(memory: EkkoMemoryNode): string {
  return memory.categoryPath.length ? memory.categoryPath.join(' / ') : memory.domain || '-'
}
function primaryRelationshipKind(edge: EkkoMemoryGraphEdge): EkkoMemoryRelationshipKind {
  if (edge.kinds.includes('revision')) return 'revision'
  if (edge.kinds.includes('source')) return 'source'
  return 'entity'
}
function relationshipLabel(edge: EkkoMemoryGraphEdge): string {
  return edge.kinds.map(kind => t({ revision: 'ekkoConfig.relationRevision',
    source: 'ekkoConfig.relationSource', entity: 'ekkoConfig.relationEntity' }[kind])).join(' · ')
}
function miniMapNodeColor(node: { data?: MemoryFlowNodeData }): string {
  return node.data?.color || '#7f8c9a'
}
function updateViewportMetrics() {
  const rect = graphWrapRef.value?.getBoundingClientRect()
  if (rect?.height) graphHeight.value = rect.height
}

onMounted(() => {
  window.addEventListener('resize', updateViewportMetrics)
  updateViewportMetrics()
  void loadMemory()
})
onBeforeUnmount(() => {
  disposed = true
  loadGeneration += 1
  window.removeEventListener('resize', updateViewportMetrics)
})
watch(viewMode, (mode) => {
  if (mode === 'graph') nextTick(() => { updateViewportMetrics(); void fitMemoryGraph() })
})
</script>

<template>
  <PageLoading :show="loading" class="ekko-page">
    <PageHeader>
    <header class="page-header">
      <h2 class="header-title">{{ t('ekkoConfig.memoryTitle') }}</h2>
      <NButton size="small" quaternary :loading="loading" @click="loadMemory">
        <template #icon>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <polyline points="23 4 23 10 17 10" />
            <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
          </svg>
        </template>
        {{ t('ekkoConfig.refresh') }}
      </NButton>
    </header>
    </PageHeader>

    <div class="toolbar">
      <NInput v-model:value="query" clearable :placeholder="t('ekkoConfig.searchMemory')" @keyup.enter="loadMemory" />
      <NSelect v-model:value="status" class="status-select" :options="statusOptions" @update:value="loadMemory" />
      <div class="view-switch" role="group" :aria-label="t('ekkoConfig.memoryTitle')">
        <NButton size="small" :type="viewMode === 'graph' ? 'primary' : 'default'" :secondary="viewMode !== 'graph'" @click="viewMode = 'graph'">{{ t('ekkoConfig.graphView') }}</NButton>
        <NButton size="small" :type="viewMode === 'list' ? 'primary' : 'default'" :secondary="viewMode !== 'list'" @click="viewMode = 'list'">{{ t('ekkoConfig.listView') }}</NButton>
      </div>
    </div>

    <main class="memory-workspace">
      <section v-if="viewMode === 'graph'" class="memory-graph-panel">
        <div class="relationship-legend">
          <span class="relationship-legend__hint">{{ t('ekkoConfig.memoryGraphHint') }}</span>
          <span class="relationship-legend__item relationship-legend__item--revision"><i />{{ t('ekkoConfig.relationRevision') }} · {{ relationCounts.revision }}</span>
          <span class="relationship-legend__item relationship-legend__item--source"><i />{{ t('ekkoConfig.relationSource') }} · {{ relationCounts.source }}</span>
          <span class="relationship-legend__item relationship-legend__item--entity"><i />{{ t('ekkoConfig.relationEntity') }} · {{ relationCounts.entity }}</span>
        </div>

        <div class="memory-graph-spin">
          <div ref="graphWrapRef" class="memory-graph-wrap">
            <VueFlow
              id="ekko-memory" :nodes="flowNodes" :edges="flowEdges" :fit-view-on-init="false"
              :default-viewport="{ x: 28, y: 36, zoom: 0.82 }" :min-zoom="0.25" :max-zoom="1.4"
              :nodes-draggable="false" :nodes-connectable="false" :elements-selectable="false"
              :zoom-on-double-click="false" class="memory-flow" @pane-click="clearGraphSelection"
            >
              <template #node-memory-card="{ data: nodeData }">
                <button
                  type="button" class="memory-node"
                  :class="{ 'is-active': nodeData.active, 'is-related': nodeData.related,
                    'is-dimmed': nodeData.dimmed, 'is-inactive': nodeData.memory.status !== 'active' }"
                  :style="{ '--node-color': nodeData.color }"
                  @click.stop="openDetails(nodeData.memory.id)"
                  @mouseenter="hoverId = nodeData.memory.id" @mouseleave="hoverId = ''"
                >
                  <Handle type="target" :position="Position.Left" class="memory-node__handle" />
                  <Handle type="source" :position="Position.Right" class="memory-node__handle" />
                  <span class="memory-node__topline">
                    <span class="memory-node__kind"><i />{{ nodeData.memory.type }}</span>
                    <span class="memory-node__status">{{ nodeData.status }}</span>
                  </span>
                  <strong class="memory-node__title">{{ nodeData.memory.title || nodeData.memory.key }}</strong>
                  <span class="memory-node__content">{{ nodeData.memory.content }}</span>
                  <span class="memory-node__meta">
                    <span>{{ nodeData.scope }}</span><span>r{{ nodeData.memory.revision }}</span>
                    <span>{{ nodeData.degree }} {{ t('ekkoConfig.memoryRelations') }}</span>
                  </span>
                </button>
              </template>
              <Background :gap="24" :size="1.15" color="var(--border-color)" />
              <MiniMap pannable zoomable :node-color="miniMapNodeColor" />
              <Controls :show-interactive="false" />
            </VueFlow>
            <NEmpty v-if="!loading && !memories.length" class="graph-empty" :description="t('ekkoConfig.noMemory')" />
            <div class="memory-hud">
              <span>{{ memories.length }} {{ t('ekkoConfig.memoryNodes') }}</span>
              <span>{{ graphEdges.length }} {{ t('ekkoConfig.memoryRelations') }}</span>
            </div>
          </div>
        </div>
      </section>

      <div v-else class="memory-list-spin">
        <div class="memory-list-scroll">
          <div v-if="memories.length" class="memory-grid">
            <article v-for="memory in memories" :key="memory.id" class="memory-card">
              <div class="memory-card-head">
                <div>
                  <h3>{{ memory.title || memory.key }}</h3>
                  <div class="memory-meta">
                    <NTag size="small" :bordered="false">{{ memory.type }}</NTag>
                    <NTag size="small" :bordered="false">{{ scopeLabel(memory) }}</NTag>
                    <NTag size="small" :bordered="false" :type="statusTagType(memory.status)">{{ statusLabel(memory.status) }}</NTag>
                    <span>r{{ memory.revision }}</span>
                  </div>
                </div>
                <div class="memory-actions">
                  <NButton size="tiny" secondary :disabled="memory.status !== 'active'" @click="openEditor(memory)">{{ t('common.edit') }}</NButton>
                  <NPopconfirm :disabled="memory.status !== 'active'" @positive-click="removeMemory(memory)">
                    <template #trigger><NButton size="tiny" type="error" secondary :disabled="memory.status !== 'active'">{{ t('common.delete') }}</NButton></template>
                    {{ t('ekkoConfig.deleteMemoryConfirm') }}
                  </NPopconfirm>
                </div>
              </div>
              <p class="memory-content">{{ memory.content }}</p>
              <div v-if="memory.tags.length" class="tag-row"><NTag v-for="tag in memory.tags" :key="tag" size="tiny" round>{{ tag }}</NTag></div>
              <div class="memory-foot">{{ formatDate(memory.updatedAt) }}</div>
            </article>
          </div>
          <NEmpty v-else class="empty" :description="t('ekkoConfig.noMemory')" />
        </div>
      </div>
    </main>

    <NDrawer :show="detailDrawerOpen" width="var(--studio-drawer-width)" placement="right" @update:show="handleDrawerShow">
      <NDrawerContent v-if="selectedMemory" class="memory-detail-drawer" :native-scrollbar="false" closable>
        <template #header>
          <div class="drawer-title-row">
            <span>{{ selectedMemory.title || selectedMemory.key }}</span>
            <NTag size="small" :bordered="false" :type="statusTagType(selectedMemory.status)">{{ statusLabel(selectedMemory.status) }}</NTag>
          </div>
        </template>
        <div class="detail-card memory-detail-content">
          <span class="detail-card-label">{{ t('ekkoConfig.contentLabel') }}</span>
          <p>{{ selectedMemory.content }}</p>
        </div>
        <div class="detail-actions">
          <NButton size="small" secondary :disabled="selectedMemory.status !== 'active'" @click="openEditor(selectedMemory)">{{ t('common.edit') }}</NButton>
          <NPopconfirm :disabled="selectedMemory.status !== 'active'" @positive-click="removeMemory(selectedMemory)">
            <template #trigger><NButton size="small" type="error" secondary :disabled="selectedMemory.status !== 'active'">{{ t('common.delete') }}</NButton></template>
            {{ t('ekkoConfig.deleteMemoryConfirm') }}
          </NPopconfirm>
        </div>
        <div class="detail-grid">
          <div class="detail-item"><span>{{ t('ekkoConfig.memoryKey') }}</span><code>{{ selectedMemory.key }}</code></div>
          <div class="detail-item"><span>{{ t('ekkoConfig.memoryCategory') }}</span><strong>{{ categoryLabel(selectedMemory) }}</strong></div>
          <div class="detail-item"><span>{{ t('ekkoConfig.memoryScope') }}</span><strong>{{ scopeLabel(selectedMemory) }}</strong></div>
          <div class="detail-item"><span>{{ t('ekkoConfig.memoryRevision') }}</span><strong>r{{ selectedMemory.revision }}</strong></div>
          <div class="detail-item"><span>{{ t('ekkoConfig.memoryConfidence') }}</span><strong>{{ selectedMemory.confidence }}</strong></div>
          <div class="detail-item"><span>{{ t('ekkoConfig.memoryImportance') }}</span><strong>{{ selectedMemory.importance }}</strong></div>
          <div class="detail-item detail-item--wide"><span>{{ t('ekkoConfig.memoryUpdatedAt') }}</span><strong>{{ formatDate(selectedMemory.updatedAt) }}</strong></div>
        </div>
        <div v-if="selectedMemory.tags.length" class="drawer-section">
          <span class="detail-card-label">{{ t('ekkoConfig.tagsLabel') }}</span>
          <div class="tag-row"><NTag v-for="tag in selectedMemory.tags" :key="tag" size="small" round>{{ tag }}</NTag></div>
        </div>
        <div v-if="selectedMemory.entities.length" class="drawer-section">
          <span class="detail-card-label">{{ t('ekkoConfig.memoryEntities') }}</span>
          <div class="tag-row"><NTag v-for="entity in selectedMemory.entities" :key="entity" size="small" round>{{ entity }}</NTag></div>
        </div>
        <div class="drawer-section">
          <span class="detail-card-label">{{ t('ekkoConfig.relatedMemories') }}</span>
          <div v-if="selectedRelations.length" class="related-memory-list">
            <button v-for="relation in selectedRelations" :key="relation.edge.id" type="button" class="related-memory-link" @click="openDetails(relation.memory.id)">
              <span>{{ relation.memory.title || relation.memory.key }}</span><small>{{ relationshipLabel(relation.edge) }}</small>
            </button>
          </div>
          <p v-else class="no-relations">{{ t('ekkoConfig.noRelations') }}</p>
        </div>
      </NDrawerContent>
    </NDrawer>

    <NModal :show="!!editing" preset="card" :title="t('ekkoConfig.editMemory')" :style="{ width: 'min(680px, calc(100vw - 32px))' }" @update:show="(show) => { if (!show) editing = null }">
      <div class="editor-form">
        <label>{{ t('ekkoConfig.titleLabel') }}</label><NInput v-model:value="draftTitle" />
        <label>{{ t('ekkoConfig.contentLabel') }}</label><NInput v-model:value="draftContent" type="textarea" :autosize="{ minRows: 6, maxRows: 16 }" />
        <label>{{ t('ekkoConfig.tagsLabel') }}</label><NInput v-model:value="draftTags" :placeholder="t('ekkoConfig.tagsPlaceholder')" />
        <div class="modal-actions"><NButton @click="editing = null">{{ t('common.cancel') }}</NButton><NButton type="primary" :loading="saving" @click="saveMemory">{{ t('common.save') }}</NButton></div>
      </div>
    </NModal>
  </PageLoading>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;

.ekko-page { height: 100%; min-height: 0; display: flex; flex-direction: column; overflow: hidden; }
.toolbar { display: flex; align-items: center; gap: 12px; flex: 0 0 auto; margin: 16px 20px 14px; > .n-input { max-width: 520px; } }
.status-select { width: 180px; flex: 0 0 auto; }
.view-switch { display: flex; gap: 6px; margin-inline-start: auto; }
.memory-workspace { flex: 1; min-height: 0; padding: 0 20px 20px; overflow: hidden; }
.memory-graph-panel { height: 100%; min-height: 0; display: flex; flex-direction: column; }

.relationship-legend { min-height: 30px; display: flex; align-items: center; gap: 8px 16px; flex-wrap: wrap; padding: 0 2px 10px; color: $text-secondary; font-size: 11px; }
.relationship-legend__hint { margin-inline-end: auto; color: $text-muted; }
.relationship-legend__item { display: inline-flex; align-items: center; gap: 6px; white-space: nowrap; }
.relationship-legend__item i { width: 22px; height: 2px; display: inline-block; background: currentcolor; }
.relationship-legend__item--revision { color: #f59e42; }
.relationship-legend__item--source { color: #4f8cff; }
.relationship-legend__item--source i { background: repeating-linear-gradient(90deg, currentcolor 0 6px, transparent 6px 10px); }
.relationship-legend__item--entity { color: #9b6cff; }
.relationship-legend__item--entity i { background: repeating-linear-gradient(90deg, currentcolor 0 2px, transparent 2px 6px); }

.memory-graph-spin { flex: 1; height: auto; min-height: 0; }
.memory-list-spin { height: 100%; min-height: 0; }
.memory-graph-wrap { position: relative; width: 100%; height: 100%; min-height: 0; overflow: hidden; border: 1px solid color-mix(in srgb, $border-color 72%, transparent); border-radius: $radius-md; background: radial-gradient(circle at 50% 42%, rgba(var(--accent-info-rgb), 0.07), transparent 50%), $bg-primary; }
.memory-flow { width: 100%; height: 100%;
  :deep(.vue-flow__pane) { cursor: grab; }
  :deep(.vue-flow__pane.dragging) { cursor: grabbing; }
  :deep(.vue-flow__node) { border: 0; background: transparent; }
  :deep(.vue-flow__edge-path) { transition: stroke 0.16s ease, stroke-width 0.16s ease, opacity 0.16s ease; }
  :deep(.vue-flow__controls) { overflow: hidden; border: 1px solid color-mix(in srgb, $border-color 78%, transparent); border-radius: $radius-sm; box-shadow: 0 8px 24px rgba(0, 0, 0, 0.12); }
  :deep(.vue-flow__controls-button) { border-color: color-mix(in srgb, $border-color 68%, transparent); background: color-mix(in srgb, $bg-primary 94%, transparent); color: $text-primary; }
  :deep(.vue-flow__minimap) { width: 138px; height: 92px; overflow: hidden; border: 1px solid color-mix(in srgb, $border-color 72%, transparent); border-radius: $radius-sm; background: color-mix(in srgb, $bg-primary 90%, transparent); box-shadow: 0 8px 24px rgba(0, 0, 0, 0.12); }
}
.memory-node { position: relative; width: 270px; min-height: 116px; display: grid; gap: 6px; padding: 11px 13px; overflow: hidden; border: 1px solid color-mix(in srgb, var(--node-color) 35%, $border-color); border-radius: $radius-sm; background: color-mix(in srgb, $bg-primary 96%, var(--node-color) 4%); box-shadow: 0 7px 20px rgba(0, 0, 0, 0.08); color: $text-primary; font: inherit; text-align: start; cursor: pointer; transition: border-color 0.16s ease, box-shadow 0.16s ease, opacity 0.16s ease, transform 0.16s ease;
  &:hover, &:focus-visible, &.is-active { border-color: var(--node-color); box-shadow: 0 0 0 2px color-mix(in srgb, var(--node-color) 18%, transparent), 0 11px 28px rgba(0, 0, 0, 0.14); transform: translateY(-1px); }
  &:focus-visible { outline: 2px solid $text-primary; outline-offset: 2px; }
  &.is-related { border-color: color-mix(in srgb, var(--node-color) 72%, $border-color); }
  &.is-dimmed { opacity: 0.25; }
  &.is-inactive { filter: saturate(0.55); }
}
.memory-node__handle { width: 7px; height: 7px; border: 2px solid $bg-primary; background: var(--node-color); opacity: 0.75; pointer-events: none; }
.memory-node__topline, .memory-node__meta { min-width: 0; display: flex; align-items: center; }
.memory-node__topline { justify-content: space-between; gap: 8px; color: $text-muted; font-size: 10px; font-weight: 650; letter-spacing: 0.035em; text-transform: uppercase; }
.memory-node__kind { min-width: 0; display: inline-flex; align-items: center; gap: 6px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.memory-node__kind i { width: 7px; height: 7px; flex: 0 0 auto; border-radius: 2px; background: var(--node-color); transform: rotate(45deg); }
.memory-node__status { flex: 0 0 auto; }
.memory-node__title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 13px; font-weight: 650; }
.memory-node__content { display: -webkit-box; overflow: hidden; color: $text-secondary; font-size: 11px; line-height: 1.42; -webkit-box-orient: vertical; -webkit-line-clamp: 2; }
.memory-node__meta { gap: 5px 10px; flex-wrap: wrap; color: $text-muted; font-size: 10px; }
.memory-node__meta span:first-child { max-width: 145px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.graph-empty { position: absolute; inset: 0; display: grid; place-content: center; pointer-events: none; }
.memory-hud { position: absolute; top: 12px; right: 12px; display: flex; gap: 8px; padding: 6px 9px; border: 1px solid color-mix(in srgb, $border-color 70%, transparent); border-radius: 999px; background: color-mix(in srgb, $bg-primary 90%, transparent); color: $text-muted; font-size: 10px; backdrop-filter: blur(8px); pointer-events: none; }

.memory-list-scroll { height: 100%; overflow-y: auto; padding: 2px 2px 24px; }
.memory-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(320px, 1fr)); gap: 14px; }
.memory-card { padding: 18px; border: 1px solid $border-color; border-radius: 12px; background: $bg-card; }
.memory-card-head { display: flex; justify-content: space-between; gap: 12px; h3 { margin: 0 0 8px; font-size: 15px; } }
.memory-meta, .tag-row { display: flex; align-items: center; flex-wrap: wrap; gap: 6px; color: $text-muted; font-size: 12px; }
.memory-actions { display: flex; gap: 6px; flex-shrink: 0; }
.memory-content { margin: 14px 0; color: $text-secondary; line-height: 1.55; white-space: pre-wrap; overflow-wrap: anywhere; }
.memory-foot { margin-top: 12px; color: $text-muted; font-size: 11px; }
.empty { padding: 80px 0; }

.drawer-title-row { min-width: 0; display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.drawer-title-row > span:first-child { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.detail-card { padding: 14px; border: 1px solid $border-color; border-radius: $radius-sm; background: $bg-secondary; }
.detail-card-label { display: block; margin-bottom: 8px; color: $text-muted; font-size: 11px; font-weight: 650; letter-spacing: 0.04em; text-transform: uppercase; }
.memory-detail-content p { margin: 0; color: $text-secondary; line-height: 1.65; white-space: pre-wrap; overflow-wrap: anywhere; }
.detail-actions { display: flex; justify-content: flex-end; gap: 8px; margin: 14px 0; }
.detail-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
.detail-item { min-width: 0; display: grid; gap: 5px; padding: 11px; border: 1px solid color-mix(in srgb, $border-color 75%, transparent); border-radius: $radius-sm; }
.detail-item > span { color: $text-muted; font-size: 10px; text-transform: uppercase; }
.detail-item strong, .detail-item code { min-width: 0; overflow-wrap: anywhere; color: $text-secondary; font-size: 12px; }
.detail-item--wide { grid-column: 1 / -1; }
.drawer-section { margin-top: 20px; }
.related-memory-list { display: grid; gap: 7px; }
.related-memory-link { width: 100%; display: grid; gap: 4px; padding: 10px 11px; border: 1px solid $border-color; border-radius: $radius-sm; background: $bg-secondary; color: $text-primary; font: inherit; text-align: start; cursor: pointer; }
.related-memory-link:hover { border-color: $accent-primary; }
.related-memory-link span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; font-weight: 600; }
.related-memory-link small, .no-relations { color: $text-muted; font-size: 11px; }
.no-relations { margin: 0; }
.editor-form { display: grid; gap: 10px; label { margin-top: 4px; color: $text-secondary; font-size: 13px; } }
.modal-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 12px; }

@media (max-width: $breakpoint-mobile) {
  .toolbar { align-items: stretch; flex-direction: column; margin: 14px 12px; }
  .memory-workspace { padding: 0 12px 12px; }
  .toolbar > .n-input, .status-select { width: 100%; max-width: none; }
  .view-switch { margin-inline-start: 0; }
  .view-switch .n-button { flex: 1; }
  .relationship-legend__hint { width: 100%; }
  .memory-hud { display: none; }
  .memory-grid { grid-template-columns: 1fr; }
  .memory-card-head { flex-direction: column; }
  .detail-grid { grid-template-columns: 1fr; }
  .detail-item--wide { grid-column: auto; }
}
</style>
