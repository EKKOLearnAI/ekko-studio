<script setup lang="ts">
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { NButton, NDatePicker, NInput, NSelect, NTag, NTimePicker } from 'naive-ui'
import type { PersonSchedule, PersonTask } from '@/api/person'
import PersonPanelIcon from './PersonPanelIcon.vue'

const props = defineProps<{ schedules: PersonSchedule[]; tasks: PersonTask[]; timezone: string; saving: boolean; save: (input: Record<string, unknown>) => Promise<boolean> }>()
const emit = defineEmits<{ action: [schedule: PersonSchedule, action: string] }>()
const { t, locale } = useI18n()
const editorOpen = ref(false)
const editing = ref<PersonSchedule | null>(null)
const taskId = ref<string | null>(null)
const kind = ref('cron')
const cadence = ref('daily')
const time = ref('09:00')
const date = ref<number | null>(null)
const customExpression = ref('')
const zone = ref(props.timezone)
const localZone = Intl.DateTimeFormat().resolvedOptions().timeZone
const tasks = computed(() => props.tasks.filter(task => task.status === 'open' || task.id === editing.value?.task_id).map(task => ({ label: task.title, value: task.id })))
const cadenceOptions = computed(() => ['daily', 'weekdays', 'custom'].map(value => ({ value, label: t(`person.${value}`) })))
const expression = computed(() => {
  if (kind.value === 'once') return date.value === null ? '' : new Date(date.value).toISOString()
  if (cadence.value === 'custom') return customExpression.value.trim()
  const [hour, minute] = time.value.split(':').map(Number)
  return `${minute} ${hour} * * ${cadence.value === 'weekdays' ? '1-5' : '*'}`
})
function startEdit(schedule?: PersonSchedule) {
  editing.value = schedule || null
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
async function submit() {
  if (props.saving || !taskId.value || !expression.value || !zone.value.trim()) return
  if (await props.save({ action: editing.value ? 'update' : 'create', task_id: taskId.value, schedule_id: editing.value?.id, expected_revision: editing.value?.revision,
    kind: kind.value, expression: expression.value, timezone: zone.value, misfire: 'run_latest', idempotency_key: crypto.randomUUID() })) editorOpen.value = false
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
      <div class="editor-fields">
        <label class="field-wide">{{ t('person.tasks') }}<NSelect v-model:value="taskId" filterable :options="tasks" :disabled="saving || !!editing" :placeholder="t('person.tasks')" :aria-label="t('person.tasks')" /></label>
        <label>{{ t('person.schedules') }}<NSelect v-model:value="kind" :disabled="saving" :options="[{ label: t('person.recurring'), value: 'cron' }, { label: t('person.once'), value: 'once' }]" :aria-label="t('person.schedules')" /></label>
        <label v-if="kind === 'cron'">{{ t('person.frequency') }}<NSelect v-model:value="cadence" :options="cadenceOptions" :disabled="saving" :aria-label="t('person.frequency')" /></label>
        <label v-if="kind === 'once'">{{ t('person.dateTime') }} · {{ localZone }}<NDatePicker v-model:value="date" type="datetime" clearable :disabled="saving" /></label>
        <label v-else-if="cadence !== 'custom'">{{ t('person.dateTime') }}<NTimePicker v-model:formatted-value="time" format="HH:mm" :clearable="false" :disabled="saving" /></label>
        <label v-else>{{ t('person.expression') }}<NInput v-model:value="customExpression" :disabled="saving" :placeholder="t('person.cronHint')" :input-props="{ 'aria-label': t('person.expression') }" /></label>
        <label>{{ t('person.timezone') }}<NInput v-model:value="zone" :disabled="saving" :input-props="{ 'aria-label': t('person.timezone') }" /></label>
      </div>
      <footer class="editor-actions"><NButton :disabled="saving" @click="editorOpen = false">{{ t('common.cancel') }}</NButton><NButton type="primary" attr-type="submit" :loading="saving" :disabled="!taskId || !expression || !zone.trim()">{{ t('common.save') }}</NButton></footer>
    </form>
    <div class="panel-toolbar"><span class="panel-count"><strong>{{ schedules.length }}</strong>{{ t('person.schedules') }}</span><span class="tile-meta">{{ t('person.states.active') }} · {{ schedules.filter(item => item.state === 'active').length }}</span></div>
    <div v-if="schedules.length" class="panel-grid">
      <article v-for="schedule in schedules" :key="schedule.id" class="panel-tile schedule-tile" data-theme-surface="card">
        <div class="tile-top"><span class="tile-icon"><PersonPanelIcon name="schedule" /></span><NTag :bordered="false" round size="small" :type="schedule.state === 'active' ? 'success' : 'default'">{{ t(`person.states.${schedule.state}`) }}</NTag></div>
        <h3>{{ props.tasks.find(task => task.id === schedule.task_id)?.title || t('person.tasks') }}</h3>
        <p class="schedule-frequency">{{ scheduleLabel(schedule) }}</p>
        <div class="schedule-next"><span class="tile-meta">{{ t('person.nextRun') }}</span><time>{{ nextDate(schedule) }}</time><span class="tile-meta">{{ schedule.timezone }}</span></div>
        <footer class="tile-footer"><NButton quaternary size="small" :disabled="saving || schedule.state === 'cancelled'" @click="startEdit(schedule)">{{ t('common.edit') }}</NButton><div class="tile-actions">
          <NButton v-if="schedule.state === 'active'" quaternary size="small" :disabled="saving" @click="emit('action', schedule, 'pause')">{{ t('person.pause') }}</NButton>
          <NButton v-if="schedule.state === 'paused'" quaternary size="small" :disabled="saving" @click="emit('action', schedule, 'resume')">{{ t('person.resume') }}</NButton>
          <NButton v-if="schedule.state !== 'cancelled'" quaternary size="small" :disabled="saving" @click="emit('action', schedule, 'cancel')">{{ t('person.cancelSchedule') }}</NButton>
        </div></footer>
      </article>
    </div>
    <div v-else-if="!editorOpen" class="panel-empty"><PersonPanelIcon name="schedule" :size="36" /><h3>{{ t('person.empty') }}</h3><p>{{ t('person.scheduleEmpty') }}</p></div>
  </section>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;
@use './person-panels';
.schedule-frequency { font-size: 13px; color: $text-secondary; margin: 8px 0 24px; overflow-wrap: anywhere; }
.schedule-next { display: flex; flex-direction: column; gap: 6px; margin-bottom: 24px; }
.schedule-next time { font-size: 21px; letter-spacing: -.3px; font-variant-numeric: tabular-nums; }
</style>
