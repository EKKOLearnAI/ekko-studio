<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { NModal, NForm, NFormItem, NInput, NInputNumber, NSelect, NButton, NCheckbox, useMessage } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import { useKanbanStore } from '@/stores/hermes/kanban'
import { useProfilesStore } from '@/stores/hermes/profiles'
import { fetchSkills } from '@/api/hermes/skills'
import type { SkillInfo } from '@/api/hermes/skills'

const emit = defineEmits<{
  close: []
  created: []
}>()

const { t } = useI18n()
const message = useMessage()
const kanbanStore = useKanbanStore()
const profilesStore = useProfilesStore()

// Task text is written by people in whatever language they think in, while the
// UI language is a separate choice. `dir="auto"` lets each field follow its own
// first strong character, the same way the chat composer already does.
const autoDirectionInputProps = { dir: 'auto' } as const

const title = ref('')
const body = ref('')
const assignee = ref<string | null>(null)
const priority = ref<number | null>(null)
const tenant = ref('')
const triage = ref(false)
const workspaceKind = ref<'scratch' | 'dir' | 'worktree'>('scratch')
const workspacePath = ref('')
const branch = ref('')
const skills = ref<string[]>([])
const maxRuntime = ref('')
const maxRetries = ref<number | null>(null)
const goalMode = ref(false)
const goalMaxTurns = ref<number | null>(null)
const saving = ref(false)
const skillsLoading = ref(false)
const skillOptions = ref<Array<{ label: string; value: string }>>([])

const priorityOptions = computed(() => [
  { label: t('kanban.card.priority.low'), value: 1 },
  { label: t('kanban.card.priority.medium'), value: 2 },
  { label: t('kanban.card.priority.high'), value: 3 },
])

const assigneeOptions = computed(() => {
  // profilesStore.profiles 是全集；kanbanStore.assignees 仅作"已被使用过"的标记
  return profilesStore.profiles.map(p => ({
    label: p.alias || p.name,
    value: p.name,
    used: kanbanStore.assignees.includes(p.name),
  }))
})

const workspaceOptions = computed(() => [
  { label: t('kanban.form.workspaceScratch'), value: 'scratch' },
  { label: t('kanban.form.workspaceDir'), value: 'dir' },
  { label: t('kanban.form.workspaceWorktree'), value: 'worktree' },
])

function workspaceValue(): string | undefined {
  if (workspaceKind.value === 'scratch') return undefined
  const path = workspacePath.value.trim()
  if (!path) return workspaceKind.value
  return `${workspaceKind.value}:${path}`
}

function skillList(): string[] | undefined {
  return skills.value.length ? skills.value : undefined
}

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

onMounted(async () => {
  skillsLoading.value = true
  try {
    const data = await fetchSkills()
    skillOptions.value = buildSkillOptions(data.categories.flatMap(category => category.skills || []))
  } catch {
    skillOptions.value = []
  } finally {
    skillsLoading.value = false
  }
})

async function handleSubmit() {
  if (!title.value.trim()) {
    message.warning(t('kanban.form.titleRequired'))
    return
  }
  saving.value = true
  try {
    const payload: Parameters<typeof kanbanStore.createTask>[0] = {
      title: title.value.trim(),
      body: body.value.trim() || undefined,
      assignee: assignee.value || undefined,
      priority: priority.value ?? undefined,
    }
    const tenantValue = tenant.value.trim()
    const selectedWorkspace = workspaceValue()
    const branchValue = branch.value.trim()
    const selectedSkills = skillList()
    const runtimeValue = maxRuntime.value.trim()
    if (tenantValue) payload.tenant = tenantValue
    if (triage.value) payload.triage = true
    if (selectedWorkspace) payload.workspace = selectedWorkspace
    if (workspaceKind.value === 'worktree' && branchValue) payload.branch = branchValue
    if (selectedSkills) payload.skills = selectedSkills
    if (runtimeValue) payload.maxRuntime = runtimeValue
    if (maxRetries.value !== null) payload.maxRetries = maxRetries.value
    if (goalMode.value) {
      payload.goalMode = true
      if (goalMaxTurns.value !== null) payload.goalMaxTurns = goalMaxTurns.value
    }
    await kanbanStore.createTask(payload)
    message.success(t('kanban.message.taskCreated'))
    emit('created')
    emit('close')
  } catch (err: any) {
    message.error(err.message)
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <NModal :show="true" preset="dialog" :title="t('kanban.createTask')" style="width: 480px;" @close="emit('close')">
    <NForm label-placement="top">
      <NFormItem :label="t('kanban.form.title')">
        <NInput v-model:value="title" :input-props="autoDirectionInputProps" :placeholder="t('kanban.form.titlePlaceholder')" />
      </NFormItem>
      <NFormItem :label="t('kanban.form.body')">
        <NInput v-model:value="body" type="textarea" :rows="3" :input-props="autoDirectionInputProps" :placeholder="t('kanban.form.bodyPlaceholder')" />
      </NFormItem>
      <NFormItem :label="t('kanban.form.assignee')">
        <NSelect v-model:value="assignee" :options="assigneeOptions" :placeholder="t('kanban.form.selectAssignee')" clearable />
      </NFormItem>
      <NFormItem :label="t('kanban.form.priority')">
        <NSelect v-model:value="priority" :options="priorityOptions" :placeholder="t('kanban.form.selectPriority')" clearable />
      </NFormItem>
      <NFormItem :label="t('kanban.form.tenant')">
        <NInput v-model:value="tenant" :placeholder="t('kanban.form.tenantPlaceholder')" />
      </NFormItem>
      <NFormItem :label="t('kanban.form.workspace')">
        <NSelect v-model:value="workspaceKind" :options="workspaceOptions" />
      </NFormItem>
      <NFormItem v-if="workspaceKind !== 'scratch'" :label="t('kanban.form.workspacePath')">
        <NInput v-model:value="workspacePath" :placeholder="t('kanban.form.workspacePathPlaceholder')" />
      </NFormItem>
      <NFormItem v-if="workspaceKind === 'worktree'" :label="t('kanban.form.branch')">
        <NInput v-model:value="branch" :placeholder="t('kanban.form.branchPlaceholder')" />
      </NFormItem>
      <NFormItem :label="t('kanban.form.skills')">
        <NSelect
          v-model:value="skills"
          multiple
          filterable
          clearable
          :loading="skillsLoading"
          :options="skillOptions"
          :placeholder="t('kanban.form.skillsPlaceholder')"
        />
      </NFormItem>
      <div class="advanced-row">
        <NCheckbox v-model:checked="triage">{{ t('kanban.form.triage') }}</NCheckbox>
        <NCheckbox v-model:checked="goalMode">{{ t('kanban.form.goalMode') }}</NCheckbox>
      </div>
      <div class="advanced-grid">
        <NFormItem :label="t('kanban.form.maxRuntime')">
          <NInput v-model:value="maxRuntime" :placeholder="t('kanban.form.maxRuntimePlaceholder')" />
        </NFormItem>
        <NFormItem :label="t('kanban.form.maxRetries')">
          <NInputNumber
            v-model:value="maxRetries"
            :min="1"
            :max="100"
            :precision="0"
            :placeholder="t('kanban.form.maxRetriesPlaceholder')"
            clearable
          />
        </NFormItem>
        <NFormItem v-if="goalMode" :label="t('kanban.form.goalMaxTurns')">
          <NInputNumber
            v-model:value="goalMaxTurns"
            :min="1"
            :max="100"
            :precision="0"
            :placeholder="t('kanban.form.goalMaxTurnsPlaceholder')"
            clearable
          />
        </NFormItem>
      </div>
    </NForm>
    <template #action>
      <NButton @click="emit('close')">{{ t('common.cancel') }}</NButton>
      <NButton type="primary" :loading="saving" @click="handleSubmit">{{ t('common.create') }}</NButton>
    </template>
  </NModal>
</template>

<style scoped lang="scss">
.advanced-row {
  display: flex;
  gap: 16px;
  margin: 0 0 12px;
  flex-wrap: wrap;
}

.advanced-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 10px;
}
</style>
