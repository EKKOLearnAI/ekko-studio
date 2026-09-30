<script setup lang="ts">
import PageLoading from '@/components/common/PageLoading.vue'
import PageHeader from '@/components/layout/PageHeader.vue'
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import {
  NAlert,
  NButton,
  NEmpty,
  NInput,
  NModal,
  NRadioButton,
  NRadioGroup,
  useMessage,
} from 'naive-ui'
import { useI18n } from 'vue-i18n'
import McpServerCard from '@/components/hermes/mcp/McpServerCard.vue'
import { useMcpConfigInput } from '@/composables/useMcpConfigInput'
import type { McpServerInfo } from '@/api/hermes/mcp'
import {
  createEkkoMcpServer,
  deleteEkkoMcpServer,
  fetchEkkoMcpServers,
  setEkkoMcpServerEnabled,
  testEkkoMcpServer,
  updateEkkoMcpServer,
  type EkkoMcpServerConfig,
  type EkkoMcpServerInfo,
  type EkkoMcpToolInfo,
} from '@/api/ekko/mcp'

const { t } = useI18n()
const message = useMessage()
const loading = ref(true)
const saving = ref(false)
const probingServers = ref<Set<string>>(new Set())
const error = ref('')
const searchQuery = ref('')
const servers = ref<EkkoMcpServerInfo[]>([])
const toolsByServer = ref<Record<string, EkkoMcpToolInfo[]>>({})
const testErrors = ref<Record<string, string>>({})
const showModal = ref(false)
const modalMode = ref<'add' | 'edit'>('add')
const editingName = ref('')
const probeVersions = new Map<string, number>()

const {
  inputMode,
  configText,
  configError,
  clearFormatTimer,
  handleInput,
  handleModeChange,
  parseAndValidate,
  setConfigText,
} = useMcpConfigInput({
  messages: {
    invalidJson: () => t('mcp.invalidJson'),
    invalidYaml: detail => detail ? `${t('mcp.invalidYaml')}: ${detail}` : t('mcp.invalidYaml'),
    invalidConfig: () => t('mcp.invalidConfig'),
  },
  validateServer(name, config) {
    if (!name.trim() || !config || typeof config !== 'object' || Array.isArray(config)) {
      return `${name || t('mcp.invalidConfig')}: ${t('mcp.invalidServerConfig')}`
    }
    const serverConfig = config as Record<string, unknown>
    const hasCommand = typeof serverConfig.command === 'string' && !!serverConfig.command.trim()
    const hasUrl = typeof serverConfig.url === 'string' && !!serverConfig.url.trim()
    if (!hasCommand && !hasUrl) {
      return `${name}: ${t('mcp.missingCommandOrUrl')}`
    }
    return null
  },
})

const jsonPlaceholder = '{\n  "local-tools": {\n    "command": "node",\n    "args": ["server.mjs"],\n    "enabled": true\n  }\n}'
const yamlPlaceholder = 'remote-tools:\n  type: streamable_http\n  url: https://example.com/mcp\n  enabled: true'
const placeholder = computed(() => inputMode.value === 'json' ? jsonPlaceholder : yamlPlaceholder)

const summary = computed(() => ({
  total: servers.value.length,
  enabled: servers.value.filter(server => server.config.enabled !== false).length,
  managed: servers.value.filter(server => server.managed).length,
  tools: Object.values(toolsByServer.value).reduce((total, tools) => total + tools.length, 0),
}))

const filteredServers = computed(() => {
  const query = searchQuery.value.trim().toLowerCase()
  if (!query) return servers.value
  return servers.value.filter(server => {
    const tools = toolsByServer.value[server.name] ?? []
    return server.name.toLowerCase().includes(query)
      || (server.config.command ?? '').toLowerCase().includes(query)
      || (server.config.url ?? '').toLowerCase().includes(query)
      || (server.config.type ?? 'stdio').includes(query)
      || (server.config.args ?? []).some(arg => arg.toLowerCase().includes(query))
      || tools.some(tool => tool.name.toLowerCase().includes(query))
  })
})

function toMcpServer(server: EkkoMcpServerInfo): McpServerInfo {
  const tools = toolsByServer.value[server.name] ?? []
  return {
    name: server.name,
    transport: server.config.type === 'streamable_http' || server.config.url ? 'http' : 'stdio',
    connected: server.config.enabled !== false && !testErrors.value[server.name],
    tools: tools.length,
    tools_registered: tools.length,
    tool_names: tools.map(tool => tool.name),
    tool_names_registered: tools.map(tool => tool.name),
    tool_details: tools,
    error: testErrors.value[server.name] || null,
    raw_config: server.config,
  }
}

function errorMessage(value: unknown): string {
  return value instanceof Error ? value.message : String(value)
}

function nextProbeVersion(name: string): number {
  const version = (probeVersions.get(name) ?? 0) + 1
  probeVersions.set(name, version)
  return version
}

function setServerProbing(name: string, probing: boolean) {
  const next = new Set(probingServers.value)
  if (probing) next.add(name)
  else next.delete(name)
  probingServers.value = next
}

function invalidateServerProbe(name: string) {
  nextProbeVersion(name)
  setServerProbing(name, false)
}

async function probeServer(server: EkkoMcpServerInfo, notify: boolean) {
  const version = nextProbeVersion(server.name)
  setServerProbing(server.name, true)
  const nextErrors = { ...testErrors.value }
  delete nextErrors[server.name]
  testErrors.value = nextErrors
  try {
    const tools = await testEkkoMcpServer(server.name)
    if (probeVersions.get(server.name) !== version) return
    toolsByServer.value = { ...toolsByServer.value, [server.name]: tools }
    if (notify) message.success(t('ekkoConfig.testSuccess', { count: tools.length }))
  } catch (probeError) {
    if (probeVersions.get(server.name) !== version) return
    testErrors.value = { ...testErrors.value, [server.name]: errorMessage(probeError) }
    if (notify) message.error(`${t('ekkoConfig.testFailed')}: ${errorMessage(probeError)}`)
  } finally {
    if (probeVersions.get(server.name) === version) setServerProbing(server.name, false)
  }
}

async function probeEnabledServers(candidates: EkkoMcpServerInfo[]) {
  await Promise.allSettled(
    candidates
      .filter(server => server.config.enabled !== false)
      .map(server => probeServer(server, false)),
  )
}

async function loadServers() {
  loading.value = true
  error.value = ''
  try {
    const loadedServers = await fetchEkkoMcpServers()
    servers.value = loadedServers
    const enabledNames = new Set(
      loadedServers
        .filter(server => server.config.enabled !== false)
        .map(server => server.name),
    )
    for (const name of probeVersions.keys()) {
      if (!enabledNames.has(name)) invalidateServerProbe(name)
    }
    toolsByServer.value = Object.fromEntries(
      Object.entries(toolsByServer.value).filter(([name]) => enabledNames.has(name)),
    )
    testErrors.value = Object.fromEntries(
      Object.entries(testErrors.value).filter(([name]) => enabledNames.has(name)),
    )
    void probeEnabledServers(loadedServers)
  } catch (loadError) {
    error.value = errorMessage(loadError)
  } finally {
    loading.value = false
  }
}

function openCreate() {
  modalMode.value = 'add'
  editingName.value = ''
  inputMode.value = 'json'
  configText.value = ''
  configError.value = ''
  showModal.value = true
}

function openEdit(server: EkkoMcpServerInfo) {
  modalMode.value = 'edit'
  editingName.value = server.name
  inputMode.value = 'json'
  setConfigText({ [server.name]: server.config })
  showModal.value = true
}

async function saveServer() {
  clearFormatTimer()
  const { servers: parsed, error: validationError } = parseAndValidate()
  if (validationError) {
    configError.value = validationError
    return
  }
  configError.value = ''
  const entries = Object.entries(parsed) as Array<[string, EkkoMcpServerConfig]>

  saving.value = true
  try {
    if (modalMode.value === 'edit') {
      const wrapped = entries.find(([name]) => name === editingName.value)
      const config = wrapped?.[1] ?? entries[0]?.[1]
      if (!config) throw new Error(t('mcp.invalidConfig'))
      await updateEkkoMcpServer(editingName.value, config)
    } else {
      for (const [name, config] of entries) await createEkkoMcpServer(name.trim(), config)
    }
    showModal.value = false
    await loadServers()
    message.success(t('common.saved'))
  } catch (saveError) {
    message.error(`${t('common.saveFailed')}: ${errorMessage(saveError)}`)
  } finally {
    saving.value = false
  }
}

async function toggleServer(server: EkkoMcpServerInfo, enabled: boolean) {
  try {
    await setEkkoMcpServerEnabled(server.name, enabled)
    server.config.enabled = enabled
    delete toolsByServer.value[server.name]
    delete testErrors.value[server.name]
    if (enabled) void probeServer(server, false)
    else invalidateServerProbe(server.name)
  } catch (toggleError) {
    message.error(`${t('common.saveFailed')}: ${errorMessage(toggleError)}`)
  }
}

async function toggleFromCard(server: EkkoMcpServerInfo) {
  await toggleServer(server, server.config.enabled === false)
}

async function removeServer(server: EkkoMcpServerInfo) {
  try {
    await deleteEkkoMcpServer(server.name)
    invalidateServerProbe(server.name)
    delete toolsByServer.value[server.name]
    await loadServers()
    message.success(t('ekkoConfig.deleted'))
  } catch (removeError) {
    message.error(`${t('common.deleteFailed')}: ${errorMessage(removeError)}`)
  }
}

async function testServer(server: EkkoMcpServerInfo) {
  await probeServer(server, true)
}

onMounted(() => void loadServers())
onBeforeUnmount(() => {
  for (const server of servers.value) invalidateServerProbe(server.name)
})
</script>

<template>
  <PageLoading :show="loading && servers.length === 0" class="mcp-view">
    <PageHeader>
    <header class="page-header">
      <h2 class="header-title">{{ t('ekkoConfig.mcpTitle') }}</h2>
      <div class="header-actions">
        <NButton size="small" quaternary :loading="loading" @click="loadServers">
          {{ t('ekkoConfig.refresh') }}
        </NButton>
      </div>
    </header>
    </PageHeader>

    <div class="mcp-content" :class="{ 'is-loading': loading && servers.length === 0 }">
      <div v-if="loading && servers.length === 0" class="mcp-loading-state"></div>
      <template v-else>
        <NAlert v-if="error" type="error" class="mcp-notice">{{ error }}</NAlert>

        <div class="summary-grid">
          <div class="summary-card">
            <span class="summary-label">{{ t('mcp.total') }}</span>
            <strong>{{ summary.total }}</strong>
          </div>
          <div class="summary-card success">
            <span class="summary-label">{{ t('ekkoConfig.enabledServers') }}</span>
            <strong>{{ summary.enabled }}</strong>
          </div>
          <div class="summary-card warning">
            <span class="summary-label">{{ t('ekkoConfig.managed') }}</span>
            <strong>{{ summary.managed }}</strong>
          </div>
          <div class="summary-card info">
            <span class="summary-label">{{ t('mcp.tool') }}</span>
            <strong>{{ summary.tools }}</strong>
          </div>
        </div>

        <div class="toolbar-row">
          <NInput
            v-model:value="searchQuery"
            :placeholder="t('mcp.searchPlaceholder')"
            clearable
            size="small"
            class="search-input"
          />
          <div class="btn-group">
            <NButton type="primary" size="small" @click="openCreate">{{ t('ekkoConfig.addServer') }}</NButton>
          </div>
        </div>

        <div v-if="filteredServers.length" class="servers-grid">
          <McpServerCard
            v-for="server in filteredServers"
            :key="server.name"
            :server="toMcpServer(server)"
            :tools-by-server="toolsByServer"
            :show-manage-tools="false"
            :show-reload="false"
            :context-label="server.managed ? t('ekkoConfig.managed') : t('ekkoConfig.custom')"
            :testing="probingServers.has(server.name)"
            @edit="openEdit(server)"
            @test="testServer(server)"
            @remove="removeServer(server)"
            @toggle-enabled="toggleFromCard(server)"
          />
        </div>
        <NEmpty v-else :description="t('ekkoConfig.noServers')" />
      </template>
    </div>

    <NModal
      v-model:show="showModal"
      :title="modalMode === 'add' ? t('ekkoConfig.addServer') : t('ekkoConfig.editServer')"
      preset="card"
      :style="{ width: 'min(520px, calc(100vw - 32px))' }"
    >
      <div class="mode-switch-row">
        <NRadioGroup v-model:value="inputMode" size="small" @update:value="handleModeChange">
          <NRadioButton value="json">JSON</NRadioButton>
          <NRadioButton value="yaml">YAML</NRadioButton>
        </NRadioGroup>
      </div>
      <NInput
        v-model:value="configText"
        type="textarea"
        :rows="16"
        class="config-textarea"
        :placeholder="placeholder"
        :status="configError ? 'error' : undefined"
        spellcheck="false"
        @input="handleInput"
      />
      <div v-if="configError" class="config-error">{{ configError }}</div>
      <div class="config-hint">{{ t('ekkoConfig.serverConfigHint') }}</div>
      <div class="modal-actions">
        <NButton @click="showModal = false">{{ t('common.cancel') }}</NButton>
        <NButton type="primary" :loading="saving" :disabled="!configText.trim()" @click="saveServer">
          {{ modalMode === 'add' ? t('mcp.add') : t('common.save') }}
        </NButton>
      </div>
    </NModal>
  </PageLoading>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;
@use '@/styles/mcp-manager' as mcp-manager;

@include mcp-manager.layout;

.config-hint { margin-top: 6px; }
.config-hint { color: $text-muted; font-size: 12px; }
</style>
