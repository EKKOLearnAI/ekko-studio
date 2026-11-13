<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { NSelect } from 'naive-ui'
import { switchLocale } from '@/i18n'
import { languageOptions } from '@/i18n/language-options'

withDefaults(defineProps<{
  size?: 'tiny' | 'small' | 'medium' | 'large'
}>(), {
  size: 'tiny',
})

const { locale } = useI18n()

async function handleChange(val: string) {
  await switchLocale(val)
}
</script>

<template>
  <NSelect
    :value="locale"
    :options="languageOptions"
    :size="size"
    :consistent-menu-width="false"
    class="language-switch input-sm"
    @update:value="handleChange"
  />
</template>
