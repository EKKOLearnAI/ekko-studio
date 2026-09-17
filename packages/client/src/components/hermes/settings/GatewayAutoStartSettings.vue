<script setup lang="ts">
import { computed } from 'vue'
import { NSelect, NSwitch, useMessage } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import { useSettingsStore } from '@/stores/hermes/settings'
import { useProfilesStore } from '@/stores/hermes/profiles'
import SettingRow from './SettingRow.vue'
import { profileSelectLabel } from '@/lib/profileDisplay'

const settingsStore = useSettingsStore()
const profilesStore = useProfilesStore()
const message = useMessage()
const { t } = useI18n()
withDefaults(defineProps<{ standalone?: boolean }>(), {
  standalone: false,
})

const enabled = computed(() => settingsStore.gatewayAutoStart.enabled !== false)
const mode = computed(() => Array.isArray(settingsStore.gatewayAutoStart.include) ? 'include' : 'all')
const managementEnabled = computed(() => settingsStore.gatewayAutoStart.management === 'unified')
const includeProfiles = computed(() => settingsStore.gatewayAutoStart.include || [])
const excludeProfiles = computed(() => settingsStore.gatewayAutoStart.exclude || [])
const isDefaultProfile = computed(() => (profilesStore.activeProfileName || profilesStore.activeProfile?.name || 'default') === 'default')
const profileOptions = computed(() =>
  profilesStore.profiles.map(profile => ({
    label: profileSelectLabel(profile),
    value: profile.name,
  })),
)
const modeOptions = computed(() => [
  { label: t('settings.gatewayAutoStart.modeAll'), value: 'all' },
  { label: t('settings.gatewayAutoStart.modeInclude'), value: 'include' },
])

function normalizeProfileList(raw: string[]): string[] {
  const seen = new Set<string>()
  const names: string[] = []
  for (const part of raw) {
    const name = String(part || '').trim()
    if (!name || seen.has(name)) continue
    seen.add(name)
    names.push(name)
  }
  return names
}

async function save(values: Record<string, any>) {
  try {
    settingsStore.updateLocal('gatewayAutoStart', values)
    await settingsStore.saveSection('gatewayAutoStart', values, { restart: false })
    await settingsStore.fetchSettings()
    message.success(t('settings.saved'))
  } catch {
    message.error(t('settings.saveFailed'))
  }
}

function saveMode(value: string) {
  void save(value === 'include'
    ? { include: settingsStore.gatewayAutoStart.include || [], exclude: null }
    : { include: null })
}

function saveManagement(value: boolean) {
  void save({ management: value ? 'unified' : 'per_profile' })
}

function saveInclude(value: string[]) {
  void save({ include: normalizeProfileList(value), exclude: null })
}

function saveExclude(value: string[]) {
  const exclude = normalizeProfileList(value)
  void save({ exclude: exclude.length > 0 ? exclude : null })
}
</script>

<template>
  <section class="settings-section gateway-auto-start-settings" :class="{ standalone }">
    <h3 class="section-title">{{ t('settings.gatewayAutoStart.title') }}</h3>
    <p class="section-hint">{{ t('settings.gatewayAutoStart.description') }}</p>

    <SettingRow :label="t('settings.gatewayAutoStart.enabled')" :hint="t('settings.gatewayAutoStart.enabledHint')">
      <NSwitch :value="enabled" @update:value="value => save({ enabled: value })" />
    </SettingRow>

    <SettingRow
      v-if="isDefaultProfile"
      :label="t('settings.gatewayAutoStart.management')"
      :hint="t('settings.gatewayAutoStart.managementHint')"
    >
      <NSwitch :value="managementEnabled" @update:value="saveManagement" />
    </SettingRow>

    <SettingRow :label="t('settings.gatewayAutoStart.mode')" :hint="t('settings.gatewayAutoStart.modeHint')">
      <NSelect
        :value="mode"
        :options="modeOptions"
        size="small"
        class="input-md"
        @update:value="saveMode"
      />
    </SettingRow>

    <SettingRow
      v-if="mode === 'include'"
      :label="t('settings.gatewayAutoStart.include')"
      :hint="t('settings.gatewayAutoStart.includeHint')"
    >
      <NSelect
        multiple
        filterable
        :value="includeProfiles"
        :options="profileOptions"
        size="small"
        class="input-md"
        :placeholder="t('settings.gatewayAutoStart.profileListPlaceholder')"
        @update:value="saveInclude"
      />
    </SettingRow>

    <SettingRow
      v-if="mode === 'all'"
      :label="t('settings.gatewayAutoStart.exclude')"
      :hint="t('settings.gatewayAutoStart.excludeHint')"
    >
      <NSelect
        multiple
        filterable
        :value="excludeProfiles"
        :options="profileOptions"
        size="small"
        class="input-md"
        :placeholder="t('settings.gatewayAutoStart.profileListPlaceholder')"
        @update:value="saveExclude"
      />
    </SettingRow>
  </section>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;

.settings-section {
  margin-top: 16px;
}

.gateway-auto-start-settings {
  padding-top: 16px;
  border-top: 1px solid var(--border-color);

  &.standalone {
    margin-top: 0;
    padding-top: 0;
    border-top: 0;
  }
}

.section-title {
  margin: 0 0 6px;
  font-size: 15px;
  font-weight: 600;
  color: var(--text-color);
}

.section-hint {
  margin: 0 0 12px;
  color: var(--text-color-secondary);
  font-size: 13px;
}

.input-md {
  max-width: 320px;
}
</style>
