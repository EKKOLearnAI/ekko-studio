<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from 'vue'
import { NAlert, NButton, NCard, NEmpty, NForm, NFormItem, NInput, NModal, NSelect, NSpace, NSpin, NSwitch, NTag, useDialog, useMessage } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import { useProfilesStore } from '@/stores/hermes/profiles'
import { useSettingsStore } from '@/stores/hermes/settings'
import PlatformCard from './PlatformCard.vue'
import {
  createIncomingWebhook,
  deleteIncomingWebhook,
  enableIncomingWebhooks,
  fetchIncomingWebhooks,
  setIncomingWebhookEnabled,
  type IncomingWebhookState,
} from '@/api/hermes/incoming-webhooks'

const { t } = useI18n()
const profilesStore = useProfilesStore()
const settingsStore = useSettingsStore()
const message = useMessage()
const dialog = useDialog()
const loading = ref(true)
const enabling = ref(false)
const saving = ref(false)
const showCreate = ref(false)
const createdSecret = ref<{ name: string; url: string; secret: string } | null>(null)
const state = ref<IncomingWebhookState | null>(null)
const form = reactive({
  name: '', description: '', events: '', prompt: '', skills: '', deliver: 'log', deliver_only: false, deliver_chat_id: '',
})
const webhookIcon = '<svg viewBox="-10 -5 1034 1034" fill="currentColor" xmlns="http://www.w3.org/2000/svg"><path d="M482 226h-1l-10 2q-33 4-64.5 18.5t-55.5 38.5q-41 37-57 91q-9 30-8 63t12 63q17 45 52 78l13 12-83 135q-26-1-45 7-30 13-45 40-7 15-9 31t2 32q8 30 33 48 15 10 33 14.5t36 2 34.5-12.5 27.5-25q12-17 14.5-39t-5.5-41q-1-5-7-14l-3-6 118-192q6-9 8-14l-10-3q-9-2-13-4-23-10-41.5-27.5t-28.5-39.5q-17-36-9-75 4-23 17-43t31-34q37-27 82-27 27-1 52.5 9.5t44.5 30.5q17 16 26.5 38.5t10.5 45.5q0 17-6 42l70 19 8 1q14-43 7-86-4-33-19.5-63.5t-39.5-53.5q-42-42-103-56-6-2-18-4l-14-2h-37zM500 350q-17 0-34 7t-30.5 20.5-19.5 31.5q-8 20-4 44 3 18 14 34t28 25q24 15 56 13 3 4 5 8l112 191q3 6 6 9 27-26 58.5-35.5t65-3.5 58.5 26q32 25 43.5 61.5t.5 73.5q-8 28-28.5 50t-48.5 33q-31 13-66.5 8.5t-63.5-24.5q-4-3-13-10l-5-6q-4 3-11 10l-47 46q23 23 52 38.5t61 21.5l22 4h39l28-5q64-13 110-60 22-22 36.5-50.5t19.5-59.5q5-36-2-71.5t-25-64.5-44-51-57-35q-34-14-70.5-16t-71.5 7l-17 5-81-137q13-19 16-37 5-32-13-60-16-25-44-35-17-6-35-6zM218 614q-58 13-100 53-47 44-61 105l-4 24v37l2 11q2 13 4 20 7 31 24.5 59t42.5 49q50 41 115 49 38 4 76-4.5t70-28.5q53-34 78-91 7-17 14-45 6-1 18 0l125 2q14 0 20 1 11 20 25 31t31.5 16 35.5 4q28-3 50-20 27-21 32-54 2-17-1.5-33t-13.5-30q-16-22-41-32-17-7-35.5-6.5t-35.5 7.5q-28 12-43 37l-3 6q-14 0-42-1l-113-1q-15-1-43-1l-50-1 3 17q8 43-13 81-14 27-40 45t-57 22q-35 6-70-7.5t-57-42.5q-28-35-27-79 1-37 23-69 13-19 32-32t41-19l9-3z"/></svg>'

const internalPlatforms = new Set(['webhook', 'relay', 'api_server', 'msgraph_webhook'])
const platformNames: Record<string, string> = {
  telegram: 'Telegram', discord: 'Discord', slack: 'Slack', whatsapp: 'WhatsApp',
  matrix: 'Matrix', weixin: 'Weixin', wecom: 'WeCom', feishu: 'Feishu',
  dingtalk: 'DingTalk', qqbot: 'QQBot',
}

function platformLabel(key: string): string {
  return platformNames[key] || key.split(/[-_]/).filter(Boolean).map(part => part.charAt(0).toUpperCase() + part.slice(1)).join(' ')
}

function platformReady(key: string): boolean {
  return settingsStore.platforms[key]?.enabled === true && settingsStore.platformCredentialStatus[key] === true
}

const deliveryPlatforms = computed(() => {
  const keys = new Set([
    ...Object.keys(platformNames),
    ...Object.keys(settingsStore.platformCredentialStatus),
    ...Object.keys(settingsStore.platforms),
  ])
  return [...keys].filter(key => !internalPlatforms.has(key)).sort((a, b) => platformLabel(a).localeCompare(platformLabel(b)))
})

const deliveryOptions = computed(() => [
  { label: t('incomingWebhooks.destinations.log'), value: 'log' },
  ...deliveryPlatforms.value.map(key => ({
    label: platformReady(key) ? platformLabel(key) : `${platformLabel(key)} — ${t('common.notConfigured')}`,
    value: key,
  })),
])

const selectedPlatformConfig = computed(() => settingsStore.platforms[form.deliver] || {})
const selectedHasHome = computed(() => Boolean(String(selectedPlatformConfig.value.home_channel?.chat_id || '').trim()))

function selectDelivery(value: string) {
  if (value !== 'log' && !platformReady(value)) {
    message.warning(t('incomingWebhooks.messages.channelUnavailable', { channel: platformLabel(value) }))
    return
  }
  form.deliver = value
  if (value === 'log') {
    form.deliver_chat_id = ''
    form.deliver_only = false
  }
}

async function load() {
  loading.value = true
  try { state.value = await fetchIncomingWebhooks() }
  catch (error: any) { message.error(error?.message || t('incomingWebhooks.messages.loadFailed')) }
  finally { loading.value = false }
}

async function enable() {
  enabling.value = true
  try {
    await enableIncomingWebhooks()
    await load()
    message.success(t('incomingWebhooks.messages.enabled'))
  } catch (error: any) { message.error(error?.message || t('incomingWebhooks.messages.enableFailed')) }
  finally { enabling.value = false }
}

function resetForm() {
  Object.assign(form, { name: '', description: '', events: '', prompt: '', skills: '', deliver: 'log', deliver_only: false, deliver_chat_id: '' })
  createdSecret.value = null
}

function openCreate() {
  resetForm()
  showCreate.value = true
}

function csv(value: string): string[] {
  return value.split(',').map(item => item.trim()).filter(Boolean)
}

async function create() {
  if (!form.name.trim()) return message.warning(t('incomingWebhooks.messages.nameRequired'))
  saving.value = true
  try {
    const created = await createIncomingWebhook({
      name: form.name,
      description: form.description,
      events: csv(form.events),
      prompt: form.prompt,
      skills: csv(form.skills),
      deliver: form.deliver,
      deliver_only: form.deliver_only,
      deliver_chat_id: form.deliver_chat_id,
    })
    createdSecret.value = { name: created.name, url: created.url, secret: created.secret }
    await load()
    message.success(t('incomingWebhooks.messages.created'))
  } catch (error: any) { message.error(error?.message || t('incomingWebhooks.messages.createFailed')) }
  finally { saving.value = false }
}

async function copy(value: string) {
  await navigator.clipboard.writeText(value)
  message.success(t('incomingWebhooks.messages.copied'))
}

async function toggle(name: string, enabled: boolean) {
  try { await setIncomingWebhookEnabled(name, enabled); await load() }
  catch (error: any) { message.error(error?.message || t('incomingWebhooks.messages.updateFailed')) }
}

function remove(name: string) {
  dialog.warning({
    title: t('incomingWebhooks.deleteTitle'),
    content: t('incomingWebhooks.deleteConfirm', { name }),
    positiveText: t('common.delete'), negativeText: t('common.cancel'),
    onPositiveClick: async () => {
      try { await deleteIncomingWebhook(name); await load(); message.success(t('incomingWebhooks.messages.deleted')) }
      catch (error: any) { message.error(error?.message || t('incomingWebhooks.messages.deleteFailed')) }
    },
  })
}

onMounted(load)
watch(() => profilesStore.activeProfileName, () => void load())
</script>

<template>
  <section class="incoming-section">
    <PlatformCard
      :name="t('incomingWebhooks.title')"
      :icon="webhookIcon"
      :config="{}"
      :credentials="{ enabled: state?.enabled === true }"
    >
      <NSpin :show="loading">
        <div class="webhook-intro">
          <p>{{ t('incomingWebhooks.description') }}</p>
          <NTag size="small" type="info">{{ t('incomingWebhooks.profile', { name: state?.profile || profilesStore.activeProfileName || 'default' }) }}</NTag>
        </div>
      <NAlert v-if="state?.unified" type="info" :show-icon="true" class="mode-alert">
        {{ t('incomingWebhooks.unifiedHint') }} <code>{{ state.base_url }}/webhooks/&lt;name&gt;</code>
      </NAlert>
      <NAlert v-else-if="state && !state.gateway_running" type="warning" :show-icon="true" class="mode-alert">
        {{ t('incomingWebhooks.gatewayStopped') }}
      </NAlert>

      <div v-if="state && !state.enabled" class="enable-panel">
        <div>
          <strong>{{ t('incomingWebhooks.enableTitle') }}</strong>
          <p>{{ t('incomingWebhooks.enableHint') }}</p>
        </div>
        <NButton type="primary" :loading="enabling" @click="enable">{{ t('incomingWebhooks.enable') }}</NButton>
      </div>

      <template v-else-if="state">
        <div class="toolbar">
          <div class="base-url">
            <span>{{ t('incomingWebhooks.listener') }}</span>
            <code>{{ state.base_url }}</code>
          </div>
          <NButton type="primary" @click="openCreate">{{ t('incomingWebhooks.add') }}</NButton>
        </div>

        <NEmpty v-if="state.subscriptions.length === 0" :description="t('incomingWebhooks.empty')" class="empty" />
        <div v-else class="route-list">
          <NCard v-for="route in state.subscriptions" :key="route.name" size="small" class="route-card">
            <div class="route-head">
              <div>
                <div class="route-name"><strong>{{ route.name }}</strong><NTag size="tiny">{{ route.deliver }}</NTag></div>
                <p>{{ route.description || t('incomingWebhooks.noDescription') }}</p>
              </div>
              <NSpace align="center">
                <NSwitch :value="route.enabled" @update:value="value => toggle(route.name, value)" />
                <NButton size="tiny" quaternary type="error" @click="remove(route.name)">{{ t('common.delete') }}</NButton>
              </NSpace>
            </div>
            <button class="url-row" type="button" @click="copy(route.url)"><code>{{ route.url }}</code><span>{{ t('common.copy') }}</span></button>
            <div class="route-meta">
              <span>{{ route.events.length ? route.events.join(', ') : t('incomingWebhooks.allEvents') }}</span>
              <span v-if="route.skills.length">{{ t('incomingWebhooks.skills') }}: {{ route.skills.join(', ') }}</span>
            </div>
          </NCard>
        </div>
      </template>
      </NSpin>
    </PlatformCard>

    <NModal
      v-model:show="showCreate"
      preset="card"
      :title="t('incomingWebhooks.createTitle')"
      :style="{ width: 'min(620px, calc(100vw - 32px))' }"
      :mask-closable="!saving"
    >
      <NAlert v-if="createdSecret" type="success" :show-icon="true">
        <strong>{{ t('incomingWebhooks.secretOnce') }}</strong>
        <button class="copy-secret" type="button" @click="copy(createdSecret.secret)"><code>{{ createdSecret.secret }}</code><span>{{ t('common.copy') }}</span></button>
        <button class="copy-secret" type="button" @click="copy(createdSecret.url)"><code>{{ createdSecret.url }}</code><span>{{ t('common.copy') }}</span></button>
      </NAlert>
      <NForm v-else label-placement="top">
        <div class="form-grid">
          <NFormItem :label="t('incomingWebhooks.form.name')" required><NInput v-model:value="form.name" placeholder="github-push" /></NFormItem>
          <NFormItem :label="t('incomingWebhooks.form.description')"><NInput v-model:value="form.description" /></NFormItem>
        </div>
        <NFormItem :label="t('incomingWebhooks.form.events')"><NInput v-model:value="form.events" :placeholder="t('incomingWebhooks.form.eventsHint')" /></NFormItem>
        <NFormItem :label="t('incomingWebhooks.form.prompt')"><NInput v-model:value="form.prompt" type="textarea" :autosize="{ minRows: 3, maxRows: 7 }" :placeholder="t('incomingWebhooks.form.promptHint')" /></NFormItem>
        <div class="form-grid">
          <NFormItem :label="t('incomingWebhooks.form.deliver')"><NSelect :value="form.deliver" :options="deliveryOptions" @update:value="selectDelivery" /></NFormItem>
          <NFormItem :label="t('incomingWebhooks.form.chatId')"><NInput v-model:value="form.deliver_chat_id" :disabled="form.deliver === 'log'" /></NFormItem>
        </div>
        <NAlert v-if="form.deliver !== 'log'" :type="selectedHasHome ? 'info' : 'warning'" :show-icon="true" class="destination-alert">
          {{ selectedHasHome ? t('incomingWebhooks.form.homeDestinationHint') : t('incomingWebhooks.form.destinationRequiredHint') }}
        </NAlert>
        <NFormItem :label="t('incomingWebhooks.form.skills')"><NInput v-model:value="form.skills" :placeholder="t('incomingWebhooks.form.skillsHint')" /></NFormItem>
        <NFormItem :label="t('incomingWebhooks.form.direct')"><NSwitch v-model:value="form.deliver_only" :disabled="form.deliver === 'log'" /></NFormItem>
      </NForm>
      <template #footer>
        <div class="modal-actions">
          <NButton :disabled="saving" @click="showCreate = false">{{ createdSecret ? t('common.ok') : t('common.cancel') }}</NButton>
          <NButton v-if="!createdSecret" type="primary" :loading="saving" @click="create">{{ t('common.create') }}</NButton>
        </div>
      </template>
    </NModal>
  </section>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;
.incoming-section { margin-top: 16px; }
.webhook-intro, .route-head, .toolbar, .enable-panel { display: flex; align-items: center; justify-content: space-between; gap: 14px; }
p { margin: 4px 0 0; color: $text-muted; font-size: 13px; }
.webhook-intro { margin-top: 12px; }
.mode-alert { margin-top: 14px; } .enable-panel { margin-top: 14px; padding: 16px; border-radius: 8px; background: $bg-secondary; }
.toolbar { margin: 16px 0 12px; } .base-url { display: flex; align-items: center; gap: 10px; color: $text-muted; font-size: 12px; }
code { direction: ltr; unicode-bidi: isolate; color: $text-primary; }
.route-list { display: grid; gap: 10px; } .route-card { background: $bg-secondary; } .route-name { display: flex; align-items: center; gap: 8px; }
.url-row, .copy-secret { width: 100%; display: flex; justify-content: space-between; gap: 12px; margin-top: 12px; padding: 8px 10px; border: 1px solid $border-light; border-radius: 6px; background: $bg-card; cursor: pointer; text-align: start; }
.url-row code, .copy-secret code { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.route-meta { display: flex; flex-wrap: wrap; gap: 12px; margin-top: 10px; color: $text-muted; font-size: 12px; }
.empty { padding: 36px 0; } .form-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
.modal-actions { display: flex; justify-content: flex-end; gap: 8px; }
.destination-alert { margin-bottom: 16px; }
@media (max-width: 640px) { .webhook-intro, .toolbar, .enable-panel, .route-head { align-items: flex-start; flex-direction: column; } .form-grid { grid-template-columns: 1fr; } .base-url { align-items: flex-start; flex-direction: column; max-width: 100%; } }
</style>
