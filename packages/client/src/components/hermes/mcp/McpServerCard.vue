<script setup lang="ts">
import { computed } from 'vue'
import { NButton, NSwitch, NPopconfirm } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import type { McpServerInfo } from '@/api/hermes/mcp'

const props = defineProps<{
  server: McpServerInfo
  toolsByServer: Record<string, Array<{ name: string; description?: string }>>
  readonly?: boolean
  showManageTools?: boolean
  showReload?: boolean
  contextLabel?: string
  testing?: boolean
  allowReadonlyToggle?: boolean
  allowReadonlyRemove?: boolean
  allowReadonlyEdit?: boolean
  readonlyToolsView?: boolean
}>()

const emit = defineEmits<{
  edit: [server: McpServerInfo]
  test: [server: McpServerInfo]
  reload: [name: string]
  remove: [server: McpServerInfo]
  toggleEnabled: [server: McpServerInfo]
  manageTools: [server: McpServerInfo]
}>()

const { t } = useI18n()

function statusClass(server: McpServerInfo) {
  if (server.raw_config.enabled === false) return 'disabled'
  if (props.testing) return 'testing'
  return server.connected ? 'connected' : 'disconnected'
}

function statusLabel(server: McpServerInfo) {
  if (server.raw_config.enabled === false) return t('mcp.disabledStatus')
  if (props.testing) return t('mcp.loading')
  return server.connected ? t('mcp.connectedStatus') : t('mcp.disconnectedStatus')
}

const tools = computed(() => props.toolsByServer[props.server.name] || [])
const MAX_VISIBLE_TOOLS = 20
</script>

<template>
  <div
    class="mcp-card"
    :class="{
      testing,
      disconnected: !testing && server.raw_config.enabled !== false && !server.connected,
      disabled: server.raw_config.enabled === false,
    }"
  >
    <!-- 第一行：标题 + 标签 -->
    <div class="card-header">
      <h3 class="server-name">{{ server.name }}</h3>
      <div class="server-badges">
        <span class="type-badge transport">{{ server.transport }}</span>
        <span v-if="contextLabel" class="type-badge context">{{ contextLabel }}</span>
        <span class="type-badge" :class="statusClass(server)">{{ statusLabel(server) }}</span>
      </div>
    </div>

    <!-- 第二行：工具列表 + 数量 -->
    <div class="card-body">
      <div v-if="server.error" class="error-row">
        <span class="error-text">{{ server.error }}</span>
      </div>

      <div class="info-row">
        <span class="info-label">{{ t('mcp.toolList') }}</span>
        <span class="info-value">
          {{ server.tools_registered }}/{{ server.tools }}{{ t('mcp.count') }}{{ t('mcp.tools') }}
        </span>
      </div>

      <!-- 工具标签列表 -->
      <div v-if="server.tools > 0" class="tools-list">
        <span
          v-for="tool in tools.slice(0, MAX_VISIBLE_TOOLS)"
          :key="tool.name"
          class="tool-tag"
          :title="tool.description"
        >
          {{ tool.name }}
        </span>
        <span v-if="tools.length > MAX_VISIBLE_TOOLS" class="tool-tag tool-tag-more">
          +{{ tools.length - MAX_VISIBLE_TOOLS }} {{ t('mcp.more') }}
        </span>
      </div>
      <div v-else class="tools-empty">
        <span class="muted">{{ t('mcp.zeroTools') }}</span>
      </div>
    </div>

    <!-- 底部：按钮 + 开关 -->
    <div class="card-footer">
      <div class="card-actions">
        <NButton v-if="!readonly || allowReadonlyEdit" size="tiny" quaternary @click="emit('edit', server)">{{ t('mcp.edit') }}</NButton>
        <NButton v-if="showManageTools !== false" size="tiny" quaternary @click="emit('manageTools', server)">
          {{ readonlyToolsView ? t('mcp.toolList') : t('mcp.manageTools') }}
        </NButton>
        <NButton size="tiny" quaternary :loading="testing" @click="emit('test', server)">{{ t('mcp.test') }}</NButton>
        <NButton v-if="showReload !== false" size="tiny" quaternary @click="emit('reload', server.name)">{{ t('mcp.reload') }}</NButton>
        <NPopconfirm v-if="!readonly || allowReadonlyRemove" @positive-click="emit('remove', server)">
          <template #trigger>
            <NButton size="tiny" quaternary type="error">{{ t('mcp.remove') }}</NButton>
          </template>
          {{ t('mcp.confirmRemove', { name: server.name }) }}
        </NPopconfirm>
      </div>
      <NSwitch
        :value="server.raw_config.enabled !== false"
        size="small"
        :disabled="readonly && !allowReadonlyToggle"
        @update:value="() => emit('toggleEnabled', server)"
      />
    </div>
  </div>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;

.mcp-card {
  background-color: var(--theme-card-bg, $bg-card);
  border: var(--border-width, 1px) solid $border-color;
  border-radius: $radius-md;
  padding: calc(16px * var(--spacing-scale, 1));
  transition: border-color $transition-fast;

  &:hover {
    border-color: rgba(var(--accent-primary-rgb), 0.3);
  }

  &.disconnected {
    border-color: rgba(var(--error-rgb), 0.3);
  }

  &.testing {
    border-color: rgba(var(--accent-primary-rgb), 0.3);
  }

  &.disabled {
    opacity: 0.7;
  }
}

.card-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: calc(12px * var(--spacing-scale, 1));
  margin-bottom: 12px;
}

.server-name {
  font-size: calc(var(--font-size-base, 14px) * 15 / 14);
  font-weight: 600;
  color: $text-primary;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 70%;
}

.server-badges {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: calc(6px * var(--spacing-scale, 1));
  min-width: 0;
}

.type-badge {
  font-size: calc(var(--font-size-base, 14px) * 11 / 14);
  padding: calc(2px * var(--spacing-scale, 1)) calc(8px * var(--spacing-scale, 1));
  border-radius: var(--radius-component, 10px);
  font-weight: 500;
  white-space: nowrap;

  &.transport {
    background: rgba(var(--accent-primary-rgb), 0.12);
    color: $accent-primary;
  }

  &.connected {
    background: rgba(var(--success-rgb), 0.12);
    color: $success;
  }

  &.context {
    background: rgba(var(--accent-primary-rgb), 0.08);
    color: $text-secondary;
  }

  &.disconnected {
    background: rgba(var(--error-rgb), 0.12);
    color: $error;
  }

  &.testing {
    background: rgba(var(--accent-primary-rgb), 0.12);
    color: $accent-primary;
  }

  &.disabled {
    background: rgba(var(--text-muted-rgb, 128,128,128), 0.12);
    color: $text-muted;
  }
}

.card-body {
  display: flex;
  flex-direction: column;
  gap: calc(8px * var(--spacing-scale, 1));
  margin-bottom: 14px;
}

.error-row {
  margin-bottom: 4px;
}

.error-text {
  color: $error;
  font-size: calc(var(--font-size-base, 14px) * 11 / 14);
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.info-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.info-label {
  font-size: calc(var(--font-size-base, 14px) * 12 / 14);
  color: $text-muted;
}

.info-value {
  font-size: calc(var(--font-size-base, 14px) * 12 / 14);
  color: $text-secondary;
}

.tools-list {
  display: flex;
  flex-wrap: wrap;
  gap: calc(4px * var(--spacing-scale, 1)) calc(6px * var(--spacing-scale, 1));
  height: 88px;
  overflow-y: auto;
  align-content: flex-start;
}

.tool-tag {
  display: inline-flex;
  align-items: center;
  min-height: 22px;
  font-size: calc(var(--font-size-base, 14px) * 10 / 14);
  font-family: var(--font-code, $font-code);
  padding: calc(2px * var(--spacing-scale, 1)) calc(6px * var(--spacing-scale, 1));
  border-radius: var(--radius-component, 3px);
  background: rgba(var(--accent-primary-rgb), 0.08);
  color: $text-secondary;
  white-space: nowrap;
  max-width: 200px;
  overflow: hidden;
  text-overflow: ellipsis;
  cursor: default;

  &:hover {
    background: rgba(var(--accent-primary-rgb), 0.16);
  }

  &-more {
    background: rgba(var(--accent-primary-rgb), 0.15);
    color: $accent-primary;
    font-weight: 500;
  }
}

.tools-empty {
  height: 88px;
  display: flex;
  align-items: center;
  justify-content: center;
}

.muted {
  color: $text-muted;
  font-size: calc(var(--font-size-base, 14px) * 12 / 14);
}

.card-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  border-top: var(--border-width, 1px) solid $border-light;
  padding-top: calc(10px * var(--spacing-scale, 1));
}

.card-actions {
  display: flex;
  gap: calc(8px * var(--spacing-scale, 1));
  flex-wrap: wrap;
}
</style>
