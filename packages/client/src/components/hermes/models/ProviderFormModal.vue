<script setup lang="ts">
import { ref, watch, computed, onMounted, nextTick } from 'vue'
import { NModal, NForm, NFormItem, NInput, NInputNumber, NButton, NSelect, NRadioGroup, NRadioButton, useMessage, useDialog } from 'naive-ui'
import { useModelsStore } from '@/stores/hermes/models'
import { useI18n } from 'vue-i18n'
import CodexLoginModal from './CodexLoginModal.vue'
import NousLoginModal from './NousLoginModal.vue'
import CopilotLoginModal from './CopilotLoginModal.vue'
import XaiOAuthLoginModal from './XaiOAuthLoginModal.vue'
import AnthropicLoginModal from './AnthropicLoginModal.vue'
import MiniMaxOAuthLoginModal from './MiniMaxOAuthLoginModal.vue'
import { checkCopilotToken, enableCopilot, type CopilotTokenSource } from '@/api/hermes/copilot-auth'
import { fetchProviderModels } from '@/api/hermes/system'
import type { ProviderApiMode } from '@/api/studio/provider-api-mode'
import { inferApiKeyFunPresetProvider, isApiKeyFunBaseUrl, type ApiKeyFunPresetProvider } from '@/utils/providerBaseUrl'

const { t } = useI18n()

const emit = defineEmits<{
  close: []
  saved: [globalModelsAlreadyRefreshed?: boolean]
}>()

const modelsStore = useModelsStore()
const message = useMessage()
const dialog = useDialog()

const showModal = ref(true)
const loading = ref(false)
const fetchingModels = ref(false)
const showCodexLogin = ref(false)
const showNousLogin = ref(false)
const showCopilotLogin = ref(false)
const showXaiLogin = ref(false)
const showAnthropicLogin = ref(false)
const showMiniMaxLogin = ref(false)
const copilotChecking = ref(false)

const providerType = ref<'preset' | 'custom'>('preset')
const selectedPreset = ref<string | null>(null)
const formData = ref({
  name: '',
  base_url: '',
  api_key: '',
  model: '',
  context_length: null as number | null,
  api_mode: 'chat_completions' as ProviderApiMode,
})

const providerNameInputProps = {
  name: 'new-provider-name',
  autocomplete: 'off',
  spellcheck: false,
  'data-form-type': 'other',
}
const providerBaseUrlInputProps = {
  name: 'new-provider-base-url',
  autocomplete: 'off',
  spellcheck: false,
  'data-form-type': 'other',
}
const providerApiKeyInputProps = {
  name: 'new-provider-api-key',
  autocomplete: 'new-password',
  autocapitalize: 'none',
  spellcheck: false,
  'data-form-type': 'other',
  'data-1p-ignore': 'true',
  'data-lpignore': 'true',
}
const providerModelInputProps = {
  name: 'new-provider-default-model',
  autocomplete: 'off',
  spellcheck: false,
  'data-form-type': 'other',
}

const modelOptions = ref<Array<{ label: string; value: string }>>([])
const apiModeOptions: Array<{ label: string; value: ProviderApiMode }> = [
  { label: 'chat_completions (/chat/completions)', value: 'chat_completions' },
  { label: 'codex_responses (/responses)', value: 'codex_responses' },
  { label: 'anthropic_messages (/messages)', value: 'anthropic_messages' },
  { label: 'bedrock_converse (Converse API)', value: 'bedrock_converse' },
  { label: 'codex_app_server (App Server)', value: 'codex_app_server' },
]

const CODEX_KEY = 'openai-codex'
const NOUS_KEY = 'nous'
const COPILOT_KEY = 'copilot'
const CLIPROXYAPI_KEY = 'cliproxyapi'
const XAI_OAUTH_KEY = 'xai-oauth'
const CLAUDE_OAUTH_KEY = 'claude-oauth'
const MINIMAX_OAUTH_KEY = 'minimax-oauth'
const ALIBABA_CODING_KEY = 'alibaba-coding-plan'
const CUSTOM_STORED_PRESET_KEYS = new Set(['fun-codex', 'fun-claude'])
const ALIBABA_CODING_REGIONS = {
  intl: 'https://coding-intl.dashscope.aliyuncs.com/v1',
  cn: 'https://coding.dashscope.aliyuncs.com/v1',
} as const

const isCodex = computed(() => selectedPreset.value === CODEX_KEY)
const isNous = computed(() => selectedPreset.value === NOUS_KEY)
const isCopilot = computed(() => selectedPreset.value === COPILOT_KEY)
const isCliproxyApi = computed(() => selectedPreset.value === CLIPROXYAPI_KEY)
const isXaiOAuth = computed(() => selectedPreset.value === XAI_OAUTH_KEY)
const isClaudeOAuth = computed(() => selectedPreset.value === CLAUDE_OAUTH_KEY)
const isMiniMaxOAuth = computed(() => selectedPreset.value === MINIMAX_OAUTH_KEY)
const isOpenCodeFree = computed(() => selectedPreset.value === 'opencode-free')
const isAlibabaCoding = computed(() => selectedPreset.value === ALIBABA_CODING_KEY)
const alibabaCodingRegion = ref<'intl' | 'cn'>('intl')

const presetOptions = computed(() =>
  modelsStore.allProviders.map(g => ({ label: g.label, value: g.provider })),
)
const selectedPresetProvider = computed(() =>
  selectedPreset.value ? modelsStore.allProviders.find(g => g.provider === selectedPreset.value) : null,
)
const canEditPresetBaseUrl = computed(() => !!selectedPresetProvider.value?.base_url_env)
const canFetchProviderCatalog = computed(() =>
  !!formData.value.base_url.trim() &&
  (providerType.value === 'custom' || (
    providerType.value === 'preset' &&
    !isCodex.value &&
    !isNous.value &&
    !isCopilot.value &&
    !isXaiOAuth.value &&
    !isClaudeOAuth.value &&
    !isMiniMaxOAuth.value
  )),
)

const FUN_LINK_MAP: Record<string, string> = {
  'fun-codex': 'https://apikey.fan/register?aff=LIBAPI',
  'fun-claude': 'https://apikey.fan/register?aff=LIBAPI',
}

const funProviderLink = computed(() => selectedPreset.value ? FUN_LINK_MAP[selectedPreset.value] || '' : '')

async function switchToApiKeyFunPreset(providerKey: ApiKeyFunPresetProvider, preferredModel: string) {
  const apiKey = formData.value.api_key
  const contextLength = formData.value.context_length
  providerType.value = 'preset'
  await nextTick()
  selectedPreset.value = providerKey
  await nextTick()
  formData.value.api_key = apiKey
  formData.value.context_length = contextLength
  if (preferredModel) {
    if (!modelOptions.value.some(option => option.value === preferredModel)) {
      modelOptions.value = [{ label: preferredModel, value: preferredModel }, ...modelOptions.value]
    }
    formData.value.model = preferredModel
  }
}

async function routeApiKeyFunCustomProvider(model: string) {
  if (providerType.value !== 'custom') return
  if (!isApiKeyFunBaseUrl(formData.value.base_url)) return
  const providerKey = inferApiKeyFunPresetProvider(model)
  if (!providerKey) return
  await switchToApiKeyFunPreset(providerKey, model)
}

function autoGenerateName(url: string): string {
  const clean = url.replace(/^https?:\/\//, '').replace(/\/v1\/?$/, '')
  const host = clean.split('/')[0]
  if (host.includes('localhost') || host.includes('127.0.0.1')) {
    return t('models.local', { host })
  }
  return host.charAt(0).toUpperCase() + host.slice(1)
}

function customProviderKey(name: string): string {
  return `custom:${name.trim().toLowerCase().replace(/ /g, '-')}`
}

watch(selectedPreset, (val) => {
  formData.value.model = ''
  if (val === 'opencode-free') formData.value.api_key = ''
  alibabaCodingRegion.value = 'intl'
  if (val) {
    const group = selectedPresetProvider.value
    if (group) {
      formData.value.name = group.label
      formData.value.base_url = group.base_url
      formData.value.api_mode = group.api_mode || 'chat_completions'
      modelOptions.value = group.models.map((m: string) => ({ label: m, value: m }))
      if (group.models.length > 0) {
        formData.value.model = group.models[0]
      }
    }
    if (val === COPILOT_KEY) {
      // 判断是否已能解析到 token：有 → 弹简单确认；无 → 走 in-app device flow
      void triggerCopilotAdd()
    } else if (val === XAI_OAUTH_KEY) {
      showXaiLogin.value = true
    } else if (val === CLAUDE_OAUTH_KEY) {
      showAnthropicLogin.value = true
    } else if (val === MINIMAX_OAUTH_KEY) {
      showMiniMaxLogin.value = true
    }
  }
})

watch(alibabaCodingRegion, (region) => {
  if (isAlibabaCoding.value) {
    formData.value.base_url = ALIBABA_CODING_REGIONS[region]
  }
})

watch(() => formData.value.base_url, (url) => {
  if (providerType.value === 'custom' && url.trim() && !formData.value.name) {
    formData.value.name = autoGenerateName(url.trim())
  }
})

watch(() => formData.value.model, (model) => {
  void routeApiKeyFunCustomProvider(model)
})

watch(providerType, () => {
  modelOptions.value = []
  formData.value = { name: '', base_url: '', api_key: '', model: '', context_length: null, api_mode: 'chat_completions' }
  selectedPreset.value = null
})

onMounted(() => {
  if (modelsStore.providers.length === 0) {
    modelsStore.fetchProviders()
  }
})

async function fetchModels() {
  const { base_url } = formData.value
  if (!base_url.trim()) {
    message.warning(t('models.enterBaseUrl'))
    return
  }

  fetchingModels.value = true
  try {
    const provider = providerType.value === 'preset'
      ? selectedPreset.value && CUSTOM_STORED_PRESET_KEYS.has(selectedPreset.value)
        ? customProviderKey(selectedPreset.value)
        : selectedPreset.value || undefined
      : formData.value.name.trim()
        ? customProviderKey(formData.value.name)
        : undefined
    const label = providerType.value === 'preset'
      ? selectedPresetProvider.value?.label || provider
      : formData.value.name.trim() || provider
    const data = await fetchProviderModels({
      base_url: base_url.trim(),
      api_key: isOpenCodeFree.value ? '' : formData.value.api_key.trim(),
      provider,
      label,
      update_cache: !!provider,
    })
    modelOptions.value = data.models.map(m => ({ label: m, value: m }))
    if (modelOptions.value.length > 0 && !formData.value.model) {
      formData.value.model = modelOptions.value[0].value
    }
    message.success(t('models.foundModels', { count: modelOptions.value.length }))
  } catch (e: any) {
    message.error(t('models.fetchFailed') + ': ' + e.message)
  } finally {
    fetchingModels.value = false
  }
}

async function handleSave() {
  if (providerType.value === 'preset' && !selectedPreset.value) {
    message.warning(t('models.selectProviderRequired'))
    return
  }

  // Codex: 弹出授权码弹窗
  if (isCodex.value) {
    showCodexLogin.value = true
    return
  }

  // Nous: 弹出 OAuth 设备码弹窗
  if (isNous.value) {
    showNousLogin.value = true
    return
  }

  // Copilot: 走 token-aware 的添加流程（已有 token → 确认窗；否则 device flow）
  if (isCopilot.value) {
    void triggerCopilotAdd()
    return
  }

  if (isXaiOAuth.value) {
    showXaiLogin.value = true
    return
  }

  if (isClaudeOAuth.value) {
    showAnthropicLogin.value = true
    return
  }

  if (isMiniMaxOAuth.value) {
    showMiniMaxLogin.value = true
    return
  }

  if (!formData.value.base_url.trim()) {
    message.warning(t('models.baseUrlRequired'))
    return
  }
  if (!formData.value.api_key.trim() && !isCliproxyApi.value && !isXaiOAuth.value && !isClaudeOAuth.value && !isMiniMaxOAuth.value && !isOpenCodeFree.value) {
    message.warning(t('models.apiKeyRequired'))
    return
  }
  if (!formData.value.model) {
    message.warning(t('models.modelRequired'))
    return
  }

  loading.value = true
  try {
    const contextLength = formData.value.context_length ?? undefined
    const apiKeyFunPreset = providerType.value === 'custom' && isApiKeyFunBaseUrl(formData.value.base_url)
      ? inferApiKeyFunPresetProvider(formData.value.model)
      : null
    const providerKey = providerType.value === 'preset'
      ? selectedPreset.value
      : apiKeyFunPreset
    const presetProvider = apiKeyFunPreset
      ? modelsStore.allProviders.find(group => group.provider === apiKeyFunPreset)
      : null
    const baseUrl = presetProvider?.base_url || formData.value.base_url.trim()
    const providerName = presetProvider?.label || formData.value.name.trim()

    await modelsStore.addProvider({
      name: providerName,
      base_url: baseUrl,
      api_key: isOpenCodeFree.value ? '' : formData.value.api_key.trim(),
      model: formData.value.model,
      context_length: contextLength,
      api_mode: formData.value.api_mode,
      providerKey,
    })
    message.success(t('models.providerAdded'))
    emit('saved', true)
  } catch (e: any) {
    message.error(e.message)
  } finally {
    loading.value = false
  }
}

async function handleCodexSuccess() {
  showCodexLogin.value = false
  message.success(t('models.providerAdded'))
  emit('saved')
}

async function handleNousSuccess() {
  showNousLogin.value = false
  message.success(t('models.providerAdded'))
  emit('saved')
}

async function handleCopilotSuccess() {
  showCopilotLogin.value = false
  message.success(t('models.providerAdded'))
  emit('saved')
}

async function handleXaiSuccess() {
  showXaiLogin.value = false
  message.success(t('models.providerAdded'))
  emit('saved')
}

async function handleAnthropicSuccess() {
  showAnthropicLogin.value = false
  message.success(t('models.providerAdded'))
  emit('saved')
}

async function handleMiniMaxSuccess() {
  showMiniMaxLogin.value = false
  message.success(t('models.providerAdded'))
  emit('saved')
}

function copilotSourceLabel(source: CopilotTokenSource): string {
  if (source === 'env') return t('models.copilotAddSourceEnv')
  if (source === 'gh-cli') return t('models.copilotAddSourceGhCli')
  if (source === 'apps-json') return t('models.copilotAddSourceAppsJson')
  return ''
}

async function triggerCopilotAdd() {
  if (copilotChecking.value) return
  copilotChecking.value = true
  try {
    const status = await checkCopilotToken()
    if (status.has_token) {
      // 已能解析到 token：弹确认窗，用户点 [添加] → enable + saved
      const sourceText = copilotSourceLabel(status.source)
      dialog.success({
        title: t('models.copilotAddDetectedTitle'),
        content: sourceText
          ? `${t('models.copilotAddDetected')}\n\n${sourceText}`
          : t('models.copilotAddDetected'),
        positiveText: t('common.add'),
        negativeText: t('common.cancel'),
        onPositiveClick: async () => {
          try {
            await enableCopilot()
            message.success(t('models.providerAdded'))
            emit('saved')
          } catch (e: any) {
            message.error(e?.message ?? String(e))
          }
        },
        onNegativeClick: () => {
          selectedPreset.value = null
        },
        onClose: () => {
          selectedPreset.value = null
        },
      })
    } else {
      // 无 token：device flow
      showCopilotLogin.value = true
    }
  } catch (e: any) {
    message.error(e?.message ?? String(e))
    selectedPreset.value = null
  } finally {
    copilotChecking.value = false
  }
}

function handleCopilotClose() {
  showCopilotLogin.value = false
  // 用户取消 Copilot 引导时，清空选择避免卡在无 api_key 状态
  selectedPreset.value = null
}

function handleXaiClose() {
  showXaiLogin.value = false
  selectedPreset.value = null
}

function handleAnthropicClose() {
  showAnthropicLogin.value = false
  selectedPreset.value = null
}

function handleMiniMaxClose() {
  showMiniMaxLogin.value = false
  selectedPreset.value = null
}

function handleClose() {
  showModal.value = false
  setTimeout(() => emit('close'), 200)
}
</script>

<template>
  <NModal
    v-model:show="showModal"
    preset="card"
    :title="t('models.addProvider')"
    :style="{ width: 'min(520px, calc(100vw - 32px))' }"
    :mask-closable="!loading && !showCodexLogin && !showNousLogin && !showCopilotLogin && !showXaiLogin && !showAnthropicLogin && !showMiniMaxLogin"
    @after-leave="emit('close')"
  >
    <NForm label-placement="top" autocomplete="off">
      <NFormItem :label="t('models.providerType')">
        <div style="display: flex; gap: 12px">
          <NButton
            :type="providerType === 'preset' ? 'primary' : 'default'"
            size="small"
            @click="providerType = 'preset'"
          >
            {{ t('models.preset') }}
          </NButton>
          <NButton
            :type="providerType === 'custom' ? 'primary' : 'default'"
            size="small"
            @click="providerType = 'custom'"
          >
            {{ t('models.custom') }}
          </NButton>
        </div>
      </NFormItem>

      <NFormItem v-if="providerType === 'preset'" :label="t('models.selectProvider')" required>
        <NSelect
          v-model:value="selectedPreset"
          :options="presetOptions"
          :placeholder="t('models.chooseProvider')"
          filterable
        />
        <div v-if="selectedPreset && funProviderLink" class="fun-provider-hint">
          <a :href="funProviderLink" target="_blank" rel="noopener noreferrer">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
            {{ t('models.getApiKey') }}
          </a>
        </div>
      </NFormItem>

      <NFormItem v-if="providerType === 'custom'" :label="t('models.name')">
        <NInput
          v-model:value="formData.name"
          :input-props="providerNameInputProps"
          :placeholder="t('models.autoGeneratedName')"
        />
      </NFormItem>

      <NFormItem v-if="isAlibabaCoding" :label="t('models.region')">
        <NRadioGroup v-model:value="alibabaCodingRegion">
          <NRadioButton value="intl">{{ t('models.regionIntl') }}</NRadioButton>
          <NRadioButton value="cn">{{ t('models.regionCn') }}</NRadioButton>
        </NRadioGroup>
      </NFormItem>

      <NFormItem v-if="!isCodex && !isNous" :label="t('models.baseUrl')" required>
        <NInput
          v-model:value="formData.base_url"
          :input-props="providerBaseUrlInputProps"
          :placeholder="t('models.baseUrlPlaceholder')"
          :disabled="providerType === 'preset' && !canEditPresetBaseUrl"
        />
      </NFormItem>

      <template v-if="isOpenCodeFree">
        <p>{{ t('models.opencodeFreeHint') }}</p>
        <p v-if="selectedPresetProvider?.catalog_status === 'unsupported'">{{ t('models.opencodeFreeUpgrade') }}</p>
      </template>
      <NFormItem v-if="!isCodex && !isNous && !isClaudeOAuth && !isMiniMaxOAuth && !isOpenCodeFree" :label="t('models.apiKey')" :required="!isCliproxyApi && !isXaiOAuth">
        <NInput
          v-model:value="formData.api_key"
          type="password"
          show-password-on="click"
          :input-props="providerApiKeyInputProps"
          :placeholder="t('models.apiKeyPlaceholder')"
        />
      </NFormItem>

      <NFormItem :label="t('models.defaultModel')" required>
        <div style="display: flex; gap: 8px; width: 100%">
          <NSelect
            v-model:value="formData.model"
            :options="modelOptions"
            :input-props="providerModelInputProps"
            filterable
            tag
            :placeholder="t('models.selectOrInput')"
            style="flex: 1"
          />
          <NButton
            v-if="canFetchProviderCatalog"
            :loading="fetchingModels"
            @click="fetchModels"
          >
            {{ t('common.fetch') }}
          </NButton>
        </div>
      </NFormItem>

      <NFormItem v-if="providerType === 'custom'" :label="t('models.contextLength')">
        <NInputNumber
          v-model:value="formData.context_length as number | null"
          :placeholder="t('models.contextLengthPlaceholder')"
          :min="0"
          clearable
          style="width: 100%"
        />
      </NFormItem>

      <NFormItem v-if="providerType === 'custom'" :label="t('models.apiMode')">
        <NSelect
          v-model:value="formData.api_mode"
          :options="apiModeOptions"
        />
      </NFormItem>
    </NForm>

    <template #footer>
      <div class="modal-footer">
        <NButton @click="handleClose">{{ t('common.cancel') }}</NButton>
        <NButton type="primary" :loading="loading" :disabled="isOpenCodeFree && selectedPresetProvider?.catalog_status === 'unsupported'" @click="handleSave">
          {{ t('common.add') }}
        </NButton>
      </div>
    </template>

    <CodexLoginModal
      v-if="showCodexLogin"
      @close="showCodexLogin = false"
      @success="handleCodexSuccess"
    />

    <NousLoginModal
      v-if="showNousLogin"
      @close="showNousLogin = false"
      @success="handleNousSuccess"
    />

    <CopilotLoginModal
      v-if="showCopilotLogin"
      @close="handleCopilotClose"
      @success="handleCopilotSuccess"
    />

    <XaiOAuthLoginModal
      v-if="showXaiLogin"
      @close="handleXaiClose"
      @success="handleXaiSuccess"
    />

    <AnthropicLoginModal
      v-if="showAnthropicLogin"
      @close="handleAnthropicClose"
      @success="handleAnthropicSuccess"
    />

    <MiniMaxOAuthLoginModal
      v-if="showMiniMaxLogin"
      @close="handleMiniMaxClose"
      @success="handleMiniMaxSuccess"
    />

  </NModal>
</template>

<style scoped lang="scss">
.fun-provider-hint {
  margin-top: 6px;
  font-size: 12px;

  a {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 4px 8px;
    white-space: nowrap;
    color: var(--accent-primary);
    text-decoration: none;
    opacity: 0.7;
    transition: opacity 0.2s;

    svg {
      flex-shrink: 0;
    }

    &:hover { opacity: 1; }
  }
}

.modal-footer {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}
</style>
