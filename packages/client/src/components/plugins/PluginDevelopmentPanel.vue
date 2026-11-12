<script setup lang="ts">
import { onBeforeUnmount, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { NAlert, NButton, NCollapse, NCollapseItem, NTag, useDialog } from 'naive-ui'
import { pluginList, pluginRequest } from '@/api/studio/plugins'

interface Project { id: string; directory: string; watching: boolean; status: string; error?: string }
const emit = defineEmits<{ changed: [] }>()
const { t } = useI18n(), dialog = useDialog()
const projects = ref<Project[]>([]), registry = ref(''), error = ref(''), busy = ref('')
const controller = new AbortController()
let timer: ReturnType<typeof setTimeout> | undefined
async function refresh() {
  try {
    const result = await pluginRequest<{ directory: string; projects: Project[] }>(undefined, '/development', undefined, 'GET', controller.signal)
    if (!controller.signal.aborted) { projects.value = result.projects || []; registry.value = result.directory || '' }
  } catch (cause) { if (!controller.signal.aborted) error.value = String(cause) }
}
async function poll() { await refresh(); if (!controller.signal.aborted) timer = setTimeout(poll, 2000) }
void poll()
onBeforeUnmount(() => { controller.abort(); if (timer) clearTimeout(timer) })
async function change(project: Project, start: boolean) {
  if (busy.value) return
  busy.value = project.id; error.value = ''
  try {
    const { revision } = await pluginList()
    await pluginRequest(undefined, '/' + encodeURIComponent(project.id) + (start ? '/development' : ''),
      start ? { revision, trusted: true } : { revision, action: 'stop-development' }, start ? 'POST' : 'PATCH')
    window.dispatchEvent(new Event('studio.plugins.changed')); emit('changed')
  } catch (cause) { error.value = cause instanceof Error ? cause.message : String(cause) }
  finally { busy.value = ''; await refresh() }
}
function start(project: Project) {
  dialog.warning({ title: t('studioPlugins.devStart'), content: t('studioPlugins.devTrust', { path: project.directory }),
    positiveText: t('studioPlugins.devStart'), negativeText: t('common.cancel'), onPositiveClick: () => change(project, true) })
}
</script>

<template>
  <section class="development-panel">
    <NCollapse>
      <NCollapseItem :title="`${t('studioPlugins.devProjects')} (${projects.length})`" name="development">
        <p>{{ t('studioPlugins.devHint') }}</p>
        <code>ekko-studio plugins create my-plugin</code>
        <p v-if="registry" class="development-path">{{ registry }}</p>
        <NAlert v-if="error" type="error" closable @close="error = ''">{{ error }}</NAlert>
        <article v-for="project in projects" :key="project.id" class="development-project">
          <div class="development-heading"><strong>{{ project.id }}</strong><NTag size="small">{{ t('studioPlugins.devState_' + project.status) }}</NTag></div>
          <p class="development-path">{{ project.directory }}</p>
          <NAlert v-if="project.error" type="error">{{ project.error }}</NAlert>
          <div class="development-actions">
            <NButton :disabled="!!busy || project.status === 'missing' || project.status === 'building'" :loading="busy === project.id" @click="start(project)">{{ t(project.watching ? 'studioPlugins.devRebuild' : 'studioPlugins.devStart') }}</NButton>
            <NButton v-if="project.watching" :disabled="!!busy" @click="change(project, false)">{{ t('studioPlugins.devStop') }}</NButton>
          </div>
        </article>
      </NCollapseItem>
    </NCollapse>
  </section>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;
.development-panel { padding: 16px 0; border-bottom: 1px solid $border-light; }
.development-project { padding: 12px 0; }
.development-heading, .development-actions { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; }
.development-actions { margin-top: 8px; }
.development-path { color: $text-secondary; overflow-wrap: anywhere; }
</style>
