<script setup lang="ts">
import { ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { NAlert, NButton, NForm, NFormItem, NInput } from 'naive-ui'
import { personRequest, type PersonProject } from '@/api/person'
const props = defineProps<{ projects: PersonProject[] }>()
const emit = defineEmits<{ saved: [] }>()
const { t } = useI18n()
const editing = ref(false), saving = ref(false), error = ref('')
const blank = () => ({ id: undefined as string | undefined, name: '', workspace: '', repository: '', worktree_root: '', instructions: '', expected_revision: 0 })
const draft = ref(blank())
function edit(project?: PersonProject) { draft.value = project ? { ...project, expected_revision: project.revision } : blank(); editing.value = true; error.value = '' }
async function save() {
  saving.value = true; error.value = ''
  try { await personRequest('/projects', draft.value, 'PUT'); editing.value = false; emit('saved') }
  catch (e) { error.value = String(e) }
  finally { saving.value = false }
}
</script>

<template>
  <section class="person-panel">
    <header class="panel-heading"><div><h2>{{ t('person.projects') }}</h2><p>{{ t('person.projectsHint') }}</p></div><NButton v-if="!editing" secondary @click="edit()">{{ t('person.newProject') }}</NButton></header>
    <NAlert v-if="error" type="error">{{ error }}</NAlert>
    <NForm v-if="editing" label-placement="top" :disabled="saving" @submit.prevent="save">
      <NFormItem :label="t('person.projectName')"><NInput v-model:value="draft.name" :maxlength="100" :input-props="{ 'aria-label': t('person.projectName') }" /></NFormItem>
      <NFormItem :label="t('person.projectWorkspace')"><NInput v-model:value="draft.workspace" :input-props="{ 'aria-label': t('person.projectWorkspace') }" /></NFormItem>
      <NFormItem :label="t('person.projectRepository')"><NInput v-model:value="draft.repository" :input-props="{ 'aria-label': t('person.projectRepository') }" /></NFormItem>
      <NFormItem :label="t('person.projectWorktrees')"><NInput v-model:value="draft.worktree_root" :input-props="{ 'aria-label': t('person.projectWorktrees') }" /></NFormItem>
      <NFormItem :label="t('person.projectInstructions')"><NInput v-model:value="draft.instructions" type="textarea" :autosize="{ minRows: 4, maxRows: 12 }" :maxlength="8000" :input-props="{ 'aria-label': t('person.projectInstructions') }" /></NFormItem>
      <div class="editor-actions"><NButton :disabled="saving" @click="editing = false">{{ t('common.cancel') }}</NButton><NButton type="primary" attr-type="submit" :loading="saving" :disabled="saving || !draft.name.trim() || !draft.workspace.trim()">{{ t('common.save') }}</NButton></div>
    </NForm>
    <div v-else-if="props.projects.length" class="panel-grid">
      <article v-for="project in props.projects" :key="project.id" class="panel-tile" data-theme-surface="card">
        <h3>{{ project.name }}</h3><p class="project-path">{{ project.workspace }}</p><p class="project-instructions">{{ project.instructions }}</p>
        <footer class="tile-footer"><NButton secondary size="small" @click="edit(project)">{{ t('common.edit') }}</NButton></footer>
      </article>
    </div>
    <p v-else class="panel-empty">{{ t('person.empty') }}</p>
  </section>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;
@use './person-panels';
.project-path { overflow-wrap: anywhere; color: $text-secondary; font-size: 12px; }
.project-instructions { white-space: pre-wrap; overflow-wrap: anywhere; line-height: 1.7; }
</style>
