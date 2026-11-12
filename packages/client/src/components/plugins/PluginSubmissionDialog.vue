<script setup lang="ts">
import { computed, onBeforeUnmount, reactive, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { NAlert, NButton, NForm, NFormItem, NInput, NModal, type FormInst, type FormRules } from 'naive-ui'
import { PluginSubmissionError, submissionLimits, submitPlugin, validSubmissionField, type PluginSubmission } from '@/api/studio/plugin-submissions'

const show = defineModel<boolean>('show', { default: false })
const { t } = useI18n()
const form = ref<FormInst>(), draft = reactive<PluginSubmission>({ repository: '', name: '', description: '' })
const busy = ref(false), submitted = ref(false), error = ref('')
let controller: AbortController | undefined
const rules = computed<FormRules>(() => Object.fromEntries((Object.keys(submissionLimits) as Array<keyof PluginSubmission>).map(field => [field, {
  required: true,
  trigger: ['input', 'blur'],
  validator: (_rule: unknown, value: string) => validSubmissionField(field, value) || new Error(t(`studioPluginSubmission.invalid_${field}`)),
}])))
watch(show, value => {
  if (value && submitted.value) {
    Object.assign(draft, { repository: '', name: '', description: '' }); submitted.value = false; error.value = ''
  }
})
onBeforeUnmount(() => controller?.abort())
function close(value = false) { if (!busy.value) show.value = value }
async function submit() {
  if (busy.value || submitted.value) return
  busy.value = true; error.value = ''
  try {
    try { await form.value?.validate() } catch { return }
    controller = new AbortController()
    await submitPlugin(draft, controller.signal)
    if (!controller.signal.aborted) submitted.value = true
  } catch (cause) {
    if (!controller?.signal.aborted) error.value = cause instanceof PluginSubmissionError ? cause.kind : 'uncertain'
  } finally { busy.value = false }
}
</script>

<template>
  <NModal :show="show" preset="card" :title="t('studioPluginSubmission.title')" class="plugin-submission-modal"
    style="width: min(540px, calc(100vw - 32px))"
    :closable="!busy" :mask-closable="!busy" :close-on-esc="!busy" @update:show="close">
    <div v-if="submitted" class="submission-result">
      <NAlert type="success" :title="t('studioPluginSubmission.submitted')">{{ t('studioPluginSubmission.pending') }}</NAlert>
      <NButton @click="close()">{{ t('common.close') }}</NButton>
    </div>
    <template v-else>
      <p class="submission-hint">{{ t('studioPluginSubmission.hint') }}</p>
      <NForm ref="form" :model="draft" :rules="rules" :disabled="busy" @submit.prevent="submit">
        <NFormItem path="repository" :label="t('studioPluginSubmission.repository')">
          <NInput v-model:value="draft.repository" :maxlength="submissionLimits.repository" placeholder="https://github.com/owner/my-plugin" :input-props="{ 'aria-label': t('studioPluginSubmission.repository') }" />
        </NFormItem>
        <NFormItem path="name" :label="t('studioPluginSubmission.name')">
          <NInput v-model:value="draft.name" :maxlength="submissionLimits.name" :placeholder="t('studioPluginSubmission.name')" :input-props="{ 'aria-label': t('studioPluginSubmission.name') }" />
        </NFormItem>
        <NFormItem path="description" :label="t('studioPluginSubmission.description')">
          <NInput v-model:value="draft.description" type="textarea" :autosize="{ minRows: 3, maxRows: 6 }" :maxlength="submissionLimits.description" show-count
            :placeholder="t('studioPluginSubmission.description')" :input-props="{ 'aria-label': t('studioPluginSubmission.description') }" />
        </NFormItem>
        <NAlert v-if="error" class="submission-error" type="error" role="alert">{{ t('studioPluginSubmission.' + error) }}</NAlert>
        <div class="submission-actions">
          <NButton :disabled="busy" @click="close()">{{ t('common.cancel') }}</NButton>
          <NButton type="primary" attr-type="submit" :disabled="busy" :loading="busy" :aria-label="t('studioPluginSubmission.submit')">{{ t('studioPluginSubmission.submit') }}</NButton>
        </div>
      </NForm>
    </template>
  </NModal>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;
.submission-hint { margin: 0 0 20px; color: $text-secondary; line-height: 1.7; }
.submission-actions { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 8px; }
.submission-error { margin-bottom: 16px; }
.submission-result { display: flex; flex-direction: column; align-items: flex-start; gap: 20px; }
</style>
