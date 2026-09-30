<script setup lang="ts">
import { NSpin, NButton, NTag, useMessage } from 'naive-ui'
import { computed, defineAsyncComponent, onMounted, ref } from 'vue'

import { useI18n } from 'vue-i18n'
import {
  approvePendingWrite,
  fetchPendingWriteReview,
  fetchPendingWrites,
  rejectPendingWrite,
  type PendingWriteReview,
  type PendingWriteRecord,
} from '@/api/hermes/write-gate'

const MarkdownRenderer = defineAsyncComponent(async () => (await import('@/components/hermes/chat/MarkdownRenderer.vue')).default)

const emit = defineEmits<{
  (e: 'count-change', count: number): void
}>()

const { t } = useI18n()
const message = useMessage()
const pendingWrites = ref<PendingWriteRecord[]>([])
const pendingLoading = ref(false)
const pendingActions = ref<Set<string>>(new Set())
const resolvingWrite = ref(false)
const expandedReviews = ref<Record<string, string>>({})
const writeGateSupported = ref(true)
const pendingCount = computed(() => pendingWrites.value.length)

function pendingKey(record: PendingWriteRecord): string {
  return `${record.subsystem}:${record.id}`
}

function codeFence(language: string, content: string): string {
  const ticks = '```'
  let text = content || ''
  text = text.replaceAll(ticks, '``\u200b`')
  if (text && !text.endsWith('\n')) text += '\n'
  return `${ticks}${language || ''}\n${text}${ticks}`
}

function noteMarkdown(review: PendingWriteReview): string[] {
  const notes: string[] = []
  for (const note of review.notes || []) {
    if (note.type === 'patchOldStringMissing') {
      notes.push(t('skills.writeApprovalPatchOldStringMissing', { file: note.targetLabel || review.targetLabel }))
    } else if (note.type === 'currentReadFailed') {
      notes.push(t('skills.writeApprovalCurrentReadFailed', { file: note.targetLabel || review.targetLabel }))
    } else if (note.type === 'deleteSkill') {
      notes.push(t('skills.writeApprovalDeleteSkill', { skill: note.skillName || '-' }))
    } else if (note.type === 'removeFile') {
      notes.push(t('skills.writeApprovalRemoveFile', {
        file: note.targetLabel || review.targetLabel,
        skill: note.skillName || '-',
      }))
    }
  }
  if (review.requestedOldString) {
    notes.push([
      t('skills.writeApprovalRequestedOldString'),
      codeFence(review.language || 'text', review.requestedOldString),
    ].join('\n\n'))
  }
  return notes
}

function buildReviewMarkdown(review: PendingWriteReview): string {
  if (review.subsystem === 'memory') {
    return [
      `### ${t('skills.writeApprovalPendingMemoryWrite')}`,
      codeFence('json', review.payloadText || review.proposed || review.diff),
    ].join('\n\n')
  }

  const file = review.targetLabel || 'SKILL.md'
  const diff = review.diff || t('skills.writeApprovalNoDiff')
  return [
    ...noteMarkdown(review),
    `### ${t('skills.writeApprovalCurrentFile', { file })}`,
    codeFence(review.language || 'text', review.current),
    `### ${t('skills.writeApprovalProposedFile', { file })}`,
    codeFence(review.language || 'text', review.proposed),
    `### ${t('skills.writeApprovalDiffSection')}`,
    codeFence('diff', diff),
  ].filter(Boolean).join('\n\n')
}

function formatPendingTime(value: number | null): string {
  if (!value) return ''
  return new Date(value * 1000).toLocaleString([], {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

async function loadPendingWrites() {
  pendingLoading.value = true
  try {
    const data = await fetchPendingWrites()
    writeGateSupported.value = data.supported !== false
    pendingWrites.value = writeGateSupported.value ? data.records || [] : []
    emit('count-change', pendingWrites.value.length)
  } catch (err: any) {
    message.error(t('skills.writeApprovalLoadFailed'))
  } finally {
    pendingLoading.value = false
  }
}

async function toggleDiff(record: PendingWriteRecord) {
  const key = pendingKey(record)
  if (expandedReviews.value[key]) {
    const next = { ...expandedReviews.value }
    delete next[key]
    expandedReviews.value = next
    return
  }
  const actionKey = `${key}:diff`
  if (pendingActions.value.has(actionKey)) return
  pendingActions.value.add(actionKey)
  try {
    const review = await fetchPendingWriteReview(record.subsystem, record.id)
    expandedReviews.value = { ...expandedReviews.value, [key]: buildReviewMarkdown(review) }
  } catch (err: any) {
    message.error(t('skills.writeApprovalDiffFailed'))
  } finally {
    pendingActions.value.delete(actionKey)
  }
}

async function resolvePendingWrite(record: PendingWriteRecord, decision: 'approve' | 'reject') {
  if (resolvingWrite.value) return
  resolvingWrite.value = true
  const key = pendingKey(record)
  const actionKey = `${key}:${decision}`
  pendingActions.value.add(actionKey)
  try {
    const result = decision === 'approve'
      ? await approvePendingWrite(record.subsystem, record.id)
      : await rejectPendingWrite(record.subsystem, record.id)
    if (!result.success) {
      const failureMessage = t('skills.writeApprovalActionFailed')
      message.error(result.output ? `${failureMessage}: ${result.output}` : failureMessage)
    } else {
      message.success(decision === 'approve'
        ? t('skills.writeApprovalApproved')
        : t('skills.writeApprovalRejected'))
      // Optimistic removal before re-fetch
      pendingWrites.value = pendingWrites.value.filter(r => pendingKey(r) !== key)
      emit('count-change', pendingWrites.value.length)
      const nextReviews = { ...expandedReviews.value }
      delete nextReviews[key]
      expandedReviews.value = nextReviews
    }
    await loadPendingWrites()
  } catch (err: any) {
    message.error(t('skills.writeApprovalActionFailed'))
  } finally {
    pendingActions.value.delete(actionKey)
    resolvingWrite.value = false
  }
}

onMounted(() => {
  void loadPendingWrites()
})
</script>

<template>
  <section class="write-approval-panel">
    <div class="write-approval-header">
      <div>
        <h3>{{ t('skills.writeApprovalTitle') }}</h3>
        <p>{{ t('skills.writeApprovalDescription') }}</p>
      </div>
      <NButton size="small" quaternary :loading="pendingLoading" :disabled="resolvingWrite" @click="loadPendingWrites">
        {{ t('skills.writeApprovalRefresh') }}
      </NButton>
    </div>
    <div v-if="!writeGateSupported" class="write-approval-state">
      {{ t('skills.writeApprovalUnsupported') }}
    </div>
    <div v-else-if="pendingLoading && pendingCount === 0" class="write-approval-state">
      <NSpin :description="t('common.loading')" />
    </div>
    <div v-else-if="pendingCount === 0" class="write-approval-state">
      {{ t('skills.writeApprovalEmpty') }}
    </div>
    <div v-else class="write-approval-list">
      <div v-for="record in pendingWrites" :key="pendingKey(record)" class="write-approval-item">
        <div class="write-approval-main">
          <div class="write-approval-meta">
            <NTag size="small" :type="record.subsystem === 'memory' ? 'info' : 'warning'">
              {{ record.subsystem === 'memory' ? t('skills.writeApprovalMemory') : t('skills.writeApprovalSkills') }}
            </NTag>
            <span>{{ record.action || '-' }}</span>
            <span>{{ record.origin }}</span>
            <span v-if="record.created_at">{{ formatPendingTime(record.created_at) }}</span>
          </div>
          <div class="write-approval-summary">{{ record.summary || record.id }}</div>
        </div>
        <div class="write-approval-actions">
          <NButton
            size="tiny"
            quaternary
            :loading="pendingActions.has(`${pendingKey(record)}:diff`)"
            :disabled="resolvingWrite"
            @click="toggleDiff(record)"
          >
            {{ expandedReviews[pendingKey(record)] ? t('skills.writeApprovalHideDiff') : t('skills.writeApprovalViewDiff') }}
          </NButton>
          <NButton
            size="tiny"
            type="success"
            :loading="pendingActions.has(`${pendingKey(record)}:approve`)"
            :disabled="resolvingWrite"
            @click="resolvePendingWrite(record, 'approve')"
          >
            {{ t('skills.writeApprovalApprove') }}
          </NButton>
          <NButton
            size="tiny"
            quaternary
            type="error"
            :loading="pendingActions.has(`${pendingKey(record)}:reject`)"
            :disabled="resolvingWrite"
            @click="resolvePendingWrite(record, 'reject')"
          >
            {{ t('skills.writeApprovalReject') }}
          </NButton>
        </div>
        <div v-if="expandedReviews[pendingKey(record)]" class="write-approval-review">
          <MarkdownRenderer :content="expandedReviews[pendingKey(record)]" />
        </div>
      </div>
    </div>
  </section>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;

.write-approval-panel {
  display: flex;
  flex-direction: column;
  min-height: 100%;
}

.write-approval-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 4px 0 14px;
  border-bottom: 1px solid $border-color;

  h3 {
    margin: 0;
    font-size: 16px;
    color: $text-primary;
  }

  p {
    margin: 4px 0 0;
    font-size: 12px;
    color: $text-muted;
  }
}

.write-approval-state {
  padding: 18px 0;
  color: $text-muted;
  font-size: 13px;
}

.write-approval-list {
  display: flex;
  flex-direction: column;
}

.write-approval-item {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 12px;
  padding: 14px 0;
  border-top: 1px solid $border-color;

  &:first-child {
    border-top: 0;
  }
}

.write-approval-main {
  min-width: 0;
}

.write-approval-meta {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  font-size: 12px;
  color: $text-muted;
}

.write-approval-summary {
  margin-top: 7px;
  font-size: 13px;
  color: $text-primary;
  overflow-wrap: anywhere;
}

.write-approval-actions {
  display: flex;
  align-items: flex-start;
  gap: 6px;
}

.write-approval-review {
  grid-column: 1 / -1;
  max-height: 360px;
  overflow: auto;
  margin: 0;
  padding: 10px;
  border: 1px solid $border-color;
  border-radius: $radius-sm;
  background: $bg-input;
  color: $text-primary;

  :deep(.markdown-body) {
    font-size: 12px;
  }

  :deep(pre) {
    max-height: none;
  }
}

@media (max-width: $breakpoint-mobile) {
  .write-approval-header {
    align-items: flex-start;
  }

  .write-approval-item {
    grid-template-columns: 1fr;
  }

  .write-approval-actions {
    flex-wrap: wrap;
  }
}
</style>
