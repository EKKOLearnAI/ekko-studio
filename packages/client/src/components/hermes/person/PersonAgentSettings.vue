<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { NAlert, NButton, NInput, NModal, NSelect, NSpin } from 'naive-ui'
import { applyPersonTeam, personRequest, personTeamUsage, PERSON_DEFAULT_TEAM_ID,
  type PersonAgentPreset, type PersonTeam, type PersonTeamUsage } from '@/api/person'
import type { AvailableModelGroup } from '@/api/hermes/system'
import type { CodingAgentId, ChatCodingAgentId } from '@/api/coding-agents'
import type { StudioAgent } from '@/api/studio/agents'
import { AGENT_OPTIONS, syncPluginAgentOptions } from '@/utils/agent-options'
import { isGlobalOnlyCodingAgent, agentSupportsSurface, agentMetadata } from '@/utils/agent-catalog'
import { canScopedCodingAgentUseProvider } from '@/utils/codingAgentProviders'
import { agentReasoningEffortOptions, agentReasoningEffortValue, modelReasoningEfforts } from '@/utils/model-reasoning-effort'
import ScopedModelSelector from '@/components/hermes/models/ScopedModelSelector.vue'
import { clientUuid } from '@/utils/secure-uuid'
import PersonPanelIcon from './PersonPanelIcon.vue'
import { chatSessionAgentAvatar } from '@/utils/chat-agent-avatar'
import NativeCodingAgentModelFields from '@/components/hermes/models/NativeCodingAgentModelFields.vue'

const props = defineProps<{ teams: PersonTeam[]; teamId: string; saving: boolean; saveError?: string }>()
const emit = defineEmits<{ reloaded: [] }>()
const { t, te } = useI18n()
const draft = ref<PersonAgentPreset[]>([])
const groups = ref<Array<AvailableModelGroup & { profile: string }>>([])
const resourceProfiles = ref<string[]>([])
const installed = ref<string[]>([])
const nativeAllowed = ref(false)
const loading = ref(true)
const error = ref('')
const editingId = ref<string | null>(null)
const selectedTeamId = ref(props.teamId || props.teams[0]?.id || '')
const creating = ref(false)
const newTeamName = ref('')
const newTeamError = ref('')
const writePending = ref(false)
const deleteTarget = ref<PersonTeam | null>(null)
const deleteUsage = ref<PersonTeamUsage | null>(null)
const deleting = ref(false)
const renameTarget = ref<PersonTeam | null>(null)
const renameName = ref('')
const renameError = ref('')
const renaming = ref(false)

const selectedTeam = computed(() => props.teams.find(team => team.id === selectedTeamId.value) || props.teams[0])
const agents = computed(() => selectedTeam.value?.agents || [])
const teamChoices = computed(() => props.teams.map(team => ({ label: team.name, value: team.id })))
const editingAgent = computed(() => draft.value.find(agent => agent.id === editingId.value))
const busy = computed(() => props.saving || writePending.value)
const dirty = computed(() => JSON.stringify(draft.value) !== JSON.stringify(agents.value))
const profiles = computed(() => resourceProfiles.value.map(value => ({ label: value, value })))
const agentOptions = computed(() => AGENT_OPTIONS.filter(option => agentSupportsSurface(option.value, 'chat')).map(option => ({ ...option, value: option.value === 'ekko-agent' ? 'ekko' : option.value,
  disabled: !installed.value.includes(option.value === 'ekko-agent' ? 'ekko' : option.value) || (!nativeAllowed.value && !option.value.startsWith('plugin:') && isGlobalOnlyCodingAgent(option.value)) })))
const valid = computed(() => draft.value.every(agent => agent.name.trim() && agent.description.trim() && agent.selection.runtime && agent.selection.profile
  && (agent.selection.mode === 'global' || (agent.selection.provider && agent.selection.model))))

/** Follow the account's default team until the user picks one explicitly. */
watch(() => [props.teamId, props.teams.map(team => team.id).join(',')], () => {
  if (!props.teams.some(team => team.id === selectedTeamId.value)) selectedTeamId.value = props.teamId || props.teams[0]?.id || ''
})
watch(() => JSON.stringify(agents.value), () => { draft.value = JSON.parse(JSON.stringify(agents.value)); editingId.value = null }, { immediate: true })
watch(() => props.saving, (saving, wasSaving) => { if (wasSaving && !saving && !props.saveError && !dirty.value) editingId.value = null })

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
function resetModel(agent: PersonAgentPreset) { agent.selection.provider = ''; agent.selection.model = ''; agent.selection.apiMode = undefined; agent.selection.reasoningEffort = '' }
function selectModel(agent: PersonAgentPreset, selection: Pick<PersonAgentPreset['selection'], 'provider' | 'model' | 'apiMode'>) {
  const changed = agent.selection.provider !== selection.provider || agent.selection.model !== selection.model
  Object.assign(agent.selection, selection)
  if (changed) agent.selection.reasoningEffort = ''
}
function changeRuntime(agent: PersonAgentPreset, runtime: string) {
  agent.selection.runtime = runtime
  agent.selection.mode = isGlobalOnlyCodingAgent(runtime) ? 'global' : 'scoped'
  resetModel(agent)
}
function add() {
  editingId.value = clientUuid()
  draft.value.push({ id: editingId.value, name: '', description: '', selection: { runtime: '', mode: 'scoped',
    profile: profiles.value[0]?.value || '', provider: '', model: '', reasoningEffort: '' } })
}
function cancelEdit() {
  const index = draft.value.findIndex(agent => agent.id === editingId.value)
  const saved = agents.value.find(agent => agent.id === editingId.value)
  if (index >= 0) { if (saved) draft.value[index] = JSON.parse(JSON.stringify(saved)); else draft.value.splice(index, 1) }
  editingId.value = null
}
function avatar(runtime: string) { return chatSessionAgentAvatar({ agent: runtime }) }
function reasoningLabel(agent: PersonAgentPreset) {
  const value = agent.selection.reasoningEffort?.trim()
  if (!value) return t('chat.reasoningEffort.defaultLabel')
  const key = `chat.reasoningEffort.options.${value}`
  return te(key) ? t(key) : value
}
async function save() {
  if (!valid.value || busy.value || error.value || !selectedTeam.value) return
  const team = selectedTeam.value
  writePending.value = true; error.value = ''
  try {
    // One team's presets are saved atomically; other teams never reload.
    await applyPersonTeam({ action: 'save', team_id: team.id, expected_revision: team.revision,
      agents: draft.value.map(agent => ({ ...agent, selection: { ...agent.selection,
        reasoningEffort: agent.selection.mode === 'global' ? agent.selection.reasoningEffort
          : agentReasoningEffortValue(agent.selection.reasoningEffort, efforts(agent)) } })) })
    editingId.value = null
    emit('reloaded')
  } catch (e) { error.value = String(e) } finally { writePending.value = false }
}
function openCreate() { newTeamName.value = ''; newTeamError.value = ''; creating.value = true }
async function createTeam() {
  const name = newTeamName.value.trim()
  if (!name) return
  writePending.value = true; newTeamError.value = ''
  try {
    const result = await applyPersonTeam({ action: 'create', name })
    if (result.team) selectedTeamId.value = result.team.id
    creating.value = false
    emit('reloaded')
  } catch (e) { newTeamError.value = String(e) } finally { writePending.value = false }
}
async function openDelete(team: PersonTeam) {
  deleteTarget.value = team
  deleteUsage.value = null
  try { deleteUsage.value = await personTeamUsage(team.id) } catch (e) { error.value = String(e) }
}
function openRename(team: PersonTeam) { renameTarget.value = team; renameName.value = team.name; renameError.value = '' }
async function confirmRename() {
  const team = renameTarget.value
  const name = renameName.value.trim()
  if (!team || !name || busy.value) return
  renaming.value = true; renameError.value = ''
  try {
    await applyPersonTeam({ action: 'rename', team_id: team.id, name, expected_revision: team.revision })
    renameTarget.value = null
    emit('reloaded')
  } catch (e) { renameError.value = String(e); } finally { renaming.value = false }
}
async function confirmDelete() {
  const team = deleteTarget.value
  if (!team) return
  deleting.value = true; error.value = ''
  try {
    await applyPersonTeam({ action: 'delete', team_id: team.id, expected_revision: team.revision })
    if (selectedTeamId.value === team.id) selectedTeamId.value = PERSON_DEFAULT_TEAM_ID
    deleteTarget.value = null; deleteUsage.value = null
    emit('reloaded')
  } catch (e) { error.value = String(e) } finally { deleting.value = false }
}
onMounted(async () => {
  try {
    const [models, capabilities] = await Promise.all([
      personRequest<{ groups: Array<AvailableModelGroup & { profile: string }>; profiles?: string[] }>('/agent-models'),
      personRequest<{ agents: Array<{ runtime: string; installed: boolean; descriptor?: Omit<StudioAgent, 'status'> }>; native_allowed: boolean }>('/capabilities'),
    ])
    syncPluginAgentOptions(capabilities.agents.flatMap(agent => agent.descriptor ? [{ ...agent.descriptor, status: { installed: agent.installed, version: '' } }] : []))
    groups.value = models.groups
    resourceProfiles.value = models.profiles || [...new Set(models.groups.map(group => group.profile))]
    installed.value = capabilities.agents.filter(agent => agent.installed).map(agent => agent.runtime)
    nativeAllowed.value = capabilities.native_allowed
  } catch (e) { error.value = String(e) } finally { loading.value = false }
})
</script>

<template>
  <section class="person-panel person-agent-settings">
    <header class="panel-heading">
      <div><h2>{{ t('person.teamsTitle') }}</h2><p>{{ t('person.teamsHint') }}</p></div>
      <div class="heading-actions">
        <NButton :disabled="busy" @click="openCreate"><template #icon><PersonPanelIcon name="plus" :size="18" /></template>{{ t('person.newTeam') }}</NButton>
        <NButton type="primary" :disabled="loading || busy || !!editingId || draft.length >= 20 || !!error" @click="add"><template #icon><PersonPanelIcon name="plus" :size="18" /></template>{{ t('person.addAgent') }}</NButton>
      </div>
    </header>
    <NAlert v-if="error || saveError" class="panel-error" type="error">{{ saveError || error }}</NAlert>
    <NSelect v-if="teams.length > 1" class="team-compact" style="width: 220px" :value="selectedTeam?.id" :options="teamChoices" :disabled="busy" :aria-label="t('person.selectTeam')" @update:value="selectedTeamId = $event" />
    <NSpin v-if="loading" />
    <div v-else class="team-layout">
      <aside class="team-list" :aria-label="t('person.teamsTitle')">
        <div v-for="team in teams" :key="team.id" class="team-item" :class="{ selected: team.id === selectedTeam?.id }">
          <button type="button" class="team-select" :aria-pressed="team.id === selectedTeam?.id" @click="selectedTeamId = team.id">
            <span class="team-name" :title="team.name">{{ team.name }}</span>
            <span v-if="team.id === PERSON_DEFAULT_TEAM_ID" class="team-badge">{{ t('person.defaultTeam') }}</span>
            <span class="team-count">{{ team.agents.length }}</span>
          </button>
          <button type="button" class="team-icon" :aria-label="t('person.renameTeam')"
            :title="t('person.renameTeam')" @click="openRename(team)"><PersonPanelIcon name="pencil" :size="15" /></button>
          <button v-if="team.id !== PERSON_DEFAULT_TEAM_ID" type="button" class="team-icon team-delete" :aria-label="t('person.deleteTeam')"
            :title="t('person.deleteTeam')" @click="openDelete(team)"><PersonPanelIcon name="trash" :size="15" /></button>
        </div>
        <p v-if="!teams.length" class="panel-empty-hint">{{ t('person.teamsEmpty') }}</p>
      </aside>
      <div class="team-body">
        <form v-if="editingAgent" class="panel-editor" data-theme-surface="card" @submit.prevent="save">
          <div class="editor-heading"><img v-if="editingAgent.selection.runtime" class="agent-avatar" :src="avatar(editingAgent.selection.runtime).src" alt="" /><span v-else class="tile-icon"><PersonPanelIcon name="agents" :size="22" /></span><h3 :title="editingAgent.name || t('person.addAgent')">{{ editingAgent.name || t('person.addAgent') }}</h3></div>
          <fieldset class="runtime-picker"><legend>{{ t('person.agentRuntime') }}</legend><div class="runtime-grid">
            <button v-for="option in agentOptions.filter(item => !item.disabled || item.value === editingAgent?.selection.runtime)" :key="option.value" type="button" class="runtime-option" :class="{ selected: editingAgent.selection.runtime === option.value }" :aria-pressed="editingAgent.selection.runtime === option.value" :disabled="busy || option.disabled" @click="changeRuntime(editingAgent, option.value)"><img :src="avatar(option.value).src" alt="" /><span class="runtime-label" :title="option.label">{{ option.label }}</span><span v-if="editingAgent.selection.runtime === option.value" class="runtime-check" aria-hidden="true">✓</span></button>
          </div></fieldset>
          <div class="editor-fields">
          <label>{{ t('person.agentName') }}<NInput v-model:value="editingAgent.name" :maxlength="100" :disabled="busy" :input-props="{ 'aria-label': t('person.agentName') }" /></label>
          <label>{{ t('person.agentResource') }}<NSelect v-model:value="editingAgent.selection.profile" :options="profiles" :disabled="busy" :aria-label="t('person.agentResource')" @update:value="resetModel(editingAgent)" /></label>
          <label class="field-wide">{{ t('person.agentPurpose') }}<NInput v-model:value="editingAgent.description" type="textarea" :maxlength="1000" :disabled="busy" :autosize="{ minRows: 2, maxRows: 4 }" :input-props="{ 'aria-label': t('person.agentPurpose') }" /></label>
          <label v-if="editingAgent.selection.runtime && !['ekko', 'hermes'].includes(editingAgent.selection.runtime)">{{ t('codingAgents.launchModeScope') }}
            <NSelect v-model:value="editingAgent.selection.mode" :disabled="busy || isGlobalOnlyCodingAgent(editingAgent.selection.runtime)" :aria-label="t('codingAgents.launchModeScope')"
              :options="[{ label: t('codingAgents.modelScope'), value: 'scoped' }, { label: t('codingAgents.launchModeGlobalShort'), value: 'global', disabled: !agentMetadata(editingAgent.selection.runtime)?.modes.includes('global') || (!nativeAllowed && !editingAgent.selection.runtime.startsWith('plugin:')) }]" @update:value="resetModel(editingAgent)" />
          </label>
          <template v-if="editingAgent.selection.mode === 'scoped'">
            <label>{{ t('person.chooseModel') }}<ScopedModelSelector :provider="editingAgent.selection.provider" :model="editingAgent.selection.model" :groups="groupsFor(editingAgent)" :disabled="busy || !editingAgent.selection.runtime"
              :select-protocol="editingAgent.selection.runtime !== 'hermes'" inherit-api-mode :api-mode="editingAgent.selection.apiMode"
              @select="selectModel(editingAgent, $event)" /></label>
            <label>{{ t('chat.reasoningEffort.tooltip') }}<NSelect :value="agentReasoningEffortValue(editingAgent.selection.reasoningEffort, efforts(editingAgent))" @update:value="editingAgent.selection.reasoningEffort = $event" :options="efforts(editingAgent)" :disabled="busy || !editingAgent.selection.model" :aria-label="t('chat.reasoningEffort.tooltip')" /></label>
          </template>
          <template v-else>
            <label>{{ t('person.chooseModel') }}<NativeCodingAgentModelFields :agent="editingAgent.selection.runtime as CodingAgentId" :profile="editingAgent.selection.profile" :model="editingAgent.selection.model" :reasoning-effort="editingAgent.selection.reasoningEffort" :disabled="busy" @change="Object.assign(editingAgent.selection, $event)" /></label>
            <label>{{ t('chat.reasoningEffort.tooltip') }}<NativeCodingAgentModelFields field="reasoning-effort" :agent="editingAgent.selection.runtime as CodingAgentId" :profile="editingAgent.selection.profile" :model="editingAgent.selection.model" :reasoning-effort="editingAgent.selection.reasoningEffort" :disabled="busy" @change="Object.assign(editingAgent.selection, $event)" /></label>
          </template>
          </div>
          <footer class="editor-actions"><NButton :disabled="busy" @click="cancelEdit">{{ t('common.cancel') }}</NButton><NButton attr-type="submit" type="primary" :loading="busy" :disabled="!valid || !!error">{{ t('common.save') }}</NButton></footer>
        </form>
        <template v-else>
          <div class="panel-toolbar"><span class="panel-count"><strong>{{ draft.length }}</strong>{{ t('person.agentRuntime') }}</span><span class="tile-meta">{{ t('person.agentTeamHint') }}</span></div>
          <div v-if="!draft.length" class="panel-empty" data-theme-surface="card"><PersonPanelIcon name="agents" :size="32" /><h3>{{ t('person.agentsEmpty') }}</h3><p>{{ t('person.agentSetupHint') }}</p></div>
          <div v-else class="panel-grid">
            <article v-for="(agent, index) in draft" :key="agent.id" class="panel-tile agent-card" data-theme-surface="card">
              <div class="agent-identity"><img class="agent-avatar" :src="avatar(agent.selection.runtime).src" alt="" /><div><h3 :title="agent.name">{{ agent.name }}</h3><span class="tile-meta agent-runtime-label" :title="avatar(agent.selection.runtime).label">{{ avatar(agent.selection.runtime).label }}</span></div></div>
              <p class="agent-description">{{ agent.description }}</p>
              <div class="agent-model"><span class="tile-meta">{{ t('person.chooseModel') }}</span><span>{{ agent.selection.model || t('codingAgents.nativeModelDefault') }}</span></div>
              <div class="agent-reasoning"><span class="tile-meta">{{ t('chat.reasoningEffort.tooltip') }}</span><span>{{ reasoningLabel(agent) }}</span></div>
              <footer class="tile-footer"><span class="tile-meta">{{ agent.selection.profile }}</span><div class="tile-actions"><NButton quaternary size="small" :disabled="busy" @click="draft.splice(index, 1)">{{ t('common.delete') }}</NButton><NButton secondary size="small" :disabled="busy" @click="editingId = agent.id">{{ t('common.edit') }}</NButton></div></footer>
            </article>
          </div>
          <div v-if="dirty" class="editor-actions"><NButton :disabled="busy" @click="draft = JSON.parse(JSON.stringify(agents))">{{ t('common.cancel') }}</NButton><NButton type="primary" :loading="busy" :disabled="!valid || !!error" @click="save">{{ t('common.save') }}</NButton></div>
        </template>
      </div>
    </div>
    <NModal v-model:show="creating" preset="dialog" :title="t('person.newTeam')" :positive-text="t('common.save')" :negative-text="t('common.cancel')"
      :positive-button-props="{ loading: writePending, disabled: !newTeamName.trim() }" @positive-click="createTeam">
      <div class="team-create">
        <NInput v-model:value="newTeamName" :maxlength="100" :placeholder="t('person.teamName')" :status="newTeamError ? 'error' : undefined"
          :input-props="{ 'aria-label': t('person.teamName') }" @keyup.enter="createTeam" />
        <span v-if="newTeamError" class="panel-error-text" role="alert">{{ newTeamError }}</span>
      </div>
    </NModal>
    <NModal :show="!!renameTarget" preset="dialog" :title="t('person.renameTeam')" :positive-text="t('common.save')"
      :negative-text="t('common.cancel')" :positive-button-props="{ loading: renaming, disabled: !renameName.trim() }"
      :negative-button-props="{ disabled: renaming }" @positive-click="confirmRename" @negative-click="renameTarget = null" @close="renameTarget = null">
      <div class="team-create">
        <NInput v-model:value="renameName" :maxlength="100" :placeholder="t('person.teamName')" :status="renameError ? 'error' : undefined"
          :input-props="{ 'aria-label': t('person.teamName') }" @keyup.enter="confirmRename" />
        <span v-if="renameError" class="panel-error-text" role="alert">{{ renameError }}</span>
      </div>
    </NModal>
    <NModal :show="!!deleteTarget" preset="dialog" type="warning" :title="t('person.deleteTeam')" :positive-text="t('common.confirm')"
      :negative-text="t('common.cancel')" :positive-button-props="{ loading: deleting }" :negative-button-props="{ disabled: deleting }"
      @positive-click="confirmDelete" @negative-click="deleteTarget = null" @close="deleteTarget = null">
      <p>{{ t('person.deleteTeamConfirm', { name: deleteTarget?.name || '' }) }}</p>
      <template v-if="deleteUsage && deleteUsage.conversations.length">
        <p class="team-usage-title">{{ t('person.deleteTeamAffected', { count: deleteUsage.total }) }}</p>
        <ul class="team-usage-list">
          <li v-for="conversation in deleteUsage.conversations" :key="conversation.id">{{ conversation.title || conversation.id }}</li>
        </ul>
        <p v-if="deleteUsage.total > deleteUsage.conversations.length" class="tile-meta">
          {{ t('person.deleteTeamMore', { count: deleteUsage.total - deleteUsage.conversations.length }) }}
        </p>
      </template>
    </NModal>
  </section>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;
@use './person-panels';
.heading-actions { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.team-compact { display: none; margin-bottom: 12px; }
.team-layout { display: grid; grid-template-columns: minmax(160px, 220px) minmax(0, 1fr); gap: 18px; align-items: start; }
.team-list { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
.team-item { display: flex; align-items: center; gap: 2px; min-width: 0; border: var(--border-width, 1px) solid transparent;
  border-radius: var(--radius-component, 8px); }
.team-item:hover { background: rgba(var(--accent-primary-rgb), .06); }
.team-item.selected { border-color: $accent-primary; background: rgba(var(--accent-primary-rgb), .1); }
.team-select { flex: 1; min-width: 0; display: flex; align-items: center; gap: 8px; padding: 9px 4px 9px 10px;
  background: transparent; color: $text-primary; font: inherit; font-size: 13px; text-align: start; border: 0; cursor: pointer; }
.team-select:focus-visible { outline: 2px solid $accent-primary; outline-offset: 2px; border-radius: var(--radius-component, 8px); }
.team-name { flex: 1; min-width: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.team-badge { flex-shrink: 0; font-size: 10.5px; padding: 1px 6px; border-radius: 999px; border: 1px solid $border-color; color: $text-secondary; }
.team-count { flex-shrink: 0; font-size: 11px; color: $text-secondary; }
.team-icon { flex-shrink: 0; display: flex; align-items: center; padding: 6px; border: 0; border-radius: var(--radius-component, 8px);
  background: transparent; color: $text-secondary; cursor: pointer; opacity: .7; }
.team-icon:hover { color: $text-primary; opacity: 1; }
.team-icon:focus-visible { outline: 2px solid $accent-primary; outline-offset: 1px; }
.team-delete:hover { color: $error; }
.team-body { min-width: 0; }
.team-create { display: flex; flex-direction: column; gap: 6px; }
.panel-error-text { color: $error; font-size: 12px; }
.team-usage-title { margin: 12px 0 4px; font-size: 13px; }
.team-usage-list { margin: 0 0 8px; padding-inline-start: 20px; font-size: 13px; line-height: 1.7; }
.panel-empty-hint { font-size: 12px; color: $text-secondary; }
.agent-identity { display: flex; align-items: center; gap: 14px; }
.agent-identity > div { min-width: 0; flex: 1; }
.agent-identity h3, .editor-heading h3, .agent-runtime-label { min-width: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.agent-runtime-label { display: block; }
.editor-heading h3 { flex: 1; }
.agent-avatar { width: 44px; height: 44px; flex-shrink: 0; object-fit: contain; border-radius: var(--radius-component, 10px); }
.agent-description { color: $text-secondary; font-size: 14px; line-height: 1.8; white-space: pre-wrap; overflow-wrap: anywhere; margin: 22px 0; }
.agent-model, .agent-reasoning { display: flex; flex-direction: column; gap: 5px; font-size: 13px; overflow-wrap: anywhere; }
.agent-model { margin: auto 0 14px; }
.agent-reasoning { margin: 0 0 22px; }
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
@media (max-width: 720px) {
  .team-layout { grid-template-columns: minmax(0, 1fr); }
  .team-list { flex-direction: row; overflow-x: auto; padding-bottom: 4px; }
  .team-item { width: auto; white-space: nowrap; }
  .team-compact { display: none; }
}
</style>
