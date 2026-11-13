<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { NAlert, NButton, NModal } from 'naive-ui'
import { copyToClipboard } from '@/utils/clipboard'

const mode = defineModel<'create' | 'link' | null>('mode', { default: null })
const { t } = useI18n()
const copied = ref(false), copyFailed = ref(false)
const command = computed(() => mode.value === 'create'
  ? 'ekko-studio plugins create my-plugin ./my-plugin'
  : 'ekko-studio plugins link "/absolute/path/my-plugin"')
watch(mode, () => { copied.value = false; copyFailed.value = false })
async function copyCommand() {
  const value = command.value, success = await copyToClipboard(value)
  if (value === command.value) { copied.value = success; copyFailed.value = !success }
}
</script>

<template>
  <NModal :show="Boolean(mode)" preset="card" :title="t('studioPlugins.' + (mode === 'create' ? 'developCreate' : 'developLink'))"
    class="plugin-development-guide" style="width: min(600px, calc(100vw - 32px))" @update:show="value => { if (!value) mode = null }">
    <div class="guide-content">
      <p>{{ t('studioPlugins.developTerminal') }}</p>
      <section class="guide-step">
        <p>{{ t('studioPlugins.' + (mode === 'create' ? 'developCreateHint' : 'developLinkHint')) }}</p>
        <div class="guide-command">
          <pre><code>{{ command }}</code></pre>
          <NButton size="small" secondary @click="copyCommand">{{ t(copied ? 'common.copied' : 'common.copy') }}</NButton>
        </div>
        <NAlert v-if="copyFailed" type="error" role="alert">{{ t('chat.copyFailed') }}</NAlert>
        <p v-if="mode === 'create'" class="guide-note">{{ t('studioPlugins.developCreateContents') }}</p>
      </section>
      <section class="guide-step">
        <h3>{{ t('studioPlugins.developNext') }}</h3>
        <p>{{ t('studioPlugins.developNextHint') }}</p>
      </section>
      <p class="guide-note">{{ t('studioPlugins.developHomeHint') }}</p>
      <div class="guide-actions"><NButton @click="mode = null">{{ t('common.close') }}</NButton></div>
    </div>
  </NModal>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;
.guide-content { display: flex; flex-direction: column; gap: 20px; }
.guide-content p { margin: 0; color: $text-secondary; line-height: 1.7; overflow-wrap: anywhere; }
.guide-step { display: flex; flex-direction: column; gap: 12px; }
.guide-step h3 { margin: 0; color: $text-primary; font-size: 14px; font-weight: 600; }
.guide-command { display: flex; align-items: center; flex-wrap: wrap; gap: 12px; padding: 12px; border: 1px solid $border-color; border-radius: $radius-sm; }
.guide-command pre { flex: 1; min-width: 180px; margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; font-size: 12px; line-height: 1.7; color: $text-primary; }
.guide-note { font-size: 12px; }
.guide-actions { display: flex; justify-content: flex-end; }
</style>
