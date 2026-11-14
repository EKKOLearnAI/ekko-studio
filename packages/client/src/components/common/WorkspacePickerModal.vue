<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { NAlert, NButton, NModal, NSpin, useMessage } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import FolderPicker from '@/components/hermes/chat/FolderPicker.vue'
import StarIcon from '@/components/common/StarIcon.vue'
import { useDefaultWorkspace } from '@/composables/useDefaultWorkspace'

const props = defineProps<{ current?: string; title: string }>()
const emit = defineEmits<{ select: [workspace: string]; cancel: [] }>()
const { t } = useI18n(), message = useMessage()
const workspace = ref<string | null>(props.current || '')
const directories = useDefaultWorkspace()
const { defaultWorkspaces, recentWorkspaces } = directories
const loading = ref(false), failed = ref(false)
const favorite = computed(() => Boolean(workspace.value && directories.isDefaultWorkspace(workspace.value)))
const valid = computed(() => Boolean(workspace.value?.trim() && workspace.value.length <= 4096 && !workspace.value.includes('\0')))
const folderName = (path: string) => path.replace(/\\/g, '/').split('/').filter(Boolean).pop() || path

async function loadDirectories() {
  loading.value = true; failed.value = false
  try { await directories.init() }
  catch { failed.value = true }
  finally { loading.value = false }
}
async function toggleFavorite() {
  if (!valid.value) return
  try { await directories.toggleDefaultWorkspace(workspace.value!.trim()) }
  catch { message.error(t('chat.workspaceSetFailed')) }
}
function confirm() {
  if (!valid.value) return false
  const path = workspace.value!.trim()
  void directories.recordWorkspaceUsage(path).catch(() => message.error(t('chat.workspaceSetFailed')))
  emit('select', path)
}
onMounted(loadDirectories)
</script>

<template>
  <NModal :show="true" preset="dialog" class="workspace-picker-modal" :title="title" :aria-label="title"
    :positive-text="t('common.ok')" :negative-text="t('common.cancel')"
    :positive-button-props="{ type: 'primary', disabled: !valid }" style="width: var(--studio-workspace-picker-width)"
    @positive-click="confirm" @negative-click="emit('cancel')" @update:show="show => { if (!show) emit('cancel') }">
    <div class="workspace-picker-content">
      <NAlert v-if="failed" type="error" :show-icon="false">{{ t('chat.workspaceSetFailed') }}
        <NButton text @click="loadDirectories">{{ t('common.retry') }}</NButton>
      </NAlert>
      <NSpin v-if="loading" size="small" />
      <div v-if="defaultWorkspaces.length" class="workspace-shortcuts" :aria-label="t('chat.favoriteWorkspaces')" role="group">
        <span>{{ t('chat.favoriteWorkspaces') }}:</span>
        <NButton v-for="path in defaultWorkspaces" :key="path" size="tiny" :title="path"
          :type="workspace === path ? 'primary' : 'default'" @click="workspace = path">{{ folderName(path) }}</NButton>
      </div>
      <FolderPicker v-model="workspace" data-theme-surface="card" show-favorite :favorite="favorite" :favorite-disabled="!valid"
        :remember-selection="false" :favorite-title="favorite ? t('chat.workspaceUnfavorite') : t('chat.workspaceFavorite')"
        @toggle-favorite="toggleFavorite" />
      <div v-if="recentWorkspaces.length" class="workspace-shortcuts" :aria-label="t('chat.workspaceRecent')" role="group">
        <span>{{ t('chat.workspaceRecent') }}:</span>
        <NButton v-for="entry in recentWorkspaces" :key="entry.path" size="tiny" :title="entry.path"
          :type="workspace === entry.path ? 'primary' : 'default'" @click="workspace = entry.path">
          <template v-if="directories.isDefaultWorkspace(entry.path)" #icon><StarIcon filled width="14" height="14" /></template>
          {{ folderName(entry.path) }}
        </NButton>
      </div>
    </div>
  </NModal>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;
.workspace-picker-content { display: flex; flex-direction: column; gap: calc(12px * var(--spacing-scale, 1)); max-height: 65vh; overflow-y: auto; }
.workspace-shortcuts { display: flex; align-items: center; flex-wrap: wrap; gap: calc(6px * var(--spacing-scale, 1)); min-width: 0; color: $text-secondary; }
.workspace-shortcuts :deep(.n-button__content) { max-width: min(200px, 60vw); overflow: hidden; text-overflow: ellipsis; }
</style>
