<script setup lang="ts">
import { computed } from 'vue'
import { NSpin } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import LogoLoading from './LogoLoading.vue'

defineOptions({ inheritAttrs: false })

const props = withDefaults(defineProps<{
  show?: boolean
  size?: 'small' | 'medium' | 'large' | number
  description?: string
}>(), { show: true, size: 'medium' })

const { t } = useI18n()
const logoSize = computed(() => typeof props.size === 'number'
  ? props.size
  : { small: 24, medium: 48, large: 72 }[props.size])
</script>

<template>
  <NSpin
    v-if="show || $slots.default"
    v-bind="$attrs"
    class="studio-loading"
    :show="show"
    :size="logoSize"
    :rotate="false"
    :description="description"
    :aria-busy="$slots.default ? show : undefined"
  >
    <template #icon>
      <span class="studio-loading-status" role="status" :aria-label="description || t('common.loading')">
        <LogoLoading :size="logoSize" />
      </span>
    </template>
    <template v-if="$slots.default" #default><slot /></template>
    <template v-if="$slots.description" #description><slot name="description" /></template>
  </NSpin>
</template>

<style scoped>
.studio-loading-status {
  display: flex;
  width: 100%;
  height: 100%;
  line-height: 0;
}
</style>
