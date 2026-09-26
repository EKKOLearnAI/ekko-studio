<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { NButton, NInput, NSpin, NTag, useMessage } from 'naive-ui'
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

const route = useRoute()
const { t } = useI18n()
const message = useMessage()

const agentId = computed(() => String(route.params.agentId || ''))
const section = computed(() => String(route.params.section || 'settings'))

type SettingsEditor = 'preference' | 'configuration'

interface SettingsEditorState {
  file: CodingAgentConfigFileContent | null
  content: string
  saving: boolean
  error: string
}

const settingsKeys: Record<CodingAgentId, Record<SettingsEditor, string>> = {
  'claude-code': { preference: 'memory', configuration: 'settings' },
  codex: { preference: 'agents', configuration: 'config' },
  pi: { preference: 'agents', configuration: 'settings' },
  grok: { preference: 'agents', configuration: 'settings' },
  opencode: { preference: 'memory', configuration: 'settings' },
  dsh: { preference: 'memory', configuration: 'settings' },
  cursor: { preference: 'memory', configuration: 'settings' },
}

const skillTargets: Record<CodingAgentId, SkillTarget> = {
  'claude-code': 'claude',
  codex: 'codex',
  pi: 'pi',
  grok: 'grok',
  opencode: 'opencode',
  dsh: 'dsh',
  cursor: 'hermes',
}

const editorKinds: SettingsEditor[] = ['preference', 'configuration']
const editors = reactive<Record<SettingsEditor, SettingsEditorState>>({
  preference: { file: null, content: '', saving: false, error: '' },
  configuration: { file: null, content: '', saving: false, error: '' },
})
const loading = ref(false)
let loadVersion = 0

const validAgentId = computed<CodingAgentId | null>(() =>
  agentId.value in settingsKeys ? agentId.value as CodingAgentId : null,
)
const skillTarget = computed<SkillTarget>(() =>
  validAgentId.value ? skillTargets[validAgentId.value] : 'hermes',
)
const editorItems = computed(() => editorKinds.map(kind => ({
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
  if (!validAgentId.value || section.value !== 'settings' || validAgentId.value === 'cursor') {
    loading.value = false
    return
  }

  loading.value = true
  const currentAgentId = validAgentId.value
  const results = await Promise.allSettled(editorKinds.map(kind =>
    readCodingAgentConfigFile(currentAgentId, settingsKeys[currentAgentId][kind]),
  ))

  if (version !== loadVersion) return

  results.forEach((result, index) => {
    const state = editors[editorKinds[index]]
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
  if (!currentAgentId || state.saving) return

  state.saving = true
  try {
    const file = await writeCodingAgentConfigFile(
      currentAgentId,
      settingsKeys[currentAgentId][kind],
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

watch([agentId, section], loadSettingsFiles, { immediate: true })
</script>

<template>
  <div class="coding-agent-config-view">
    <header v-if="section === 'settings'" class="page-header">
      <h2 class="header-title">{{ t('sidebar.settings') }}</h2>
    </header>

    <DshPluginsPanel v-if="section === 'plugins' && validAgentId === 'dsh'" />
    <DshAgentPresetsPanel v-else-if="section === 'presets' && validAgentId === 'dsh'" />
    <div v-else-if="section === 'skills'" class="coding-agent-skills-content">
      <CodingAgentSkillsPanel :target="skillTarget" />
    </div>

    <div v-else-if="section === 'mcp' && validAgentId" class="coding-agent-mcp-content">
      <CodingAgentMcpPanel :agent-id="validAgentId" />
    </div>

    <div v-else-if="section === 'settings' && validAgentId === 'cursor'" class="coding-agent-settings-content">
      <p>{{ t('agentManager.cursorNoManagedConfig') }}</p>
    </div>
    <div v-else-if="section === 'settings' && validAgentId" class="coding-agent-settings-content">
      <NSpin v-if="loading" class="settings-loading" />
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
  </div>
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
  background: $bg-main-surface;
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
  padding: 20px;
  overflow: hidden;
}

.settings-loading {
  display: grid;
  height: 100%;
  place-content: center;
}

.settings-editors {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 16px;
  height: 100%;
  min-height: 0;
}

.settings-editor-panel {
  display: flex;
  min-width: 0;
  min-height: 0;
  flex-direction: column;
  padding: 16px;
  border: 1px solid $border-color;
  border-radius: 10px;
  background: $bg-card;
}

.editor-toolbar,
.editor-heading {
  display: flex;
  align-items: center;
  gap: 10px;
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
  font-size: 14px;
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
    padding: 12px;
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
