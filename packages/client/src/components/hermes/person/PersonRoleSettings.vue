<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { NAlert, NButton, NForm, NFormItem, NInput, NSelect } from 'naive-ui'
import { personRequest, type PersonAgentPreset, type PersonProject, type PersonRoleConfiguration } from '@/api/person'
import type { SessionSummary } from '@/api/studio/sessions'
import { PERSON_BOTS } from '../../../../../shared/person-bots'
import { deploymentUrl } from '@/utils/deployment-url'
import { personBotLabel } from '@/utils/person-bot-label'

const props = defineProps<{ session: SessionSummary; role?: PersonRoleConfiguration; projects: PersonProject[]; agents: PersonAgentPreset[]; busy: boolean }>()
const emit = defineEmits<{ saved: [] }>()
const { t } = useI18n()
const draft = ref({ title: '', bot_type: 'zhezhe', project_id: '', instructions: '', allowed_agents: [] as string[], expected_revision: 0 })
const saving = ref(false), error = ref('')
watch(() => [props.session.id, props.role?.revision], () => {
  draft.value = { title: props.session.title || '', bot_type: props.session.bot_type || 'zhezhe', project_id: props.role?.project_id || '',
    instructions: props.role?.instructions || '', allowed_agents: [...(props.role?.allowed_agents || [])], expected_revision: props.role?.revision || 0 }
  error.value = ''
}, { immediate: true })
const projectOptions = computed(() => [{ label: t('person.accountCoordination'), value: '' }, ...props.projects.map(p => ({ label: p.name, value: p.id }))])
async function save() {
  saving.value = true; error.value = ''
  try { await personRequest(`/conversations/${encodeURIComponent(props.session.id)}/role`, draft.value, 'PUT'); emit('saved') }
  catch (e) { error.value = String(e) }
  finally { saving.value = false }
}
</script>

<template>
  <section class="person-panel">
    <header class="panel-heading"><div><h2>{{ t('person.roleSettings') }}</h2><p>{{ t('person.roleHint') }}</p></div></header>
    <NAlert v-if="error" type="error">{{ error }}</NAlert>
    <NForm label-placement="top" :disabled="busy || saving" @submit.prevent="save">
      <NFormItem :label="t('person.botName')"><NInput v-model:value="draft.title" :maxlength="100" :input-props="{ 'aria-label': t('person.botName') }" /></NFormItem>
      <NFormItem :label="t('person.roleAvatar')">
        <div class="role-avatars" role="group" :aria-label="t('person.roleAvatar')">
          <button v-for="bot in PERSON_BOTS" :key="bot.type" type="button" :aria-label="personBotLabel(bot)" :aria-pressed="draft.bot_type === bot.type" :class="{ selected: draft.bot_type === bot.type }" :disabled="busy || saving" @click="draft.bot_type = bot.type">
            <img :src="deploymentUrl(bot.idleFrame)" alt="" /><span>{{ personBotLabel(bot) }}</span>
          </button>
        </div>
      </NFormItem>
      <NFormItem :label="t('person.roleInstructions')"><NInput v-model:value="draft.instructions" type="textarea" :autosize="{ minRows: 4, maxRows: 12 }" :maxlength="8000" :input-props="{ 'aria-label': t('person.roleInstructions') }" /></NFormItem>
      <NFormItem :label="t('person.boundProject')"><NSelect v-model:value="draft.project_id" :options="projectOptions" :aria-label="t('person.boundProject')" /></NFormItem>
      <p class="scope-hint">{{ t('person.projectMemoryHint') }}</p>
      <NFormItem :label="t('person.allowedExecutors')"><NSelect v-model:value="draft.allowed_agents" multiple :options="agents.map(a => ({ label: a.name, value: a.id }))" :aria-label="t('person.allowedExecutors')" /></NFormItem>
      <p class="scope-hint">{{ t('person.allowedExecutorsHint') }}</p>
      <div class="editor-actions"><NButton type="primary" attr-type="submit" :loading="saving" :disabled="busy || saving || !draft.title.trim()">{{ t('common.save') }}</NButton></div>
    </NForm>
  </section>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;
@use './person-panels';
.role-avatars { display: grid; grid-template-columns: repeat(auto-fit, minmax(88px, 1fr)); width: 100%; gap: 8px; }
.role-avatars button { display: flex; flex-direction: column; align-items: center; padding: 8px; border: 1px solid $border-light; border-radius: var(--radius-component, 8px); background: transparent; color: $text-secondary; font: inherit; cursor: pointer; }
.role-avatars button.selected { border-color: $accent-primary; color: $text-primary; background: rgba(var(--accent-primary-rgb), .06); }
.role-avatars button:focus-visible { outline: 2px solid $accent-primary; outline-offset: 2px; }
.role-avatars button:disabled { opacity: .5; cursor: not-allowed; }
.role-avatars img { width: 48px; height: 48px; object-fit: contain; }
.scope-hint { margin: 0 0 20px; color: $text-secondary; font-size: 12px; line-height: 1.7; }
</style>
