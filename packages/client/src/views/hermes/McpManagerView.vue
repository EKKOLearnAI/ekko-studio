<script setup lang="ts">
import PageLoading from '@/components/common/PageLoading.vue'
import PageHeader from '@/components/layout/PageHeader.vue'
import { computed, onUnmounted, ref } from 'vue'
import {
  NAlert, NButton, NEmpty, NInput, NModal,
  NRadioGroup, NRadioButton, useMessage,
  NCheckbox, NScrollbar,
} from 'naive-ui'
import { useI18n } from 'vue-i18n'
import McpServerCard from '@/components/hermes/mcp/McpServerCard.vue'
import { useMcpConfigInput } from '@/composables/useMcpConfigInput'
import {
  fetchMcpServers, fetchMcpTools, mcpServerAdd, mcpServerRemove,
  mcpServerUpdate, mcpServerTest, mcpReload,
  type McpServerInfo, type McpServerConfig,
} from '@/api/hermes/mcp'

const { t } = useI18n()
const message = useMessage()

const servers = ref<McpServerInfo[]>([])
const loading = ref(true)
const error = ref('')
const searchQuery = ref('')

const showModal = ref(false)
const modalMode = ref<'add' | 'edit'>('add')
const editingName = ref('')
const saving = ref(false)

const {
  inputMode,
  configText: jsonText,
  configError: jsonError,
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
    if (!config || typeof config !== 'object' || Array.isArray(config)) {
      return `${name}: ${t('mcp.invalidServerConfig')}`
    }
    const serverConfig = config as Record<string, unknown>
    if (!serverConfig.command && !serverConfig.url) {
      return `${name}: ${t('mcp.missingCommandOrUrl')}`
    }
    return null
  },
})

// Tools visibility modal
const showToolsModal = ref(false)
const toolsModalServer = ref<McpServerInfo | null>(null)
const toolsMode = ref<'all' | 'include' | 'exclude'>('all')
const selectedTools = ref<string[]>([])
const allTools = ref<string[]>([])
const fetchingTools = ref(false)

const jsonPlaceholder = '{\n  "my-server": {\n    "command": "npx",\n    "args": ["-y", "@modelcontextprotocol/server-filesystem", "/path"]\n  }\n}'
const yamlPlaceholder = 'my-server:\n  command: npx\n  args:\n    - "-y"\n    - "@modelcontextprotocol/server-filesystem"\n    - "/path"'

const placeholder = computed(() => inputMode.value === 'json' ? jsonPlaceholder : yamlPlaceholder)

let _pendingReload: ReturnType<typeof setTimeout> | null = null
let _autoRetryCount = 0
const MAX_AUTO_RETRIES = 5
const BASE_RETRY_DELAY = 2000 // 2s base

function scheduleReload(delay = 3000) {
  if (_pendingReload) clearTimeout(_pendingReload)
  _pendingReload = setTimeout(() => { _pendingReload = null; loadServers() }, delay)
}

onUnmounted(() => {
  if (_pendingReload) { clearTimeout(_pendingReload); _pendingReload = null }
})

const toolsByServer = ref<Record<string, {name: string, description: string}[]>>({})

const summary = computed(() => {
  let connected = 0, totalTools = 0
  for (const s of servers.value) {
    if (s.connected) connected++
    totalTools += s.tools_registered
  }
  return { total: servers.value.length, connected, disconnected: servers.value.length - connected, totalTools }
})

const filteredServers = computed(() => {
  const query = searchQuery.value.trim().toLowerCase()
  if (!query) return servers.value
  return servers.value.filter(s =>
    s.name.toLowerCase().includes(query) ||
    s.transport.includes(query) ||
    s.tool_names.some(n => n.toLowerCase().includes(query))
  )
})

async function loadServers() {
  loading.value = true
  error.value = ''
  try {
    const data = await fetchMcpServers()
    servers.value = data.servers ?? []
    // Populate toolsByServer from embedded tool_details, including empty filtered results.
    const nextToolsByServer: Record<string, {name: string, description: string}[]> = {}
    for (const s of servers.value) {
      nextToolsByServer[s.name] = (s.tool_details || []).map(t => ({
        name: t.name,
        description: t.description || '',
      }))
    }
    toolsByServer.value = nextToolsByServer
    // Auto-retry with exponential backoff if enabled servers are still disconnected
    const hasPending = servers.value.some(s => s.raw_config.enabled !== false && !s.connected)
    if (hasPending && _autoRetryCount < MAX_AUTO_RETRIES) {
      const delay = BASE_RETRY_DELAY * Math.pow(2, _autoRetryCount) // 2s, 4s, 8s, 16s, 32s
      _autoRetryCount++
      scheduleReload(delay)
    } else {
      _autoRetryCount = 0
    }
  } catch (err: any) {
    error.value = err?.message || t('mcp.loadFailed')
  } finally {
    loading.value = false
  }
}

async function handleReload(server?: string) {
  try {
    const res = await mcpReload(server)
    if (res.ok) {
      if (server) {
        const { [server]: _, ...rest } = toolsByServer.value
        toolsByServer.value = rest
      } else {
        toolsByServer.value = {}
      }
      message.success(server ? t('mcp.reloaded', { server }) : t('mcp.reloadedAll'))
      scheduleReload()
    } else {
      message.error(res.error || t('mcp.reloadFailed'))
    }
  } catch (err: any) {
    message.error(err.message || t('mcp.reloadFailed'))
  }
}

function openAddModal() {
  modalMode.value = 'add'
  editingName.value = ''
  jsonText.value = ''
  jsonError.value = ''
  inputMode.value = 'json'
  showModal.value = true
}

function openEditModal(server: McpServerInfo) {
  modalMode.value = 'edit'
  editingName.value = server.name
  const serverConfig = { [server.name]: server.raw_config }
  setConfigText(serverConfig)
  showModal.value = true
}

async function saveServer() {
  clearFormatTimer()
  const { servers: parsed, error: validationErr } = parseAndValidate(jsonText.value)
  if (validationErr) {
    jsonError.value = validationErr
    return
  }
  jsonError.value = ''
  saving.value = true
  try {
    if (modalMode.value === 'add') {
      // Expect: { "server-name": { "command": "...", ... } }
      const entries = Object.entries(parsed)
      if (entries.length === 0) {
        jsonError.value = t('mcp.invalidConfig')
        saving.value = false
        return
      }
      let added = 0
      for (const [name, config] of entries) {
        if (typeof config !== 'object' || config === null) continue
        const res = await mcpServerAdd(name, config as McpServerConfig)
        if (res.ok) added++
        else message.error(`${name}: ${res.error || t('mcp.addFailed')}`)
      }
      if (added > 0) {
        showModal.value = false
        message.success(t('mcp.serverAdded', { name: `${added} server(s)` }))
        // Immediately show server from config (disconnected)
        await loadServers()
        // Delayed refresh to show updated connection status after discovery
        scheduleReload()
      }
    } else {
      const name = editingName.value
      // For edit, config can be flat or wrapped: { "name": { ... } }
      const config = (parsed[name] && typeof parsed[name] === 'object')
        ? parsed[name] as Record<string, unknown>
        : parsed
      const res = await mcpServerUpdate(name, config)
      if (res.ok) {
        showModal.value = false
        message.success(t('mcp.serverUpdated', { name: editingName.value }))
        // Immediately show updated config
        await loadServers()
        // Delayed refresh to show reconnection status
        scheduleReload()
      } else {
        message.error(res.error || t('mcp.updateFailed'))
      }
    }
  } catch (err: any) {
    message.error(err.message || t('mcp.saveFailed'))
  } finally {
    saving.value = false
  }
}

async function handleRemove(server: McpServerInfo) {
  try {
    const res = await mcpServerRemove(server.name)
    if (res.ok) {
      message.success(t('mcp.serverRemoved', { name: server.name }))
      const { [server.name]: _, ...rest } = toolsByServer.value
      toolsByServer.value = rest
      await loadServers()
    } else {
      message.error(res.error || t('mcp.removeFailed'))
    }
  } catch (err: any) {
    message.error(err.message || t('mcp.removeFailed'))
  }
}

async function handleToggleEnabled(server: McpServerInfo) {
  const newValue = !server.raw_config.enabled
  try {
    const config = { ...server.raw_config, enabled: newValue }
    const res = await mcpServerUpdate(server.name, config)
    if (res.ok) {
      message.success(t(newValue ? 'mcp.enabled' : 'mcp.disabled', { name: server.name }))
      const { [server.name]: _, ...rest } = toolsByServer.value
      toolsByServer.value = rest
      await mcpReload(server.name)
      scheduleReload()
    } else {
      message.error(res.error || t('mcp.updateFailed'))
    }
  } catch (err: any) {
    message.error(err.message || t('mcp.updateFailed'))
  }
}

async function handleTest(server: McpServerInfo) {
  try {
    const res = await mcpServerTest(server.name)
    if (res.ok && res.tools) {
      message.success(t('mcp.testOk', { count: res.tools.length }), { duration: 3000 })
    } else {
      message.warning(res.error || t('mcp.testEmpty'))
    }
  } catch (err: any) {
    message.error(err.message || t('mcp.testFailed'))
  }
}


void loadServers()

function openToolsModal(server: McpServerInfo) {
  toolsModalServer.value = server
  // Load mode from config
  const tools = server.raw_config.tools
  if (!tools || (!tools.include && !tools.exclude)) {
    toolsMode.value = 'all'
    selectedTools.value = [...server.tool_names]
  } else if (tools.include) {
    toolsMode.value = 'include'
    selectedTools.value = [...tools.include]
  } else {
    toolsMode.value = 'exclude'
    selectedTools.value = [...(tools.exclude || [])]
  }
  allTools.value = [...server.tool_names]
  showToolsModal.value = true
}

async function fetchToolsList() {
  if (!toolsModalServer.value) return
  fetchingTools.value = true
  try {
    const res = await fetchMcpTools(toolsModalServer.value.name, true)
    if (res.ok && res.results?.length) {
      const serverResult = res.results.find((r: { server: string }) => r.server === toolsModalServer.value!.name)
      if (serverResult?.tools) {
        allTools.value = serverResult.tools.map((t: { name: string }) => t.name)
        // Reset selection to current mode
        if (toolsMode.value === 'all') {
          selectedTools.value = [...allTools.value]
        }
      }
    }
  } catch (err: any) {
    message.error(err.message || t('mcp.fetchToolsFailed'))
  } finally {
    fetchingTools.value = false
  }
}

function handleToolsModeChange(mode: 'all' | 'include' | 'exclude') {
  toolsMode.value = mode
  if (mode === 'all') {
    selectedTools.value = [...allTools.value]
  } else {
    // Load from config for include/exclude mode
    const server = toolsModalServer.value
    if (server) {
      const tools = server.raw_config.tools
      if (mode === 'include' && tools?.include) {
        selectedTools.value = [...tools.include]
      } else if (mode === 'exclude' && tools?.exclude) {
        selectedTools.value = [...tools.exclude]
      } else {
        selectedTools.value = []
      }
    }
  }
}

function handleToolCheck(tool: string, checked: boolean) {
  if (checked) {
    if (!selectedTools.value.includes(tool)) {
      selectedTools.value.push(tool)
    }
  } else {
    selectedTools.value = selectedTools.value.filter(t => t !== tool)
  }
}

function selectAllTools() {
  selectedTools.value = [...allTools.value]
}

function clearSelectedTools() {
  selectedTools.value = []
}

async function saveToolsVisibility() {
  const server = toolsModalServer.value
  if (!server) return

  const config = { ...server.raw_config }

  if (toolsMode.value === 'all') {
    delete config.tools
  } else if (toolsMode.value === 'include') {
    config.tools = { include: [...selectedTools.value] }
  } else {
    config.tools = { exclude: [...selectedTools.value] }
  }

  try {
    const res = await mcpServerUpdate(server.name, config)
    if (res.ok) {
      message.success(t('mcp.toolsVisibilitySaved'))
      showToolsModal.value = false
      await loadServers()
      scheduleReload()
    } else {
      message.error(res.error || t('mcp.updateFailed'))
    }
  } catch (err: any) {
    message.error(err.message || t('mcp.updateFailed'))
  }
}
</script>

<template>
  <PageLoading :show="loading && servers.length === 0" class="mcp-view">
    <PageHeader>
    <header class="page-header">
      <h2 class="header-title">{{ t('mcp.title') }}</h2>
      <div class="header-actions">
        <NButton size="small" quaternary :loading="loading" @click="_autoRetryCount = 0; loadServers()">
          {{ t('mcp.refresh') }}
        </NButton>
      </div>
    </header>
    </PageHeader>

    <div class="mcp-content" :class="{ 'is-loading': loading && servers.length === 0 }">
      <div v-if="loading && servers.length === 0" class="mcp-loading-state">

      </div>
      <template v-else>
        <NAlert v-if="error" type="error" class="mcp-notice">
          {{ error }}
        </NAlert>

        <div class="summary-grid">
          <div class="summary-card">
            <span class="summary-label">{{ t('mcp.total') }}</span>
            <strong>{{ summary.total }}</strong>
          </div>
          <div class="summary-card success">
            <span class="summary-label">{{ t('mcp.connected') }}</span>
            <strong>{{ summary.connected }}</strong>
          </div>
          <div class="summary-card warning">
            <span class="summary-label">{{ t('mcp.disconnected') }}</span>
            <strong>{{ summary.disconnected }}</strong>
          </div>
          <div class="summary-card info">
            <span class="summary-label">{{ t('mcp.tool') }}</span>
            <strong>{{ summary.totalTools }}</strong>
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
            <NButton size="small" type="primary" @click="handleReload()">
              {{ t('mcp.reloadAll') }}
            </NButton>
            <NButton type="primary" size="small" @click="openAddModal">
              {{ t('mcp.addServer') }}
            </NButton>
          </div>
        </div>

        <div v-if="filteredServers.length" class="servers-grid">
          <McpServerCard
            v-for="server in filteredServers"
            :key="server.name"
            :server="server"
            :tools-by-server="toolsByServer"
            @edit="openEditModal"
            @test="handleTest"
            @reload="handleReload"
            @remove="handleRemove"
            @toggle-enabled="handleToggleEnabled"
            @manage-tools="openToolsModal"
          />
        </div>
        <NEmpty v-else :description="t('mcp.empty')" />
      </template>
    </div>

    <NModal v-model:show="showModal" :title="modalMode === 'add' ? t('mcp.addTitle') : t('mcp.editTitle')" preset="card" :style="{ width: 'min(520px, calc(100vw - 32px))' }">
      <div class="mode-switch-row">
        <NRadioGroup v-model:value="inputMode" size="small" @update:value="handleModeChange">
          <NRadioButton value="json">JSON</NRadioButton>
          <NRadioButton value="yaml">YAML</NRadioButton>
        </NRadioGroup>
      </div>
      <NInput
        v-model:value="jsonText"
        type="textarea"
        :rows="16"
        class="config-textarea"
        :placeholder="placeholder"
        :status="jsonError ? 'error' : undefined"
        @input="handleInput"
      />
      <div v-if="jsonError" class="config-error">{{ jsonError }}</div>
      <div class="modal-actions">
        <NButton @click="showModal = false">{{ t('mcp.cancel') }}</NButton>
        <NButton type="primary" :loading="saving" @click="saveServer">
          {{ modalMode === 'add' ? t('mcp.add') : t('mcp.save') }}
        </NButton>
      </div>
    </NModal>

    <!-- Tools Visibility Modal -->
    <NModal v-model:show="showToolsModal" :title="t('mcp.toolsVisibilityTitle')" preset="card" :style="{ width: 'min(480px, calc(100vw - 32px))' }">
      <div v-if="toolsModalServer" class="tools-modal-content">
        <div class="tools-modal-header">
          <span class="server-name-label">{{ toolsModalServer.name }}</span>
          <NButton size="small" :loading="fetchingTools" @click="fetchToolsList">
            {{ t('mcp.fetchTools') }}
          </NButton>
        </div>

        <div class="tools-mode-selector">
          <span class="mode-label">{{ t('mcp.toolsMode') }}</span>
          <NRadioGroup v-model:value="toolsMode" size="small" @update:value="handleToolsModeChange">
            <NRadioButton value="all">{{ t('mcp.toolsModeAll') }}</NRadioButton>
            <NRadioButton value="include">{{ t('mcp.toolsModeInclude') }}</NRadioButton>
            <NRadioButton value="exclude">{{ t('mcp.toolsModeExclude') }}</NRadioButton>
          </NRadioGroup>
        </div>

        <div class="tools-list-container">
          <div class="tools-list-header">
            <span>{{ t('mcp.toolsListHeader') }}</span>
            <div v-if="toolsMode !== 'all'" class="tools-list-actions">
              <NButton size="tiny" quaternary @click="selectAllTools">
                {{ toolsMode === 'exclude' ? t('mcp.toolsExcludeAll') : t('mcp.toolsSelectAll') }}
              </NButton>
              <NButton size="tiny" quaternary @click="clearSelectedTools">
                {{ toolsMode === 'exclude' ? t('mcp.toolsClearExcluded') : t('mcp.toolsClearSelection') }}
              </NButton>
            </div>
          </div>
          <NScrollbar style="max-height: 300px;">
            <div v-if="allTools.length" class="tools-checkbox-list">
              <div v-for="tool in allTools" :key="tool" class="tool-checkbox-item" :class="{ disabled: toolsMode === 'all' }">
                <NCheckbox
                  :checked="selectedTools.includes(tool)"
                  :disabled="toolsMode === 'all'"
                  @update:checked="(val: boolean) => handleToolCheck(tool, val)"
                />
                <span class="tool-name" :title="tool">{{ tool }}</span>
              </div>
            </div>
            <div v-else class="tools-empty">
              <span class="muted">{{ t('mcp.toolsEmpty') }}</span>
            </div>
          </NScrollbar>
        </div>

        <div class="tools-summary">
          <span v-if="toolsMode === 'all'">{{ t('mcp.toolsSummaryAll', { count: allTools.length }) }}</span>
          <span v-else-if="toolsMode === 'include'">{{ t('mcp.toolsSummaryInclude', { count: selectedTools.length, total: allTools.length }) }}</span>
          <span v-else>{{ t('mcp.toolsSummaryExclude', { count: selectedTools.length, total: allTools.length }) }}</span>
        </div>

        <div class="modal-actions">
          <NButton @click="showToolsModal = false">{{ t('mcp.cancel') }}</NButton>
          <NButton type="primary" @click="saveToolsVisibility">{{ t('mcp.save') }}</NButton>
        </div>
      </div>
    </NModal>
  </PageLoading>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;
@use '@/styles/mcp-manager' as mcp-manager;

@include mcp-manager.layout;

.tools-modal-content {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.tools-modal-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.server-name-label {
  font-weight: 600;
  font-size: 14px;
}

.tools-mode-selector {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
}

.mode-label {
  font-size: 13px;
  color: $text-muted;
  white-space: nowrap;
}

.tools-list-container {
  border: 1px solid $border-color;
  border-radius: 8px;
  overflow: hidden;
}

.tools-list-header {
  padding: 10px 12px;
  background: $bg-secondary;
  font-size: 12px;
  font-weight: 600;
  color: $text-muted;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.tools-list-actions {
  display: flex;
  align-items: center;
  gap: 4px;
  text-transform: none;
  letter-spacing: 0;
  font-weight: 400;
}

.tools-checkbox-list {
  padding: 8px 0;
}

.tool-checkbox-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 6px 12px;
  transition: background 0.15s;

  &:hover {
    background: $bg-secondary;
  }

  &.disabled {
    opacity: 0.6;
    cursor: not-allowed;
  }
}

.tool-name {
  font-size: 13px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.tools-empty {
  padding: 24px 12px;
  text-align: center;
}

.tools-summary {
  font-size: 12px;
  color: $text-muted;
  text-align: center;
}

@media (max-width: $breakpoint-mobile) {
  .tools-mode-selector {
    flex-direction: column;
    align-items: flex-start;
  }
}
</style>
