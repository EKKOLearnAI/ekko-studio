<script setup lang="ts">
import PageLoading from '@/components/common/PageLoading.vue'
import PageHeader from '@/components/layout/PageHeader.vue'
import { computed, reactive, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { NButton, NInput, NTag, NSelect, NEmpty, NAlert, useMessage } from 'naive-ui'
import {
  readCodingAgentConfigFile,
  writeCodingAgentConfigFile,
  type CodingAgentConfigFileContent,
  type CodingAgentId,
} from '@/api/coding-agents'
import type { SkillTarget } from '@/api/hermes/skills'
import CodingAgentMcpPanel from '@/components/coding-agents/CodingAgentMcpPanel.vue'
import CodingAgentSkillsPanel from '@/components/coding-agents/CodingAgentSkillsPanel.vue'
import DshAgentPresetsPanel from '@/components/coding-agents/dsh/DshAgentPresetsPanel.vue'
import DshPluginsPanel from '@/components/coding-agents/dsh/DshPluginsPanel.vue'

import { useAgentResourceEditor } from '@/composables/useAgentResourceEditor'
const { t } = useI18n()
const message = useMessage()
const route = useRoute()
const resourceInstanceId = computed(() => typeof route.query.instance === 'string' ? route.query.instance : '')
const section = computed(() => String(route.params.section || 'settings'))
const resources = useAgentResourceEditor(resourceInstanceId, section)
const { catalog, loading: resourcesLoading, error: resourcesError, file: resourceFile,
  draft: resourceDraft, saving: resourceSaving, reading: resourceReading, selectedFile, fileOptions, skills: resourceSkills, dirty: resourceDirty } = resources
async function saveResourceFile() {
  try { await resources.save(); message.success(t('files.saveFile')) }
  catch (err: any) { message.error(err.message || String(err)) }
}

const agentId = computed(() => String(route.params.agentId || ''))

type SettingsEditor = 'preference' | 'configuration'

interface SettingsEditorState {
  file: CodingAgentConfigFileContent | null
  content: string
  saving: boolean
  error: string
}

const settingsKeys: Record<CodingAgentId, Partial<Record<SettingsEditor, string>>> = {
  'claude-code': { preference: 'memory', configuration: 'settings' },
  codex: { preference: 'agents', configuration: 'config' },
  pi: { preference: 'agents', configuration: 'settings' },
  grok: { preference: 'agents', configuration: 'settings' },
  opencode: { preference: 'memory', configuration: 'settings' },
  dsh: { preference: 'memory', configuration: 'settings' },
  cursor: { configuration: 'settings' },
  qwen: {},
  kimi: {},
  codebuddy: {},
  qoder: {},
  copilot: {},
  zcode: {},
  antigravity: { preference: 'memory', configuration: 'settings' },
}

const skillTargets: Partial<Record<CodingAgentId, SkillTarget>> = {
  'claude-code': 'claude',
  codex: 'codex',
  pi: 'pi',
  grok: 'grok',
  opencode: 'opencode',
  dsh: 'dsh',
  cursor: 'cursor',
  antigravity: 'antigravity',
}

const editorKinds: SettingsEditor[] = ['preference', 'configuration']
const editors = reactive<Record<SettingsEditor, SettingsEditorState>>({
  preference: { file: null, content: '', saving: false, error: '' },
  configuration: { file: null, content: '', saving: false, error: '' },
})
const loading = ref(true)
let loadVersion = 0

const validAgentId = computed<CodingAgentId | null>(() =>
  agentId.value in settingsKeys ? agentId.value as CodingAgentId : null,
)
const skillTarget = computed<SkillTarget>(() =>
  validAgentId.value ? skillTargets[validAgentId.value] || 'hermes' : 'hermes',
)
const activeEditorKinds = computed(() => editorKinds.filter(kind =>
  validAgentId.value && settingsKeys[validAgentId.value][kind],
))
const editorItems = computed(() => activeEditorKinds.value.map(kind => ({
  kind,
  label: t(`codingAgents.${kind}`),
  state: editors[kind],
})))

function resetEditors() {
  for (const kind of editorKinds) {
    editors[kind].file = null
    editors[kind].content = ''
    editors[kind].error = ''
  }
}

async function loadSettingsFiles() {
  const version = ++loadVersion
  resetEditors()
  if (resourceInstanceId.value || !validAgentId.value || section.value !== 'settings') {
    loading.value = false
    return
  }

  loading.value = true
  const currentAgentId = validAgentId.value
  const kinds = activeEditorKinds.value
  const results = await Promise.allSettled(kinds.map(kind =>
    readCodingAgentConfigFile(currentAgentId, settingsKeys[currentAgentId][kind]!),
  ))

  if (version !== loadVersion) return

  results.forEach((result, index) => {
    const state = editors[kinds[index]]
    if (result.status === 'fulfilled') {
      state.file = result.value
      state.content = result.value.content
      return
    }
    state.error = result.reason?.message || String(result.reason)
  })
  loading.value = false
}

async function saveSettingsFile(kind: SettingsEditor) {
  const currentAgentId = validAgentId.value
  const state = editors[kind]
  if (!currentAgentId || !settingsKeys[currentAgentId][kind] || state.saving) return

  state.saving = true
  try {
    const file = await writeCodingAgentConfigFile(
      currentAgentId,
      settingsKeys[currentAgentId][kind]!,
      state.content,
    )
    state.file = file
    state.content = file.content
    message.success(t('files.saveFile'))
  } catch (err: any) {
    message.error(err?.message || String(err))
  } finally {
    state.saving = false
  }
}

watch([agentId, section, resourceInstanceId], loadSettingsFiles, { immediate: true })
</script>

<template>
  <PageLoading :show="resourceInstanceId ? resourcesLoading : loading" class="coding-agent-config-view">
    <PageHeader>
    <header v-if="section === 'settings'" class="page-header">
      <h2 class="header-title">{{ t('sidebar.settings') }}</h2>
    </header>
    </PageHeader>

    <div v-if="resourceInstanceId" class="resource-toolbar">
      <NButton :disabled="resourceSaving || resourcesLoading" @click="resources.refresh">{{ t('codingAgents.refresh') }}</NButton>
    </div>
    <NAlert v-if="resourcesError" type="error" :bordered="false">{{ resourcesError }}</NAlert>

    <template v-if="resourceInstanceId">
      <div v-if="section === 'skills' && resourceSkills" class="coding-agent-skills-content" :inert="!!resourcesError || undefined">
        <CodingAgentSkillsPanel :key="`${resourceInstanceId}/${catalog?.snapshot}`" target="hermes" :resource-adapter="resourceSkills" />
      </div>
      <div v-else-if="section === 'settings' && catalog" class="coding-agent-settings-content">
        <div v-if="fileOptions.length" class="settings-editors">
          <section class="settings-editor-panel" data-theme-surface="card">
            <div class="editor-toolbar">
              <NSelect :value="selectedFile" :options="fileOptions" :disabled="resourceSaving || resourceReading" :aria-label="t('codingAgents.resourceFile')" @update:value="resources.selectFile" />
              <NButton type="primary" size="small" :loading="resourceSaving" :disabled="!resourceDirty || resourceFile?.readOnly || !!resourcesError || resourceReading" @click="saveResourceFile">{{ t('files.saveFile') }}</NButton>
            </div>
            <div class="resource-file-meta">
              <span>{{ resourceFile?.absolutePath }}</span>
              <NTag v-if="resourceFile?.readOnly" size="small">{{ t('codingAgents.resourceReadOnly') }}</NTag>
              <NTag v-if="resourceFile && !resourceFile.exists" size="small">{{ t('codingAgents.configFileNotCreated') }}</NTag>
            </div>
            <NInput v-model:value="resourceDraft" class="config-editor" type="textarea" :readonly="resourceFile?.readOnly || resourceSaving || !!resourcesError" :disabled="resourceReading || !resourceFile" :placeholder="resourceFile?.absolutePath" />
          </section>
        </div>
        <NEmpty v-else :description="t(catalog.configs ? 'codingAgents.resourcesEmpty' : 'codingAgents.resourcesUnsupported')" />
      </div>
      <NEmpty v-else-if="!resourcesLoading && !resourcesError" :description="t('codingAgents.resourcesUnsupported')" />
    </template>
    <DshPluginsPanel v-else-if="section === 'plugins' && validAgentId === 'dsh'" />
    <DshAgentPresetsPanel v-else-if="section === 'presets' && validAgentId === 'dsh'" />
    <div v-else-if="section === 'skills'" class="coding-agent-skills-content">
      <CodingAgentSkillsPanel :target="skillTarget" />
    </div>

    <div v-else-if="section === 'mcp' && validAgentId" class="coding-agent-mcp-content">
      <CodingAgentMcpPanel :agent-id="validAgentId" />
    </div>

    <div v-else-if="section === 'settings' && validAgentId" class="coding-agent-settings-content">
      <template v-if="loading" class="settings-loading" />
      <div v-else class="settings-editors">
        <section
          v-for="editor in editorItems"
          :key="editor.kind"
          class="settings-editor-panel"
        >
          <div class="editor-toolbar">
            <div class="editor-heading">
              <h3>{{ editor.label }}</h3>
              <NTag
                v-if="editor.state.file && !editor.state.file.exists"
                size="small"
                :bordered="false"
              >
                {{ t('codingAgents.configFileNotCreated') }}
              </NTag>
            </div>
            <NButton
              type="primary"
              size="small"
              :disabled="editor.state.content === (editor.state.file?.content || '') || !!editor.state.error"
              :loading="editor.state.saving"
              @click="saveSettingsFile(editor.kind)"
            >
              {{ t('files.saveFile') }}
            </NButton>
          </div>

          <div v-if="editor.state.error" class="config-error">
            <p>{{ editor.state.error }}</p>
            <NButton size="small" @click="loadSettingsFiles">{{ t('common.retry') }}</NButton>
          </div>
          <NInput
            v-else
            v-model:value="editor.state.content"
            class="config-editor"
            type="textarea"
            :placeholder="editor.state.file?.path"
          />
        </section>
      </div>
    </div>
  </PageLoading>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;

.coding-agent-config-view {
  display: flex;
  height: 100%;
  min-height: 0;
  min-width: 0;
  flex-direction: column;
  overflow: hidden;
  background: var(--theme-content-bg, $bg-main-surface);
}

.coding-agent-skills-content,
.coding-agent-mcp-content {
  flex: 1;
  min-height: 0;
  overflow: hidden;
}

.coding-agent-settings-content {
  flex: 1;
  min-height: 0;
  padding: calc(20px * var(--spacing-scale, 1));
  overflow: hidden;
}

.resource-toolbar {
  display: flex;
  flex-shrink: 0;
  gap: 12px;
  padding: 12px;
  .n-select { min-width: 0; }
}
.resource-file-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  overflow-wrap: anywhere;
  color: $text-muted;
  font-size: 12px;
  margin-bottom: 12px;
}

.settings-loading {
  display: grid;
  height: 100%;
  place-content: center;
}

.settings-editors {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: calc(16px * var(--spacing-scale, 1));
  height: 100%;
  min-height: 0;
}

.settings-editor-panel {
  &:only-child { grid-column: 1 / -1; }
  display: flex;
  min-width: 0;
  min-height: 0;
  flex-direction: column;
  padding: calc(16px * var(--spacing-scale, 1));
  border: var(--border-width, 1px) solid $border-color;
  border-radius: var(--radius-component, 10px);
  background: var(--theme-card-bg, $bg-card);
}

.editor-toolbar,
.editor-heading {
  display: flex;
  align-items: center;
  gap: calc(10px * var(--spacing-scale, 1));
}

.editor-toolbar {
  flex-shrink: 0;
  justify-content: space-between;
  margin-bottom: 12px;
}

.editor-heading {
  min-width: 0;
}

.editor-heading h3 {
  margin: 0;
  color: $text-primary;
  font-size: calc(var(--font-size-base, 14px) * 14 / 14);
  font-weight: 600;
}

.config-editor {
  flex: 1;
  width: 100%;
  min-height: 0;
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
}

.config-editor :deep(.n-input-wrapper),
.config-editor :deep(.n-input__textarea) {
  height: 100%;
}

.config-editor :deep(.n-input__textarea-el) {
  height: 100% !important;
  resize: none;
}

.config-error {
  display: grid;
  flex: 1;
  min-height: 0;
  place-content: center;
  justify-items: center;
  color: $text-muted;
  text-align: center;
}

@media (max-width: $breakpoint-mobile) {
  .coding-agent-settings-content {
    padding: calc(12px * var(--spacing-scale, 1));
    overflow-y: auto;
  }

  .settings-editors {
    grid-template-columns: 1fr;
    height: auto;
  }

  .settings-editor-panel {
    min-height: 420px;
  }
}
</style>
