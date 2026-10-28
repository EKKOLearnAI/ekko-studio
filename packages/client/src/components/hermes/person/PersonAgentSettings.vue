<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { NAlert, NButton, NInput, NSelect, NSpin } from 'naive-ui'
import { personRequest, type PersonAgentPreset } from '@/api/person'
import type { AvailableModelGroup } from '@/api/hermes/system'
import type { CodingAgentId, ChatCodingAgentId } from '@/api/coding-agents'
import { AGENT_OPTIONS } from '@/utils/agent-options'
import { isGlobalOnlyCodingAgent } from '@/utils/agent-catalog'
import { canScopedCodingAgentUseProvider } from '@/utils/codingAgentProviders'
import { agentReasoningEffortOptions, agentReasoningEffortValue, modelReasoningEfforts } from '@/utils/model-reasoning-effort'
import ScopedModelSelector from '@/components/hermes/models/ScopedModelSelector.vue'
import PersonPanelIcon from './PersonPanelIcon.vue'
import { chatSessionAgentAvatar } from '@/utils/chat-agent-avatar'
import NativeCodingAgentModelFields from '@/components/hermes/models/NativeCodingAgentModelFields.vue'

const props = defineProps<{ agents: PersonAgentPreset[]; saving: boolean; saveError?: string }>()
const emit = defineEmits<{ save: [agents: PersonAgentPreset[]] }>()
const { t } = useI18n()
const draft = ref<PersonAgentPreset[]>([])
const groups = ref<Array<AvailableModelGroup & { profile: string }>>([])
const resourceProfiles = ref<string[]>([])
const installed = ref<string[]>([])
const nativeAllowed = ref(false)
const loading = ref(true)
const error = ref('')
const editingId = ref<string | null>(null)
const editingAgent = computed(() => draft.value.find(agent => agent.id === editingId.value))
const dirty = computed(() => JSON.stringify(draft.value) !== JSON.stringify(props.agents || []))
watch(() => JSON.stringify(props.agents || []), value => { draft.value = JSON.parse(value); editingId.value = null }, { immediate: true })
watch(() => props.saving, (saving, wasSaving) => { if (wasSaving && !saving && !props.saveError && !dirty.value) editingId.value = null })
const profiles = computed(() => resourceProfiles.value.map(value => ({ label: value, value })))
const agentOptions = computed(() => AGENT_OPTIONS.map(option => ({ ...option, value: option.value === 'ekko-agent' ? 'ekko' : option.value,
  disabled: !installed.value.includes(option.value === 'ekko-agent' ? 'ekko' : option.value) || (!nativeAllowed.value && isGlobalOnlyCodingAgent(option.value)) })))
const valid = computed(() => draft.value.every(agent => agent.name.trim() && agent.description.trim() && agent.selection.runtime && agent.selection.profile
  && (agent.selection.mode === 'global' || (agent.selection.provider && agent.selection.model))))
function groupsFor(agent: PersonAgentPreset) {
  if (!agent.selection.runtime) return []
  return groups.value.filter(group => group.profile === agent.selection.profile
    && (agent.selection.runtime === 'hermes' || canScopedCodingAgentUseProvider((agent.selection.runtime === 'ekko' ? 'ekko-agent' : agent.selection.runtime) as ChatCodingAgentId, group.provider)))
    .map(group => ({ ...group, models: group.models.filter(model => agent.selection.runtime === 'hermes'
      || !['bedrock_converse', 'codex_app_server'].includes(group.api_mode_by_model?.[model] || group.api_mode || '')) }))
}
function efforts(agent: PersonAgentPreset) {
  return agentReasoningEffortOptions([{ label: t('chat.reasoningEffort.options.none'), value: '' }, ...modelReasoningEfforts(groupsFor(agent), agent.selection.provider, agent.selection.model)
    .map(value => ({ label: t(`chat.reasoningEffort.options.${value}`), value }))])
}
function resetModel(agent: PersonAgentPreset) { agent.selection.provider = ''; agent.selection.model = ''; agent.selection.reasoningEffort = '' }
function changeRuntime(agent: PersonAgentPreset, runtime: string) {
  agent.selection.runtime = runtime
  agent.selection.mode = isGlobalOnlyCodingAgent(runtime) ? 'global' : 'scoped'
  resetModel(agent)
}
function add() {
  editingId.value = crypto.randomUUID()
  draft.value.push({ id: editingId.value, name: '', description: '', selection: { runtime: '', mode: 'scoped',
    profile: profiles.value[0]?.value || '', provider: '', model: '', reasoningEffort: '' } })
}
function cancelEdit() {
  const index = draft.value.findIndex(agent => agent.id === editingId.value)
  const saved = props.agents.find(agent => agent.id === editingId.value)
  if (index >= 0) { if (saved) draft.value[index] = JSON.parse(JSON.stringify(saved)); else draft.value.splice(index, 1) }
  editingId.value = null
}
function avatar(runtime: string) { return chatSessionAgentAvatar({ agent: runtime }) }
function save() {
  if (valid.value && !props.saving && !error.value) emit('save', draft.value.map(agent => ({ ...agent,
    selection: { ...agent.selection, reasoningEffort: agent.selection.mode === 'global' ? agent.selection.reasoningEffort
      : agentReasoningEffortValue(agent.selection.reasoningEffort, efforts(agent)) },
  })))
}
onMounted(async () => {
  try {
    const [models, capabilities] = await Promise.all([
      personRequest<{ groups: Array<AvailableModelGroup & { profile: string }>; profiles?: string[] }>('/agent-models'),
      personRequest<{ agents: Array<{ runtime: string; installed: boolean }>; native_allowed: boolean }>('/capabilities'),
    ])
    groups.value = models.groups
    resourceProfiles.value = models.profiles || [...new Set(models.groups.map(group => group.profile))]
    installed.value = capabilities.agents.filter(agent => agent.installed).map(agent => agent.runtime)
    nativeAllowed.value = capabilities.native_allowed
  } catch (e) { error.value = String(e) } finally { loading.value = false }
})
</script>

<template>
  <section class="person-panel person-agent-settings">
    <header class="panel-heading"><div><h2>{{ t('person.agentsTitle') }}</h2><p>{{ t('person.agentsHint') }}</p></div><NButton type="primary" :disabled="loading || saving || !!editingId || draft.length >= 20 || !!error" @click="add"><template #icon><PersonPanelIcon name="plus" :size="18" /></template>{{ t('person.addAgent') }}</NButton></header>
    <NAlert v-if="error || saveError" class="panel-error" type="error">{{ saveError || error }}</NAlert>
    <NSpin v-if="loading" />
    <template v-else>
      <form v-if="editingAgent" class="panel-editor" data-theme-surface="card" @submit.prevent="save">
        <div class="editor-heading"><img v-if="editingAgent.selection.runtime" class="agent-avatar" :src="avatar(editingAgent.selection.runtime).src" alt="" /><span v-else class="tile-icon"><PersonPanelIcon name="agents" :size="22" /></span><h3 :title="editingAgent.name || t('person.addAgent')">{{ editingAgent.name || t('person.addAgent') }}</h3></div>
        <fieldset class="runtime-picker"><legend>{{ t('person.agentRuntime') }}</legend><div class="runtime-grid">
          <button v-for="option in agentOptions.filter(item => !item.disabled || item.value === editingAgent?.selection.runtime)" :key="option.value" type="button" class="runtime-option" :class="{ selected: editingAgent.selection.runtime === option.value }" :aria-pressed="editingAgent.selection.runtime === option.value" :disabled="saving || option.disabled" @click="changeRuntime(editingAgent, option.value)"><img :src="avatar(option.value).src" alt="" /><span class="runtime-label" :title="option.label">{{ option.label }}</span><span v-if="editingAgent.selection.runtime === option.value" class="runtime-check" aria-hidden="true">✓</span></button>
        </div></fieldset>
        <div class="editor-fields">
        <label>{{ t('person.agentName') }}<NInput v-model:value="editingAgent.name" :maxlength="100" :disabled="saving" :input-props="{ 'aria-label': t('person.agentName') }" /></label>
        <label>{{ t('person.agentResource') }}<NSelect v-model:value="editingAgent.selection.profile" :options="profiles" :disabled="saving" :aria-label="t('person.agentResource')" @update:value="resetModel(editingAgent)" /></label>
        <label class="field-wide">{{ t('person.agentPurpose') }}<NInput v-model:value="editingAgent.description" type="textarea" :maxlength="1000" :disabled="saving" :autosize="{ minRows: 2, maxRows: 4 }" :input-props="{ 'aria-label': t('person.agentPurpose') }" /></label>
        <label v-if="editingAgent.selection.runtime && !['ekko', 'hermes'].includes(editingAgent.selection.runtime)">{{ t('person.agentMode') }}
          <NSelect v-model:value="editingAgent.selection.mode" :disabled="saving || isGlobalOnlyCodingAgent(editingAgent.selection.runtime)" :aria-label="t('person.agentMode')"
            :options="[{ label: t('person.scopedMode'), value: 'scoped' }, { label: t('person.nativeMode'), value: 'global', disabled: !nativeAllowed }]" @update:value="resetModel(editingAgent)" />
        </label>
        <template v-if="editingAgent.selection.mode === 'scoped'">
          <label>{{ t('person.chooseModel') }}<ScopedModelSelector :provider="editingAgent.selection.provider" :model="editingAgent.selection.model" :groups="groupsFor(editingAgent)" :disabled="saving || !editingAgent.selection.runtime"
            @select="Object.assign(editingAgent.selection, $event, { reasoningEffort: '' })" /></label>
          <label>{{ t('chat.reasoningEffort.tooltip') }}<NSelect :value="agentReasoningEffortValue(editingAgent.selection.reasoningEffort, efforts(editingAgent))" @update:value="editingAgent.selection.reasoningEffort = $event" :options="efforts(editingAgent)" :disabled="saving || !editingAgent.selection.model" :aria-label="t('chat.reasoningEffort.tooltip')" /></label>
        </template>
        <template v-else>
          <label>{{ t('person.chooseModel') }}<NativeCodingAgentModelFields :agent="editingAgent.selection.runtime as CodingAgentId" :model="editingAgent.selection.model" :reasoning-effort="editingAgent.selection.reasoningEffort" :disabled="saving" @change="Object.assign(editingAgent.selection, $event)" /></label>
          <label>{{ t('chat.reasoningEffort.tooltip') }}<NativeCodingAgentModelFields field="reasoning-effort" :agent="editingAgent.selection.runtime as CodingAgentId" :model="editingAgent.selection.model" :reasoning-effort="editingAgent.selection.reasoningEffort" :disabled="saving" @change="Object.assign(editingAgent.selection, $event)" /></label>
        </template>
        </div>
        <footer class="editor-actions"><NButton :disabled="saving" @click="cancelEdit">{{ t('common.cancel') }}</NButton><NButton attr-type="submit" type="primary" :loading="saving" :disabled="!valid || !!error">{{ t('common.save') }}</NButton></footer>
      </form>
      <template v-else>
        <div class="panel-toolbar"><span class="panel-count"><strong>{{ draft.length }}</strong>{{ t('person.agentRuntime') }}</span><span class="tile-meta">{{ t('person.agentTeamHint') }}</span></div>
        <div v-if="!draft.length" class="panel-empty" data-theme-surface="card"><PersonPanelIcon name="agents" :size="32" /><h3>{{ t('person.agentsEmpty') }}</h3><p>{{ t('person.agentSetupHint') }}</p></div>
        <div v-else class="panel-grid">
          <article v-for="(agent, index) in draft" :key="agent.id" class="panel-tile agent-card" data-theme-surface="card">
            <div class="agent-identity"><img class="agent-avatar" :src="avatar(agent.selection.runtime).src" alt="" /><div><h3 :title="agent.name">{{ agent.name }}</h3><span class="tile-meta agent-runtime-label" :title="avatar(agent.selection.runtime).label">{{ avatar(agent.selection.runtime).label }}</span></div></div>
            <p class="agent-description">{{ agent.description }}</p>
            <div class="agent-model"><span class="tile-meta">{{ t('person.chooseModel') }}</span><span>{{ agent.selection.model || t('person.nativeMode') }}</span></div>
            <footer class="tile-footer"><span class="tile-meta">{{ agent.selection.profile }}</span><div class="tile-actions"><NButton quaternary size="small" :disabled="saving" @click="draft.splice(index, 1)">{{ t('common.delete') }}</NButton><NButton secondary size="small" :disabled="saving" @click="editingId = agent.id">{{ t('common.edit') }}</NButton></div></footer>
          </article>
        </div>
        <div v-if="dirty" class="editor-actions"><NButton :disabled="saving" @click="draft = JSON.parse(JSON.stringify(agents))">{{ t('common.cancel') }}</NButton><NButton type="primary" :loading="saving" :disabled="!valid || !!error" @click="save">{{ t('common.save') }}</NButton></div>
      </template>
    </template>
  </section>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;
@use './person-panels';
.agent-identity { display: flex; align-items: center; gap: 14px; }
.agent-identity > div { min-width: 0; flex: 1; }
.agent-identity h3, .editor-heading h3, .agent-runtime-label { min-width: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.agent-runtime-label { display: block; }
.editor-heading h3 { flex: 1; }
.agent-avatar { width: 44px; height: 44px; flex-shrink: 0; object-fit: contain; border-radius: var(--radius-component, 10px); }
.agent-description { color: $text-secondary; font-size: 14px; line-height: 1.8; white-space: pre-wrap; overflow-wrap: anywhere; margin: 22px 0; }
.agent-model { display: flex; flex-direction: column; gap: 5px; margin: auto 0 22px; font-size: 13px; overflow-wrap: anywhere; }
.runtime-picker { border: 0; padding: 0; margin: 0 0 24px; min-width: 0; }
.runtime-picker legend { font-size: 12px; color: $text-secondary; margin-bottom: 10px; }
.runtime-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(135px, 1fr)); gap: 10px; }
.runtime-option { height: 56px; min-width: 0; display: flex; align-items: center; gap: 10px; position: relative; padding: 14px; background: transparent; color: $text-primary; font: inherit; font-size: 13px; border: 1px solid $border-color; border-radius: var(--radius-component, 8px); cursor: pointer; text-align: start; }
.runtime-option img { flex-shrink: 0; width: 26px; height: 26px; object-fit: contain; }
.runtime-option.selected { border-color: $accent-primary; background: rgba(var(--accent-primary-rgb), .05); }
.runtime-option:focus-visible { outline: 2px solid $accent-primary; outline-offset: 2px; }
.runtime-option:disabled { opacity: .5; cursor: not-allowed; }
.runtime-label { min-width: 0; flex: 1; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.runtime-check { flex-shrink: 0; margin-inline-start: auto; }
</style>
