<script setup lang="ts">
import { NSelect, NTooltip } from 'naive-ui'
import { computed, onMounted, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useProfilesStore } from '@/stores/hermes/profiles'

// MCP/Skills 管理页顶部的“管理目标”profile 选择器。
// modelValue 为 null 表示跟随激活 profile；选中其他 profile 只影响当前
// 管理页的读写，不会真正切换激活 profile。
const props = defineProps<{
  modelValue: string | null
}>()

const emit = defineEmits<{
  'update:modelValue': [value: string | null]
}>()

const { t } = useI18n()
const profilesStore = useProfilesStore()

const options = computed(() => profilesStore.profiles.map(profile => ({
  label: profile.alias?.trim() || profile.name,
  value: profile.name,
})))

const selected = computed(() => props.modelValue || profilesStore.activeProfileName)

const differsFromActive = computed(() =>
  !!profilesStore.activeProfileName && selected.value !== profilesStore.activeProfileName,
)

const tooltip = computed(() => (differsFromActive.value
  ? t('profiles.scope.differsHint', { name: selected.value, active: profilesStore.activeProfileName })
  : t('profiles.scope.hint')))

function handleChange(value: unknown) {
  const name = typeof value === 'string' ? value : null
  // 选回激活 profile 时归一为 null，让请求回到全局 X-Hermes-Profile 头。
  emit('update:modelValue', name && name !== profilesStore.activeProfileName ? name : null)
}

onMounted(() => { void profilesStore.fetchProfiles() })

// 选中的 profile 被删除后回落到激活 profile。
watch(() => options.value.map(option => option.value), names => {
  if (props.modelValue && !names.includes(props.modelValue)) handleChange(null)
})
</script>

<template>
  <NTooltip v-if="options.length > 1" trigger="hover" placement="bottom-end" :delay="400">
    <template #trigger>
      <div class="profile-scope-select" role="group" :aria-label="t('profiles.scope.label')">
        <NSelect
          size="small"
          :value="selected"
          :options="options"
          :status="differsFromActive ? 'warning' : undefined"
          class="scope-select"
          @update:value="handleChange"
        />
      </div>
    </template>
    {{ tooltip }}
  </NTooltip>
</template>

<style scoped lang="scss">
.profile-scope-select {
  display: inline-flex;
  align-items: center;
  // 管理页 header 在窄窗口下有严格的不可裁剪约束，选择器必须可收缩
  flex: 0 1 112px;
  min-width: 72px;
}

.scope-select {
  width: 100%;
}
</style>
