<script setup lang="ts">
import { reactive, watch } from 'vue'
import { NButton, NInput, useMessage } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import { useSettingsStore } from '@/stores/hermes/settings'
import SettingRow from './SettingRow.vue'

const settingsStore = useSettingsStore()
const message = useMessage()
const { t } = useI18n()
const proxyKeys = ['HTTPS_PROXY', 'HTTP_PROXY', 'ALL_PROXY', 'NO_PROXY'] as const

const draft = reactive<Record<string, string>>({
  HTTPS_PROXY: '',
  HTTP_PROXY: '',
  ALL_PROXY: '',
  NO_PROXY: '',
})

watch(
  () => settingsStore.proxy,
  (proxy) => {
    for (const key of proxyKeys) {
      draft[key] = String(proxy?.[key] || '')
    }
  },
  { immediate: true, deep: true },
)

async function save() {
  try {
    await settingsStore.saveSection('proxy', { ...draft })
    await settingsStore.fetchSettings()
    message.success(t('settings.saved'))
  } catch {
    message.error(t('settings.saveFailed'))
  }
}
</script>

<template>
  <section class="settings-section proxy-settings">
    <h3 class="section-title">{{ t('settings.proxy.title') }}</h3>
    <p class="section-hint">{{ t('settings.proxy.description') }}</p>

    <SettingRow :label="t('settings.proxy.httpsProxy')" :hint="t('settings.proxy.httpsProxyHint')">
      <NInput v-model:value="draft.HTTPS_PROXY" clearable size="small" class="input-lg" placeholder="http://127.0.0.1:7890" />
    </SettingRow>

    <SettingRow :label="t('settings.proxy.httpProxy')" :hint="t('settings.proxy.httpProxyHint')">
      <NInput v-model:value="draft.HTTP_PROXY" clearable size="small" class="input-lg" placeholder="http://127.0.0.1:7890" />
    </SettingRow>

    <SettingRow :label="t('settings.proxy.allProxy')" :hint="t('settings.proxy.allProxyHint')">
      <NInput v-model:value="draft.ALL_PROXY" clearable size="small" class="input-lg" placeholder="socks5://127.0.0.1:7890" />
    </SettingRow>

    <SettingRow :label="t('settings.proxy.noProxy')" :hint="t('settings.proxy.noProxyHint')">
      <NInput v-model:value="draft.NO_PROXY" clearable size="small" class="input-lg" placeholder="localhost,127.0.0.1,.local" />
    </SettingRow>

    <div class="settings-actions">
      <NButton type="primary" :loading="settingsStore.saving" @click="save">
        {{ t('settings.proxy.save') }}
      </NButton>
    </div>
  </section>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;

.settings-section {
  width: 100%;
  max-width: none;
}

.section-title {
  margin: 0 0 6px;
  font-size: calc(var(--font-size-base, 14px) * 18 / 14);
}

.section-hint {
  margin: 0 0 16px;
  color: $text-muted;
  font-size: calc(var(--font-size-base, 14px) * 13 / 14);
}

.input-lg {
  width: 100%;
}

.proxy-settings :deep(.setting-info),
.proxy-settings :deep(.setting-control) {
  min-width: 0;
  flex: 1;
}

.settings-actions {
  display: flex;
  justify-content: flex-end;
  padding-top: calc(16px * var(--spacing-scale, 1));
}

@media (max-width: $breakpoint-mobile) {
  .input-lg {
    width: 100%;
  }
}
</style>
