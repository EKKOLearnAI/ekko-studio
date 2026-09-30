<script setup lang="ts">
import PageLoading from '@/components/common/PageLoading.vue'
import PageHeader from '@/components/layout/PageHeader.vue'
import { computed, defineAsyncComponent, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useDialog } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import { useFilesStore } from '@/stores/hermes/files'
import { useProfilesStore } from '@/stores/hermes/profiles'
import FileTree from '@/components/hermes/files/FileTree.vue'
import FileBreadcrumb from '@/components/hermes/files/FileBreadcrumb.vue'
import FileToolbar from '@/components/hermes/files/FileToolbar.vue'
import FileList from '@/components/hermes/files/FileList.vue'
import FileContextMenu from '@/components/hermes/files/FileContextMenu.vue'
import FileUploadModal from '@/components/hermes/files/FileUploadModal.vue'
import FileRenameModal from '@/components/hermes/files/FileRenameModal.vue'
import type { FileEntry } from '@/api/studio/files'

const FileEditor = defineAsyncComponent(async () => (await import('@/components/hermes/files/FileEditor.vue')).default)
const FilePreview = defineAsyncComponent(async () => (await import('@/components/hermes/files/FilePreview.vue')).default)

const filesStore = useFilesStore()
const profilesStore = useProfilesStore()
const route = useRoute()
const router = useRouter()
const dialog = useDialog()
const { t } = useI18n()

const contextMenuRef = ref<InstanceType<typeof FileContextMenu> | null>(null)
const showUpload = ref(false)
const showRenameModal = ref(false)
const renameMode = ref<'newFile' | 'newFolder' | 'rename'>('newFile')
const renameEntry = ref<FileEntry | null>(null)
const renameTargetPath = ref<string | null>(null)
const scopedProfile = computed(() => firstQueryString(route.query.profile))
const routeFilePath = computed(() => firstQueryString(route.query.file))
const isProfileConfigEditor = computed(() => !!scopedProfile.value && routeFilePath.value === 'config.yaml')
const profileConfigTitle = computed(() =>
  scopedProfile.value ? `${scopedProfile.value} / config.yaml` : 'config.yaml',
)

function handleContextMenu(e: MouseEvent, entry: FileEntry) {
  contextMenuRef.value?.show(e, entry)
}

function handleShowNewFile() {
  renameMode.value = 'newFile'
  renameEntry.value = null
  renameTargetPath.value = null
  showRenameModal.value = true
}

function handleShowNewFolder() {
  renameMode.value = 'newFolder'
  renameEntry.value = null
  renameTargetPath.value = null
  showRenameModal.value = true
}

function handleContextNewFolder(entry: FileEntry) {
  renameMode.value = 'newFolder'
  renameEntry.value = null
  renameTargetPath.value = entry.isDir ? entry.path : filesStore.currentPath
  showRenameModal.value = true
}

function handleRename(entry: FileEntry) {
  renameMode.value = 'rename'
  renameEntry.value = entry
  renameTargetPath.value = null
  showRenameModal.value = true
}

function firstQueryString(value: unknown): string | null {
  const raw = Array.isArray(value) ? value[0] : value
  return typeof raw === 'string' && raw.trim() ? raw.trim() : null
}

function parentDir(filePath: string): string {
  const lastSlash = filePath.lastIndexOf('/')
  return lastSlash > 0 ? filePath.slice(0, lastSlash) : ''
}

async function ensureProfilesLoaded() {
  if (!profilesStore.activeProfileName || profilesStore.profiles.length === 0) {
    await profilesStore.fetchProfiles()
  }
}

const initializing = ref(true)
let loadGeneration = 0

async function loadFromRoute() {
  const generation = ++loadGeneration
  initializing.value = true
  try {
    await ensureProfilesLoaded()

    const profile = scopedProfile.value
    const filePath = routeFilePath.value
    const directoryPath = filePath
      ? parentDir(filePath)
      : (firstQueryString(route.query.path) || '')

    if (!isProfileConfigEditor.value) {
      await filesStore.fetchEntries(directoryPath, {
        profile,
        workspaceSessionId: null,
        workspaceRoomId: null,
      })
    }

    if (filePath) {
      await filesStore.openEditor(filePath, { profile })
    }
  } finally {
    if (generation === loadGeneration) initializing.value = false
  }
}

function closeProfileConfigEditor() {
  const close = () => {
    filesStore.closeEditor()
    void router.push({ name: 'hermes.profiles' })
  }

  if (filesStore.hasUnsavedChanges) {
    dialog.warning({
      title: t('files.unsavedChanges'),
      positiveText: t('common.ok'),
      negativeText: t('common.cancel'),
      onPositiveClick: close,
    })
    return
  }

  close()
}

watch(
  [() => route.query.profile, () => route.query.path, () => route.query.file],
  () => {
    void loadFromRoute()
  },
  { immediate: true },
)
</script>

<template>
  <PageLoading :show="initializing" class="files-view" :class="{ 'profile-config-editor-view': isProfileConfigEditor }">
    <template v-if="isProfileConfigEditor">
      <PageHeader>
      <div class="profile-config-editor-header">
        <div class="profile-config-title">
          <span class="profile-config-eyebrow">{{ t('profiles.editConfig') }}</span>
          <span class="profile-config-file">{{ profileConfigTitle }}</span>
        </div>
      </div>
      </PageHeader>
      <div class="profile-config-editor-content">
        <FileEditor v-if="filesStore.editingFile" :custom-close="closeProfileConfigEditor" />
      </div>
    </template>
    <FilePreview v-else-if="filesStore.previewFile" />
    <template v-else>
      <div class="files-tree-panel">
        <FileTree :profile="scopedProfile" />
      </div>
      <div class="files-main-panel">
        <PageHeader>
        <FileToolbar
          @show-new-file="handleShowNewFile"
          @show-new-folder="handleShowNewFolder"
          @show-upload="showUpload = true"
        />
        </PageHeader>
        <FileBreadcrumb />
        <div class="files-content">
          <FileEditor v-if="filesStore.editingFile" />
          <FileList v-else @contextmenu-entry="handleContextMenu" />
        </div>
      </div>
    </template>
    <FileContextMenu
      ref="contextMenuRef"
      @rename="handleRename"
      @new-folder="handleContextNewFolder"
    />
    <FileUploadModal v-model:show="showUpload" />
    <FileRenameModal
      v-model:show="showRenameModal"
      :mode="renameMode"
      :entry="renameEntry"
      :target-path="renameTargetPath"
    />
  </PageLoading>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;

.files-view {
  display: flex;
  height: 100%;
  overflow: hidden;
}

.profile-config-editor-view {
  flex-direction: column;
}

.profile-config-editor-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 12px 16px;
  border-bottom: 1px solid $border-color;
  background-color: $bg-card;
}

.profile-config-title {
  display: flex;
  flex-direction: column;
  min-width: 0;
  gap: 2px;
}

.profile-config-eyebrow {
  font-size: 12px;
  color: $text-secondary;
}

.profile-config-file {
  font-size: 14px;
  font-weight: 600;
  color: $text-primary;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.profile-config-editor-content {
  flex: 1;
  min-height: 0;
  overflow: hidden;
}

.files-tree-panel {
  width: 240px;
  min-width: 180px;
  max-width: 400px;
  border-inline-end: 1px solid $border-color;
  overflow-y: auto;
  flex-shrink: 0;
}

.files-main-panel {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-width: 0;
  overflow: hidden;
}

.files-content {
  flex: 1;
  overflow-y: auto;
  min-height: 0;
}

@media (max-width: $breakpoint-mobile) {
  .files-view {
    flex-direction: column;
  }

  .files-tree-panel {
    width: 100%;
    max-width: none;
    height: 200px;
    border-inline-end: none;
    border-bottom: 1px solid $border-color;
  }
}
</style>
