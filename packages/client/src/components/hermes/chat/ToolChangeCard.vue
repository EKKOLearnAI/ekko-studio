<script setup lang="ts">
import { useI18n } from 'vue-i18n'

interface ToolChangeCardFile {
  id: string | number
  path: string
  additions: number
  deletions: number
}

const props = withDefaults(defineProps<{
  files: ToolChangeCardFile[]
  filesChanged?: number
  additions?: number
  deletions?: number
  expanded?: boolean
  selectedFileId?: string | number | null
  title?: string
}>(), {
  filesChanged: 0,
  additions: 0,
  deletions: 0,
  expanded: false,
  selectedFileId: null,
  title: '',
})

const emit = defineEmits<{
  toggle: []
  select: [file: ToolChangeCardFile]
}>()
const { t } = useI18n()

function fileNameFromPath(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() || path
}

function fileExtension(path: string): string {
  const name = fileNameFromPath(path)
  const index = name.lastIndexOf('.')
  if (index >= 0) return name.slice(index + 1).toLowerCase()
  const lower = name.toLowerCase()
  if (lower === 'dockerfile') return 'docker'
  if (lower === 'makefile') return 'make'
  return 'file'
}

function fileBadgeClass(path: string): string {
  const ext = fileExtension(path)
  if (['js', 'ts', 'jsx', 'tsx'].includes(ext)) return 'script'
  if (['py', 'rb', 'php'].includes(ext)) return 'dynamic'
  if (['java', 'kt', 'scala'].includes(ext)) return 'jvm'
  if (['rs', 'go', 'c', 'cc', 'cpp', 'h', 'hpp'].includes(ext)) return 'systems'
  if (['html', 'vue'].includes(ext)) return 'markup'
  if (['css', 'scss', 'sass', 'less'].includes(ext)) return 'style'
  if (['json', 'yaml', 'yml', 'toml', 'xml'].includes(ext)) return 'data'
  if (['md', 'mdx', 'txt'].includes(ext)) return 'doc'
  if (['sh', 'bash', 'zsh', 'fish', 'docker', 'make'].includes(ext)) return 'shell'
  return 'default'
}
</script>

<template>
  <div class="tool-change-card">
    <button
      class="tool-change-card-header"
      type="button"
      :aria-expanded="props.expanded"
      @click="emit('toggle')"
    >
      <svg
        width="12"
        height="12"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        class="tool-change-chevron"
        :class="{ rotated: props.expanded }"
      >
        <polyline points="9 18 15 12 9 6" />
      </svg>
      <span class="tool-change-card-title">
        {{ props.title || t('chat.changedFiles', { files: props.filesChanged || props.files.length }) }}
      </span>
      <span v-if="props.title" class="tool-change-card-file-count">
        {{ t('chat.changedFiles', { files: props.filesChanged || props.files.length }) }}
      </span>
      <span class="tool-change-card-stats">
        <span class="additions">+{{ props.additions }}</span>
        <span class="deletions">-{{ props.deletions }}</span>
      </span>
    </button>
    <div v-if="props.expanded" class="tool-change-files">
      <button
        v-for="file in props.files"
        :key="file.id"
        class="tool-change-file-row"
        :class="{ selected: props.selectedFileId === file.id }"
        type="button"
        @click="emit('select', file)"
      >
        <span class="tool-change-file-main">
          <span class="tool-change-file-badge" :class="fileBadgeClass(file.path)">
            {{ fileExtension(file.path) }}
          </span>
          <span class="tool-change-file-name" :title="file.path">
            {{ fileNameFromPath(file.path) }}
          </span>
        </span>
        <span class="tool-change-file-stats">
          <span class="additions">+{{ file.additions }}</span>
          <span class="deletions">-{{ file.deletions }}</span>
        </span>
      </button>
    </div>
  </div>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;

.tool-change-card {
  background: $bg-secondary;
  border: var(--border-width, 1px) solid $border-light;
  border-radius: var(--radius-component, 10px);
  color: $text-primary;
  display: grid;
  gap: calc(10px * var(--spacing-scale, 1));
  padding: calc(12px * var(--spacing-scale, 1)) calc(14px * var(--spacing-scale, 1));
  width: 100%;

  :global(.dark) & {
    background: #1f1f1f;
    border-color: rgba(255, 255, 255, 0.14);
    color: #f2f2f2;
  }
}

.tool-change-card-header {
  align-items: baseline;
  background: transparent;
  border: 0;
  color: inherit;
  cursor: pointer;
  display: flex;
  gap: calc(8px * var(--spacing-scale, 1));
  justify-content: flex-start;
  min-width: 0;
  padding: 0;
  text-align: start;
  width: 100%;
}

.tool-change-chevron {
  align-self: center;
  flex-shrink: 0;
  transition: transform 0.15s ease;

  &.rotated {
    transform: rotate(90deg);
  }
}

.tool-change-files {
  display: grid;
  gap: calc(10px * var(--spacing-scale, 1));
}

.tool-change-card-title {
  font-size: calc(var(--font-size-base, 14px) * 13 / 14);
  font-weight: 700;
}

.tool-change-card-file-count {
  color: $text-muted;
  font-size: calc(var(--font-size-base, 14px) * 12 / 14);
}

.tool-change-card-stats,
.tool-change-file-stats {
  display: inline-flex;
  flex-shrink: 0;
  font-family: var(--font-code, $font-code);
  font-size: calc(var(--font-size-base, 14px) * 12 / 14);
  gap: calc(6px * var(--spacing-scale, 1));

  .additions { color: #00e676; }
  .deletions { color: #ff3b58; }
}

.tool-change-file-row {
  align-items: center;
  background: transparent;
  border: 0;
  color: $text-primary;
  cursor: pointer;
  display: flex;
  gap: calc(12px * var(--spacing-scale, 1));
  justify-content: space-between;
  min-width: 0;
  padding: calc(4px * var(--spacing-scale, 1)) 0;
  text-align: start;

  &:hover,
  &.selected {
    .tool-change-file-name {
      color: $text-primary;
      text-decoration: underline;
      text-underline-offset: 3px;
    }
  }

  :global(.dark) & {
    color: #f2f2f2;

    &:hover,
    &.selected {
      .tool-change-file-name { color: #ffffff; }
    }
  }
}

.tool-change-file-main {
  align-items: center;
  display: inline-flex;
  gap: calc(8px * var(--spacing-scale, 1));
  min-width: 0;
}

.tool-change-file-badge {
  align-items: center;
  border-radius: var(--radius-component, 2px);
  display: inline-flex;
  flex: 0 0 13px;
  font-family: var(--font-code, $font-code);
  font-size: 7px;
  font-weight: 700;
  height: 13px;
  justify-content: center;
  line-height: var(--line-height, 1);
  overflow: hidden;
  text-transform: uppercase;
  width: 13px;

  &.script { background: #f7df1e; color: #1f1f1f; }
  &.dynamic { background: #3776ab; color: #ffffff; }
  &.jvm { background: #f0642f; color: #ffffff; }
  &.systems { background: #5e63b6; color: #ffffff; }
  &.markup { background: #e34f26; color: #ffffff; }
  &.style { background: #8b5cf6; color: #ffffff; }
  &.data { background: #64748b; color: #ffffff; }
  &.doc { background: #0f766e; color: #ffffff; }
  &.shell { background: #111827; color: #ffffff; }
  &.default { background: #6b7280; color: #ffffff; }
}

.tool-change-file-name {
  font-size: calc(var(--font-size-base, 14px) * 13 / 14);
  font-weight: 600;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
