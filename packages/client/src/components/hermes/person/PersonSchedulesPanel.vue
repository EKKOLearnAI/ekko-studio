<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { NButton, NDatePicker, NInput, NModal, NSelect, NTag, NTimePicker } from 'naive-ui'
import type { PersonSchedule, PersonTask } from '@/api/person'
import PersonPanelIcon from './PersonPanelIcon.vue'
import { clientUuid } from '@/utils/secure-uuid'
import { chatSessionAgentAvatar, personAvatarStyle } from '@/utils/chat-agent-avatar'

const props = defineProps<{ sessionId: string; schedules: PersonSchedule[]; tasks: PersonTask[]; timezone: string; saving: boolean; save: (input: Record<string, unknown>) => Promise<boolean> }>()
const emit = defineEmits<{ action: [schedule: PersonSchedule, action: string] }>()
const { t, locale } = useI18n()
const editorOpen = ref(false)
const editing = ref<PersonSchedule | null>(null)
const deleteTarget = ref<PersonSchedule | null>(null)
const detailId = ref<string | null>(null)
const detail = computed(() => props.schedules.find(schedule => schedule.id === detailId.value))
watch(() => props.schedules, schedules => {
  if (deleteTarget.value && !schedules.some(schedule => schedule.id === deleteTarget.value?.id)) deleteTarget.value = null
  if (editing.value && !schedules.some(schedule => schedule.id === editing.value?.id)) {
    editing.value = null; editorOpen.value = false
  }
})
const taskId = ref<string | null>(null)
const mode = ref<'assistant' | 'worker'>('assistant')
const title = ref('')
const goal = ref('')
const kind = ref('cron')
const cadence = ref('daily')
const time = ref('09:00')
const date = ref<number | null>(null)
const customExpression = ref('')
const zone = ref(props.timezone)
const localZone = Intl.DateTimeFormat().resolvedOptions().timeZone
const tasks = computed(() => {
  const options = props.tasks.filter(task => task.status === 'open' || task.id === editing.value?.task_id).map(task => ({ label: task.title, value: task.id }))
  const schedule = editing.value
  if (schedule?.task_id && !options.some(task => task.value === schedule.task_id)) options.push({ label: schedule.task_title || schedule.title, value: schedule.task_id })
  return options
})
const targetSessionId = computed(() => editing.value?.session_id || props.sessionId)
const ownerName = (schedule: PersonSchedule) => schedule.session_title || t('person.chat')
const avatar = (schedule: PersonSchedule) => chatSessionAgentAvatar({ id: schedule.session_id, bot_type: schedule.bot_type || undefined })
const scheduleTitle = (schedule: PersonSchedule) => schedule.title || schedule.task_title || props.tasks.find(task => task.id === schedule.task_id)?.title || t('person.tasks')
const scheduleGoal = (schedule: PersonSchedule) => schedule.goal || schedule.task_goal || props.tasks.find(task => task.id === schedule.task_id)?.summary || t('person.scheduleGoalUnavailable')
const cadenceOptions = computed(() => ['daily', 'weekdays', 'custom'].map(value => ({ value, label: t(`person.${value}`) })))
const expression = computed(() => {
  if (kind.value === 'once') return date.value === null ? '' : new Date(date.value).toISOString()
  if (cadence.value === 'custom') return customExpression.value.trim()
  const [hour, minute] = time.value.split(':').map(Number)
  return `${minute} ${hour} * * ${cadence.value === 'weekdays' ? '1-5' : '*'}`
})
function startEdit(schedule?: PersonSchedule) {
  editing.value = schedule || null
  mode.value = schedule?.mode || 'assistant'; title.value = schedule?.title || ''; goal.value = schedule?.goal || ''
  taskId.value = schedule?.task_id || null
  zone.value = schedule?.timezone || props.timezone
  kind.value = schedule ? (/\s/.test(schedule.expression) ? 'cron' : 'once') : 'cron'
  date.value = schedule && kind.value === 'once' ? Date.parse(schedule.expression) : null
  customExpression.value = schedule?.expression || ''
  const fields = schedule?.expression.split(' ') || []
  const simple = /^\d+ \d+ \* \* (\*|1-5)$/.test(schedule?.expression || '')
  cadence.value = !schedule ? 'daily' : simple ? (fields[4] === '*' ? 'daily' : 'weekdays') : 'custom'
  time.value = simple ? `${fields[1]!.padStart(2, '0')}:${fields[0]!.padStart(2, '0')}` : '09:00'
  editorOpen.value = true
}
const validTarget = computed(() => mode.value === 'worker' ? !!taskId.value : !!targetSessionId.value && !!title.value.trim() && !!goal.value.trim())
async function submit() {
  if (props.saving || !validTarget.value || !expression.value || !zone.value.trim()) return
  if (await props.save({ action: editing.value ? 'update' : 'create', mode: mode.value, ...(mode.value === 'worker' ? { task_id: taskId.value } : { session_id: targetSessionId.value, title: title.value, goal: goal.value }), schedule_id: editing.value?.id, expected_revision: editing.value?.revision,
    kind: kind.value, expression: expression.value, timezone: zone.value, misfire: 'run_latest', idempotency_key: clientUuid() })) editorOpen.value = false
}
function confirmDelete() {
  if (props.saving || !deleteTarget.value) return false
  emit('action', deleteTarget.value, 'delete')
  deleteTarget.value = null
}
function scheduleLabel(schedule: PersonSchedule) {
  const fields = schedule.expression.split(' ')
  if (/^\d+ \d+ \* \* (\*|1-5)$/.test(schedule.expression)) return `${t(fields[4] === '*' ? 'person.daily' : 'person.weekdays')} · ${fields[1]!.padStart(2, '0')}:${fields[0]!.padStart(2, '0')}`
  return /\s/.test(schedule.expression) ? schedule.expression : t('person.once')
}
function nextDate(schedule: PersonSchedule) {
  if (!schedule.next_at || ['cancelled', 'exhausted'].includes(schedule.state)) return '—'
  return new Intl.DateTimeFormat(locale.value, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: schedule.timezone }).format(schedule.next_at)
}
</script>

<template>
  <section class="person-panel">
    <header class="panel-heading"><div><h2>{{ t('person.schedulesTitle') }}</h2><p>{{ t('person.schedulesHint') }}</p></div><NButton type="primary" :disabled="saving" @click="startEdit()"><template #icon><PersonPanelIcon name="plus" :size="18" /></template>{{ t('person.addSchedule') }}</NButton></header>
    <form v-if="editorOpen" class="panel-editor" data-theme-surface="card" @submit.prevent="submit">
      <div class="editor-heading"><span class="tile-icon"><PersonPanelIcon name="schedule" /></span><h3>{{ editing ? t('common.edit') : t('person.addSchedule') }}</h3></div>
      <p v-if="editing" class="schedule-editor-owner">{{ t('person.botName') }} · {{ ownerName(editing) }}</p>
      <div class="editor-fields">
        <label class="field-wide">{{ t('person.scheduleMode') }}<NSelect v-model:value="mode" :disabled="saving || !!editing" :options="[{ value: 'assistant', label: t('person.assistantSchedule') }, { value: 'worker', label: t('person.workerSchedule') }]" :aria-label="t('person.scheduleMode')" /></label>
        <template v-if="mode === 'assistant'">
          <label class="field-wide">{{ t('person.scheduleTitle') }}<NInput v-model:value="title" :maxlength="200" :disabled="saving" :input-props="{ 'aria-label': t('person.scheduleTitle') }" /></label>
          <label class="field-wide">{{ t('person.scheduleGoal') }}<NInput v-model:value="goal" type="textarea" :maxlength="8000" :disabled="saving" :placeholder="t('person.assistantScheduleHint')" :input-props="{ 'aria-label': t('person.scheduleGoal') }" /></label>
        </template>
        <label v-else class="field-wide">{{ t('person.tasks') }}<NSelect v-model:value="taskId" filterable :options="tasks" :disabled="saving || !!editing" :placeholder="t('person.tasks')" :aria-label="t('person.tasks')" /></label>
        <label>{{ t('person.schedules') }}<NSelect v-model:value="kind" :disabled="saving" :options="[{ label: t('person.recurring'), value: 'cron' }, { label: t('person.once'), value: 'once' }]" :aria-label="t('person.schedules')" /></label>
        <label v-if="kind === 'cron'">{{ t('person.frequency') }}<NSelect v-model:value="cadence" :options="cadenceOptions" :disabled="saving" :aria-label="t('person.frequency')" /></label>
        <label v-if="kind === 'once'">{{ t('person.dateTime') }} · {{ localZone }}<NDatePicker v-model:value="date" type="datetime" clearable :disabled="saving" /></label>
        <label v-else-if="cadence !== 'custom'">{{ t('person.dateTime') }}<NTimePicker v-model:formatted-value="time" format="HH:mm" :clearable="false" :disabled="saving" /></label>
        <label v-else>{{ t('person.expression') }}<NInput v-model:value="customExpression" :disabled="saving" :placeholder="t('person.cronHint')" :input-props="{ 'aria-label': t('person.expression') }" /></label>
        <label>{{ t('person.timezone') }}<NInput v-model:value="zone" :disabled="saving" :input-props="{ 'aria-label': t('person.timezone') }" /></label>
      </div>
      <footer class="editor-actions"><NButton :disabled="saving" @click="editorOpen = false">{{ t('common.cancel') }}</NButton><NButton type="primary" attr-type="submit" :loading="saving" :disabled="!validTarget || !expression || !zone.trim()">{{ t('common.save') }}</NButton></footer>
    </form>
    <div class="panel-toolbar"><span class="panel-count"><strong>{{ schedules.length }}</strong>{{ t('person.schedules') }}</span><span class="tile-meta">{{ t('person.states.active') }} · {{ schedules.filter(item => item.state === 'active').length }}</span></div>
    <div v-if="schedules.length" class="panel-grid">
      <article v-for="schedule in schedules" :key="schedule.id" class="panel-tile schedule-tile" data-theme-surface="card">
        <div class="tile-top"><div class="schedule-owner"><img :src="avatar(schedule).src" :style="personAvatarStyle(avatar(schedule))" alt="" width="42" height="42" /><span>{{ ownerName(schedule) }}</span></div><NTag :bordered="false" round size="small" :type="schedule.state === 'active' ? 'success' : 'default'">{{ t(`person.states.${schedule.state}`) }}</NTag></div>
        <h3>{{ scheduleTitle(schedule) }}</h3>
        <p class="schedule-goal-preview">{{ scheduleGoal(schedule) }}</p>
        <p class="schedule-frequency">{{ t(schedule.mode === 'assistant' ? 'person.assistantSchedule' : 'person.workerSchedule') }} · {{ scheduleLabel(schedule) }}</p>
        <div class="schedule-next"><span class="tile-meta">{{ t('person.nextRun') }}</span><time>{{ nextDate(schedule) }}</time><span class="tile-meta">{{ schedule.timezone }}</span></div>
        <footer class="tile-footer"><div class="tile-actions"><NButton quaternary size="small" @click="detailId = schedule.id">{{ t('person.details') }}</NButton><NButton quaternary size="small" :disabled="saving || schedule.state === 'cancelled'" @click="startEdit(schedule)">{{ t('common.edit') }}</NButton></div><div class="tile-actions">
          <NButton v-if="schedule.state === 'active'" quaternary size="small" :disabled="saving" @click="emit('action', schedule, 'pause')">{{ t('person.pause') }}</NButton>
          <NButton v-if="schedule.state === 'paused'" quaternary size="small" :disabled="saving" @click="emit('action', schedule, 'resume')">{{ t('person.resume') }}</NButton>
          <NButton v-if="schedule.state !== 'cancelled'" quaternary size="small" :disabled="saving" @click="emit('action', schedule, 'cancel')">{{ t('person.cancelSchedule') }}</NButton>
          <NButton quaternary size="small" type="error" :disabled="saving" @click="deleteTarget = schedule">{{ t('common.delete') }}</NButton>
        </div></footer>
      </article>
    </div>
    <div v-else-if="!editorOpen" class="panel-empty"><PersonPanelIcon name="schedule" :size="36" /><h3>{{ t('person.empty') }}</h3><p>{{ t('person.scheduleEmpty') }}</p></div>
    <NModal :show="!!detail" preset="card" :title="detail ? scheduleTitle(detail) : ''" :aria-label="t('person.details')"
      :style="{ width: 'min(680px, calc(100vw - 32px))' }" @update:show="show => { if (!show) detailId = null }">
      <div v-if="detail" class="schedule-detail">
        <div class="schedule-owner"><img :src="avatar(detail).src" :style="personAvatarStyle(avatar(detail))" alt="" width="42" height="42" /><span>{{ ownerName(detail) }}</span><NTag :bordered="false" size="small">{{ t(`person.states.${detail.state}`) }}</NTag></div>
        <h4>{{ t('person.scheduleGoal') }}</h4><p class="schedule-goal-full">{{ scheduleGoal(detail) }}</p>
        <dl class="schedule-detail-meta">
          <div><dt>{{ t('person.scheduleMode') }}</dt><dd>{{ t(detail.mode === 'assistant' ? 'person.assistantSchedule' : 'person.workerSchedule') }}</dd></div>
          <div><dt>{{ t('person.expression') }}</dt><dd>{{ detail.expression }}</dd></div>
          <div><dt>{{ t('person.timezone') }}</dt><dd>{{ detail.timezone }}</dd></div>
          <div><dt>{{ t('person.nextRun') }}</dt><dd>{{ nextDate(detail) }}</dd></div>
        </dl>
      </div>
    </NModal>
    <NModal :show="!!deleteTarget" preset="dialog" :title="t('common.delete')" :content="t('person.deleteScheduleConfirm')"
      :positive-text="t('common.delete')" :negative-text="t('common.cancel')" :positive-button-props="{ type: 'error', disabled: saving }"
      :mask-closable="!saving" :closable="!saving" :style="{ width: 'min(420px, calc(100vw - 32px))' }"
      @positive-click="confirmDelete" @negative-click="deleteTarget = null" @update:show="show => { if (!show) deleteTarget = null }" />
  </section>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;
@use './person-panels';
.schedule-frequency { font-size: 13px; color: $text-secondary; margin: 8px 0 24px; overflow-wrap: anywhere; }
.schedule-next { display: flex; flex-direction: column; gap: 6px; margin-bottom: 24px; }
.schedule-next time { font-size: 21px; letter-spacing: -.3px; font-variant-numeric: tabular-nums; }
.schedule-owner { display: flex; align-items: center; gap: 10px; min-width: 0; }
.schedule-owner img { flex: none; object-fit: contain; }
.schedule-owner span { overflow-wrap: anywhere; font-size: 13px; }
.schedule-goal-preview, .schedule-goal-full { white-space: pre-wrap; overflow-wrap: anywhere; line-height: 1.8; color: $text-secondary; }
.schedule-goal-preview { display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; font-size: 13px; margin: 10px 0 0; }
.schedule-editor-owner { font-size: 13px; color: $text-secondary; margin: -12px 0 24px; }
.schedule-detail { max-height: 70vh; overflow-y: auto; }
.schedule-detail h4 { margin: 24px 0 8px; }
.schedule-goal-full { margin: 0; }
.schedule-detail-meta { display: grid; gap: 12px; margin: 24px 0 0; }
.schedule-detail-meta div { display: grid; grid-template-columns: minmax(90px, auto) minmax(0, 1fr); gap: 16px; }
.schedule-detail-meta dt { color: $text-muted; }
.schedule-detail-meta dd { margin: 0; overflow-wrap: anywhere; }
</style>
