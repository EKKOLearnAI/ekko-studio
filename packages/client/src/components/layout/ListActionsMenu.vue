<script setup lang="ts">
import { computed, h, ref } from 'vue'
import { NDropdown, type DropdownOption } from 'naive-ui'
import { useI18n } from 'vue-i18n'

const props = defineProps<{
  label: string
  profiles?: Array<{ name: string }>
  profile?: string | null
  loading?: boolean
  batchMode: boolean
  batchDisabled?: boolean
}>()
const emit = defineEmits<{
  filter: [profile: string | null]
  batch: []
}>()
const { t } = useI18n()
const show = ref(false)

function profileOption(name: string | null): DropdownOption {
  return {
    key: name === null ? 'all' : `profile:${name}`,
    label: name ?? t('chat.allProfiles'),
    icon: () => h('span', { 'aria-hidden': 'true' }, name === props.profile ? '✓' : ''),
  }
}

const options = computed<DropdownOption[]>(() => {
  const items: DropdownOption[] = []
  if (props.profiles) {
    items.push(
      {
        key: 'profiles',
        label: t('chat.filterByProfile'),
        disabled: props.loading || props.batchMode,
        children: [profileOption(null), ...props.profiles.map(profile => profileOption(profile.name))],
      },
      { type: 'divider', key: 'divider' },
    )
  }
  items.push({ key: 'batch', label: t('chat.toggleBatchMode'), disabled: props.batchMode || props.batchDisabled })
  return items
})

function select(key: string) {
  show.value = false
  if (key === 'batch') emit('batch')
  else if (key === 'all') emit('filter', null)
  else if (key.startsWith('profile:')) emit('filter', key.slice('profile:'.length))
}
</script>

<template>
  <NDropdown v-model:show="show" trigger="click" placement="bottom-end" :options="options" @select="select">
    <button
      class="list-actions-menu-trigger"
      type="button"
      :title="label"
      :aria-label="label"
      aria-haspopup="menu"
      :aria-expanded="show"
      @keydown.down.prevent="show = true"
      @keydown.esc="show = false"
    >
      <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
        <circle cx="5" cy="12" r="1.6" />
        <circle cx="12" cy="12" r="1.6" />
        <circle cx="19" cy="12" r="1.6" />
      </svg>
    </button>
  </NDropdown>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;

.list-actions-menu-trigger {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 34px;
  padding: 0;
  border: 0;
  border-radius: $radius-sm;
  background: transparent;
  color: $text-secondary;
  cursor: pointer;

  &:hover,
  &[aria-expanded='true'] { background: rgba(var(--accent-primary-rgb), 0.06); color: $text-primary; }
  &:focus-visible { outline: 2px solid $accent-primary; outline-offset: -2px; }
}
</style>
