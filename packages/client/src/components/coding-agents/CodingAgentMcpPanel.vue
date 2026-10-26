<script setup lang="ts">
import { usePageLoadingTask } from '@/composables/usePageLoading'
import { NSpin, NAlert, NButton, NEmpty, NInput, NModal, NRadioButton, NRadioGroup, useMessage } from 'naive-ui'
import PageHeader from '@/components/layout/PageHeader.vue'
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'

import { useI18n } from 'vue-i18n'
import McpServerCard from '@/components/hermes/mcp/McpServerCard.vue'
import { useMcpConfigInput } from '@/composables/useMcpConfigInput'
import type { CodingAgentId } from '@/api/coding-agents'
import type { McpServerConfig } from '@/api/hermes/mcp'
import {
  addCodingAgentMcpServer,
  fetchCodingAgentMcpServers,
  removeCodingAgentMcpServer,
  testCodingAgentMcpServer,
  updateCodingAgentMcpServer,
  type CodingAgentMcpServerInfo,
} from '@/api/coding-agent-mcp'

const props = defineProps<{
  agentId: CodingAgentId
}>()

const { t } = useI18n()
const message = useMessage()
const loading = ref(true)
const reloadingAll = ref(false)
const saving = ref(false)
const error = ref('')
const searchQuery = ref('')
const servers = ref<CodingAgentMcpServerInfo[]>([])
const testedTools = ref<Record<string, Array<{ name: string; description?: string }>>>({})
const testErrors = ref<Record<string, string>>({})
const testingServers = ref<Set<string>>(new Set())
const showModal = ref(false)
const modalMode = ref<'add' | 'edit'>('add')
const editingName = ref('')
const probeVersions = new Map<string, number>()
let agentGeneration = 0
let loadVersion = 0

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
    const server = config as Record<string, unknown>
    if (!String(server.command || '').trim() && !String(server.url || '').trim()) {
      return `${name}: ${t('mcp.missingCommandOrUrl')}`
    }
    return null
  },
})

const placeholder = computed(() => inputMode.value === 'json'
  ? '{\n  "my-server": {\n    "command": "npx",\n    "args": ["-y", "@modelcontextprotocol/server-filesystem", "/path"],\n    "enabled": true\n  }\n}'
  : 'my-server:\n  command: npx\n  args:\n    - -y\n    - @modelcontextprotocol/server-filesystem\n    - /path\n  enabled: true')

const toolsByServer = computed<Record<string, Array<{ name: string; description?: string }>>>(() =>
  Object.fromEntries(servers.value.map(server => [
    server.name,
    testedTools.value[server.name] || server.tool_details || [],
  ])),
)

const displayedServers = computed<CodingAgentMcpServerInfo[]>(() =>
  servers.value.map((server) => {
    const tools = toolsByServer.value[server.name] || []
    const tested = Object.prototype.hasOwnProperty.call(testedTools.value, server.name)
    const testError = testErrors.value[server.name]
    return {
      ...server,
      connected: server.raw_config.enabled !== false && tested && !testError,
      tools: tools.length,
      tools_registered: tools.length,
      tool_names: tools.map(tool => tool.name),
      tool_names_registered: tools.map(tool => tool.name),
      tool_details: tools,
      error: testError || null,
    }
  }),
)

const summary = computed(() => ({
  total: displayedServers.value.length,
  enabled: displayedServers.value.filter(server => server.raw_config.enabled !== false).length,
  managed: displayedServers.value.filter(server => server.managed).length,
  tools: displayedServers.value.reduce((total, server) => total + server.tools_registered, 0),
}))

const filteredServers = computed(() => {
  const query = searchQuery.value.trim().toLowerCase()
  if (!query) return displayedServers.value
  return displayedServers.value.filter(server =>
    server.name.toLowerCase().includes(query)
    || server.transport.includes(query)
    || String(server.raw_config.command || '').toLowerCase().includes(query)
    || String(server.raw_config.url || '').toLowerCase().includes(query)
    || server.tool_names.some(tool => tool.toLowerCase().includes(query)),
  )
})

function errorMessage(value: unknown): string {
  return value instanceof Error ? value.message : String(value)
}

function nextProbeVersion(name: string): number {
  const version = (probeVersions.get(name) || 0) + 1
  probeVersions.set(name, version)
  return version
}

function setServerTesting(name: string, testing: boolean) {
  const next = new Set(testingServers.value)
  if (testing) next.add(name)
  else next.delete(name)
  testingServers.value = next
}

function invalidateServerProbe(name: string) {
  nextProbeVersion(name)
  setServerTesting(name, false)
  const nextTools = { ...testedTools.value }
  const nextErrors = { ...testErrors.value }
  delete nextTools[name]
  delete nextErrors[name]
  testedTools.value = nextTools
  testErrors.value = nextErrors
}

function isCurrentAgent(agentId: CodingAgentId, generation: number): boolean {
  return props.agentId === agentId && agentGeneration === generation
}

async function probeServer(
  server: CodingAgentMcpServerInfo,
  notify: boolean,
  requestedAgentId = props.agentId,
  generation = agentGeneration,
) {
  if (!isCurrentAgent(requestedAgentId, generation)) return
  const version = nextProbeVersion(server.name)
  setServerTesting(server.name, true)
  const nextErrors = { ...testErrors.value }
  delete nextErrors[server.name]
  testErrors.value = nextErrors
  try {
    const response = await testCodingAgentMcpServer(requestedAgentId, server.name)
    if (!isCurrentAgent(requestedAgentId, generation) || probeVersions.get(server.name) !== version) return
    if (!response.ok) throw new Error(response.error || t('mcp.testEmpty'))
    const tools = response.tool_details?.length
      ? response.tool_details
      : (response.tools || []).map(name => ({ name }))
    testedTools.value = { ...testedTools.value, [server.name]: tools }
    if (notify) message.success(t('mcp.testOk', { count: tools.length }))
  } catch (probeError) {
    if (!isCurrentAgent(requestedAgentId, generation) || probeVersions.get(server.name) !== version) return
    testErrors.value = { ...testErrors.value, [server.name]: errorMessage(probeError) }
    if (notify) message.error(`${t('mcp.testFailed')}: ${errorMessage(probeError)}`)
  } finally {
    if (isCurrentAgent(requestedAgentId, generation) && probeVersions.get(server.name) === version) {
      setServerTesting(server.name, false)
    }
  }
}

async function probeEnabledServers(
  candidates: CodingAgentMcpServerInfo[],
  requestedAgentId = props.agentId,
  generation = agentGeneration,
) {
  await Promise.allSettled(
    candidates
      .filter(server => server.raw_config.enabled !== false)
      .map(server => probeServer(server, false, requestedAgentId, generation)),
  )
}

async function refreshServers(probe: boolean): Promise<boolean> {
  const requestedAgentId = props.agentId
  const generation = agentGeneration
  const version = ++loadVersion
  loading.value = true
  error.value = ''
  try {
    const response = await fetchCodingAgentMcpServers(requestedAgentId)
    if (!isCurrentAgent(requestedAgentId, generation) || version !== loadVersion) return false
    servers.value = response.servers || []
    const loadedNames = new Set(servers.value.map(server => server.name))
    for (const name of probeVersions.keys()) {
      if (!loadedNames.has(name)) invalidateServerProbe(name)
    }
    if (probe) void probeEnabledServers(servers.value, requestedAgentId, generation)
    return true
  } catch (loadError) {
    if (!isCurrentAgent(requestedAgentId, generation) || version !== loadVersion) return false
    error.value = errorMessage(loadError)
    return false
  } finally {
    if (isCurrentAgent(requestedAgentId, generation) && version === loadVersion) {
      loading.value = false
    }
  }
}

async function loadServers() {
  await refreshServers(true)
}

async function reloadAllServers() {
  const requestedAgentId = props.agentId
  const generation = agentGeneration
  reloadingAll.value = true
  try {
    const loaded = await refreshServers(false)
    if (!loaded || error.value || !isCurrentAgent(requestedAgentId, generation)) return
    await probeEnabledServers(servers.value, requestedAgentId, generation)
    if (!isCurrentAgent(requestedAgentId, generation)) return
    message.success(t('mcp.reloadedAll'))
  } finally {
    if (isCurrentAgent(requestedAgentId, generation)) reloadingAll.value = false
  }
}

function openAdd() {
  modalMode.value = 'add'
  editingName.value = ''
  inputMode.value = 'json'
  configText.value = ''
  configError.value = ''
  showModal.value = true
}

function openEdit(server: CodingAgentMcpServerInfo) {
  modalMode.value = 'edit'
  editingName.value = server.name
  inputMode.value = 'json'
  setConfigText({ [server.name]: server.raw_config })
  showModal.value = true
}

async function saveServer() {
  const requestedAgentId = props.agentId
  const generation = agentGeneration
  clearFormatTimer()
  const { servers: parsed, error: validationError } = parseAndValidate()
  if (validationError) {
    configError.value = validationError
    return
  }
  const entries = Object.entries(parsed) as Array<[string, McpServerConfig]>
  if (!entries.length) {
    configError.value = t('mcp.invalidConfig')
    return
  }
  saving.value = true
  try {
    if (modalMode.value === 'edit') {
      const config = entries.find(([name]) => name === editingName.value)?.[1] || entries[0][1]
      await updateCodingAgentMcpServer(requestedAgentId, editingName.value, config)
    } else {
      for (const [name, config] of entries) {
        await addCodingAgentMcpServer(requestedAgentId, name, config)
      }
    }
    if (!isCurrentAgent(requestedAgentId, generation)) return
    showModal.value = false
    await loadServers()
    if (!isCurrentAgent(requestedAgentId, generation)) return
    message.success(t('common.saved'))
  } catch (saveError) {
    if (isCurrentAgent(requestedAgentId, generation)) {
      message.error(`${t('common.saveFailed')}: ${errorMessage(saveError)}`)
    }
  } finally {
    if (isCurrentAgent(requestedAgentId, generation)) saving.value = false
  }
}

async function removeServer(server: CodingAgentMcpServerInfo) {
  const requestedAgentId = props.agentId
  const generation = agentGeneration
  try {
    await removeCodingAgentMcpServer(requestedAgentId, server.name)
    if (!isCurrentAgent(requestedAgentId, generation)) return
    invalidateServerProbe(server.name)
    await loadServers()
    if (!isCurrentAgent(requestedAgentId, generation)) return
    message.success(t('mcp.serverRemoved', { name: server.name }))
  } catch (removeError) {
    if (isCurrentAgent(requestedAgentId, generation)) {
      message.error(`${t('common.deleteFailed')}: ${errorMessage(removeError)}`)
    }
  }
}

async function toggleServer(server: CodingAgentMcpServerInfo) {
  const requestedAgentId = props.agentId
  const generation = agentGeneration
  try {
    const enabled = server.raw_config.enabled === false
    await updateCodingAgentMcpServer(
      requestedAgentId,
      server.name,
      server.managed ? { enabled } : { ...server.raw_config, enabled },
    )
    if (!isCurrentAgent(requestedAgentId, generation)) return
    invalidateServerProbe(server.name)
    await loadServers()
  } catch (toggleError) {
    if (isCurrentAgent(requestedAgentId, generation)) {
      message.error(`${t('common.saveFailed')}: ${errorMessage(toggleError)}`)
    }
  }
}

async function testServer(server: CodingAgentMcpServerInfo) {
  await probeServer(server, true)
}

async function changeAgent() {
  agentGeneration += 1
  loadVersion += 1
  for (const name of probeVersions.keys()) invalidateServerProbe(name)
  probeVersions.clear()
  servers.value = []
  loading.value = false
  reloadingAll.value = false
  saving.value = false
  showModal.value = false
  editingName.value = ''
  await loadServers()
}

onMounted(changeAgent)
onBeforeUnmount(() => {
  agentGeneration += 1
  loadVersion += 1
  for (const name of probeVersions.keys()) invalidateServerProbe(name)
})
watch(() => props.agentId, changeAgent)

usePageLoadingTask(() => loading.value && servers.value.length === 0)
</script>

<template>
  <div class="mcp-view embedded">
    <PageHeader>
    <header class="page-header">
      <h2 class="header-title">{{ t('mcp.title') }}</h2>
      <div class="header-actions">
        <NButton size="small" quaternary :loading="loading" @click="loadServers">
          {{ t('mcp.refresh') }}
        </NButton>
      </div>
    </header>
    </PageHeader>

    <div class="mcp-content" :class="{ 'is-loading': loading && servers.length === 0 }">
      <div v-if="loading && servers.length === 0" class="mcp-loading-state">
        <NSpin />
      </div>
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
            <NButton size="small" type="primary" :loading="reloadingAll" @click="reloadAllServers">
              {{ t('mcp.reloadAll') }}
            </NButton>
            <NButton type="primary" size="small" @click="openAdd">{{ t('mcp.addServer') }}</NButton>
          </div>
        </div>

        <div v-if="filteredServers.length" class="servers-grid">
          <McpServerCard
            v-for="server in filteredServers"
            :key="server.name"
            :server="server"
            :tools-by-server="toolsByServer"
            :show-manage-tools="false"
            :show-reload="false"
            :readonly="server.managed"
            :allow-readonly-edit="true"
            :allow-readonly-toggle="true"
            :allow-readonly-remove="true"
            :context-label="server.managed ? t('ekkoConfig.managed') : t('ekkoConfig.custom')"
            :testing="testingServers.has(server.name)"
            @edit="openEdit(server)"
            @test="testServer(server)"
            @remove="removeServer(server)"
            @toggle-enabled="toggleServer(server)"
          />
        </div>
        <NEmpty v-else :description="t('mcp.empty')" />
      </template>
    </div>

    <NModal
      v-model:show="showModal"
      :title="modalMode === 'add' ? t('mcp.addTitle') : t('mcp.editTitle')"
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
        @input="handleInput"
      />
      <div v-if="configError" class="config-error">{{ configError }}</div>
      <div class="modal-actions">
        <NButton @click="showModal = false">{{ t('mcp.cancel') }}</NButton>
        <NButton type="primary" :loading="saving" @click="saveServer">{{ t('mcp.save') }}</NButton>
      </div>
    </NModal>

  </div>
</template>

<style scoped lang="scss">
@use '@/styles/mcp-manager' as mcp-manager;

@include mcp-manager.layout;

.mcp-view.embedded {
  height: 100%;
  min-height: 0;
}
</style>
