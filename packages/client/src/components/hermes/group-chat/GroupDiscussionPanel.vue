<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { NAlert, NButton, NDrawer, NDrawerContent, NInput, NInputNumber, NSelect, NSwitch } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import { useGroupChatStore } from '@/stores/hermes/group-chat'
import { useDiscussionReportDownload } from '@/composables/useDiscussionReportDownload'
import { cleanupDeliveryFiles, fetchDeliveryUsage, downloadGroupWorkspaceFile, type DeliveryUsage } from '@/api/studio/group-chat'
const props = defineProps<{ canManage: boolean }>()
const emit = defineEmits<{ close: [] }>()
const { t } = useI18n()
const store = useGroupChatStore()
const { downloadReport, isDownloading } = useDiscussionReportDownload()
const LONG_RUN_GUARDRAILS = [
    '【阶段划分】请将任务拆分为多个阶段（如：盘点材料 → 逐项分析 → 方案制定 → 汇总交付），每阶段集中深化后再进入下一阶段，不要跳阶段。',
    '【阶段落盘】每个阶段完成时，立即把该阶段成果保存为 Markdown 文件到交付目录（绝对路径已由【交付要求】给出），文件名带阶段号（如「阶段1-xxx.md」）。中途断电/重启也不丢失已落盘成果。',
    '【完成标准】当且仅当所有阶段成果均已落盘、且任务目标涉及的问题全部得到实质性解答、并产出可直接使用的最终交付物时，才算完成；条件不满足前，即使意见一致也不得结束。',
    '【禁止事项】不要反问用户、不要等待用户决策、不要请求用户介入；材料无法读取时标注"需人工核实"而不是编造内容；不要输出空回复。',
].join('\n')
const goal = ref(''), maxRounds = ref(20), minRounds = ref(0), maxMessages = ref(200), longRun = ref(false)
const order = ref<string[]>([]), reporter = ref(''), readingAgents = ref<string[]>([])
const files = ref<File[]>([]), uploadInput = ref<HTMLInputElement>(), busy = ref(false), error = ref('')
const usage = ref<DeliveryUsage | null>(null)
const state = computed(() => store.currentRoomId ? store.discussionStates.get(store.currentRoomId) : null)
const active = computed(() => state.value && ['pending', 'running', 'paused'].includes(state.value.status))
const agentOptions = computed(() => store.agents.map(agent => ({ value: agent.agentId, label: agent.name || agent.agentId })))
const documents = computed(() => [...store.documentStates.values()])
watch(longRun, enabled => { if (enabled) { maxRounds.value = 40; minRounds.value = 15; maxMessages.value = 600 } })
onMounted(async () => { if (store.currentRoomId) { await store.loadDiscussion(store.currentRoomId); await store.refreshDocuments(store.currentRoomId); await refreshUsage() } })
async function refreshUsage() { if (store.currentRoomId) usage.value = await fetchDeliveryUsage(store.currentRoomId).catch(() => null) }
async function attempt(action: () => Promise<unknown>) {
  error.value = ''; busy.value = true
  try { await action() } catch (cause) { error.value = cause instanceof Error ? cause.message : String(cause) }
  finally { busy.value = false }
}
async function start() {
  if (!store.currentRoomId) return
  const uploaded: string[] = []
  for (const file of files.value) uploaded.push((await store.uploadDocument(store.currentRoomId, file)).name)
  await store.beginDiscussion(store.currentRoomId, { goal: longRun.value ? `${goal.value.trim()}\n\n${LONG_RUN_GUARDRAILS}` : goal.value.trim(), attachments: uploaded, agentOrder: order.value.length ? order.value : undefined, reporterId: reporter.value || undefined, maxRounds: maxRounds.value, minRounds: minRounds.value, maxMessages: maxMessages.value })
}
async function upload(event: Event) {
  const selected = Array.from((event.target as HTMLInputElement).files || [])
  await attempt(async () => { for (const file of selected) if (store.currentRoomId) await store.uploadDocument(store.currentRoomId, file) })
}
async function cleanup() {
  if (!store.currentRoomId || !window.confirm(t('groupChat.discussion.delivery.cleanupConfirm'))) return
  await cleanupDeliveryFiles(store.currentRoomId); await refreshUsage()
}
</script>
<template>
  <NDrawer :show="true" :width="'min(560px, 100vw)'" placement="right" @update:show="value => { if (!value) emit('close') }">
    <NDrawerContent :title="t('groupChat.discussion.title')" closable class="group-discussion-panel">
      <div class="group-discussion-fields">
        <NAlert v-if="error" type="error">{{ error }}</NAlert>
        <p>{{ t('groupChat.discussion.desc') }}</p>
        <template v-if="state">
          <NAlert :type="active ? 'info' : 'success'">{{ t(`groupChat.discussion.status.${state.status}`) }} · {{ t('groupChat.discussion.round', { current: state.currentRound, max: state.maxRounds }) }}</NAlert>
          <p>{{ state.goal }}</p>
          <p v-if="state.lastError" role="alert">{{ state.lastError }}</p>
          <NButton v-if="active" :disabled="!canManage" :loading="busy" @click="attempt(() => store.endDiscussion(store.currentRoomId!))">{{ t('groupChat.discussion.stop') }}</NButton>
          <NButton v-else :loading="isDownloading" @click="downloadReport">{{ t('groupChat.discussion.downloadReport') }}</NButton>
          <NButton v-if="state.summaryFilePath" @click="attempt(() => downloadGroupWorkspaceFile(store.currentRoomId!, state!.summaryFilePath!, state!.summaryFilePath!.split('/').pop() || 'summary.md'))">{{ t('groupChat.discussion.downloadSummary') }}</NButton>
          <NButton v-for="file in state.deliverables || []" :key="file" text @click="attempt(() => downloadGroupWorkspaceFile(store.currentRoomId!, file, file.split('/').pop() || 'delivery'))">{{ file.split('/').pop() }}</NButton>
          <p v-for="note in state.judgeNotes" :key="note.round">{{ note.round }} · {{ note.assessment }} {{ note.suggestion }}</p>
        </template>
        <template v-if="!active && canManage">
          <label>{{ t('groupChat.discussion.goal') }}<NInput v-model:value="goal" type="textarea" :placeholder="t('groupChat.discussion.goalPlaceholder')" /></label>
          <label>{{ t('groupChat.discussion.longRun') }}<NSwitch v-model:value="longRun" /></label>
          <label>{{ t('groupChat.discussion.agentOrder') }}<NSelect v-model:value="order" multiple :options="agentOptions" /></label>
          <label>{{ t('groupChat.discussion.reporter') }}<NSelect v-model:value="reporter" :options="agentOptions" /></label>
          <label>{{ t('groupChat.discussion.attachments') }}<input type="file" multiple @change="files = Array.from(($event.target as HTMLInputElement).files || [])"></label>
          <label>{{ t('groupChat.discussion.maxRounds') }}<NInputNumber v-model:value="maxRounds" :min="1" :max="100" /></label>
          <label>{{ t('groupChat.discussion.minRounds') }}<NInputNumber v-model:value="minRounds" :min="0" :max="maxRounds" /></label>
          <label>{{ t('groupChat.discussion.maxMessages') }}<NInputNumber v-model:value="maxMessages" :min="1" :max="2000" /></label>
          <p>{{ t('groupChat.discussion.judgeDesc') }}</p>
          <NButton type="primary" :disabled="!goal.trim() || store.agents.length < 2" :loading="busy" @click="attempt(start)">{{ t('groupChat.discussion.start') }}</NButton>
          <p v-if="store.agents.length < 2">{{ t('groupChat.discussion.needsAgents') }}</p>
        </template>
        <section v-if="usage" class="group-discussion-deliveries" data-theme-surface="card">
          <p>{{ t('groupChat.discussion.delivery.usage', { used: Math.round(usage.totalBytes / 1024 / 1024) + ' MB', limit: Math.round(usage.limitBytes / 1024 / 1024) + ' MB', count: usage.fileCount }) }}</p>
          <NButton :disabled="!canManage || busy" @click="attempt(cleanup)">{{ t('groupChat.discussion.delivery.cleanup') }}</NButton>
        </section>
        <h3>{{ t('groupChat.document.title') }}</h3>
        <p>{{ t('groupChat.document.desc') }}</p>
        <input ref="uploadInput" type="file" accept=".txt,.md,.docx" multiple hidden @change="upload">
        <NButton :disabled="!canManage" :loading="busy" @click="uploadInput?.click()">{{ t('groupChat.document.upload') }}</NButton>
        <NSelect v-model:value="readingAgents" multiple :options="agentOptions" :placeholder="t('groupChat.document.agentsPlaceholder')" />
        <article v-for="doc in documents" :key="doc.fileId" data-theme-surface="card" class="group-document-card">
          <strong>{{ doc.name }}</strong><p>{{ t(`groupChat.document.status.${doc.status}`) }} · {{ doc.chunkCount }} {{ t('groupChat.document.chunks') }}</p>
          <p v-if="store.documentProgress.get(doc.fileId)">{{ t('groupChat.document.progress', { done: store.documentProgress.get(doc.fileId)?.chunksRead, total: store.documentProgress.get(doc.fileId)?.chunksTotal }) }}</p>
          <NButton :disabled="!canManage || !store.agents.length || ['reading', 'aggregating'].includes(doc.status)" :loading="busy" @click="attempt(() => store.startDocumentReading(store.currentRoomId!, doc.fileId, readingAgents.length ? readingAgents : store.agents.map(a => a.agentId)))">{{ t('groupChat.document.start') }}</NButton>
        </article>
      </div>
    </NDrawerContent>
  </NDrawer>
</template>
<style scoped lang="scss">
.group-discussion-fields { display: grid; gap: 16px; }
.group-discussion-fields label { display: grid; gap: 8px; }
.group-discussion-fields p { margin: 0; }
.group-document-card, .group-discussion-deliveries { padding: 12px; border: 1px solid var(--border-color); border-radius: var(--radius-component, 8px); }
.group-discussion-fields a { color: var(--accent-info); overflow-wrap: anywhere; }
.group-discussion-fields [role="alert"] { color: var(--error); }
</style>
