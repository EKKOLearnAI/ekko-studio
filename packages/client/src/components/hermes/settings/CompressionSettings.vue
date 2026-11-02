<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { NInputNumber, NSwitch, useMessage } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import { useSettingsStore } from '@/stores/hermes/settings'
import { fetchConfig, updateConfigSection } from '@/api/hermes/config'
import { syncProfileCompression } from '@/api/hermes/profiles'
import SettingRow from './SettingRow.vue'

const settingsStore = useSettingsStore()
const message = useMessage()
const { t } = useI18n()

const microCompactDefault = ref(false)

async function loadMicroCompactDefault() {
  try {
    const data = await fetchConfig(['microCompactDefault'])
    microCompactDefault.value = data.microCompactDefault?.microCompactDefault === true
  } catch {
    /* best-effort: leave the default off if the read fails */
  }
}

// 开关切换：设全局默认 + 立即应用到所有现有 profile（消化已有的；未来新建自动遵循该值）
async function setMicroCompactDefault(v: boolean) {
  try {
    await updateConfigSection('microCompactDefault', { microCompactDefault: v })
    microCompactDefault.value = v
  } catch {
    message.error(t('settings.compression.microCompactFailed'))
    return
  }
  try {
    const r = await syncProfileCompression()
    if (r.skipped && r.skipped.length) {
      message.warning(
        t('settings.compression.microCompactApplied', { count: r.count }) +
        ' · ' +
        t('settings.compression.microCompactSkipped', { count: r.skipped.length, list: r.skipped.join(', ') }),
      )
    } else {
      message.success(t('settings.compression.microCompactApplied', { count: r.count }))
    }
  } catch {
    message.error(t('settings.compression.microCompactFailed'))
  }
}

onMounted(() => {
  void loadMicroCompactDefault()
})

const defaults = {
  enabled: true,
  threshold: 0.5,
  target_ratio: 0.2,
  protect_last_n: 20,
  protect_first_n: 3,
}

const debounceTimers: Record<string, ReturnType<typeof setTimeout>> = {}

function save(values: Record<string, any>) {
  settingsStore.updateLocal('compression', values)
  settingsStore.saveSection('compression', values).then(() => {
    message.success(t('settings.saved'))
  }).catch(() => {
    message.error(t('settings.saveFailed'))
  })
}

function debouncedSave(key: string, value: any) {
  settingsStore.updateLocal('compression', { [key]: value })
  if (debounceTimers[key]) clearTimeout(debounceTimers[key])
  debounceTimers[key] = setTimeout(async () => {
    try {
      await settingsStore.saveSection('compression', { [key]: value })
      message.success(t('settings.saved'))
    } catch {
      message.error(t('settings.saveFailed'))
    }
  }, 300)
}
</script>

<template>
  <section class="settings-section">
    <div class="global-default-block">
      <div class="gd-row">
        <div class="gd-text">
          <div class="gd-title">{{ t('settings.compression.microCompactDefault') }}</div>
          <div class="gd-hint">{{ t('settings.compression.microCompactDefaultHint') }}</div>
        </div>
        <NSwitch
          :value="microCompactDefault"
          size="small"
          @update:value="(v: boolean) => setMicroCompactDefault(v)"
        />
      </div>
    </div>
    <div class="section-divider"></div>
    <SettingRow :label="t('settings.compression.enabled')" :hint="t('settings.compression.enabledHint')">
      <NSwitch
        :value="settingsStore.compression.enabled ?? defaults.enabled"
        size="small"
        @update:value="v => save({ enabled: v })"
      />
    </SettingRow>
    <SettingRow :label="t('settings.compression.threshold')" :hint="t('settings.compression.thresholdHint')">
      <NInputNumber
        :value="settingsStore.compression.threshold ?? defaults.threshold"
        :min="0.1"
        :max="0.95"
        :step="0.05"
        size="small"
        class="input-sm"
        @update:value="v => v != null && debouncedSave('threshold', v)"
      />
    </SettingRow>
    <SettingRow :label="t('settings.compression.targetRatio')" :hint="t('settings.compression.targetRatioHint')">
      <NInputNumber
        :value="settingsStore.compression.target_ratio ?? defaults.target_ratio"
        :min="0.05"
        :max="0.8"
        :step="0.05"
        size="small"
        class="input-sm"
        @update:value="v => v != null && debouncedSave('target_ratio', v)"
      />
    </SettingRow>
    <SettingRow :label="t('settings.compression.protectLastN')" :hint="t('settings.compression.protectLastNHint')">
      <NInputNumber
        :value="settingsStore.compression.protect_last_n ?? defaults.protect_last_n"
        :min="0"
        :max="200"
        :step="1"
        size="small"
        class="input-sm"
        @update:value="v => v != null && debouncedSave('protect_last_n', v)"
      />
    </SettingRow>
    <SettingRow :label="t('settings.compression.protectFirstN')" :hint="t('settings.compression.protectFirstNHint')">
      <NInputNumber
        :value="settingsStore.compression.protect_first_n ?? defaults.protect_first_n"
        :min="0"
        :max="50"
        :step="1"
        size="small"
        class="input-sm"
        @update:value="v => v != null && debouncedSave('protect_first_n', v)"
      />
    </SettingRow>
  </section>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;

.settings-section {
  margin-top: 16px;
}

.global-default-block {
  margin-bottom: 16px;
  padding: 12px;
  border-radius: 8px;
  background: rgba(127, 127, 127, 0.08);
}

.gd-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.gd-title {
  font-size: 14px;
  font-weight: 600;
}

.gd-hint {
  font-size: 12px;
  opacity: 0.65;
  margin-top: 2px;
  line-height: 1.5;
}

.section-divider {
  height: 1px;
  background: rgba(127, 127, 127, 0.2);
  margin: 4px 0 12px;
}
</style>
