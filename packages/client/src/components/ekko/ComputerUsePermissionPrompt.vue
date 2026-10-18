<script setup lang="ts">
import { computed, onBeforeUnmount } from 'vue'
import { useRouter } from 'vue-router'
import { NButton, NCard, NModal } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import { useComputerUsePermissionPrompt } from '@/composables/useComputerUsePermissionPrompt'

const { t } = useI18n()
const router = useRouter()
const { pending, dismiss } = useComputerUsePermissionPrompt()
const missing = computed(() => (['accessibility', 'screenRecording'] as const).filter(key =>
  pending.value?.supported && ['denied', 'not-determined', 'restricted'].includes(pending.value[key]),
))
function openGuide() {
  dismiss()
  void router.push({ path: '/ekko/settings', query: { tab: 'tools' } })
}
onBeforeUnmount(dismiss)
</script>

<template>
  <NModal :show="missing.length > 0" :mask-closable="false" @update:show="show => !show && dismiss()">
    <NCard class="permission-prompt" data-testid="computer-use-permission-prompt" role="dialog" aria-modal="true" aria-labelledby="computer-use-permission-title" :bordered="false">
      <template #header><span id="computer-use-permission-title">{{ t('computerUsePermissions.promptTitle') }}</span></template>
      <p>{{ t('computerUsePermissions.promptDescription') }}</p>
      <ul><li v-for="key in missing" :key="key">{{ t(`computerUsePermissions.${key}`) }}</li></ul>
      <p class="later-hint">{{ t('computerUsePermissions.promptLaterHint') }}</p>
      <template #footer>
        <div class="actions">
          <NButton data-testid="permission-prompt-later" @click="dismiss">{{ t('computerUsePermissions.promptLater') }}</NButton>
          <NButton type="primary" data-testid="permission-prompt-authorize" @click="openGuide">{{ t('computerUsePermissions.promptGo') }}</NButton>
        </div>
      </template>
    </NCard>
  </NModal>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;
.permission-prompt { width: min(460px, calc(100vw - 32px)); }
p { margin: 0; line-height: var(--line-height, 1.6); }
ul { margin: 16px 0; padding-inline-start: 22px; line-height: 1.8; }
.later-hint { color: $text-secondary; font-size: calc(var(--font-size-base, 14px) * 12 / 14); }
.actions { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 10px; }
</style>
