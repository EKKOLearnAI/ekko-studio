<script setup lang="ts">
import { ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { NAlert, NButton, NEmpty, NInput, NPopconfirm, NTag } from 'naive-ui'
import { changeWebPlugins, type DshWebPackages } from '@/api/coding-agents/dsh'
const props = defineProps<{ web: DshWebPackages }>()
const emit = defineEmits<{ changed: [] }>()
const { t } = useI18n()
const spec = ref('')
const busy = ref(false)
const error = ref('')
async function change(body: { action: 'install'; packageSpec: string } | { action: 'remove'; packageName: string }) {
  busy.value = true; error.value = ''
  try { await changeWebPlugins(body, props.web.revision); if (body.action === 'install') spec.value = '' }
  catch (err: any) { error.value = t(err?.code === 'DSH_REVISION_CHANGED' ? 'dshPlugins.conflict' : 'dshPlugins.nativeOperationFailed') }
  finally { busy.value = false; emit('changed') }
}
</script>
<template>
  <section class="web-packages" data-testid="dsh-web-packages">
    <h3>{{ t('dshPlugins.webPackages') }} <NTag size="small">{{ web.packages.length }}</NTag></h3>
    <form class="install-row" @submit.prevent="change({ action: 'install', packageSpec: spec.trim() })">
      <NInput v-model:value="spec" :disabled="busy" placeholder="@scope/plugin@1.2.3" :input-props="{ 'aria-label': t('dshPlugins.packageSpec') }" />
      <NButton attr-type="submit" type="primary" :loading="busy" :disabled="!spec.trim()">{{ t('dshPlugins.install') }}</NButton>
    </form>
    <p class="hint">{{ t('dshPlugins.webInstallHint') }}</p>
    <NAlert v-if="error" type="error">{{ error }}</NAlert>
    <div v-if="web.packages.length" class="plugins-table-wrap"><table class="plugins-table"><thead><tr><th>{{ t('plugins.table.plugin') }}</th><th>{{ t('dshPlugins.packageVersion') }}</th><th>{{ t('plugins.table.status') }}</th><th>{{ t('plugins.table.manage') }}</th></tr></thead><tbody>
      <tr v-for="pkg in web.packages" :key="pkg.name" data-testid="dsh-web-package"><td><div class="plugin-name"><strong>{{ pkg.title || pkg.name }}</strong><span v-if="pkg.description">{{ pkg.description }}</span><span>{{ pkg.requested }}</span></div></td><td>{{ pkg.version || '—' }}</td><td><NTag :type="pkg.error ? 'error' : 'info'" size="small">{{ t(pkg.error ? 'dshPlugins.missingDependency' : pkg.bundle ? 'dshPlugins.registeredBundle' : 'dshPlugins.dependency') }}</NTag></td><td><NPopconfirm @positive-click="change({ action: 'remove', packageName: pkg.name })"><template #trigger><NButton size="small" :disabled="busy">{{ t('dshPlugins.remove') }}</NButton></template>{{ t('dshPlugins.removeConfirm', { name: pkg.name }) }}</NPopconfirm></td></tr>
    </tbody></table></div>
    <NEmpty v-else :description="t('dshPlugins.noWebPackages')" />
  </section>
</template>
<style scoped lang="scss">
@use '@/styles/plugins-page' as plugins-page;
@include plugins-page.layout;
h3 { display: flex; gap: calc(10px * var(--spacing-scale, 1)); align-items: center; margin: 0 0 14px; }.install-row { display: flex; gap: calc(10px * var(--spacing-scale, 1)); }.hint { padding-block: calc(8px * var(--spacing-scale, 1)); font-size: calc(var(--font-size-base, 14px) * 12 / 14); opacity: .7; }.web-packages { margin-bottom: 24px; }
</style>
