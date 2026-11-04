<script setup lang="ts">
import { NSwitch, useMessage } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import { useSettingsStore } from '@/stores/hermes/settings'
import SettingRow from './SettingRow.vue'

const settingsStore = useSettingsStore()
const message = useMessage()
const { t } = useI18n()

async function save(values: Record<string, any>) {
  try {
    await settingsStore.saveSection('privacy', values)
    message.success(t('settings.saved'))
  } catch (err: any) {
    message.error(t('settings.saveFailed'))
  }
}
</script>

<template>
  <section class="settings-section">
    <SettingRow :label="t('settings.privacy.policy')">
      <a href="https://github.com/EKKOLearnAI/ekko-studio/blob/main/PRIVACY.md" target="_blank" rel="noopener noreferrer">{{ t('settings.privacy.policy') }}</a>
    </SettingRow>
    <SettingRow :label="t('settings.privacy.redactPii')" :hint="t('settings.privacy.redactPiiHint')">
      <NSwitch :value="settingsStore.privacy.redact_pii" @update:value="v => save({ redact_pii: v })" />
    </SettingRow>
  </section>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;

.settings-section {
  margin-top: 16px;
}
</style>
