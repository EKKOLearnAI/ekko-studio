<script setup lang="ts">
import { NInputNumber, NSelect, useMessage } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import { useSettingsStore } from '@/stores/hermes/settings'
import SettingRow from './SettingRow.vue'

const settingsStore = useSettingsStore()
const message = useMessage()
const { t } = useI18n()

// 防抖保存：每个字段独立定时器，300ms 内只发最后一次 HTTP 请求
const debounceTimers: Record<string, ReturnType<typeof setTimeout>> = {}

function save(values: Record<string, any>) {
  // NSelect 等一次性操作，直接保存，不需要防抖
  settingsStore.updateLocal('agent', values)
  settingsStore.saveSection('agent', values).then(() => {
    message.success(t('settings.saved'))
  }).catch(() => {
    message.error(t('settings.saveFailed'))
  })
}

function debouncedSave(key: string, value: any) {
  // 先立即更新本地 store（UI 即时响应）
  settingsStore.updateLocal('agent', { [key]: value })
  // 再防抖发 HTTP 保存
  if (debounceTimers[key]) clearTimeout(debounceTimers[key])
  debounceTimers[key] = setTimeout(async () => {
    try {
      await settingsStore.saveSection('agent', { [key]: value })
      message.success(t('settings.saved'))
    } catch (err: any) {
      message.error(t('settings.saveFailed'))
    }
  }, 300)
}
</script>

<template>
  <section class="settings-section">
    <SettingRow :label="t('settings.agent.maxTurns')" :hint="t('settings.agent.maxTurnsHint')">
      <NInputNumber
        :value="settingsStore.agent.max_turns"
        :min="1" :step="5"
        size="small" class="input-sm"
        @update:value="v => v != null && debouncedSave('max_turns', v)"
      />
    </SettingRow>
    <SettingRow :label="t('settings.agent.gatewayTimeout')" :hint="t('settings.agent.gatewayTimeoutHint')">
      <NInputNumber
        :value="settingsStore.agent.gateway_timeout"
        :min="0" :max="7200" :step="60"
        size="small" class="input-sm"
        @update:value="v => v != null && debouncedSave('gateway_timeout', v)"
      />
    </SettingRow>
    <SettingRow :label="t('settings.agent.restartDrainTimeout')" :hint="t('settings.agent.restartDrainTimeoutHint')">
      <NInputNumber
        :value="settingsStore.agent.restart_drain_timeout"
        :min="10" :max="300" :step="10"
        size="small" class="input-sm"
        @update:value="v => v != null && debouncedSave('restart_drain_timeout', v)"
      />
    </SettingRow>
    <SettingRow :label="t('settings.agent.toolEnforcement')" :hint="t('settings.agent.toolEnforcementHint')">
      <NSelect
        :value="settingsStore.agent.tool_use_enforcement || 'auto'"
        :options="[
          { label: t('settings.agent.auto'), value: 'auto' },
          { label: t('settings.agent.always'), value: 'always' },
          { label: t('settings.agent.never'), value: 'never' },
        ]"
        size="small" class="input-sm"
        @update:value="v => save({ tool_use_enforcement: v })"
      />
    </SettingRow>
  </section>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;

.settings-section {
  margin-top: 16px;
}
</style>
