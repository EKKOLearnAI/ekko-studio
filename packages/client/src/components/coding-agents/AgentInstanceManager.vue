<script setup lang="ts">
import { computed, onUnmounted, reactive, ref, shallowRef, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import { generateClientUuid } from '@/utils/client-random'
import { NAlert, NButton, NEmpty, NForm, NFormItem, NInput, NModal, NSelect, NSpin, NTag } from 'naive-ui'
import { isStoredSuperAdmin } from '@/api/client'
import { useProfilesStore } from '@/stores/hermes/profiles'
import { fetchAgentTypes, fetchManagedAgentInstances, saveManagedAgentInstance, fetchBundledAgentPlugins, enableBundledAgentPlugin,
  fetchAgentSetup, inspectManagedAgent, createManagedAgentChat, type AgentTypeSummary, type ManagedAgentInstance, type BundledAgentPlugin, type AgentSetup, type AgentInspection, type JsonObject } from '@/api/studio/agent-management'
import { agentConfigFields, parseAgentConfigFields } from '@/utils/agent-instance-form'
import AgentLoginTerminal from './AgentLoginTerminal.vue'

const props = defineProps<{ instanceId: string; agentTypeId: string }>()
const emit = defineEmits<{ saved: [id: string, agentTypeId: string] }>()
const { t } = useI18n(), profiles = useProfilesStore()
const router = useRouter()
const show = ref(false), loading = ref(false), saving = ref(false), checking = ref(false), error = ref(''), inspectError = ref('')
const types = shallowRef<AgentTypeSummary[]>([]), instances = shallowRef<ManagedAgentInstance[]>([]), bundles = shallowRef<BundledAgentPlugin[]>([])
const selectedId = ref(''), typeId = ref(''), mode = ref<'scoped' | 'global'>('scoped'), raw = ref('{}'), drafts = reactive<Record<string, string>>(Object.create(null))
const setup = shallowRef<AgentSetup | null>(null), inspection = shallowRef<AgentInspection | null>(null)
const loginActive = ref(false), installActive = ref(false)
const managementActive = computed(() => loginActive.value || installActive.value)
let generation = 0
let chatRequest: { target: string; key: string } | undefined
const selected = computed(() => instances.value.find(item => item.id === selectedId.value))
const type = computed(() => types.value.find(item => item.id === typeId.value))
const fields = computed(() => type.value ? agentConfigFields(type.value.configSchema) : null)
const typeOptions = computed(() => types.value.map(item => ({ label: item.name, value: item.id })))
const instanceOptions = computed(() => [{ value: '', label: t('agentManagement.newInstance') }, ...instances.value.map(item => ({ value: item.id, label: `${item.agentTypeId} · ${item.mode} · ${item.id.slice(0, 8)}` }))])
const modeOptions = computed(() => (type.value?.capabilities.modes || []).map(value => ({ value, label: t(`agentManagement.${value}`) })))
const busy = computed(() => loading.value || saving.value || checking.value)
const dirty = computed(() => {
  if (!selected.value) return true
  try { return mode.value !== selected.value.mode || JSON.stringify(configuration()) !== JSON.stringify(selected.value.config || {}) }
  catch { return true }
})
function configuration(): JsonObject {
  if (fields.value) return parseAgentConfigFields(fields.value, drafts, selected.value?.config)
  const value = JSON.parse(raw.value)
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('config')
  return value
}
function resetDraft() {
  const item = selected.value, config = item?.config || {}
  typeId.value = item?.agentTypeId || (types.value.some(value => value.id === props.agentTypeId) ? props.agentTypeId : types.value[0]?.id || '')
  mode.value = item?.mode || (type.value?.capabilities.modes.includes('scoped') ? 'scoped' : 'global')
  raw.value = JSON.stringify(config, null, 2)
  for (const key of Object.keys(drafts)) delete drafts[key]
  for (const [key, value] of Object.entries(config)) drafts[key] = typeof value === 'string' ? value : JSON.stringify(value, null, 2)
  setup.value = null; inspection.value = null; error.value = ''; inspectError.value = ''
}
function selectInstance(id: string) { ++generation; checking.value = false; loginActive.value = false; installActive.value = false; selectedId.value = id; resetDraft() }
function selectType(id: string) { typeId.value = id; for (const key of Object.keys(drafts)) delete drafts[key]; raw.value = '{}'; mode.value = type.value?.capabilities.modes.includes('scoped') ? 'scoped' : 'global' }
async function load() {
  const current = ++generation
  loading.value = true; error.value = ''; setup.value = null; inspection.value = null; types.value = []; instances.value = []; bundles.value = []
  try {
    if (!profiles.activeProfileName) await profiles.fetchProfiles()
    if (current !== generation) return
    const profile = profiles.activeProfileName
    if (!profile) throw new Error(t('codingAgents.resourcesUnavailable'))
    const results = await Promise.allSettled([fetchAgentTypes(profile), fetchManagedAgentInstances(profile), isStoredSuperAdmin() ? fetchBundledAgentPlugins(profile) : Promise.resolve([])])
    if (current !== generation) return
    const [catalog, list, plugins] = results
    if (catalog.status === 'fulfilled') types.value = catalog.value
    if (list.status === 'fulfilled') instances.value = list.value
    if (plugins.status === 'fulfilled') bundles.value = plugins.value
    const failures = results.filter(value => value.status === 'rejected') as PromiseRejectedResult[]
    selectedId.value = instances.value.some(value => value.id === props.instanceId) ? props.instanceId : ''
    resetDraft()
    if (failures.length) error.value = failures.map(value => value.reason?.message || String(value.reason)).join('\n')
  } catch (err: any) { if (current === generation) error.value = err.message || String(err) }
  finally { if (current === generation) loading.value = false }
}
async function enable(bundle: BundledAgentPlugin) {
  const current = generation, profile = profiles.activeProfileName
  if (!profile) return
  saving.value = true; error.value = ''
  try {
    await enableBundledAgentPlugin(profile, bundle)
    if (current === generation) await load()
  } catch (err: any) { if (current === generation) error.value = err.message || String(err) }
  finally { saving.value = false }
}
async function save() {
  const current = generation, profile = profiles.activeProfileName, previous = selected.value
  if (!profile) return
  error.value = ''
  let config: JsonObject
  try { config = configuration() }
  catch (err: any) { error.value = t('agentManagement.invalidField', { field: err.message }); return }
  saving.value = true
  try {
    const result = await saveManagedAgentInstance(profile, typeId.value, config, mode.value, previous)
    if (current === generation) { emit('saved', result.id, result.agentTypeId); show.value = false }
  } catch (err: any) { if (current === generation) error.value = err.message || String(err) }
  finally { saving.value = false }
}
async function checkSetup() {
  const item = selected.value, profile = profiles.activeProfileName, current = generation
  if (!item || !profile) return
  checking.value = true; error.value = ''; inspectError.value = ''; setup.value = null; inspection.value = null
  try {
    const result = await fetchAgentSetup(profile, item)
    if (current !== generation) return
    setup.value = result
    if (item.mode === 'global' && result.cli.state === 'available' && type.value?.management?.inspect) {
      try {
        const metadata = await inspectManagedAgent(profile, item)
        if (current === generation) inspection.value = metadata
      } catch (err: any) { if (current === generation) inspectError.value = err.message || String(err) }
    }
  } catch (err: any) { if (current === generation) error.value = err.message || String(err) }
  finally { if (current === generation) checking.value = false }
}
async function openChat() {
  const item = selected.value, profile = profiles.activeProfileName, current = generation
  if (!item || !profile || busy.value || managementActive.value || dirty.value) return
  const target = JSON.stringify([profile, item.id, item.revision])
  if (chatRequest?.target !== target) chatRequest = { target, key: generateClientUuid() }
  saving.value = true; error.value = ''
  try {
    const chat = await createManagedAgentChat(profile, item, chatRequest.key)
    if (current !== generation || profiles.activeProfileName !== profile) return
    await router.push({ name: 'hermes.session', params: { sessionId: chat.sessionId }, query: { profile } })
    chatRequest = undefined; show.value = false
  } catch (err: any) { if (current === generation) error.value = err.message || String(err) }
  finally { saving.value = false }
}
watch(show, value => { if (value) void load(); else { ++generation; loading.value = false; checking.value = false } })
watch(() => profiles.activeProfileName, () => { if (show.value) void load() })
watch(() => props.agentTypeId, () => { show.value = false })
onUnmounted(() => { ++generation })
</script>

<template>
  <div class="instance-manager-toolbar">
    <NButton size="small" @click="show = true">{{ t('agentManagement.manage') }}</NButton>
  </div>
  <NModal v-model:show="show" preset="card" class="instance-manager-modal" :style="{ width: 'min(720px, calc(100vw - 24px))' }" :title="t('agentManagement.manage')" :mask-closable="!busy" :closable="!busy">
    <NSpin :show="loading">
      <div class="instance-manager-body">
        <NAlert v-if="error" type="error" :bordered="false">{{ error }}</NAlert>
        <div v-for="bundle in bundles.filter(item => item.state !== 'ready')" :key="bundle.id" class="bundle-row">
          <div><strong>{{ bundle.name }}</strong><p>{{ t('agentManagement.pluginScope') }}</p><code>{{ bundle.requiredCapabilities.join(', ') }}</code></div>
          <NButton :disabled="busy" @click="enable(bundle)">{{ t('agentManagement.enablePlugin') }}</NButton>
        </div>
        <NAlert v-if="!types.length && !loading" type="info" :bordered="false">{{ t('agentManagement.noTypes') }}</NAlert>
        <NSelect :value="selectedId" :options="instanceOptions" :disabled="busy" :aria-label="t('codingAgents.resourceInstance')" @update:value="selectInstance" />
        <NForm label-placement="top" :disabled="busy || managementActive" @submit.prevent="save">
          <NFormItem :label="t('agentManagement.type')">
            <NSelect :value="typeId" :options="typeOptions" :disabled="busy || !!selected" :aria-label="t('agentManagement.type')" @update:value="selectType" />
          </NFormItem>
          <NFormItem :label="t('agentManagement.mode')">
            <NSelect v-model:value="mode" :options="modeOptions" :aria-label="t('agentManagement.mode')" />
          </NFormItem>
          <NAlert type="info" :bordered="false">{{ t(mode === 'scoped' ? 'agentManagement.scopedHint' : 'agentManagement.globalHint') }}</NAlert>
          <template v-if="type && fields">
            <NFormItem v-for="field in fields" :key="field.key" :label="field.key" :required="field.required">
              <NSelect v-if="field.enum && field.type === 'string'" v-model:value="drafts[field.key]" clearable :options="field.enum.map(value => ({ value: String(value), label: String(value) }))" :aria-label="field.key" />
              <NSelect v-else-if="field.type === 'boolean'" v-model:value="drafts[field.key]" clearable :options="[{ label: 'true', value: 'true' }, { label: 'false', value: 'false' }]" :aria-label="field.key" />
              <NInput v-else v-model:value="drafts[field.key]" :type="['object', 'array'].includes(field.type) || /prompt|instructions/i.test(field.key) ? 'textarea' : 'text'" :autosize="['object', 'array'].includes(field.type) || /prompt|instructions/i.test(field.key) ? { minRows: 2, maxRows: 8 } : false" :maxlength="field.maxLength" :input-props="{ 'aria-label': field.key }" :placeholder="['object', 'array'].includes(field.type) ? 'JSON' : field.key" />
            </NFormItem>
          </template>
          <NFormItem v-else-if="type" :label="t('agentManagement.configuration')"><NInput v-model:value="raw" type="textarea" :autosize="{ minRows: 8, maxRows: 20 }" :input-props="{ 'aria-label': t('agentManagement.configuration') }" /></NFormItem>
          <NEmpty v-else :description="t('agentManagement.noTypes')" />
        </NForm>
        <div class="instance-actions">
          <NButton :disabled="busy" @click="load">{{ t('codingAgents.refresh') }}</NButton>
          <NButton v-if="selected && type?.management?.setup" :loading="checking" :disabled="busy || managementActive || dirty" @click="checkSetup">{{ t('agentManagement.checkSetup') }}</NButton>
          <NButton v-if="selected" :disabled="busy || managementActive || dirty" @click="openChat">{{ t('chat.newChat') }}</NButton>
          <NButton type="primary" :loading="saving" :disabled="busy || managementActive || !type || !dirty" @click="save">{{ t(selected ? 'common.save' : 'common.create') }}</NButton>
        </div>
        <section v-if="setup" class="native-setup" data-theme-surface="card">
          <NTag :type="setup.cli.state === 'available' ? 'success' : 'warning'">{{ t(`agentManagement.${setup.cli.state}`) }} {{ setup.cli.version }}</NTag>
          <p v-if="'command' in setup.installation">{{ t('agentManagement.manualSetup') }}</p>
          <strong>{{ t('agentManagement.installCli') }}</strong>
          <p v-if="'kind' in setup.installation"><a :href="setup.installation.url" target="_blank" rel="noopener noreferrer">{{ setup.installation.url }}</a></p>
          <pre v-else>{{ setup.installation.command }} {{ JSON.stringify(setup.installation.args) }}</pre>
          <p v-if="setup.authentication.kind === 'studio'">{{ t('agentManagement.scopedHint') }}</p>
          <template v-else>
            <strong>{{ t('agentManagement.loginCli') }}</strong>
            <pre>{{ setup.authentication.command }} {{ JSON.stringify(setup.authentication.args) }}</pre>
            <p v-if="setup.authentication.input">{{ t('agentManagement.terminalInput') }} <code>{{ setup.authentication.input }}</code></p>
            <p>{{ t('agentManagement.authState') }}: {{ t(`agentManagement.auth.${inspection?.authentication.state || 'unknown'}`) }}</p>
          </template>
          <NAlert v-if="inspectError" type="warning" :bordered="false">{{ inspectError }}</NAlert>
        </section>
        <AgentLoginTerminal v-if="show && profiles.activeProfileName && selected && !dirty && type?.management?.prepareInstall && isStoredSuperAdmin()"
          :key="`install:${profiles.activeProfileName}:${selected.id}:${selected.revision}`" :profile="profiles.activeProfileName" :instance="selected" action="install" :disabled="busy || loginActive"
          @busy="installActive = $event" @ended="checkSetup" />
        <AgentLoginTerminal v-if="show && profiles.activeProfileName && selected && !dirty && selected.mode === 'global' && type?.management?.prepareLogin && isStoredSuperAdmin()"
          :key="`${profiles.activeProfileName}:${selected.id}:${selected.revision}`" :profile="profiles.activeProfileName" :instance="selected" :disabled="busy || installActive"
          @busy="loginActive = $event" @ended="checkSetup" />
      </div>
    </NSpin>
  </NModal>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;
.instance-manager-toolbar { display: flex; padding: 8px 12px; flex-shrink: 0; }
.instance-manager-body { display: flex; flex-direction: column; gap: 16px; min-width: 0; max-height: calc(100dvh - 200px); overflow-y: auto; }
.bundle-row { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 12px; overflow-wrap: anywhere; p { margin: 4px 0; color: $text-muted; } }
.instance-actions { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 8px; }
.native-setup { padding: 16px; overflow-wrap: anywhere; pre { white-space: pre-wrap; } }
</style>
