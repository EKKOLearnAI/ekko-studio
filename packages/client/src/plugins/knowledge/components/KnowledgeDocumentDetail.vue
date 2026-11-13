<script setup lang="ts">
import { computed, onBeforeUnmount, ref, shallowRef, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import {
  NButton,
  NCard,
  NDescriptions,
  NDescriptionsItem,
  NDrawer,
  NDrawerContent,
  NEmpty,
  NScrollbar,
  NSpace,
  NSpin,
  NTag,
} from 'naive-ui'
import type { KnowledgeDocument } from '../api'
import * as api from '../api'
import type { KnowledgeChunk } from '../api'
import { statusTagType, mimeTypeLabel } from '../utils/status'
import { formatBytes, formatTimestamp, basename } from '../utils/format'
import { useMessage } from '@/composables/useAppMessage'
import MarkdownRenderer from '@/components/hermes/chat/MarkdownRenderer.vue'

const { t } = useI18n()
const message = useMessage()

const props = defineProps<{
  show: boolean
  document: KnowledgeDocument | null
}>()

const emit = defineEmits<{
  (e: 'update:show', value: boolean): void
  (e: 'delete', id: number): void
  (e: 'indexed', id: number): void
}>()

const chunks = shallowRef<KnowledgeChunk[]>([])
const chunksLoading = ref(false)
const indexing = ref(false)
let generation = 0
let disposed = false

watch(
  () => props.document?.id,
  async (id) => {
    chunks.value = []
    if (!id) return
    const gen = ++generation
    chunksLoading.value = true
    try {
      const res = await api.fetchDocumentChunks(id)
      if (!disposed && gen === generation) {
        chunks.value = res.chunks
      }
    } catch {
      // ignore — chunks are best-effort
    } finally {
      if (!disposed && gen === generation) {
        chunksLoading.value = false
      }
    }
  },
  { immediate: true },
)

onBeforeUnmount(() => {
  disposed = true
})

const vaultName = computed(() => {
  if (!props.document) return '—'
  // vault info would come from the parent; fallback to id
  return `Vault #${props.document.vault_id}`
})

function close(): void {
  emit('update:show', false)
}

function onDelete(): void {
  if (!props.document) return
  emit('delete', props.document.id)
  close()
}

async function requestIndex(): Promise<void> {
  // `indexing` also guards double-clicks — NButton's :loading shows a
  // spinner but does not swallow click events.
  if (!props.document || indexing.value) return
  indexing.value = true
  try {
    await api.indexDocument(props.document.id)
    message.success(t('knowledge.detail.indexQueued'))
    emit('indexed', props.document.id)
  } catch {
    message.error(t('knowledge.detail.indexFailed'))
  } finally {
    indexing.value = false
  }
}
</script>

<template>
  <NDrawer
    :show="props.show"
    :width="560"
    placement="right"
    @update:show="(v: boolean) => emit('update:show', v)"
  >
    <NDrawerContent :title="props.document ? basename(props.document.source_path) : ''">
      <template #header>
        <NSpace align="center" :wrap="false">
          <span class="drawer-title">
            {{ props.document ? basename(props.document.source_path) : t('knowledge.detail.title') }}
          </span>
          <NTag v-if="props.document" :type="statusTagType(props.document.status)" size="small">
            {{ t(`knowledge.documents.${props.document.status}`) }}
          </NTag>
        </NSpace>
      </template>

      <NEmpty v-if="!props.document" :description="t('knowledge.detail.noDocument')" />

      <div v-else class="document-detail">
        <div v-if="props.document.status === 'metadata_only'" class="metadata-only-box">
          <p class="metadata-only-hint">{{ t('knowledge.detail.metadataOnlyHint') }}</p>
          <NButton type="primary" size="small" :loading="indexing" @click="requestIndex">
            {{ t('knowledge.detail.index') }}
          </NButton>
        </div>

        <NCard :title="t('knowledge.detail.metadata')" size="small">
          <NDescriptions :column="1" bordered size="small">
            <NDescriptionsItem :label="t('knowledge.detail.path')">
              <code class="path-code">{{ props.document.source_path }}</code>
            </NDescriptionsItem>
            <NDescriptionsItem :label="t('knowledge.detail.vault')">
              {{ vaultName }}
            </NDescriptionsItem>
            <NDescriptionsItem :label="t('knowledge.detail.mime')">
              {{ mimeTypeLabel(props.document.mime_type) }}
            </NDescriptionsItem>
            <NDescriptionsItem :label="t('knowledge.detail.size')">
              {{ formatBytes(props.document.size_bytes) }}
            </NDescriptionsItem>
            <NDescriptionsItem :label="t('knowledge.detail.indexed')">
              {{ formatTimestamp(props.document.indexed_at) }}
            </NDescriptionsItem>
            <NDescriptionsItem v-if="props.document.error" :label="t('knowledge.detail.error')">
              <span class="error-text">{{ props.document.error }}</span>
            </NDescriptionsItem>
          </NDescriptions>
        </NCard>

        <NCard :title="t('knowledge.detail.content')" size="small" class="content-card">
          <NSpin :show="chunksLoading">
            <NScrollbar style="max-height: 360px">
              <template v-if="chunks.length">
                <article
                  v-for="chunk in chunks"
                  :key="chunk.id"
                  class="chunk-block"
                >
                  <div class="chunk-meta">
                    <NTag size="tiny">#{{ chunk.position }}</NTag>
                    <span class="chunk-tokens">{{ chunk.token_count }} tokens</span>
                  </div>
                  <MarkdownRenderer :content="chunk.content" />
                </article>
              </template>
              <NEmpty
                v-else-if="!chunksLoading"
                size="small"
                :description="t('knowledge.detail.noChunks')"
              />
            </NScrollbar>
          </NSpin>
        </NCard>
      </div>

      <template #footer>
        <NSpace justify="space-between">
          <NButton @click="close">{{ t('knowledge.detail.close') }}</NButton>
          <NButton
            v-if="props.document"
            type="error"
            quaternary
            @click="onDelete"
          >
            {{ t('knowledge.actions.delete') }}
          </NButton>
        </NSpace>
      </template>
    </NDrawerContent>
  </NDrawer>
</template>

<style scoped>
.document-detail {
  display: flex;
  flex-direction: column;
  gap: 16px;
}
.metadata-only-box {
  border: 1px solid var(--border-color, rgba(var(--text-primary-rgb), 0.08));
  border-radius: 8px;
  padding: 12px 14px;
  display: flex;
  flex-direction: column;
  gap: 10px;
  background: var(--card-color, rgba(var(--text-primary-rgb), 0.02));
}
.metadata-only-hint {
  margin: 0;
  font-size: 13px;
  line-height: 1.5;
  opacity: 0.75;
}
.content-card {
  margin: 0;
}
.path-code {
  font-family: var(--font-family-mono, monospace);
  font-size: 12px;
  word-break: break-all;
}
.error-text {
  color: var(--error-color, var(--error));
  font-family: var(--font-family-mono, monospace);
  font-size: 12px;
}
.chunk-block {
  margin-bottom: 16px;
  padding-bottom: 16px;
  border-bottom: 1px solid var(--border-color, rgba(var(--text-primary-rgb), 0.06));
}
.chunk-block:last-child {
  border-bottom: none;
}
.chunk-meta {
  display: flex;
  gap: 8px;
  align-items: center;
  margin-bottom: 8px;
}
.chunk-tokens {
  font-size: 11px;
  opacity: 0.5;
}
.drawer-title {
  font-weight: 600;
}
</style>