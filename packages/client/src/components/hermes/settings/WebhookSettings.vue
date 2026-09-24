<script setup lang="ts">
import { computed, h, onBeforeUnmount, onMounted, reactive, ref } from 'vue'
import {
  NAlert,
  NButton,
  NDataTable,
  NForm,
  NFormItem,
  NInput,
  NInputNumber,
  NModal,
  NPopconfirm,
  NSelect,
  NSpace,
  NSwitch,
  NTag,
  NText,
  useMessage,
  type DataTableColumns,
} from 'naive-ui'
import { useI18n } from 'vue-i18n'
import {
  clearLocalChatWebhookTestEvents,
  createChatWebhookEndpoint,
  deleteChatWebhookEndpoint,
  fetchChatWebhookEndpoints,
  fetchLocalChatWebhookTestEvents,
  fetchLocalChatWebhookTestTarget,
  testChatWebhookEndpoint,
  updateChatWebhookEndpoint,
  type ChatWebhookEndpoint,
  type ChatWebhookEventType,
  type LocalChatWebhookTestEvent,
} from '@/api/studio/chat-webhooks'
import { useProfilesStore } from '@/stores/hermes/profiles'

const { t } = useI18n()
const message = useMessage()
const profilesStore = useProfilesStore()

const endpoints = ref<ChatWebhookEndpoint[]>([])
const loading = ref(false)
const saving = ref(false)
const testingId = ref<string | null>(null)
const creatingLocalTest = ref(false)
const localTestEvents = ref<LocalChatWebhookTestEvent[]>([])
const loadingLocalEvents = ref(false)
const clearingLocalEvents = ref(false)
const viewingLocalEvent = ref<LocalChatWebhookTestEvent | null>(null)
const showModal = ref(false)
const editingEndpoint = ref<ChatWebhookEndpoint | null>(null)
let refreshTimer: ReturnType<typeof setInterval> | null = null

const DEFAULT_EVENT_TYPES: ChatWebhookEventType[] = [
  'chat.message.created',
  'chat.run.queued',
  'chat.run.started',
  'chat.tool.started',
  'chat.tool.completed',
  'chat.tool.failed',
  'chat.approval.requested',
  'chat.approval.resolved',
  'chat.clarification.requested',
  'chat.clarification.resolved',
  'chat.run.completed',
  'chat.run.failed',
  'group.message.created',
  'group.run.failed',
  'group.approval.requested',
  'group.approval.resolved',
  'group.clarification.requested',
  'group.clarification.resolved',
  'workflow.run.completed',
  'workflow.run.failed',
  'chat.run.updated',
  'group.run.updated',
  'workflow.run.updated',
  'chat.plan.updated',
  'group.plan.updated',
  'workflow.plan.updated',
]

const EVENT_LABEL_KEYS: Record<ChatWebhookEventType, string> = {
  'chat.message.created': 'messageCreated',
  'chat.run.queued': 'runQueued',
  'chat.run.started': 'runStarted',
  'chat.tool.started': 'toolStarted',
  'chat.tool.completed': 'toolCompleted',
  'chat.tool.failed': 'toolFailed',
  'chat.approval.requested': 'approvalRequested',
  'chat.approval.resolved': 'approvalResolved',
  'chat.clarification.requested': 'clarificationRequested',
  'chat.clarification.resolved': 'clarificationResolved',
  'chat.run.completed': 'completed',
  'chat.run.failed': 'failed',
  'group.message.created': 'groupMessageCreated',
  'group.run.failed': 'failed',
  'group.approval.requested': 'approvalRequested',
  'group.approval.resolved': 'approvalResolved',
  'group.clarification.requested': 'clarificationRequested',
  'group.clarification.resolved': 'clarificationResolved',
  'workflow.run.completed': 'completed',
  'workflow.run.failed': 'failed',
  'chat.run.updated': 'runUpdated',
  'group.run.updated': 'runUpdated',
  'workflow.run.updated': 'runUpdated',
  'chat.plan.updated': 'planUpdated',
  'group.plan.updated': 'planUpdated',
  'workflow.plan.updated': 'planUpdated',
}

const form = reactive({
  name: '',
  url: '',
  secret: '',
  eventTypes: [...DEFAULT_EVENT_TYPES],
  profiles: [] as string[],
  enabled: true,
  includeContent: false,
  includeUserContent: false,
  allowPrivateNetwork: false,
  maxRetries: 3,
  clearSecret: false,
})

const eventOptions = computed(() => DEFAULT_EVENT_TYPES.map(value => ({
  label: eventLabel(value),
  value,
})))

function eventLabel(event: ChatWebhookEventType): string {
  const label = t(`settings.webhooks.events.${EVENT_LABEL_KEYS[event]}`)
  return event.startsWith('chat.') ? label : `${event} · ${label}`
}

const profileOptions = computed(() => profilesStore.profiles.map(profile => ({
  label: profile.alias || profile.name,
  value: profile.name,
})))

function resetForm() {
  editingEndpoint.value = null
  form.name = ''
  form.url = ''
  form.secret = ''
  form.eventTypes = [...DEFAULT_EVENT_TYPES]
  form.profiles = []
  form.enabled = true
  form.includeContent = false
  form.includeUserContent = false
  form.allowPrivateNetwork = false
  form.maxRetries = 3
  form.clearSecret = false
}

function openCreate() {
  resetForm()
  showModal.value = true
}

async function openLocalTest() {
  creatingLocalTest.value = true
  try {
    const target = await fetchLocalChatWebhookTestTarget()
    resetForm()
    form.name = t('settings.webhooks.form.localTestName')
    form.url = target.url
    form.includeContent = true
    form.allowPrivateNetwork = target.allow_private_network
    form.enabled = false
    showModal.value = true
  } catch (error: any) {
    message.error(error?.message || t('settings.webhooks.messages.localTestFailed'))
  } finally {
    creatingLocalTest.value = false
  }
}

function openEdit(endpoint: ChatWebhookEndpoint) {
  editingEndpoint.value = endpoint
  form.name = endpoint.name
  form.url = endpoint.url
  form.secret = ''
  form.eventTypes = [...endpoint.event_types]
  form.profiles = [...endpoint.profiles]
  form.enabled = endpoint.enabled
  form.includeContent = endpoint.include_content
  form.includeUserContent = endpoint.include_user_content
  form.allowPrivateNetwork = endpoint.allow_private_network
  form.maxRetries = endpoint.max_retries
  form.clearSecret = false
  showModal.value = true
}

async function loadEndpoints(silent = false) {
  if (!silent) loading.value = true
  try {
    endpoints.value = await fetchChatWebhookEndpoints()
  } catch (error: any) {
    if (!silent) message.error(error?.message || t('settings.webhooks.messages.loadFailed'))
  } finally {
    if (!silent) loading.value = false
  }
}

async function loadLocalTestEvents(silent = false) {
  if (!silent) loadingLocalEvents.value = true
  try {
    localTestEvents.value = await fetchLocalChatWebhookTestEvents()
  } catch (error: any) {
    if (!silent) message.error(error?.message || t('settings.webhooks.messages.inboxLoadFailed'))
  } finally {
    if (!silent) loadingLocalEvents.value = false
  }
}

async function clearLocalTestEvents() {
  clearingLocalEvents.value = true
  try {
    await clearLocalChatWebhookTestEvents()
    localTestEvents.value = []
    viewingLocalEvent.value = null
    message.success(t('settings.webhooks.messages.inboxCleared'))
  } catch (error: any) {
    message.error(error?.message || t('settings.webhooks.messages.inboxClearFailed'))
  } finally {
    clearingLocalEvents.value = false
  }
}

async function submit() {
  const name = form.name.trim()
  const url = form.url.trim()
  if (!name || !url) {
    message.error(t('settings.webhooks.messages.required'))
    return
  }
  if (form.eventTypes.length === 0) {
    message.error(t('settings.webhooks.messages.eventRequired'))
    return
  }

  const payload = {
    name,
    url,
    event_types: [...form.eventTypes],
    profiles: [...form.profiles],
    enabled: form.enabled,
    include_content: form.includeContent,
    include_user_content: form.includeUserContent,
    allow_private_network: form.allowPrivateNetwork,
    max_retries: form.maxRetries,
    ...(form.secret ? { secret: form.secret } : {}),
    ...(editingEndpoint.value && form.clearSecret ? { clear_secret: true } : {}),
  }

  saving.value = true
  try {
    if (editingEndpoint.value) {
      await updateChatWebhookEndpoint(editingEndpoint.value.id, payload)
    } else {
      await createChatWebhookEndpoint(payload)
    }
    showModal.value = false
    resetForm()
    await loadEndpoints()
    message.success(t('settings.webhooks.messages.saved'))
  } catch (error: any) {
    message.error(error?.message || t('settings.webhooks.messages.saveFailed'))
  } finally {
    saving.value = false
  }
}

async function toggleEnabled(endpoint: ChatWebhookEndpoint) {
  saving.value = true
  try {
    await updateChatWebhookEndpoint(endpoint.id, { enabled: !endpoint.enabled })
    await loadEndpoints()
    message.success(t('settings.webhooks.messages.saved'))
  } catch (error: any) {
    message.error(error?.message || t('settings.webhooks.messages.saveFailed'))
  } finally {
    saving.value = false
  }
}

async function testEndpoint(endpoint: ChatWebhookEndpoint) {
  testingId.value = endpoint.id
  try {
    await testChatWebhookEndpoint(endpoint.id)
    await Promise.all([loadEndpoints(), loadLocalTestEvents(true)])
    message.success(t('settings.webhooks.messages.testSucceeded'))
  } catch (error: any) {
    await Promise.all([loadEndpoints(), loadLocalTestEvents(true)])
    message.error(error?.message || t('settings.webhooks.messages.testFailed'))
  } finally {
    testingId.value = null
  }
}

async function removeEndpoint(endpoint: ChatWebhookEndpoint) {
  saving.value = true
  try {
    await deleteChatWebhookEndpoint(endpoint.id)
    await loadEndpoints()
    message.success(t('settings.webhooks.messages.deleted'))
  } catch (error: any) {
    message.error(error?.message || t('settings.webhooks.messages.deleteFailed'))
  } finally {
    saving.value = false
  }
}

function runtimeTagType(state: ChatWebhookEndpoint['runtime']['state']) {
  if (state === 'success') return 'success' as const
  if (state === 'failed' || state === 'dropped') return 'error' as const
  if (state === 'delivering' || state === 'retrying') return 'warning' as const
  return 'default' as const
}

const columns = computed<DataTableColumns<ChatWebhookEndpoint>>(() => [
  {
    title: t('settings.webhooks.columns.name'),
    key: 'name',
    minWidth: 140,
  },
  {
    title: t('settings.webhooks.columns.url'),
    key: 'url',
    minWidth: 260,
    ellipsis: { tooltip: true },
  },
  {
    title: t('settings.webhooks.columns.events'),
    key: 'event_types',
    minWidth: 180,
    render: row => h(NSpace, { size: 4 }, {
      default: () => row.event_types.map(event => h(NTag, { size: 'small', bordered: false }, {
        default: () => eventLabel(event),
      })),
    }),
  },
  {
    title: t('settings.webhooks.columns.profiles'),
    key: 'profiles',
    minWidth: 160,
    render: row => row.profiles.length
      ? h(NSpace, { size: 4 }, {
          default: () => row.profiles.map(profile => h(NTag, { size: 'small', bordered: false }, {
            default: () => profile,
          })),
        })
      : h(NText, { depth: 3 }, { default: () => t('settings.webhooks.allProfiles') }),
  },
  {
    title: t('settings.webhooks.columns.status'),
    key: 'status',
    width: 150,
    render: row => h(NSpace, { size: 4, vertical: true }, {
      default: () => [
        h(NTag, { size: 'small', type: row.enabled ? 'success' : 'default' }, {
          default: () => row.enabled
            ? t('settings.webhooks.status.enabled')
            : t('settings.webhooks.status.disabled'),
        }),
        (row.enabled || row.runtime.state !== 'idle') && h(NTag, { size: 'small', type: runtimeTagType(row.runtime.state), bordered: false }, {
          default: () => `${t(`settings.webhooks.runtime.${row.runtime.state}`)} · ${t('settings.webhooks.queued', { count: row.runtime.queued })}`,
        }),
      ].filter(Boolean),
    }),
  },
  {
    title: t('settings.webhooks.columns.actions'),
    key: 'actions',
    width: 310,
    fixed: 'right',
    render: row => h(NSpace, { size: 6, wrap: false }, {
      default: () => [
        h(NButton, { size: 'small', onClick: () => openEdit(row) }, {
          default: () => t('common.edit'),
        }),
        h(NButton, {
          size: 'small',
          loading: testingId.value === row.id,
          onClick: () => testEndpoint(row),
        }, { default: () => t('settings.webhooks.actions.test') }),
        h(NButton, {
          size: 'small',
          type: row.enabled ? 'warning' : 'primary',
          ghost: true,
          loading: saving.value,
          onClick: () => toggleEnabled(row),
        }, {
          default: () => row.enabled
            ? t('settings.webhooks.actions.disable')
            : t('settings.webhooks.actions.enable'),
        }),
        h(NPopconfirm, { onPositiveClick: () => removeEndpoint(row) }, {
          trigger: () => h(NButton, {
            size: 'small',
            type: 'error',
            ghost: true,
            loading: saving.value,
          }, { default: () => t('common.delete') }),
          default: () => t('settings.webhooks.deleteConfirm'),
        }),
      ],
    }),
  },
])

function formatReceivedAt(value: string): string {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString()
}

function inboxEventTagType(event: string) {
  if (event.endsWith('.failed')) return 'error' as const
  if (event.endsWith('.requested') || event.endsWith('.queued')) return 'warning' as const
  if (event.endsWith('.started')) return 'info' as const
  return 'success' as const
}

const localTestColumns = computed<DataTableColumns<LocalChatWebhookTestEvent>>(() => [
  {
    title: t('settings.webhooks.columns.receivedAt'),
    key: 'received_at',
    width: 180,
    render: row => formatReceivedAt(row.received_at),
  },
  {
    title: t('settings.webhooks.columns.event'),
    key: 'event',
    minWidth: 170,
    render: row => h(NTag, {
      size: 'small',
      bordered: false,
      type: inboxEventTagType(row.event),
    }, { default: () => row.event }),
  },
  {
    title: t('settings.webhooks.columns.eventId'),
    key: 'event_id',
    minWidth: 210,
    ellipsis: { tooltip: true },
  },
  {
    title: t('settings.webhooks.columns.deliveryId'),
    key: 'delivery_id',
    minWidth: 210,
    ellipsis: { tooltip: true },
  },
  {
    title: t('settings.webhooks.columns.actions'),
    key: 'actions',
    width: 90,
    fixed: 'right',
    render: row => h(NButton, {
      size: 'small',
      onClick: () => { viewingLocalEvent.value = row },
    }, { default: () => t('settings.webhooks.actions.view') }),
  },
])

onMounted(async () => {
  if (profilesStore.profiles.length === 0) await profilesStore.fetchProfiles()
  await Promise.all([loadEndpoints(), loadLocalTestEvents()])
  refreshTimer = setInterval(() => {
    void loadEndpoints(true)
    void loadLocalTestEvents(true)
  }, 5_000)
})

onBeforeUnmount(() => {
  if (refreshTimer) clearInterval(refreshTimer)
  refreshTimer = null
})
</script>

<template>
  <div class="webhook-settings">
    <div class="toolbar">
      <div>
        <h3 class="section-title">{{ t('settings.webhooks.title') }}</h3>
        <p class="section-desc">{{ t('settings.webhooks.description') }}</p>
      </div>
      <NSpace>
        <NButton :loading="creatingLocalTest" @click="openLocalTest">
          {{ t('settings.webhooks.actions.localTest') }}
        </NButton>
        <NButton type="primary" @click="openCreate">
          {{ t('settings.webhooks.actions.add') }}
        </NButton>
      </NSpace>
    </div>

    <NAlert type="info" :show-icon="false" class="delivery-note">
      {{ t('settings.webhooks.deliveryNote') }}
    </NAlert>

    <NDataTable
      :columns="columns"
      :data="endpoints"
      :loading="loading"
      :bordered="false"
      :single-line="false"
      :scroll-x="1200"
      size="small"
    />

    <section class="local-inbox">
      <div class="toolbar local-inbox-toolbar">
        <div>
          <h3 class="section-title">{{ t('settings.webhooks.localInboxTitle') }}</h3>
          <p class="section-desc">
            {{ t('settings.webhooks.localInboxDescription', { count: localTestEvents.length }) }}
          </p>
        </div>
        <NSpace>
          <NButton size="small" :loading="loadingLocalEvents" @click="loadLocalTestEvents()">
            {{ t('settings.webhooks.actions.refresh') }}
          </NButton>
          <NPopconfirm @positive-click="clearLocalTestEvents">
            <template #trigger>
              <NButton
                size="small"
                type="error"
                ghost
                :disabled="localTestEvents.length === 0"
                :loading="clearingLocalEvents"
              >
                {{ t('settings.webhooks.actions.clear') }}
              </NButton>
            </template>
            {{ t('settings.webhooks.clearInboxConfirm') }}
          </NPopconfirm>
        </NSpace>
      </div>

      <NDataTable
        v-if="loadingLocalEvents || localTestEvents.length > 0"
        :columns="localTestColumns"
        :data="localTestEvents"
        :loading="loadingLocalEvents"
        :bordered="false"
        :single-line="false"
        :scroll-x="860"
        size="small"
      />
      <div v-else class="local-inbox-empty">
        <NText depth="3">{{ t('settings.webhooks.localInboxEmpty') }}</NText>
      </div>
    </section>

    <NModal
      v-model:show="showModal"
      preset="dialog"
      :title="editingEndpoint ? t('settings.webhooks.editTitle') : t('settings.webhooks.createTitle')"
      style="width: min(680px, 92vw)"
    >
      <NForm label-placement="top">
        <NFormItem :label="t('settings.webhooks.form.name')" required>
          <NInput v-model:value="form.name" :placeholder="t('settings.webhooks.form.namePlaceholder')" />
        </NFormItem>
        <NFormItem :label="t('settings.webhooks.form.url')" required>
          <NInput v-model:value="form.url" placeholder="https://example.com/webhooks/hermes" />
        </NFormItem>
        <NFormItem :label="t('settings.webhooks.form.secret')">
          <NInput
            v-model:value="form.secret"
            type="password"
            show-password-on="click"
            :placeholder="editingEndpoint?.has_secret
              ? t('settings.webhooks.form.secretKeepPlaceholder')
              : t('settings.webhooks.form.secretPlaceholder')"
          />
        </NFormItem>
        <NFormItem
          v-if="editingEndpoint?.has_secret"
          :label="t('settings.webhooks.form.clearSecret')"
          label-placement="left"
        >
          <NSwitch v-model:value="form.clearSecret" :disabled="Boolean(form.secret)" />
        </NFormItem>
        <NFormItem :label="t('settings.webhooks.form.events')" required>
          <NSelect v-model:value="form.eventTypes" multiple :options="eventOptions" />
        </NFormItem>
        <NFormItem :label="t('settings.webhooks.form.profiles')">
          <NSelect
            v-model:value="form.profiles"
            multiple
            filterable
            :options="profileOptions"
            :placeholder="t('settings.webhooks.form.profilesPlaceholder')"
          />
        </NFormItem>
        <NFormItem :label="t('settings.webhooks.form.maxRetries')">
          <NInputNumber v-model:value="form.maxRetries" :min="0" :max="10" :precision="0" />
        </NFormItem>
        <NFormItem :label="t('settings.webhooks.form.includeContent')" label-placement="left">
          <NSwitch v-model:value="form.includeContent" />
        </NFormItem>
        <NAlert v-if="form.includeContent" type="warning" class="form-alert">
          {{ t('settings.webhooks.form.includeContentHint') }}
        </NAlert>
        <NFormItem :label="t('settings.webhooks.form.includeUserContent')" label-placement="left">
          <NSwitch v-model:value="form.includeUserContent" />
        </NFormItem>
        <NAlert v-if="form.includeUserContent" type="warning" class="form-alert">
          {{ t('settings.webhooks.form.includeUserContentHint') }}
        </NAlert>
        <NFormItem :label="t('settings.webhooks.form.allowPrivateNetwork')" label-placement="left">
          <NSwitch v-model:value="form.allowPrivateNetwork" />
        </NFormItem>
        <NAlert v-if="form.allowPrivateNetwork" type="warning" class="form-alert">
          {{ t('settings.webhooks.form.allowPrivateNetworkHint') }}
        </NAlert>
        <NFormItem :label="t('settings.webhooks.form.enabled')" label-placement="left">
          <NSwitch v-model:value="form.enabled" />
        </NFormItem>
      </NForm>
      <template #action>
        <NButton @click="showModal = false">{{ t('common.cancel') }}</NButton>
        <NButton type="primary" :loading="saving" @click="submit">{{ t('common.save') }}</NButton>
      </template>
    </NModal>

    <NModal
      :show="Boolean(viewingLocalEvent)"
      preset="card"
      :title="t('settings.webhooks.localInboxPayloadTitle')"
      style="width: min(780px, 92vw)"
      @update:show="value => { if (!value) viewingLocalEvent = null }"
    >
      <pre class="payload-preview">{{ JSON.stringify(viewingLocalEvent?.payload ?? {}, null, 2) }}</pre>
    </NModal>
  </div>
</template>

<style scoped lang="scss">
@use "@/styles/variables" as *;

.webhook-settings {
  padding: 8px 0;
}

.toolbar {
  display: flex;
  flex-wrap: wrap;
  justify-content: space-between;
  align-items: flex-start;
  gap: 16px;
  margin-bottom: 16px;
}

.section-title {
  margin: 0 0 6px;
  font-size: 16px;
  font-weight: 600;
  color: $text-primary;
}

.section-desc {
  margin: 0;
  font-size: 13px;
  color: $text-muted;
}

.delivery-note {
  margin-bottom: 16px;
}

.local-inbox {
  margin-top: 28px;
}

.local-inbox-toolbar {
  margin-bottom: 12px;
}

.local-inbox-empty {
  padding: 28px 16px;
  text-align: center;
  border: 1px dashed $border-color;
  border-radius: 8px;
}

.payload-preview {
  max-height: 60vh;
  margin: 0;
  padding: 14px;
  overflow: auto;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  border-radius: 8px;
  background: $bg-secondary;
  color: $text-primary;
  font: 12px/1.55 ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
}

.form-alert {
  margin: -8px 0 16px;
}
</style>
