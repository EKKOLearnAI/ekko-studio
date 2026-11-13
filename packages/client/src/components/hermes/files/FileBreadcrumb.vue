<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { NBreadcrumb, NBreadcrumbItem } from 'naive-ui'
import { useFilesStore } from '@/stores/hermes/files'

const { t } = useI18n()
const filesStore = useFilesStore()

function handleClick(index: number) {
  if (index < 0) {
    filesStore.navigateTo('')
  } else {
    const path = filesStore.pathSegments.slice(0, index + 1).join('/')
    filesStore.navigateTo(path)
  }
}
</script>

<template>
  <div class="file-breadcrumb">
    <NBreadcrumb>
      <NBreadcrumbItem @click="handleClick(-1)">
        {{ t('files.breadcrumbRoot') }}
      </NBreadcrumbItem>
      <NBreadcrumbItem
        v-for="(segment, index) in filesStore.pathSegments"
        :key="index"
        @click="handleClick(index)"
      >
        {{ segment }}
      </NBreadcrumbItem>
    </NBreadcrumb>
  </div>
</template>

<style scoped lang="scss">
.file-breadcrumb {
  padding: 0 calc(16px * var(--spacing-scale, 1));
}
</style>
