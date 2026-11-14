<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { NAlert, NButton, NInput, NModal, NSpin, useMessage } from 'naive-ui'
import { VueDraggable } from 'vue-draggable-plus'
import { isStoredSuperAdmin } from '@/api/client'
import { usePluginCatalog } from '@/composables/usePluginCatalog'
import { useNavigationStore } from '@/stores/navigation'
import { useReducedMotion } from '@/composables/useReducedMotion'
import { navigationCatalog, reorderNavigationEntries } from '@/utils/navigation-entries'
import type { NavigationEntry } from '@/utils/navigation-entries'
import { defaultNavigationSettings } from '../../../../shared/navigation-settings'
import NavigationEntryIcon from './NavigationEntryIcon.vue'

const props = defineProps<{ show: boolean }>()
const emit = defineEmits<{ 'update:show': [show: boolean] }>()
const { t } = useI18n(), message = useMessage()
const navigation = useNavigationStore()
const { snapshot, loading: catalogLoading, error: catalogError, refresh } = usePluginCatalog(computed(() => props.show))
const search = ref(''), dragging = ref(false)
const reducedMotion = useReducedMotion()
const catalog = computed(() => navigationCatalog(snapshot.value.plugins, isStoredSuperAdmin()))
const title = (entry: NavigationEntry) => entry.label ? t(entry.label) : entry.title || entry.id
const selected = computed(() => navigation.items.flatMap(id => {
  const entry = catalog.value.find(entry => entry.id === id)
  // Keep unavailable plugin selections removable without inventing new candidates.
  return entry ? [{ ...entry, unavailable: false }] : id.startsWith('plugin:')
    ? [{ id, title: id.slice(7), to: '/', unavailable: true } as NavigationEntry & { unavailable: boolean }] : []
}))
const available = computed(() => catalog.value.filter(entry => !navigation.items.includes(entry.id) &&
  `${title(entry)} ${entry.plugin?.manifest.name || ''}`.toLocaleLowerCase().includes(search.value.trim().toLocaleLowerCase())))
const disabled = computed(() => navigation.saving || navigation.loading || navigation.error || !navigation.loaded || catalogLoading.value || !!catalogError.value)
const editingDisabled = computed(() => disabled.value || dragging.value)
const sortableEntries = computed({
  get: () => selected.value,
  set: entries => {
    if (!props.show) return
    const next = reorderNavigationEntries(navigation.items, entries.map(entry => entry.id))
    if (next.some((id, index) => id !== navigation.items[index])) void save(next)
  },
})
watch(() => props.show, show => { if (show) { search.value = ''; void navigation.load(true) } else dragging.value = false }, { immediate: true })

async function save(items: string[]) {
  if (disabled.value) return
  if (!await navigation.save(items)) message.error(t('navigation.saveFailed'))
}
function remove(id: string) { void save(navigation.items.filter(item => item !== id)) }
function move(id: string, targetId: string) {
  const items = [...navigation.items], from = items.indexOf(id), to = items.indexOf(targetId)
  if (from < 0 || to < 0 || from === to) return
  items.splice(to, 0, ...items.splice(from, 1))
  void save(items)
}
</script>

<template>
  <NModal :show="show" preset="card" class="navigation-settings-modal" :title="t('navigation.title')" :bordered="false" :mask-closable="true" @update:show="emit('update:show', $event)">
    <div class="navigation-settings-layout">
      <div class="navigation-settings-body">
        <p class="navigation-settings-description">{{ t('navigation.description') }}</p>
        <NAlert v-if="navigation.error || catalogError" type="error" class="navigation-settings-error">
          {{ t('navigation.loadFailed') }}
          <NButton size="small" :loading="navigation.loading || catalogLoading" @click="navigation.load(true); refresh(true)">{{ t('navigation.retry') }}</NButton>
        </NAlert>
        <NSpin :show="navigation.loading || catalogLoading">
          <div class="navigation-settings-editor">
            <section class="navigation-settings-lists">
              <div class="navigation-settings-heading"><h3>{{ t('navigation.selected') }}</h3><span>{{ selected.length }}</span><small>{{ t('navigation.reorder') }}</small></div>
              <VueDraggable v-model="sortableEntries" tag="ul" class="navigation-settings-added" data-theme-surface="card" :aria-label="t('navigation.selected')"
                handle=".navigation-settings-grip" draggable=".navigation-settings-row" direction="vertical" :disabled="disabled"
                :animation="reducedMotion ? 0 : 180" easing="cubic-bezier(0.2, 0.8, 0.2, 1)" :swap-threshold="0.7"
                ghost-class="navigation-settings-row--ghost" chosen-class="navigation-settings-row--chosen" fallback-class="navigation-settings-row--fallback"
                :force-fallback="true" :fallback-on-body="true" :fallback-tolerance="4" :delay="120" :delay-on-touch-only="true" :touch-start-threshold="6"
                :scroll="true" :bubble-scroll="false" :scroll-sensitivity="48" :scroll-speed="10" @start="dragging = true" @end="dragging = false">
                <li v-for="(entry, index) in sortableEntries" :key="entry.id" class="navigation-settings-row" :data-navigation-id="entry.id">
                  <button type="button" class="navigation-settings-grip" :disabled="disabled" :aria-label="t('navigation.reorder')">⠿</button>
                  <span class="navigation-settings-icon"><NavigationEntryIcon v-if="!entry.unavailable" :entry="entry" :size="19" /><span v-else>—</span></span>
                  <div class="navigation-settings-entry-label"><span>{{ title(entry) }}</span><small v-if="entry.plugin">{{ entry.plugin.manifest.name }}</small><small v-else-if="entry.unavailable">{{ t('navigation.unavailable') }}</small></div>
                  <span class="navigation-settings-kind">{{ t(entry.id.startsWith('plugin:') ? 'navigation.plugin' : 'navigation.builtin') }}</span>
                  <div class="navigation-settings-row-actions">
                    <NButton quaternary size="tiny" :disabled="editingDisabled || index === 0" :aria-label="t('navigation.moveUp', { name: title(entry) })" @click="move(entry.id, selected[index - 1]!.id)">↑</NButton>
                    <NButton quaternary size="tiny" :disabled="editingDisabled || index === selected.length - 1" :aria-label="t('navigation.moveDown', { name: title(entry) })" @click="move(entry.id, selected[index + 1]!.id)">↓</NButton>
                    <NButton quaternary size="tiny" :disabled="editingDisabled" :aria-label="t('navigation.remove', { name: title(entry) })" @click="remove(entry.id)">×</NButton>
                  </div>
                </li>
                <li v-if="!selected.length" class="navigation-settings-empty">{{ t('navigation.emptySelected') }}</li>
              </VueDraggable>
              <div class="navigation-settings-heading navigation-settings-candidates-heading"><h3>{{ t('navigation.candidates') }}</h3></div>
              <NInput v-model:value="search" clearable :placeholder="t('navigation.search')" :input-props="{ 'aria-label': t('navigation.search') }" />
              <ul class="navigation-settings-candidates" :aria-label="t('navigation.candidates')">
                <li v-for="entry in available" :key="entry.id" class="navigation-settings-row" :data-navigation-id="entry.id">
                  <span class="navigation-settings-icon"><NavigationEntryIcon :entry="entry" :size="19" /></span>
                  <div class="navigation-settings-entry-label"><span>{{ title(entry) }}</span><small>{{ entry.plugin?.manifest.name || t('navigation.builtin') }}</small></div>
                  <NButton size="small" :disabled="editingDisabled" :aria-label="t('navigation.add', { name: title(entry) })" @click="save([...navigation.items, entry.id])">+ {{ t('navigation.addButton') }}</NButton>
                </li>
                <li v-if="!available.length" class="navigation-settings-empty">{{ t('navigation.emptyCandidates') }}</li>
              </ul>
            </section>
            <aside class="navigation-settings-preview" :aria-label="t('navigation.preview')">
              <span>{{ t('navigation.preview') }}</span>
              <div class="navigation-settings-preview-rail" data-theme-surface="card">
                <span class="navigation-settings-preview-avatar">E</span>
                <span v-for="entry in selected.filter(entry => !entry.unavailable)" :key="entry.id" class="navigation-settings-preview-icon" :title="title(entry)"><NavigationEntryIcon :entry="entry" :size="20" /></span>
              </div>
            </aside>
          </div>
        </NSpin>
        <footer class="navigation-settings-footer"><span role="status">{{ t(navigation.saving ? 'navigation.saving' : navigation.loaded ? 'navigation.saved' : 'navigation.loadFailed') }}</span><span class="navigation-settings-footer-hint">{{ t('navigation.removeHint') }}</span><NButton text size="small" :disabled="editingDisabled" @click="save(defaultNavigationSettings().items)">{{ t('navigation.restore') }}</NButton></footer>
      </div>
    </div>
  </NModal>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;
:global(.navigation-settings-modal) { width: min(820px, calc(100vw - 40px)); max-height: calc(100dvh - 56px); border-radius: var(--theme-overlay-radius, 14px); }
.navigation-settings-layout { display: flex; min-height: 450px; }
.navigation-settings-body { flex: 1; min-width: 0; }
.navigation-settings-description { margin: 0 0 20px; color: $text-secondary; font-size: calc(var(--font-size-base, 14px) * 12 / 14); }
.navigation-settings-error { margin-bottom: 16px; }
.navigation-settings-editor { display: grid; grid-template-columns: minmax(0, 1fr) 92px; gap: 22px; max-height: calc(100dvh - 270px); min-height: 250px; overflow-y: auto; overscroll-behavior: contain; padding-inline-end: 4px; }
.navigation-settings-lists { min-width: 0; }
.navigation-settings-heading { display: flex; align-items: center; gap: 8px; margin-bottom: 12px; h3 { margin: 0; font-size: inherit; font-weight: 600; } span, small { color: $text-muted; font-size: calc(var(--font-size-base, 14px) * 11 / 14); } small { margin-inline-start: auto; } }
.navigation-settings-added, .navigation-settings-candidates { list-style: none; padding: 0; margin: 0; }
.navigation-settings-added { border: var(--border-width, 1px) solid var(--theme-card-border, $border-color); border-radius: var(--theme-card-radius, 8px); }
.navigation-settings-row { display: flex; align-items: center; gap: 10px; min-height: 54px; padding: 8px 10px; border-bottom: var(--border-width, 1px) solid var(--theme-card-border, $border-color); &:last-child { border-bottom: 0; } }
.navigation-settings-grip { display: grid; place-items: center; flex: 0 0 24px; width: 24px; height: 32px; padding: 0; border: 0; border-radius: var(--radius-component, 4px); background: transparent; color: $text-muted; font: inherit; cursor: grab; user-select: none; touch-action: none;
  &:hover { color: $text-primary; }
  &:focus-visible { outline: 2px solid $accent-primary; outline-offset: -2px; }
  &:disabled { cursor: default; }
}
.navigation-settings-row--chosen .navigation-settings-grip { cursor: grabbing; }
.navigation-settings-row--ghost { background: rgba(var(--accent-primary-rgb), 0.08); outline: 1px dashed var(--theme-card-border, $border-color); outline-offset: -2px;
  > * { visibility: hidden; }
}
.navigation-settings-row--fallback { list-style: none; background: var(--theme-card-bg, $bg-card); color: $text-primary; border: var(--border-width, 1px) solid var(--theme-card-border, $border-color); border-radius: var(--theme-card-radius, 8px); backdrop-filter: var(--theme-card-filter, none); box-shadow: var(--theme-card-shadow, 0 8px 24px rgba(var(--text-primary-rgb), 0.12)); z-index: 4000; cursor: grabbing; }
.navigation-settings-icon { display: grid; place-items: center; width: 28px; flex-shrink: 0; color: $text-secondary; }
.navigation-settings-entry-label { flex: 1; min-width: 0; overflow-wrap: anywhere; span { display: block; } small { display: block; color: $text-muted; font-size: calc(var(--font-size-base, 14px) * 11 / 14); } }
.navigation-settings-kind { color: $text-muted; font-size: calc(var(--font-size-base, 14px) * 11 / 14); white-space: nowrap; }
.navigation-settings-row-actions { display: flex; gap: 1px; }
.navigation-settings-candidates-heading { margin-top: 24px; }
.navigation-settings-empty { padding: 20px 12px; color: $text-muted; text-align: center; }
.navigation-settings-preview { display: flex; flex-direction: column; align-items: center; gap: 12px; font-size: calc(var(--font-size-base, 14px) * 11 / 14); color: $text-muted; border-inline-start: var(--border-width, 1px) solid var(--theme-overlay-border, $border-color); padding-inline-start: 18px; }
.navigation-settings-preview-rail { width: 58px; padding: 12px 6px; border: var(--border-width, 1px) solid var(--theme-card-border, $border-color); border-radius: var(--theme-card-radius, 9px); display: flex; flex-direction: column; align-items: center; gap: 10px; }
.navigation-settings-preview-avatar { display: grid; place-items: center; width: 29px; height: 29px; border-radius: var(--radius-component, 7px); color: $text-primary; border: var(--border-width, 1px) solid var(--theme-card-border, $border-color); margin-bottom: 10px; }
.navigation-settings-preview-icon { display: grid; place-items: center; height: 31px; color: $text-secondary; }
.navigation-settings-footer { display: flex; align-items: center; gap: 14px; margin-top: 18px; border-top: var(--border-width, 1px) solid var(--theme-overlay-border, $border-color); padding-top: 12px; color: $text-muted; font-size: calc(var(--font-size-base, 14px) * 11 / 14); }
.navigation-settings-footer-hint { margin-inline-start: auto; }
@media (max-width: 700px) {
  :global(.navigation-settings-modal) { width: calc(100vw - 16px); max-height: calc(100dvh - 16px); }
  .navigation-settings-layout { flex-direction: column; min-height: 0; }
  .navigation-settings-body { padding-inline-start: 0; }
  .navigation-settings-editor { display: block; max-height: calc(100dvh - 320px); }
  .navigation-settings-preview, .navigation-settings-kind, .navigation-settings-footer-hint { display: none; }
  .navigation-settings-footer { justify-content: space-between; }
  .navigation-settings-row { padding: 8px 5px; gap: 5px; }
}
</style>
