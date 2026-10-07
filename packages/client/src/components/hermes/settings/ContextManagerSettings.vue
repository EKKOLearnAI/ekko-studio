<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { NAlert, NButton, NInput, NSelect, NSpace, NSwitch, NTag, useMessage } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import SettingRow from './SettingRow.vue'
import { useProfilesStore } from '@/stores/hermes/profiles'
import { contextManagerError, getContextManagerHealth, getContextManagerSettings, restartContextManagerWorker, runContextManagerLifecycle, saveContextManagerSettings,
  type ContextManagerHealth, type ContextManagerLifecycleAction, type ContextManagerSettings } from '@/api/studio/context-manager'

const { t } = useI18n()
const message = useMessage()
const profiles = useProfilesStore()
const profile = computed(() => profiles.activeProfileName || '')
const settings = ref<ContextManagerSettings | null>(null)
const health = ref<ContextManagerHealth | null>(null)
const loading = ref(false)
const busy = ref(false)
const healthLoading = ref(false)
const loadError = ref(false)
const operationError = ref<{ code: string; message: string; title: string } | null>(null)
const restartConfirmation = ref<{ profile: string; token: number; activeSessions: number } | null>(null)
const restartDisabled = computed(() => busy.value || loading.value || healthLoading.value || !health.value
  || health.value.worker.profile !== profile.value || health.value.worker.status === 'unknown'
  || health.value.worker.runningSessions !== 0 || health.value.worker.activeSessions === null)
function confirmRestart() {
  if (restartDisabled.value) return
  restartConfirmation.value = { profile: profile.value, token: generation, activeSessions: health.value!.worker.activeSessions! }
}
async function restartWorker() {
  const confirmation = restartConfirmation.value
  restartConfirmation.value = null
  if (!confirmation || !current(confirmation.profile, confirmation.token) || restartDisabled.value) return
  busy.value = true
  operationError.value = null
  try {
    await restartContextManagerWorker(confirmation.profile)
    if (!current(confirmation.profile, confirmation.token)) return
    message.success(t('contextManager.actionDone'))
    await refreshHealth(confirmation.profile, confirmation.token)
  } catch (error) {
    if (current(confirmation.profile, confirmation.token)) reportError(error, 'lifecycleFailed')
  } finally {
    if (current(confirmation.profile, confirmation.token)) busy.value = false
  }
}
function reportError(error: unknown, title: string) {
  operationError.value = { ...diagnostic(error), title: t(`contextManager.${title}`) }
  message.error(t(`contextManager.${title}`))
}
function diagnostic(error: unknown) {
  const { code, reason } = contextManagerError(error)
  return { code, message: t(`contextManager.errors.${reason}`) }
}
const probeDiagnostics = computed(() => ['manifest', 'status'].flatMap(name => {
  const observation = health.value?.observations?.[name as 'manifest' | 'status']
  if (!observation?.error) return []
  const detail = diagnostic({ code: observation.errorCode })
  const status = Number.isSafeInteger(observation.statusCode) && observation.statusCode! >= 100 && observation.statusCode! <= 599 ? ` (HTTP ${observation.statusCode})` : ''
  return [{ name, ...detail, message: detail.message + status }]
}))
function compatibilityIssue(issue: string) {
  const tool = issue.startsWith('tool:') ? issue.slice(5) : ''
  if (['compress', 'decompress', 'search_context', 'acp_status', 'acp_cache'].includes(tool)) return t('contextManager.issues.tool', { tool })
  return t(`contextManager.issues.${['protocol', 'fork'].includes(issue) ? issue : 'unknown'}`)
}
const actions: ContextManagerLifecycleAction[] = ['install', 'start', 'stop', 'upgrade']
const managerOptions = computed(() => [
  { label: t('contextManager.native'), value: 'native' },
  { label: 'Billion Context', value: 'bili' },
])
let generation = 0
let healthRequest = 0
function current(name: string, token: number) { return profile.value === name && generation === token }
async function refreshHealth(name = profile.value, token = generation) {
  if (!name) return
  const request = ++healthRequest
  healthLoading.value = true
  health.value = null
  try {
    const result = await getContextManagerHealth(name)
    if (current(name, token) && request === healthRequest) health.value = result
  } catch (error) {
    if (current(name, token) && request === healthRequest) {
      health.value = null
      reportError(error, 'healthFailed')
    }
  } finally {
    if (current(name, token) && request === healthRequest) healthLoading.value = false
  }
}
watch(profile, async (name) => {
  const token = ++generation
  settings.value = null
  health.value = null
  loadError.value = false
  operationError.value = null
  busy.value = false
  restartConfirmation.value = null
  healthLoading.value = false
  loading.value = !!name
  if (!name) return
  void refreshHealth(name, token)
  try {
    const result = await getContextManagerSettings(name)
    if (current(name, token)) settings.value = result
  } catch (error) {
    if (current(name, token)) { loadError.value = true; reportError(error, 'loadFailed') }
  } finally {
    if (current(name, token)) loading.value = false
  }
}, { immediate: true })
onBeforeUnmount(() => { generation++; healthRequest++ })
async function save() {
  if (!settings.value || busy.value || loading.value) return
  const name = profile.value
  const token = generation
  busy.value = true
  operationError.value = null
  try {
    const result = await saveContextManagerSettings(name, JSON.parse(JSON.stringify(settings.value)))
    if (!current(name, token)) return
    settings.value = result
    message.success(t('contextManager.saved'))
    await refreshHealth(name, token)
  } catch (error) {
    if (current(name, token)) reportError(error, 'saveFailed')
  } finally {
    if (current(name, token)) busy.value = false
  }
}
function disabled(action: ContextManagerLifecycleAction) {
  const state = health.value?.lifecycle
  if (busy.value || loading.value || healthLoading.value || !state) return true
  if (action === 'install') return state.installed
  if (state.management === 'external') return true
  if (action === 'stop') return state.management !== 'studio'
  if (action === 'start') return !state.installed || state.running || settings.value?.proxyUrl !== health.value?.settings.proxyUrl
  return !state.installed || state.running
}
async function run(action: ContextManagerLifecycleAction) {
  if (disabled(action)) return
  const name = profile.value
  const token = generation
  busy.value = true
  try {
    await runContextManagerLifecycle(name, 'hermes', action)
    if (!current(name, token)) return
    message.success(t('contextManager.actionDone'))
    await refreshHealth(name, token)
  } catch (error) {
    if (current(name, token)) reportError(error, 'lifecycleFailed')
  } finally {
    if (current(name, token)) busy.value = false
  }
}
</script>

<template>
  <section class="context-manager-settings">
    <NAlert v-if="loadError" type="error">{{ t('contextManager.loadFailed') }}</NAlert>
    <NAlert v-if="operationError" type="error" :title="operationError.title" class="diagnostic" data-error="operation">
      <code>{{ operationError.code }}</code><div>{{ operationError.message }}</div>
    </NAlert>
    <SettingRow label="Hermes">
      <NSelect v-if="settings" v-model:value="settings.hermes.manager" :options="managerOptions" :disabled="busy" size="small" class="manager-input" />
    </SettingRow>
    <SettingRow label="Ekko">
      <NSelect v-if="settings" v-model:value="settings.ekko.manager" :options="managerOptions" :disabled="busy" size="small" class="manager-input" />
    </SettingRow>
    <SettingRow :label="t('contextManager.proxyUrl')">
      <NInput v-if="settings" v-model:value="settings.proxyUrl" :disabled="busy" size="small" class="proxy-input" />
    </SettingRow>
    <SettingRow :label="t('contextManager.allowNativeFallback')">
      <NSwitch v-if="settings" v-model:value="settings.allowNativeFallback" :disabled="busy" />
    </SettingRow>
    <NSpace justify="end" class="actions">
      <NButton data-action="save" size="small" type="primary" :loading="busy" :disabled="busy || loading || !settings" @click="save">{{ t('contextManager.save') }}</NButton>
    </NSpace>
    <div class="health-section">
      <NSpace justify="space-between" align="center">
        <h3>Billion Context</h3>
        <NButton data-action="refresh" size="small" :loading="healthLoading" :disabled="busy || !profile" @click="refreshHealth()">{{ t('contextManager.refresh') }}</NButton>
      </NSpace>
      <template v-if="health">
        <SettingRow :label="t('contextManager.health')"><NTag :type="health.healthy ? 'success' : 'error'" size="small">{{ t(`contextManager.${health.healthy ? 'healthy' : 'unavailable'}`) }}</NTag></SettingRow>
        <SettingRow :label="t('contextManager.compatibility')"><NTag :type="health.compatibility === 'compatible' ? 'success' : 'warning'" size="small">{{ t(`contextManager.${health.compatibility}`) }}</NTag></SettingRow>
        <NAlert v-if="health.compatibilityIssues.length" type="warning" class="diagnostic" data-error="compatibility">
          <ul><li v-for="issue in health.compatibilityIssues" :key="issue">{{ compatibilityIssue(issue) }}</li></ul>
        </NAlert>
        <NAlert v-for="item in probeDiagnostics" :key="item.name" type="error" class="diagnostic" data-error="health">
          <strong>{{ t(`contextManager.probes.${item.name}`) }}</strong><div>{{ item.code }}: {{ item.message }}</div>
        </NAlert>
        <SettingRow :label="t('contextManager.runtime')"><span>{{ t(`contextManager.${health.lifecycle.management}`) }}</span></SettingRow>
        <SettingRow :label="t('contextManager.version')"><span>{{ health.lifecycle.version || t('contextManager.notInstalled') }}</span></SettingRow>
        <SettingRow :label="t('contextManager.proxyVersion')"><span>{{ health.runtimeVersion || t('contextManager.unknown') }}</span></SettingRow>
        <SettingRow v-if="health.lifecycle.runtimeOrigin" :label="t('contextManager.proxyUrl')"><span class="runtime-origin">{{ health.lifecycle.runtimeOrigin }}</span></SettingRow>
      </template>
      <NSpace class="actions" wrap>
        <NButton v-for="action in actions" :key="action" :data-action="action" size="small" :disabled="disabled(action)" :loading="busy" @click="run(action)">{{ t(`contextManager.actions.${action}`) }}</NButton>
      </NSpace>
    </div>
    <div class="health-section">
      <h3>{{ t('contextManager.hermesWorker') }}</h3>
      <template v-if="health">
        <SettingRow :label="t('contextManager.worker')"><span>{{ t(`contextManager.${health.worker.status}`) }}</span></SettingRow>
        <SettingRow :label="t('contextManager.activeSessions')"><span>{{ health.worker.activeSessions ?? t('contextManager.unknown') }}</span></SettingRow>
        <SettingRow :label="t('contextManager.runningSessions')"><span>{{ health.worker.runningSessions ?? t('contextManager.unknown') }}</span></SettingRow>
        <SettingRow v-if="health.worker.pids?.length" :label="t('contextManager.workerPid')"><span data-worker-pids>{{ health.worker.pids.join(', ') }}</span></SettingRow>
        <NAlert v-if="health.worker.error" type="warning" class="diagnostic" data-error="worker">{{ diagnostic(health.worker.error).code }}: {{ diagnostic(health.worker.error).message }}</NAlert>
      </template>
      <NSpace class="actions">
        <NButton data-action="restart-worker" size="small" :disabled="restartDisabled" :loading="busy" @click="confirmRestart">{{ t('contextManager.restartWorker') }}</NButton>
      </NSpace>
    </div>
    <div v-if="restartConfirmation" role="dialog" :aria-label="t('contextManager.restartWorker')" class="worker-confirmation">
      <p>{{ t('contextManager.restartImpact', { profile: restartConfirmation?.profile, count: restartConfirmation?.activeSessions }) }}</p>
      <NSpace justify="end">
        <NButton data-action="cancel-restart" @click="restartConfirmation = null">{{ t('contextManager.cancel') }}</NButton>
        <NButton data-action="confirm-restart" type="warning" @click="restartWorker">{{ t('contextManager.restartWorker') }}</NButton>
      </NSpace>
    </div>
  </section>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;
.context-manager-settings { margin-top: 16px; }
.manager-input { width: 200px; max-width: 100%; }
.proxy-input { width: 280px; max-width: 100%; }
.runtime-origin { overflow-wrap: anywhere; }
.diagnostic { margin-bottom: 12px; overflow-wrap: anywhere; }
.worker-confirmation { padding: 12px 0; border-top: 1px solid $border-light; overflow-wrap: anywhere; }
.actions { padding: 16px 0; }
.health-section { margin-top: 16px; padding-top: 16px; border-top: 1px solid $border-light; }
h3 { margin: 0; font-size: 14px; color: $text-primary; }
@media (max-width: $breakpoint-mobile) { .manager-input, .proxy-input { width: 100%; } }
</style>
