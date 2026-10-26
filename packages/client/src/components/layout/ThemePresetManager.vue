<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { NButton, NInput, NModal, NPopconfirm, useMessage } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import { useTheme } from '@/composables/useTheme'
import { MAX_THEME_ARCHIVE_BYTES } from '../../../../shared/theme-archive'

const { t } = useI18n()
const message = useMessage()
const { themePresets, activePresetId, presetBusy, loadThemePresets, createPreset, renamePreset, switchPreset, removePreset, importPreset, exportPreset } = useTheme()
const importInput = ref<HTMLInputElement | null>(null)
const failed = ref(false)
const dialog = ref<'create' | 'duplicate' | 'rename' | null>(null)
const name = ref('')
const current = computed(() => themePresets.value.find(theme => theme.id === activePresetId.value))
const displayName = (value?: string) => value || t('theme.presets.defaultName')

async function load() {
  failed.value = false
  try { await loadThemePresets() } catch { failed.value = true }
}
onMounted(load)

function open(action: NonNullable<typeof dialog.value>) {
  name.value = action === 'create' ? t('theme.presets.newName') : action === 'duplicate'
    ? t('theme.presets.copyName', { name: displayName(current.value?.name) }) : displayName(current.value?.name)
  dialog.value = action
}
async function save() {
  if (!name.value.trim() || presetBusy.value) return
  try {
    if (dialog.value === 'rename' && activePresetId.value) await renamePreset(activePresetId.value, name.value)
    else await createPreset(name.value, dialog.value === 'duplicate' ? activePresetId.value : undefined)
    dialog.value = null
  } catch { message.error(t('theme.saveFailed')) }
}
async function activate(id: string) {
  if (id === activePresetId.value) return
  try { await switchPreset(id) } catch { message.error(t('theme.saveFailed')) }
}
async function remove() {
  if (!activePresetId.value) return
  try { await removePreset(activePresetId.value) } catch { message.error(t('theme.saveFailed')) }
}
async function importFile(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (!file || presetBusy.value) return
  if (!/\.zip$/i.test(file.name) || file.size > MAX_THEME_ARCHIVE_BYTES) {
    message.error(t('theme.presets.archiveFileHint'))
    return
  }
  try { await importPreset(file); message.success(t('theme.presets.imported')) }
  catch { message.error(t('theme.presets.importFailed')) }
}
async function exportFile() {
  if (!current.value || presetBusy.value) return
  const { id, name } = current.value
  try {
    const blob = await exportPreset(id)
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = `${displayName(name).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')}.zip`
    document.body.appendChild(link)
    link.click()
    link.remove()
    window.setTimeout(() => URL.revokeObjectURL(url), 1000)
  } catch { message.error(t('theme.presets.exportFailed')) }
}
</script>

<template>
  <section class="theme-card theme-library" :aria-busy="presetBusy" data-testid="theme-library">
    <div class="library-heading">
      <div><h3>{{ t('theme.presets.title') }}</h3><p>{{ t('theme.presets.hint') }}</p></div>
      <div class="library-actions">
        <input ref="importInput" type="file" accept=".zip,application/zip" hidden data-testid="theme-import-file" @change="importFile" />
        <NButton size="small" :disabled="presetBusy || failed" data-testid="theme-import" @click="importInput?.click()">{{ t('theme.presets.import') }}</NButton>
        <NButton size="small" :disabled="presetBusy || failed" data-testid="theme-create" @click="open('create')">{{ t('theme.presets.create') }}</NButton>
      </div>
    </div>
    <div v-if="failed" role="alert">
      {{ t('theme.presets.loadFailed') }}
      <NButton size="small" @click="load">{{ t('theme.presets.retry') }}</NButton>
    </div>
    <div class="preset-grid">
      <button v-for="preset in themePresets" :key="preset.id" type="button" class="preset-choice"
        :class="{ active: preset.id === activePresetId }" :aria-pressed="preset.id === activePresetId"
        :disabled="presetBusy" :data-testid="`theme-preset-${preset.id}`" @click="activate(preset.id)">
        <span class="preset-colors" aria-hidden="true">
          <i :style="{ background: preset.appearance?.global.backgroundColor || (preset.brightness === 'dark' ? '#242424' : '#f3f3f3') }" />
          <i :style="{ background: preset.accentColor || '#888888' }" />
          <i :style="{ background: preset.appearance?.global.gradientColor || preset.textColor || '#555555' }" />
        </span>
        <span class="preset-name">{{ displayName(preset.name) }}</span>
      </button>
    </div>
    <div v-if="current" class="preset-actions">
      <span class="editing-name">{{ t('theme.presets.editing', { name: displayName(current.name) }) }}</span>
      <NButton size="tiny" :disabled="presetBusy" data-testid="theme-export" @click="exportFile">{{ t('theme.presets.export') }}</NButton>
      <NButton size="tiny" :disabled="presetBusy" data-testid="theme-duplicate" @click="open('duplicate')">{{ t('theme.presets.duplicate') }}</NButton>
      <NButton size="tiny" :disabled="presetBusy" data-testid="theme-rename" @click="open('rename')">{{ t('theme.presets.rename') }}</NButton>
      <NPopconfirm :positive-text="t('theme.presets.delete')" :negative-text="t('common.cancel')" @positive-click="remove">
        <template #trigger><NButton size="tiny" :disabled="presetBusy || themePresets.length < 2" data-testid="theme-delete">{{ t('theme.presets.delete') }}</NButton></template>
        {{ t('theme.presets.deleteConfirm', { name: displayName(current.name) }) }}
      </NPopconfirm>
    </div>
    <NModal :show="!!dialog" preset="card" class="theme-name-dialog" :title="dialog ? t(`theme.presets.${dialog}`) : ''"
      :style="{ width: 'min(420px, calc(100vw - 32px))' }" :mask-closable="!presetBusy" :close-on-esc="!presetBusy"
      :closable="!presetBusy" @update:show="value => { if (!value && !presetBusy) dialog = null }">
      <form @submit.prevent="save">
        <label for="theme-preset-name">{{ t('theme.presets.name') }}</label>
        <NInput :input-props="{ id: 'theme-preset-name' }" v-model:value="name" :maxlength="80" :disabled="presetBusy" autofocus data-testid="theme-name" />
        <div class="dialog-actions">
          <NButton :disabled="presetBusy" @click="dialog = null">{{ t('common.cancel') }}</NButton>
          <NButton type="primary" attr-type="submit" :loading="presetBusy" :disabled="!name.trim()" data-testid="theme-name-save">{{ t('common.save') }}</NButton>
        </div>
      </form>
    </NModal>
  </section>
</template>

<style scoped lang="scss">
.theme-library {
  padding: calc(18px * var(--spacing-scale, 1));
  border: var(--border-width, 1px) solid var(--border-color);
  border-radius: var(--radius-component, 8px);
  background: var(--theme-card-bg, var(--bg-card));
  color: var(--text-primary);
  min-width: 0;
}
.library-heading, .library-actions, .preset-actions, .dialog-actions { display: flex; align-items: center; gap: calc(10px * var(--spacing-scale, 1)); flex-wrap: wrap; }
.library-heading { justify-content: space-between; margin-bottom: 16px; }
h3 { font-size: calc(var(--font-size-base, 14px) * 15 / 14); }
p { margin-top: 4px; color: var(--text-muted); font-size: calc(var(--font-size-base, 14px) * 12 / 14); }
.preset-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(100%, 180px), 1fr)); gap: calc(10px * var(--spacing-scale, 1)); }
.preset-choice {
  display: flex; align-items: center; gap: 8px; min-width: 0; padding: calc(12px * var(--spacing-scale, 1));
  border: var(--border-width, 1px) solid var(--border-color); border-radius: var(--radius-component, 8px);
  background: transparent; color: var(--text-primary); font: inherit; text-align: start; cursor: pointer;
  &.active { border-color: var(--accent-primary); background: rgba(var(--accent-primary-rgb), 0.08); }
  &:focus-visible { outline: 2px solid var(--accent-primary); outline-offset: 2px; }
  &:disabled { cursor: wait; }
}
.preset-colors { display: flex; flex-shrink: 0; overflow: hidden; border-radius: 4px; border: 1px solid var(--border-color); }
.preset-colors i { width: 10px; height: 24px; }
.preset-name { flex: 1; min-width: 0; overflow-wrap: anywhere; }
.preset-actions { margin-top: 14px; }
.editing-name { flex: 1 1 180px; min-width: 0; overflow-wrap: anywhere; color: var(--text-secondary); }
.dialog-actions { justify-content: flex-end; margin-top: 18px; }
</style>
