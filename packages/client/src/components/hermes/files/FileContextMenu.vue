<script setup lang="ts">
import { ref, nextTick } from 'vue'
import { NDropdown, useMessage, useDialog } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import { useFilesStore, isTextFile, isPreviewableFile } from '@/stores/hermes/files'
import { downloadSessionWorkspaceFile } from '@/api/studio/sessions'
import { downloadGroupWorkspaceFile } from '@/api/studio/group-chat'
import { downloadFile } from '@/api/studio/download'
import type { FileEntry } from '@/api/studio/files'
import { copyToClipboard } from '@/utils/clipboard'
import { getClipboardPathForEntry } from '@/utils/file-path'

const { t } = useI18n()
const message = useMessage()
const dialog = useDialog()
const filesStore = useFilesStore()

const props = defineProps<{
  allowAttach?: boolean
}>()

const showMenu = ref(false)
const menuX = ref(0)
const menuY = ref(0)
const targetEntry = ref<FileEntry | null>(null)

const emit = defineEmits<{
  (e: 'attach', entry: FileEntry): void
  (e: 'rename', entry: FileEntry): void
  (e: 'newFolder', entry: FileEntry): void
}>()

function show(e: MouseEvent, entry: FileEntry) {
  targetEntry.value = entry
  menuX.value = e.clientX
  menuY.value = e.clientY
  showMenu.value = false
  nextTick(() => {
    showMenu.value = true
  })
}

function getOptions() {
  const entry = targetEntry.value
  if (!entry) return []
  const options: any[] = []

  if (entry.isDir) {
    options.push({ label: t('files.open'), key: 'open' })
  } else {
    if (props.allowAttach) {
      options.push({ label: t('files.attachToChat'), key: 'attach' })
    }
    if (isTextFile(entry.name)) {
      options.push({ label: t('files.edit'), key: 'edit' })
    }
    if (isPreviewableFile(entry.name)) {
      options.push({ label: t('files.preview'), key: 'preview' })
    }
    options.push({ label: t('files.download'), key: 'download' })
  }
  options.push({ type: 'divider', key: 'd1' })
  options.push({ label: t('files.copyPath'), key: 'copyPath' })
  options.push({ label: t('files.newFolder'), key: 'newFolder' })
  options.push({ label: t('files.rename'), key: 'rename' })
  options.push({ type: 'divider', key: 'd2' })
  options.push({ label: t('files.delete'), key: 'delete' })
  return options
}

async function handleSelect(key: string) {
  showMenu.value = false
  const entry = targetEntry.value
  if (!entry) return

  switch (key) {
    case 'attach':
      if (!entry.isDir && props.allowAttach) emit('attach', entry)
      break
    case 'open':
      filesStore.navigateTo(entry.path)
      break
    case 'edit':
      try { await filesStore.openEditor(entry.path) } catch { message.error(t('files.backendError')) }
      break
    case 'preview':
      try { await filesStore.openPreview(entry) } catch { message.error(t('files.backendError')) }
      break
    case 'download':
      if (entry.isDir) return
      try {
        if (filesStore.currentWorkspaceRoomId) await downloadGroupWorkspaceFile(filesStore.currentWorkspaceRoomId, entry.path, entry.name)
        else if (filesStore.currentWorkspaceSessionId) await downloadSessionWorkspaceFile(filesStore.currentWorkspaceSessionId, entry.path, entry.name)
        else await downloadFile(entry.path, entry.name, filesStore.currentProfile)
      } catch (err: any) { message.error(err.message) }
      break
    case 'copyPath': {
      const ok = await copyToClipboard(getClipboardPathForEntry(entry))
      if (ok) {
        message.success(t('files.pathCopied'))
      } else {
        message.error(t('files.pathCopied') + ' ✗')
      }
      break
    }
    case 'rename':
      emit('rename', entry)
      break
    case 'newFolder':
      emit('newFolder', entry)
      break
    case 'delete':
      dialog.warning({
        title: t('files.delete'),
        content: entry.isDir ? t('files.confirmDeleteDir', { name: entry.name }) : t('files.confirmDelete', { name: entry.name }),
        positiveText: t('common.delete'),
        negativeText: t('common.cancel'),
        onPositiveClick: async () => {
          try {
            await filesStore.deleteEntry(entry)
            message.success(t('files.deleted'))
          } catch {
            message.error(t('files.deleteFailed'))
          }
        },
      })
      break
  }
}

function handleClickOutside() {
  showMenu.value = false
}

defineExpose({ show })
</script>

<template>
  <NDropdown
    :show="showMenu"
    :x="menuX"
    :y="menuY"
    :options="getOptions()"
    placement="bottom-start"
    trigger="manual"
    @select="handleSelect"
    @clickoutside="handleClickOutside"
  />
</template>
