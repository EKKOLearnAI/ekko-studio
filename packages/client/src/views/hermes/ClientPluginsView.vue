<script setup lang="ts">
/**
 * ClientPluginsView - 客户端插件管理
 *
 * 显示当前已内置的插件（来自 `plugins/index.ts`），并允许用户在浏览器端
 * 启用 / 禁用。启停状态持久化到 `localStorage: hermes.plugins.enabled`，
 * 实际生效时机为下次启动 / 刷新页面（插件 install 是启动期一次性动作）。
 */
import { computed, onMounted, ref } from 'vue'
import { NAlert, NButton, NCard, NEmpty, NSpin, NSwitch, NTag } from 'naive-ui'
import { request } from '@/api/client'
import { useI18n } from 'vue-i18n'
import {
  BUILTIN_PLUGINS,
  isPluginEnabled,
  listBuiltinPlugins,
  readPluginEnabledMap,
  writePluginEnabledMap,
} from '@/plugins'

const { t } = useI18n()

interface RowState {
  id: string
  name: string
  version: string
  description: string
  author?: string
  enabled: boolean
  hasOverride: boolean
}

const rows = ref<RowState[]>([])
const loading = ref(true)
const syncError = ref('')

const allEnabled = computed(() => rows.value.every(row => row.enabled))
const noneEnabled = computed(() => rows.value.every(row => !row.enabled))

function loadState() {
  const meta = listBuiltinPlugins()
  const persisted = readPluginEnabledMap()
  rows.value = meta.map((m) => {
    const registration = BUILTIN_PLUGINS.find(r => r.plugin.id === m.id)
    const enabled = isPluginEnabled(m.id, registration?.enabledByDefault ?? true)
    return {
      id: m.id,
      name: m.name,
      version: m.version,
      description: m.description,
      author: m.author,
      enabled,
      hasOverride: Object.prototype.hasOwnProperty.call(persisted, m.id),
    }
  })
  loading.value = false
}

async function persist() {
  const map: Record<string, boolean> = {}
  for (const row of rows.value) {
    if (row.hasOverride) map[row.id] = row.enabled
  }
  try {
    await request('/api/studio/scanner/grading/settings', { method: 'POST', body: JSON.stringify({ enabled: map['paper-grading'] === true && map.scanner !== false }) })
    writePluginEnabledMap(map)
    syncError.value = ''
  } catch (error) { syncError.value = (error as Error).message; loadState() }
}

function toggle(row: RowState, value: boolean) {
  const registration = BUILTIN_PLUGINS.find(r => r.plugin.id === row.id)
  if (value && registration?.plugin.dependencies?.some(id => !rows.value.find(r => r.id === id)?.enabled)) return
  if (!value) {
    for (const dependent of rows.value) {
      if (BUILTIN_PLUGINS.find(r => r.plugin.id === dependent.id)?.plugin.dependencies?.includes(row.id)) {
        dependent.enabled = false
        dependent.hasOverride = true
      }
    }
  }
  row.enabled = value
  row.hasOverride = true
  persist()
}

function enableAll() {
  for (const row of rows.value) {
    row.enabled = true
    row.hasOverride = true
  }
  persist()
}

function disableAll() {
  for (const row of rows.value) {
    row.enabled = false
    row.hasOverride = true
  }
  persist()
}

function resetOverrides() {
  writePluginEnabledMap({})
  for (const row of rows.value) {
    row.hasOverride = false
    const registration = BUILTIN_PLUGINS.find(r => r.plugin.id === row.id)
    row.enabled = isPluginEnabled(row.id, registration?.enabledByDefault ?? true)
  }
  void persist()
}

onMounted(loadState)

function descriptionFor(row: RowState) {
  // 尝试从 i18n 取，否则用 metadata.description
  const key = `pluginsClient.${row.id}.description`
  const translated = t(key)
  if (translated && translated !== key) return translated
  return row.description
}

function nameFor(row: RowState) {
  const key = `pluginsClient.${row.id}.name`
  const translated = t(key)
  if (translated && translated !== key) return translated
  return row.name
}
</script>

<template>
  <div class="client-plugins-view">
    <header class="page-header">
      <div class="header-title-block">
        <h2 class="header-title">{{ t('clientPlugins.title') }}</h2>
        <span class="header-subtitle">{{ t('clientPlugins.subtitle') }}</span>
      </div>
      <div class="header-actions">
        <NButton size="small" :disabled="allEnabled" @click="enableAll">
          {{ t('clientPlugins.enableAll') }}
        </NButton>
        <NButton size="small" :disabled="noneEnabled" @click="disableAll">
          {{ t('clientPlugins.disableAll') }}
        </NButton>
        <NButton size="small" quaternary @click="resetOverrides">
          {{ t('clientPlugins.reset') }}
        </NButton>
      </div>
    </header>

    <div class="client-plugins-content">
      <NAlert type="info" :bordered="false" class="client-plugins-notice">
        {{ t('clientPlugins.notice') }}
      </NAlert>

      <NAlert v-if="syncError" type="error">{{ syncError }}</NAlert>
      <NSpin :show="loading">
        <NEmpty v-if="!loading && rows.length === 0" :description="t('clientPlugins.empty')" />
        <div v-else class="client-plugins-grid">
          <NCard
            v-for="row in rows"
            :key="row.id"
            class="plugin-card"
            :class="{ 'is-disabled': !row.enabled }"
          >
            <div class="plugin-card-head">
              <div class="plugin-card-title-block">
                <div class="plugin-card-title">
                  <span>{{ nameFor(row) }}</span>
                  <NTag size="small" round>v{{ row.version }}</NTag>
                </div>
                <div class="plugin-card-id">{{ row.id }}</div>
              </div>
              <NSwitch
                :value="row.enabled"
                :aria-label="nameFor(row)"
                :disabled="BUILTIN_PLUGINS.find(r => r.plugin.id === row.id)?.plugin.dependencies?.some(id => !rows.find(r => r.id === id)?.enabled)"
                :aria-disabled="BUILTIN_PLUGINS.find(r => r.plugin.id === row.id)?.plugin.dependencies?.some(id => !rows.find(r => r.id === id)?.enabled) || undefined"
                size="small"
                @update:value="(value) => toggle(row, value)"
              />
            </div>
            <p class="plugin-card-desc">{{ descriptionFor(row) }}</p>
            <div class="plugin-card-meta">
              <span v-if="row.author">{{ t('clientPlugins.author', { author: row.author }) }}</span>
              <NTag v-if="row.hasOverride" size="tiny" type="warning">
                {{ t('clientPlugins.overridden') }}
              </NTag>
            </div>
          </NCard>
        </div>
      </NSpin>
    </div>
  </div>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;

.client-plugins-view {
  display: flex;
  flex-direction: column;
  height: calc(100 * var(--vh));
}

.page-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 14px 20px 12px;
  border-bottom: 1px solid $border-light;
}

.header-title-block {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}

.header-title {
  font-size: 18px;
  font-weight: 600;
  margin: 0;
}

.header-subtitle {
  font-size: 12px;
  color: $text-muted;
}

.header-actions {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-shrink: 0;
}

.client-plugins-content {
  flex: 1;
  overflow-y: auto;
  padding: 16px 20px 24px;
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.client-plugins-notice {
  font-size: 12.5px;
}

.client-plugins-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
  gap: 12px;
}

.plugin-card {
  border: 1px solid $border-light;

  &.is-disabled {
    opacity: 0.65;
  }
}

.plugin-card-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}

.plugin-card-title-block {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.plugin-card-title {
  display: flex;
  align-items: center;
  gap: 8px;
  font-weight: 600;
}

.plugin-card-id {
  font-size: 11px;
  color: $text-muted;
  font-family: var(--font-mono, monospace);
}

.plugin-card-desc {
  font-size: 12.5px;
  color: $text-secondary;
  margin: 8px 0 4px;
  line-height: 1.45;
}

.plugin-card-meta {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 11.5px;
  color: $text-muted;
}
</style>
