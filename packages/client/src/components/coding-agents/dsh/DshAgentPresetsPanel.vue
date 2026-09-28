<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { NAlert, NButton, NEmpty, NInput, NModal, NPopconfirm, NSpin, NTag } from 'naive-ui'
import { listDshAgentPresets, readDshAgentPreset, copyDshAgentPreset, deleteDshAgentPreset, defaultDshAgentPreset, locateDshAgentPreset, type DshAgentPreset, type DshAgentPresets } from '@/api/coding-agents/dsh'
const { t } = useI18n()
const roster = ref<DshAgentPresets>({ presets: [], authorable: false })
const loading = ref(true), busy = ref(false), error = ref(''), copyError = ref('')
const source = ref<DshAgentPreset | null>(null), identifier = ref(''), name = ref('')
const viewer = ref<{ title: string; content: string } | null>(null)
const validCopy = computed(() => /^[a-z0-9][a-z0-9-]*$/.test(identifier.value) && identifier.value.length <= 200 && !roster.value.presets.some(row => row.id === identifier.value))
const message = (err: unknown) => err instanceof Error ? err.message : t('dshPresets.unavailable')
async function load() {
  loading.value = true; error.value = ''
  try { roster.value = await listDshAgentPresets() } catch (err) { error.value = message(err) }
  finally { loading.value = false }
}
async function mutate(operation: () => Promise<DshAgentPresets>) {
  busy.value = true; error.value = ''
  try { roster.value = await operation() } catch (err) { error.value = message(err); await listDshAgentPresets().then(value => { roster.value = value }).catch(() => {}) }
  finally { busy.value = false }
}
function beginCopy(row: DshAgentPreset) { source.value = row; identifier.value = ''; name.value = ''; copyError.value = '' }
async function copy() {
  if (!source.value || !validCopy.value || busy.value) return
  busy.value = true; copyError.value = ''
  try { roster.value = await copyDshAgentPreset({ from: source.value.id, id: identifier.value, name: name.value }); source.value = null }
  catch (err) { copyError.value = message(err); await listDshAgentPresets().then(value => { roster.value = value }).catch(() => {}) }
  finally { busy.value = false }
}
async function view(row: DshAgentPreset) {
  busy.value = true; error.value = ''
  try { viewer.value = { title: row.name || row.id, content: (await readDshAgentPreset(row.id)).content } }
  catch (err) { error.value = message(err) } finally { busy.value = false }
}
async function locate(row: DshAgentPreset) {
  busy.value = true; error.value = ''
  try { const result = await locateDshAgentPreset(row.id); if (!result.opened) viewer.value = { title: t('dshPresets.location'), content: result.path! } }
  catch (err) { error.value = message(err) } finally { busy.value = false }
}
onMounted(load)
</script>
<template>
  <div class="plugins-view dsh-presets" data-testid="dsh-agent-presets">
    <header class="page-header"><h2 class="header-title">{{ t('dshPresets.title') }}</h2><NButton size="small" quaternary :disabled="busy || loading" @click="load">{{ t('mcp.refresh') }}</NButton></header>
    <div class="plugins-content">
      <p class="preset-hint">{{ t('dshPresets.hint') }}</p>
      <NAlert v-if="error" type="error" class="preset-error">{{ error }}</NAlert>
      <NSpin v-if="loading" />
      <div v-else-if="roster.presets.length" class="preset-grid">
        <section v-for="row in roster.presets" :key="row.id" class="preset-card" :class="{ selected: row.isDefault }" :data-testid="`dsh-preset-${row.id}`">
          <div class="preset-heading"><h3>{{ row.name || row.id }}</h3><NTag v-if="row.trust" size="small" :bordered="false">{{ t(row.trust === 'system' ? 'dshPlugins.shipped' : 'dshPlugins.userPreset') }}</NTag><NTag v-if="row.isDefault" size="small" type="success">{{ t('dshPresets.default') }}</NTag></div>
          <code>{{ row.id }}</code>
          <p class="preset-description">{{ row.description }}</p>
          <NAlert v-if="row.broken" type="error">{{ row.broken }}</NAlert>
          <div class="preset-actions">
            <NButton size="small" :disabled="busy || !!row.broken" @click="view(row)">{{ t('dshPresets.view') }}</NButton>
            <NButton size="small" :disabled="busy || !roster.authorable || !!row.broken" @click="beginCopy(row)">{{ t('dshPresets.copy') }}</NButton>
            <NButton size="small" :disabled="busy || row.isDefault || !!row.broken" @click="mutate(() => defaultDshAgentPreset(row.id))">{{ t('dshPresets.setDefault') }}</NButton>
            <NButton v-if="row.trust === 'user'" size="small" :disabled="busy" @click="locate(row)">{{ t('dshPresets.location') }}</NButton>
            <NPopconfirm v-if="row.trust === 'user'" @positive-click="mutate(() => deleteDshAgentPreset(row.id))"><template #trigger><NButton size="small" type="error" ghost :disabled="busy">{{ t('dshPresets.delete') }}</NButton></template>{{ t('dshPresets.deleteConfirm', { name: row.name || row.id }) }}</NPopconfirm>
          </div>
        </section>
      </div>
      <NEmpty v-else :description="t('dshPresets.empty')" />
    </div>
    <NModal :show="!!source" preset="card" :title="t('dshPresets.copyTitle', { name: source?.name || source?.id || '' })" class="preset-modal" :closable="!busy" :mask-closable="!busy" :close-on-esc="!busy" @update:show="value => { if (!value && !busy) source = null }">
      <NAlert v-if="copyError" type="error">{{ copyError }}</NAlert>
      <form class="preset-form" @submit.prevent="copy">
        <label>{{ t('dshPresets.identifier') }}<NInput v-model:value="identifier" :disabled="busy" :maxlength="200" :input-props="{ 'aria-label': t('dshPresets.identifier') }" /></label>
        <p class="preset-hint">{{ t('dshPresets.idHint') }}</p>
        <label>{{ t('dshPresets.name') }}<NInput v-model:value="name" :disabled="busy" :maxlength="200" :input-props="{ 'aria-label': t('dshPresets.name') }" /></label>
        <NButton attr-type="submit" type="primary" :disabled="!validCopy" :loading="busy">{{ t('dshPresets.create') }}</NButton>
      </form>
    </NModal>
    <NModal :show="!!viewer" preset="card" :title="viewer?.title" class="preset-modal preset-viewer" @update:show="value => { if (!value) viewer = null }"><pre>{{ viewer?.content }}</pre></NModal>
  </div>
</template>
<style scoped lang="scss">
@use '@/styles/plugins-page' as plugins-page;
@use '@/styles/variables' as *;
@include plugins-page.layout(100%);
.dsh-presets { min-height: 0; }
.preset-hint { margin: 0; padding-block: 8px 16px; color: $text-secondary; font-size: 13px; }
.preset-error { margin-bottom: 16px; }
.preset-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 340px), 1fr)); gap: 16px; padding-bottom: 24px; }
.preset-card { min-width: 0; padding: 20px; border: 1px solid $border-color; border-radius: 12px; display: flex; flex-direction: column; gap: 12px; }
.preset-card.selected { border-color: $accent-primary; }
.preset-heading { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.preset-heading h3 { margin: 0; font-size: 16px; overflow-wrap: anywhere; }
.preset-card code, .preset-description { color: $text-secondary; overflow-wrap: anywhere; }
.preset-description { margin: 0; flex: 1; }
.preset-actions { display: flex; flex-wrap: wrap; gap: 8px; padding-top: 8px; }
.preset-modal { width: min(560px, calc(100vw - 32px)); }
.preset-form { display: flex; flex-direction: column; gap: 12px; }
.preset-form label { display: flex; flex-direction: column; gap: 8px; }
.preset-viewer { width: min(900px, calc(100vw - 32px)); }
.preset-viewer pre { overflow: auto; max-height: 65vh; margin: 0; font-size: 12px; }
</style>
