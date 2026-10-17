<script setup lang="ts">
import { ref, onMounted, computed } from 'vue'
import { NModal, NForm, NFormItem, NInput, NButton, NSelect, NInputNumber, useMessage } from 'naive-ui'
import { useJobsStore } from '@/stores/hermes/jobs'
import { useAppStore } from '@/stores/hermes/app'
import {
  buildJobUpdateRequest,
  getJob,
  jobRepeatToEditValue,
  listJobDeliveryTargets,
  scheduleToEditableInput,
} from '@/api/hermes/jobs'
import type { CreateJobRequest, Job, JobDeliveryTarget } from '@/api/hermes/jobs'
import { fetchSkills } from '@/api/hermes/skills'
import type { SkillInfo } from '@/api/hermes/skills'
import {
  buildScheduleExpression,
  parseScheduleExpression,
  scheduleWeekdayOptions,
  SCHEDULE_HOUR_OPTIONS,
  SCHEDULE_MINUTE_OPTIONS,
  SCHEDULE_MONTH_DAY_OPTIONS,
  type ScheduleFrequency,
} from '@/utils/schedule-frequency'
import { useI18n } from 'vue-i18n'

const { t, locale } = useI18n()

const props = defineProps<{
  jobId: string | null
}>()

const emit = defineEmits<{
  close: []
  saved: []
}>()

const jobsStore = useJobsStore()
const appStore = useAppStore()
const message = useMessage()

const showModal = ref(true)
const loading = ref(false)
const skillsLoading = ref(false)
const skillOptions = ref<Array<{ label: string; value: string }>>([])
const deliveryTargetsLoading = ref(false)
const deliveryTargets = ref<JobDeliveryTarget[]>([])

const formData = ref({
  name: '',
  schedule: '',
  prompt: '',
  deliver: 'local',
  skills: [] as string[],
  repeat_times: null as number | null,
  provider: '',
  model: '',
})

const scheduleFrequency = ref<ScheduleFrequency | null>(null)
const scheduleHour = ref(9)
const scheduleMinute = ref(0)
const scheduleWeekday = ref(1)
const scheduleMonthDay = ref(1)

const isEdit = computed(() => !!props.jobId)

const scheduleFrequencyOptions = computed(() => [
  { label: t('jobs.presetEveryMinute'), value: 'every-minute' },
  { label: t('jobs.presetEvery5Min'), value: 'every-5-minutes' },
  { label: t('jobs.presetEvery30Min'), value: 'every-30-minutes' },
  { label: t('jobs.presetEveryHour'), value: 'hourly' },
  { label: t('jobs.frequencyDaily'), value: 'daily' },
  { label: t('jobs.frequencyWeekly'), value: 'weekly' },
  { label: t('jobs.frequencyMonthly'), value: 'monthly' },
  { label: t('jobs.customSchedule'), value: 'custom' },
])
const scheduleWeekdays = computed(() => scheduleWeekdayOptions(locale.value))

function generatedSchedule() {
  if (!scheduleFrequency.value) return ''
  return buildScheduleExpression({
    frequency: scheduleFrequency.value,
    hour: scheduleHour.value,
    minute: scheduleMinute.value,
    weekday: scheduleWeekday.value,
    monthDay: scheduleMonthDay.value,
  })
}

function syncGeneratedSchedule() {
  if (scheduleFrequency.value && scheduleFrequency.value !== 'custom') {
    formData.value.schedule = generatedSchedule()
  }
}

function handleScheduleFrequency(value: ScheduleFrequency | null) {
  const previous = scheduleFrequency.value
  scheduleFrequency.value = value
  if (!value) {
    formData.value.schedule = ''
  } else if (value === 'custom') {
    if (previous !== 'custom') formData.value.schedule = ''
  } else {
    syncGeneratedSchedule()
  }
}

function setScheduleHour(value: number) { scheduleHour.value = value; syncGeneratedSchedule() }
function setScheduleMinute(value: number) { scheduleMinute.value = value; syncGeneratedSchedule() }
function setScheduleWeekday(value: number) { scheduleWeekday.value = value; syncGeneratedSchedule() }
function setScheduleMonthDay(value: number) {
  scheduleMonthDay.value = value
  syncGeneratedSchedule()
}

const providerOptions = computed(() => {
  const options = [
    { label: t('jobs.defaultProvider'), value: '' },
    ...appStore.modelGroups
      .filter(group => group.models.length > 0)
      .map(group => ({ label: group.label || group.provider, value: group.provider })),
  ]
  if (formData.value.provider && !options.some(option => option.value === formData.value.provider)) {
    options.push({ label: formData.value.provider, value: formData.value.provider })
  }
  return options
})

const modelOptions = computed(() => {
  const provider = formData.value.provider
  if (!provider) return [{ label: t('jobs.defaultModel'), value: '' }]
  const group = appStore.modelGroups.find(item => item.provider === provider)
  const models = group?.models || []
  const options = models.map(model => ({
    label: appStore.displayModelName(model, provider),
    value: model,
  }))
  if (formData.value.model && !models.includes(formData.value.model)) {
    options.unshift({ label: appStore.displayModelName(formData.value.model, provider), value: formData.value.model })
  }
  return options
})

function handleProviderChange(provider: string) {
  formData.value.provider = provider
  if (!provider) {
    formData.value.model = ''
    return
  }
  const group = appStore.modelGroups.find(item => item.provider === provider)
  if (!group?.models.includes(formData.value.model)) {
    formData.value.model = group?.models[0] || ''
  }
}

const targetOptions = computed(() => {
  const options: Array<{ label: string; value: string }> = [
    { label: t('jobs.local'), value: 'local' },
  ]
  // Jobs created by the Web UI have no messaging origin. Keep the legacy
  // value editable when loading an existing job, but do not offer it for new jobs.
  if (formData.value.deliver === 'origin') {
    options.unshift({ label: t('jobs.origin'), value: 'origin' })
  }
  for (const target of deliveryTargets.value) {
    const typeSuffix = target.type ? ` (${target.type})` : ''
    options.push({
      label: `${formatPlatformName(target.platform)} · ${target.name}${typeSuffix}`,
      value: target.value,
    })
  }

  const current = formData.value.deliver.trim()
  if (current && !options.some(option => option.value === current)) {
    options.push({ label: current, value: current })
  }
  return options
})

function formatPlatformName(platform: string): string {
  const names: Record<string, string> = {
    weixin: 'WeChat',
    wecom: 'WeCom',
    qqbot: 'QQBot',
    whatsapp: 'WhatsApp',
    whatsapp_cloud: 'WhatsApp Cloud',
    dingtalk: 'DingTalk',
    feishu: 'Feishu',
  }
  return names[platform] || platform
    .split('_')
    .filter(Boolean)
    .map(part => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ')
}

const originalJob = ref<Job | null>(null)

function buildSkillOptions(skills: SkillInfo[]): Array<{ label: string; value: string }> {
  const byName = new Map<string, SkillInfo>()
  for (const skill of skills) {
    if (skill.enabled === false) continue
    if (!byName.has(skill.name)) byName.set(skill.name, skill)
  }
  return [...byName.values()]
    .map(skill => ({ label: skill.name, value: skill.name }))
    .sort((a, b) => a.label.localeCompare(b.label))
}

async function loadSkillOptions() {
  skillsLoading.value = true
  try {
    const data = await fetchSkills()
    skillOptions.value = buildSkillOptions(data.categories.flatMap(category => category.skills || []))
  } catch {
    skillOptions.value = []
  } finally {
    skillsLoading.value = false
  }
}

async function loadDeliveryTargets() {
  deliveryTargetsLoading.value = true
  try {
    const data = await listJobDeliveryTargets()
    deliveryTargets.value = Array.isArray(data.targets) ? data.targets : []
  } catch {
    deliveryTargets.value = []
  } finally {
    deliveryTargetsLoading.value = false
  }
}

onMounted(async () => {
  await Promise.all([
    appStore.loadModels(),
    loadSkillOptions(),
    loadDeliveryTargets(),
  ])

  if (props.jobId) {
    try {
      const job = await getJob(props.jobId)
      originalJob.value = job
      const schedule = scheduleToEditableInput(job.schedule, job.schedule_display || '')
      const parsedSchedule = parseScheduleExpression(schedule)
      formData.value = {
        name: job.name,
        schedule,
        prompt: job.prompt,
        deliver: job.deliver || 'origin',
        skills: job.skills || (job.skill ? [job.skill] : []),
        repeat_times: jobRepeatToEditValue(job.repeat),
        provider: job.provider || '',
        model: job.model || '',
      }
      scheduleFrequency.value = parsedSchedule.frequency
      scheduleHour.value = parsedSchedule.hour
      scheduleMinute.value = parsedSchedule.minute
      scheduleWeekday.value = parsedSchedule.weekday
      scheduleMonthDay.value = parsedSchedule.monthDay
    } catch (e: any) {
      message.error(t('jobs.loadFailed') + ': ' + e.message)
    }
  }
})

async function handleSave() {
  if (!formData.value.name.trim()) {
    message.warning(t('jobs.nameRequired'))
    return
  }
  if (!formData.value.schedule.trim()) {
    message.warning(t('jobs.scheduleRequired'))
    return
  }
  if (!formData.value.prompt.trim()) {
    message.warning(t('jobs.promptRequired'))
    return
  }

  loading.value = true
  try {
    if (isEdit.value) {
      if (!originalJob.value) {
        message.error(t('jobs.loadFailed'))
        return
      }
      const payload = buildJobUpdateRequest(originalJob.value, formData.value)
      if (Object.keys(payload).length === 0) {
        message.success(t('jobs.jobUpdated'))
        emit('saved')
        return
      }
      await jobsStore.updateJob(props.jobId!, payload)
      message.success(t('jobs.jobUpdated'))
    } else {
      const payload: CreateJobRequest = {
        name: formData.value.name,
        schedule: formData.value.schedule,
        prompt: formData.value.prompt,
        deliver: formData.value.deliver,
        skills: formData.value.skills,
        repeat: formData.value.repeat_times ?? undefined,
        provider: formData.value.provider || undefined,
        model: formData.value.model || undefined,
      }
      await jobsStore.createJob(payload)
      message.success(t('jobs.jobCreated'))
    }
    emit('saved')
  } catch (e: any) {
    message.error(e.message)
  } finally {
    loading.value = false
  }
}

function handleClose() {
  showModal.value = false
  setTimeout(() => emit('close'), 200)
}
</script>

<template>
  <NModal
    v-model:show="showModal"
    preset="card"
    :title="isEdit ? t('jobs.editJob') : t('jobs.createJob')"
    :style="{ width: 'min(520px, calc(100vw - 32px))' }"
    :mask-closable="!loading"
    @after-leave="emit('close')"
  >
    <NForm label-placement="top">
      <NFormItem :label="t('jobs.name')" required>
        <NInput
          v-model:value="formData.name"
          :placeholder="t('jobs.namePlaceholder')"
          maxlength="200"
          show-count
        />
      </NFormItem>

      <NFormItem :label="t('jobs.frequency')" required>
        <NSelect
          data-testid="job-schedule-frequency"
          :value="scheduleFrequency"
          :options="scheduleFrequencyOptions"
          :placeholder="t('jobs.selectPreset')"
          clearable
          @update:value="handleScheduleFrequency"
        />
      </NFormItem>

      <NFormItem v-if="scheduleFrequency === 'hourly'" :label="t('scheduleBuilder.minute')" required>
        <NSelect
          data-testid="job-schedule-minute"
          :value="scheduleMinute"
          :options="SCHEDULE_MINUTE_OPTIONS"
          @update:value="setScheduleMinute"
        />
      </NFormItem>

      <NFormItem v-if="scheduleFrequency === 'weekly'" :label="t('scheduleBuilder.weekday')" required>
        <NSelect
          data-testid="job-schedule-weekday"
          :value="scheduleWeekday"
          :options="scheduleWeekdays"
          @update:value="setScheduleWeekday"
        />
      </NFormItem>

      <NFormItem v-if="scheduleFrequency === 'monthly'" :label="t('scheduleBuilder.monthDay')" required>
        <NSelect
          data-testid="job-schedule-month-day"
          :value="scheduleMonthDay"
          :options="SCHEDULE_MONTH_DAY_OPTIONS"
          @update:value="setScheduleMonthDay"
        />
      </NFormItem>

      <NFormItem v-if="scheduleFrequency === 'daily' || scheduleFrequency === 'weekly' || scheduleFrequency === 'monthly'" :label="t('scheduleBuilder.time')" required>
        <div class="schedule-time-fields">
          <NSelect
            data-testid="job-schedule-hour"
            :value="scheduleHour"
            :options="SCHEDULE_HOUR_OPTIONS"
            :aria-label="t('scheduleBuilder.hour')"
            @update:value="setScheduleHour"
          />
          <span>:</span>
          <NSelect
            data-testid="job-schedule-minute"
            :value="scheduleMinute"
            :options="SCHEDULE_MINUTE_OPTIONS"
            :aria-label="t('scheduleBuilder.minute')"
            @update:value="setScheduleMinute"
          />
        </div>
      </NFormItem>

      <NFormItem v-if="scheduleFrequency === 'custom'" :label="t('jobs.schedule')" required>
        <NInput
          data-testid="job-schedule-custom"
          v-model:value="formData.schedule"
          :placeholder="t('jobs.schedulePlaceholder')"
        />
      </NFormItem>

      <NFormItem :label="t('jobs.provider')">
        <NSelect
          data-testid="job-provider"
          :value="formData.provider"
          :options="providerOptions"
          @update:value="handleProviderChange"
        />
      </NFormItem>

      <NFormItem :label="t('jobs.model')">
        <NSelect
          data-testid="job-model"
          v-model:value="formData.model"
          filterable
          clearable
          :disabled="!formData.provider"
          :options="modelOptions"
          :placeholder="t('jobs.modelPlaceholder')"
        />
      </NFormItem>

      <NFormItem :label="t('jobs.prompt')" required>
        <NInput
          v-model:value="formData.prompt"
          type="textarea"
          :placeholder="t('jobs.promptPlaceholder')"
          :rows="4"
          maxlength="5000"
          show-count
        />
      </NFormItem>

      <NFormItem :label="t('jobs.skills')">
        <NSelect
          data-testid="job-skills"
          v-model:value="formData.skills"
          multiple
          filterable
          clearable
          :loading="skillsLoading"
          :options="skillOptions"
          :placeholder="t('jobs.skillsPlaceholder')"
        />
      </NFormItem>

      <NFormItem :label="t('jobs.deliverTarget')">
        <NSelect
          data-testid="job-delivery"
          v-model:value="formData.deliver"
          :options="targetOptions"
          :loading="deliveryTargetsLoading"
          filterable
        />
      </NFormItem>

      <NFormItem :label="t('jobs.repeatCount')">
        <NInputNumber
          v-model:value="formData.repeat_times"
          :min="1"
          :placeholder="t('jobs.repeatPlaceholder')"
          clearable
          style="width: 100%"
        />
      </NFormItem>
    </NForm>

    <template #footer>
      <div class="modal-footer">
        <NButton @click="handleClose">{{ t('common.cancel') }}</NButton>
        <NButton type="primary" :loading="loading" @click="handleSave">
          {{ isEdit ? t('common.update') : t('common.create') }}
        </NButton>
      </div>
    </template>
  </NModal>
</template>

<style scoped lang="scss">
.modal-footer {
  display: flex;
  justify-content: flex-end;
  gap: calc(8px * var(--spacing-scale, 1));
}

.schedule-time-fields {
  display: grid;
  grid-template-columns: 1fr auto 1fr;
  align-items: center;
  gap: calc(8px * var(--spacing-scale, 1));
  width: 100%;
}
</style>
