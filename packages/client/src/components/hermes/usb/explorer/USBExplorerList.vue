<script setup lang="ts">
import { computed } from 'vue'
import { NEmpty, NSpin } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import type { USBFileEntry } from '@/api/studio/usb'
import { formatExplorerBytes, formatExplorerTime } from '@/utils/usb-format'

const props = defineProps<{
  entries: USBFileEntry[]
  loading: boolean
  selectedPath: string
  viewMode: 'icons' | 'list'
  searchTerm: string
  errorMessage?: string
}>()

const emit = defineEmits<{
  select: [entry: USBFileEntry]
  open: [entry: USBFileEntry]
  context: [event: MouseEvent, entry: USBFileEntry]
}>()

const { t } = useI18n()

const filteredEntries = computed(() => {
  const term = props.searchTerm.trim().toLowerCase()
  if (!term) return props.entries
  return props.entries.filter(entry => entry.name.toLowerCase().includes(term))
})

function sizeLabel(entry: USBFileEntry): string {
  if (entry.isDir) return '—'
  return formatExplorerBytes(entry.size)
}

function handleRowClick(entry: USBFileEntry, event: MouseEvent) {
  if (event.detail === 2) {
    emit('open', entry)
  } else {
    emit('select', entry)
  }
}
</script>

<template>
  <div class="usb-explorer-list">
    <div v-if="props.viewMode === 'list'" class="list-table">
      <div class="list-row list-row--head">
        <span class="col-name">{{ t('usb.explorer.list.columnName') }}</span>
        <span class="col-size">{{ t('usb.explorer.list.columnSize') }}</span>
        <span class="col-modified">{{ t('usb.explorer.list.columnModified') }}</span>
      </div>
      <NSpin :show="props.loading">
        <div v-if="props.errorMessage" class="list-empty">
          <NEmpty :description="props.errorMessage" size="small" />
        </div>
        <div v-else-if="filteredEntries.length === 0" class="list-empty">
          <NEmpty :description="t('usb.explorer.list.empty')" size="small" />
        </div>
        <div v-else class="list-rows">
          <div
            v-for="entry in filteredEntries"
            :key="entry.path"
            class="list-row"
            :class="{ active: props.selectedPath === entry.path }"
            role="row"
            tabindex="0"
            @click="handleRowClick(entry, $event)"
            @keydown.enter="emit('open', entry)"
            @contextmenu.prevent="emit('context', $event, entry)"
          >
            <span class="col-name">
              <svg v-if="entry.isDir" class="row-icon" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z" />
              </svg>
              <svg v-else class="row-icon" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                <polyline points="14 2 14 8 20 8" />
              </svg>
              <span class="row-name">{{ entry.name }}</span>
            </span>
            <span class="col-size">{{ sizeLabel(entry) }}</span>
            <span class="col-modified">{{ formatExplorerTime(entry.modTime) }}</span>
          </div>
        </div>
      </NSpin>
    </div>

    <div v-else class="grid-view">
      <NSpin :show="props.loading">
        <div v-if="props.errorMessage" class="list-empty">
          <NEmpty :description="props.errorMessage" size="small" />
        </div>
        <div v-else-if="filteredEntries.length === 0" class="list-empty">
          <NEmpty :description="t('usb.explorer.list.empty')" size="small" />
        </div>
        <div v-else class="grid-tiles">
          <div
            v-for="entry in filteredEntries"
            :key="entry.path"
            class="grid-tile"
            :class="{ active: props.selectedPath === entry.path }"
            role="row"
            tabindex="0"
            @click="handleRowClick(entry, $event)"
            @keydown.enter="emit('open', entry)"
            @contextmenu.prevent="emit('context', $event, entry)"
          >
            <span class="tile-icon">
              <svg v-if="entry.isDir" viewBox="0 0 24 24" width="40" height="40" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
                <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z" />
              </svg>
              <svg v-else viewBox="0 0 24 24" width="40" height="40" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
                <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                <polyline points="14 2 14 8 20 8" />
              </svg>
            </span>
            <span class="tile-name">{{ entry.name }}</span>
            <span class="tile-meta">
              {{ entry.isDir ? t('usb.page.browser.folder') : formatExplorerBytes(entry.size) }}
            </span>
          </div>
        </div>
      </NSpin>
    </div>
  </div>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;

.usb-explorer-list {
  display: flex;
  flex-direction: column;
  min-height: 0;
  flex: 1 1 auto;
}

.list-table,
.grid-view {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
}

/* 显式 grid 列宽：名称 | 大小 | 修改时间*/
$list-grid: minmax(0, 1fr) 110px 200px;

.list-row {
  display: grid !important;
  grid-template-columns: #{$list-grid} !important;
  align-items: center;
  gap: 16px;
  padding: 8px 16px;
  border: none;
  background: transparent;
  color: $text-primary;
  text-align: start;
  font-family: inherit;
  font-size: 12.5px;
  cursor: pointer;
  transition: background $transition-fast;
  user-select: none;
  outline: none;
  width: 100%;
  box-sizing: border-box;
  border-bottom: 1px solid $border-light;
}

.list-rows > .list-row:last-child {
  border-bottom: none;
}

.list-row:hover {
  background: var(--theme-card-bg, var(--bg-card));
}

.list-row.active {
  background: rgba(var(--accent-info-rgb), 0.12);
  color: var(--accent-info);
}

.list-row:focus-visible {
  background: rgba(var(--accent-info-rgb), 0.08);
  box-shadow: inset 2px 0 0 var(--accent-info);
}

.list-row--head {
  background: var(--theme-card-bg, var(--bg-card));
  color: $text-muted;
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  cursor: default;
  border-bottom: 1px solid $border-light;
  position: sticky;
  top: 0;
  z-index: 1;

  &:hover {
    background: var(--theme-card-bg, var(--bg-card));
  }
}

.col-name {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.row-icon {
  flex: 0 0 auto;
  color: $text-muted;
}

.list-row.active .row-icon {
  color: var(--accent-info);
}

.row-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.col-size {
  color: $text-muted;
  font-variant-numeric: tabular-nums;
  text-align: right;
  white-space: nowrap;
  font-feature-settings: 'tnum';
}

.col-modified {
  color: $text-muted;
  text-align: right;
  white-space: nowrap;
  font-variant-numeric: tabular-nums;
}

.list-empty {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px 16px;
  min-height: 200px;
}

.grid-tiles {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(110px, 1fr));
  gap: 12px;
  padding: 16px;
}

.grid-tile {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  padding: 14px 8px;
  border: 1px solid transparent;
  background: transparent;
  border-radius: $radius-sm;
  color: $text-primary;
  font-family: inherit;
  cursor: pointer;
  transition: background $transition-fast, border-color $transition-fast;
  outline: none;

  &:hover {
    background: var(--theme-card-bg, var(--bg-card));
    border-color: $border-light;
  }

  &.active {
    background: rgba(var(--accent-info-rgb), 0.12);
    border-color: rgba(var(--accent-info-rgb), 0.4);
  }
}

.tile-icon {
  color: var(--accent-info);
}

.grid-tile.active .tile-icon {
  color: var(--accent-info);
}

.tile-name {
  font-size: 12.5px;
  text-align: center;
  word-break: break-word;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.tile-meta {
  font-size: 11px;
  color: $text-muted;
}

@media (max-width: $breakpoint-mobile) {
  .list-row {
    grid-template-columns: minmax(0, 1fr) 90px !important;
    gap: 12px;
  }
  .col-modified {
    display: none;
  }
  .list-row--head .col-modified {
    display: none;
  }
}
</style>