<script setup lang="ts">
/**
 * Tasks mode — the default first screen for task-driven users.
 *
 * Answers the three questions a task-mode user has, in reading order:
 *   1. progress hero  — done / todo / running / errored (knowledge-owned
 *      index queue only; deliberately NOT coupled to kanban data).
 *   2. archived files — what is in the knowledge base, click to filter
 *      or open the detail drawer.
 *   3. citation audit — expand a row to lazy-load which searches (UI or
 *      agent tool) actually cited that document.
 *
 * Performance: references load per-row on expand (one request each,
 * cached for the session) — never N requests on mount.
 */
import { computed, h, reactive, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import {
  NAlert,
  NButton,
  NDataTable,
  NSpin,
  NTag,
  type DataTableColumns,
  type DataTableRowKey,
} from 'naive-ui'
import type { KnowledgeDocument, KnowledgeHealth, KnowledgeReference } from '../../api'
import * as api from '../../api'
import { statusTagType } from '../../utils/status'
import { formatBytes, formatTimestamp, basename } from '../../utils/format'

const props = defineProps<{
  documents: readonly KnowledgeDocument[]
  health: KnowledgeHealth | null
  loading: boolean
}>()

const emit = defineEmits<{
  (e: 'select-document', doc: KnowledgeDocument): void
  (e: 'delete-document', id: number): void
  (e: 'go-explorer'): void
}>()

const { t } = useI18n()

// --- Progress hero (knowledge-owned index queue) --------------------------

type ProgressKey = 'done' | 'todo' | 'running' | 'errored'

const progress = computed<Record<ProgressKey, number>>(() => {
  const acc: Record<ProgressKey, number> = { done: 0, todo: 0, running: 0, errored: 0 }
  for (const doc of props.documents) {
    if (doc.status === 'indexed' || doc.status === 'metadata_only') acc.done++
    else if (doc.status === 'pending') acc.todo++
    else if (doc.status === 'indexing') acc.running++
    else if (doc.status === 'failed') acc.errored++
  }
  return acc
})

const statusFilter = ref<ProgressKey | null>(null)

const FILTER_BY_PROGRESS: Record<ProgressKey, string[]> = {
  done: ['indexed', 'metadata_only'],
  todo: ['pending'],
  running: ['indexing'],
  errored: ['failed'],
}

const visibleDocuments = computed(() => {
  if (!statusFilter.value) return [...props.documents]
  const allowed = FILTER_BY_PROGRESS[statusFilter.value]
  return props.documents.filter(d => allowed.includes(d.status))
})

function toggleProgressFilter(key: ProgressKey): void {
  statusFilter.value = statusFilter.value === key ? null : key
}

// --- Citation audit (lazy, per-row) ----------------------------------------

interface RefState {
  loading: boolean
  failed: boolean
  refs: KnowledgeReference[]
}

const refsByDoc = reactive(new Map<number, RefState>())
const expandedRowKeys = ref<DataTableRowKey[]>([])

function onExpandedChange(keys: DataTableRowKey[]): void {
  for (const key of keys) {
    const docId = Number(key)
    if (Number.isInteger(docId) && !refsByDoc.has(docId)) void loadReferences(docId)
  }
  expandedRowKeys.value = keys
}

async function loadReferences(documentId: number): Promise<void> {
  refsByDoc.set(documentId, { loading: true, failed: false, refs: [] })
  try {
    const { references } = await api.fetchDocumentReferences(documentId, 100)
    refsByDoc.set(documentId, { loading: false, failed: false, refs: references })
  } catch (err) {
    console.warn(`[knowledge] failed to load references for document ${documentId}`, err)
    refsByDoc.set(documentId, { loading: false, failed: true, refs: [] })
  }
}

function renderReferencesPanel(row: KnowledgeDocument) {
  const state = refsByDoc.get(row.id)
  if (!state || state.loading) {
    return h(NSpin, { size: 'small', show: true, style: 'padding: 12px' })
  }
  if (state.failed) {
    return h('div', { class: 'knowledge-refs-empty knowledge-refs-failed' }, t('knowledge.tasks.references.loadFailed'))
  }
  if (state.refs.length === 0) {
    return h('div', { class: 'knowledge-refs-empty' }, t('knowledge.tasks.references.empty'))
  }
  return h(
    'div',
    { class: 'knowledge-refs-panel' },
    state.refs.slice(0, 20).map(r =>
      h('div', { class: 'knowledge-refs-row', key: r.id }, [
        h('span', { class: 'knowledge-refs-time' }, new Date(r.created_at).toLocaleString()),
        h(
          NTag,
          { size: 'small', bordered: false, type: r.source === 'agent-tool' ? 'info' : 'default' },
          () => t(r.source === 'agent-tool' ? 'knowledge.tasks.references.sourceAgent' : 'knowledge.tasks.references.sourceChat'),
        ),
        h('span', { class: 'knowledge-refs-rank' }, `#${r.rank + 1}`),
        r.distance != null ? h('span', { class: 'knowledge-refs-dist' }, `d=${r.distance.toFixed(3)}`) : null,
        r.session_id ? h('span', { class: 'knowledge-refs-session' }, r.session_id) : null,
      ]),
    ),
  )
}

// --- Table ------------------------------------------------------------------

const columns = computed<DataTableColumns<KnowledgeDocument>>(() => [
  {
    type: 'expand',
    expandable: () => true,
    renderExpand: row => renderReferencesPanel(row),
  },
  {
    title: t('knowledge.documents.name'),
    key: 'name',
    render(row) {
      return h(
        'a',
        {
          href: '#',
          class: 'document-link',
          onClick: (e: MouseEvent) => {
            e.preventDefault()
            emit('select-document', row)
          },
        },
        basename(row.source_path),
      )
    },
  },
  {
    title: t('knowledge.documents.status'),
    key: 'status',
    width: 110,
    render(row) {
      return h(NTag, { type: statusTagType(row.status), size: 'small' }, () =>
        t(`knowledge.documents.${row.status}`),
      )
    },
  },
  {
    title: t('knowledge.documents.size'),
    key: 'size_bytes',
    width: 90,
    render(row) {
      return formatBytes(row.size_bytes)
    },
  },
  {
    title: t('knowledge.documents.indexedAt'),
    key: 'indexed_at',
    width: 160,
    render(row) {
      if (row.status !== 'indexed' || !row.indexed_at) return '—'
      return formatTimestamp(row.indexed_at)
    },
  },
  {
    title: '',
    key: 'actions',
    width: 70,
    render(row) {
      return h(
        NButton,
        {
          size: 'tiny',
          type: 'error',
          quaternary: true,
          onClick: () => emit('delete-document', row.id),
        },
        () => t('knowledge.actions.delete'),
      )
    },
  },
])

const PROGRESS_META: Array<{ key: ProgressKey; tone: string }> = [
  { key: 'done', tone: 'good' },
  { key: 'todo', tone: 'neutral' },
  { key: 'running', tone: 'busy' },
  { key: 'errored', tone: 'bad' },
]

const lastIngestError = computed(() => props.health?.ingestion?.lastError ?? null)
</script>

<template>
  <div class="tasks-mode">
    <!-- Action 3: progress at a glance -->
    <section class="progress-hero" :aria-label="t('knowledge.tasks.heroTitle')">
      <button
        v-for="m in PROGRESS_META"
        :key="m.key"
        type="button"
        class="progress-card"
        :class="[m.tone, { active: statusFilter === m.key }]"
        @click="toggleProgressFilter(m.key)"
      >
        <span class="progress-number">{{ progress[m.key] }}</span>
        <span class="progress-label">{{ t(`knowledge.tasks.progress.${m.key}`) }}</span>
      </button>
    </section>

    <NAlert v-if="lastIngestError" type="error" size="small" class="ingest-error" :title="t('knowledge.health.lastFailure')">
      {{ lastIngestError }}
    </NAlert>

    <!-- Actions 1 & 2: archived files + citation audit -->
    <section class="files-section">
      <div class="files-header">
        <h3 class="files-title">{{ t('knowledge.tasks.filesTitle') }}</h3>
        <NButton v-if="statusFilter" size="tiny" quaternary @click="statusFilter = null">
          {{ t('knowledge.documents.all') }}
        </NButton>
      </div>

      <NAlert v-if="documents.length === 0 && !loading" type="info" class="empty-alert">
        <template #header>{{ t('knowledge.documents.noDocuments') }}</template>
        <NButton size="small" type="primary" secondary @click="emit('go-explorer')">
          {{ t('knowledge.tasks.goExplorer') }}
        </NButton>
      </NAlert>

      <NDataTable
        v-else
        :columns="columns"
        :data="visibleDocuments"
        :loading="loading"
        :bordered="false"
        size="small"
        :pagination="{ pageSize: 20 }"
        :row-key="(row: KnowledgeDocument) => row.id"
        :expanded-row-keys="expandedRowKeys"
        @update:expanded-row-keys="onExpandedChange"
      />
    </section>
  </div>
</template>

<style scoped>
.tasks-mode {
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.progress-hero {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 10px;
}
.progress-card {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  padding: 14px 8px;
  border: 1px solid var(--border-color, rgba(var(--text-primary-rgb), 0.08));
  border-radius: 10px;
  background: var(--card-color, rgba(var(--text-primary-rgb), 0.02));
  color: inherit;
  cursor: pointer;
  transition: border-color 0.15s ease, background 0.15s ease;
}
.progress-card:hover { background: var(--hover-color, rgba(var(--text-primary-rgb), 0.05)); }
.progress-card.active { border-color: var(--primary-color, var(--success)); }
.progress-number {
  font-size: 26px;
  font-weight: 700;
  line-height: 1.1;
  font-variant-numeric: tabular-nums;
}
.progress-label {
  font-size: 12px;
  opacity: 0.65;
}
.progress-card.good .progress-number { color: var(--success); }
.progress-card.busy .progress-number { color: var(--warning); }
.progress-card.bad .progress-number { color: var(--warning); }
.ingest-error { margin: 0; }
.files-section {
  border: 1px solid var(--border-color, rgba(var(--text-primary-rgb), 0.06));
  border-radius: 10px;
  background: var(--card-color, rgba(var(--text-primary-rgb), 0.02));
  padding: 12px 14px;
}
.files-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 8px;
}
.files-title {
  margin: 0;
  font-size: 14px;
  font-weight: 600;
}
.empty-alert { margin: 4px 0; }
.document-link {
  color: var(--primary-color, var(--accent-info));
  text-decoration: none;
}
.document-link:hover { text-decoration: underline; }
</style>

<style>
/* renderExpand output is rendered outside the scoped tree. */
.knowledge-refs-panel {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 8px 12px;
}
.knowledge-refs-row {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 12px;
  opacity: 0.85;
}
.knowledge-refs-time { font-variant-numeric: tabular-nums; }
.knowledge-refs-rank,
.knowledge-refs-dist,
.knowledge-refs-session {
  opacity: 0.6;
  font-size: 11px;
}
.knowledge-refs-empty {
  padding: 10px 12px;
  font-size: 12px;
  opacity: 0.55;
}
.knowledge-refs-failed { color: var(--warning); opacity: 0.9; }
</style>
