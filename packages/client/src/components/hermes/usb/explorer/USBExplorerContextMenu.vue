<script setup lang="ts">
import { computed } from 'vue'
import { NDropdown, type DropdownOption } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import type { USBFileEntry } from '@/api/studio/usb'

export type ContextMenuEntry = USBFileEntry

const props = defineProps<{
  show: boolean
  x: number
  y: number
  entry: ContextMenuEntry | null
  deviceLabel: string
  mountPoint: string
  agentReadEnabled: boolean
  agentReadBusy: boolean
}>()

const emit = defineEmits<{
  'update:show': [value: boolean]
  open: [entry: ContextMenuEntry]
  copyPath: [entry: ContextMenuEntry]
  copyName: [entry: ContextMenuEntry]
  download: [entry: ContextMenuEntry]
  readWithAgent: [entry: ContextMenuEntry]
  refresh: []
}>()

const { t } = useI18n()

const options = computed<DropdownOption[]>(() => {
  if (!props.entry) return []
  const entry = props.entry
  const items: DropdownOption[] = []
  if (entry.isDir) {
    items.push({
      key: 'open',
      label: t('usb.explorer.contextMenu.open'),
    })
    items.push({
      key: 'copy-folder',
      label: t('usb.explorer.contextMenu.copyFolderPath'),
    })
  } else {
    items.push({
      key: 'open',
      label: t('usb.explorer.contextMenu.openInNewTab'),
    })
    items.push({
      key: 'copy-absolute',
      label: t('usb.explorer.contextMenu.copyAbsolutePath'),
    })
    items.push({
      key: 'copy-name',
      label: t('usb.explorer.contextMenu.copyFileName'),
    })
    items.push({
      key: 'download',
      label: t('usb.explorer.contextMenu.download'),
    })
    items.push({
      key: 'read-with-agent',
      label: t('usb.explorer.contextMenu.readWithAgent'),
      disabled: !props.agentReadEnabled || props.agentReadBusy,
    })
  }
  items.push({ type: 'divider', key: 'd1' })
  items.push({
    key: 'refresh',
    label: t('usb.explorer.contextMenu.refresh'),
  })
  return items
})

function handleSelect(key: string | number) {
  if (!props.entry) return
  if (key === 'open') emit('open', props.entry)
  else if (key === 'copy-absolute' || key === 'copy-folder') emit('copyPath', props.entry)
  else if (key === 'copy-name') emit('copyName', props.entry)
  else if (key === 'download') emit('download', props.entry)
  else if (key === 'read-with-agent') emit('readWithAgent', props.entry)
  else if (key === 'refresh') emit('refresh')
  emit('update:show', false)
}
</script>

<template>
  <NDropdown
    placement="bottom-start"
    trigger="manual"
    :x="props.x"
    :y="props.y"
    :options="options"
    :show="props.show"
    @select="handleSelect"
    @clickoutside="emit('update:show', false)"
  />
</template>

<style scoped lang="scss">
/* No scoped styles; the NDropdown renders in a teleport overlay. */
</style>