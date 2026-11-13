<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { NButton, NForm, NFormItem, NInput, NModal, NSelect, useMessage } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import { fetchSkills } from '@/api/hermes/skills'
import {
  createSkillBundleApi,
  skillBundleCommandName,
  type SkillBundleInfo,
} from '@/api/hermes/skill-bundles'

const props = defineProps<{
  profile: string
}>()

const emit = defineEmits<{
  close: []
  created: [bundle: SkillBundleInfo]
}>()

const { t } = useI18n()
const message = useMessage()
const name = ref('')
const description = ref('')
const selectedSkills = ref<string[]>([])
const skillOptions = ref<Array<{ label: string; value: string }>>([])
const skillsLoading = ref(false)
const saving = ref(false)
const commandPreview = computed(() => skillBundleCommandName(name.value))

function handleNameInput(value: string) {
  name.value = value.replace(/[^A-Za-z0-9 _-]/g, '')
}

async function loadSkillOptions() {
  skillsLoading.value = true
  try {
    const data = await fetchSkills(props.profile)
    const byName = new Map<string, { label: string; value: string }>()
    for (const category of data.categories || []) {
      for (const skill of category.skills || []) {
        if (skill.enabled === false || byName.has(skill.name)) continue
        byName.set(skill.name, { label: skill.name, value: skill.name })
      }
    }
    skillOptions.value = [...byName.values()].sort((a, b) => a.label.localeCompare(b.label))
  } catch (err: any) {
    skillOptions.value = []
    message.error(`${t('chat.bundleCreator.skillsLoadFailed')}: ${err?.message || ''}`)
  } finally {
    skillsLoading.value = false
  }
}

function handleShowChange(show: boolean) {
  if (!show && !saving.value) emit('close')
}

async function saveBundle() {
  if (!name.value.trim()) {
    message.warning(t('chat.bundleCreator.nameRequired'))
    return
  }
  if (!commandPreview.value) {
    message.warning(t('chat.bundleCreator.nameInvalid'))
    return
  }
  if (!/[A-Za-z]/.test(name.value)) {
    message.warning(t('chat.bundleCreator.nameInvalid'))
    return
  }
  if (selectedSkills.value.length === 0) {
    message.warning(t('chat.bundleCreator.skillsRequired'))
    return
  }

  saving.value = true
  try {
    const bundle = await createSkillBundleApi(props.profile, {
      name: name.value.trim(),
      description: description.value.trim(),
      skills: selectedSkills.value,
    })
    message.success(t('chat.bundleCreator.created'))
    emit('created', bundle)
  } catch (err: any) {
    message.error(`${t('chat.bundleCreator.createFailed')}: ${err?.message || ''}`)
  } finally {
    saving.value = false
  }
}

onMounted(loadSkillOptions)
</script>

<template>
  <NModal
    :show="true"
    preset="card"
    :title="t('chat.bundleCreator.title')"
    :mask-closable="!saving"
    style="width: min(560px, calc(100vw - 32px))"
    @update:show="handleShowChange"
  >
    <NForm label-placement="top" @submit.prevent="saveBundle">
      <NFormItem :label="t('chat.bundleCreator.name')" required>
        <NInput
          :value="name"
          :maxlength="120"
          :placeholder="t('chat.bundleCreator.namePlaceholder')"
          autofocus
          @update:value="handleNameInput"
        />
      </NFormItem>
      <div class="bundle-name-hint">{{ t('chat.bundleCreator.nameHint') }}</div>
      <div v-if="commandPreview" class="bundle-command-preview">
        /bundles {{ commandPreview }}
      </div>
      <NFormItem :label="t('chat.bundleCreator.description')">
        <NInput
          v-model:value="description"
          type="textarea"
          :maxlength="1000"
          :autosize="{ minRows: 2, maxRows: 4 }"
          :placeholder="t('chat.bundleCreator.descriptionPlaceholder')"
        />
      </NFormItem>
      <NFormItem :label="t('chat.bundleCreator.skills')" required>
        <NSelect
          v-model:value="selectedSkills"
          multiple
          filterable
          :loading="skillsLoading"
          :options="skillOptions"
          :placeholder="t('chat.bundleCreator.skillsPlaceholder')"
        />
      </NFormItem>
      <div class="bundle-create-actions">
        <NButton :disabled="saving" @click="emit('close')">
          {{ t('common.cancel') }}
        </NButton>
        <NButton type="primary" :loading="saving" @click="saveBundle">
          {{ t('common.create') }}
        </NButton>
      </div>
    </NForm>
  </NModal>
</template>

<style scoped lang="scss">
.bundle-command-preview {
  margin: -10px 0 14px;
  padding: calc(7px * var(--spacing-scale, 1)) calc(10px * var(--spacing-scale, 1));
  border-radius: var(--radius-component, 8px);
  color: var(--text-secondary);
  background: var(--bg-secondary);
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  font-size: calc(var(--font-size-base, 14px) * 12 / 14);
}

.bundle-name-hint {
  margin: -12px 0 14px;
  color: var(--text-muted);
  font-size: calc(var(--font-size-base, 14px) * 12 / 14);
}

.bundle-create-actions {
  display: flex;
  justify-content: flex-end;
  gap: calc(8px * var(--spacing-scale, 1));
  margin-top: 8px;
}
</style>
