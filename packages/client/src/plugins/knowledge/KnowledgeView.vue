<script setup lang="ts">
/**
 * Knowledge plugin — container.
 *
 * Owns the shared state (useKnowledgeData / useKnowledgeSettings) so that
 * switching modes NEVER reloads or clears vault/document/health data — the
 * mode views are display-only branches below. First-run shows the skippable
 * mode picker; afterwards a slim status bar carries readiness, counts and
 * the mode switcher. Settings collapse behind the gear drawer except in
 * explorer mode, where the card stays fully expanded.
 */
import { computed, defineAsyncComponent, onMounted, ref, shallowRef } from 'vue'
import { useI18n } from 'vue-i18n'
import { NDrawer, NDrawerContent, NSpin } from 'naive-ui'
import type { KnowledgeDocument } from './api'
import { useKnowledgeData, type DocumentStatusFilter } from './composables/useKnowledgeData'
import { useKnowledgeSettings } from './composables/useKnowledgeSettings'
import { useKnowledgeMode } from './composables/useKnowledgeMode'
import KnowledgeSidebar from './components/KnowledgeSidebar.vue'
import KnowledgeSettingsCard from './components/KnowledgeSettingsCard.vue'
import ModeOnboarding from './components/ModeOnboarding.vue'
import KnowledgeStatusBar from './components/KnowledgeStatusBar.vue'

// Every mode view is an async chunk — the first screen only downloads the
// active mode (device budget: gzip < 500KB for the knowledge entry).
const TasksModeView = defineAsyncComponent(() => import('./components/modes/TasksModeView.vue'))
const ExplorerModeView = defineAsyncComponent(() => import('./components/modes/ExplorerModeView.vue'))
const LegalModeView = defineAsyncComponent(() => import('./components/modes/LegalModeView.vue'))
const LearningModeView = defineAsyncComponent(() => import('./components/modes/LearningModeView.vue'))
const BatchModeView = defineAsyncComponent(() => import('./components/modes/BatchModeView.vue'))
const KnowledgeDocumentDetail = defineAsyncComponent(() =>
  import('./components/KnowledgeDocumentDetail.vue').then(m => m.default),
)

const { t } = useI18n()

// --- Shared state (survives mode switches) --------------------------------
const data = useKnowledgeData()
const settings = useKnowledgeSettings()
const { mode, onboarded, setMode, skipOnboarding } = useKnowledgeMode()

// --- Local UI state ---------------------------------------------------------
const selectedDocument = shallowRef<KnowledgeDocument | null>(null)
const detailOpen = ref(false)
const settingsOpen = ref(false)

const statusFilterModel = computed<DocumentStatusFilter>({
  get: () => data.statusFilter.value,
  set: (v: DocumentStatusFilter) => data.setStatusFilter(v),
})

function onSelectDocument(doc: KnowledgeDocument): void {
  selectedDocument.value = doc
  detailOpen.value = true
}

function onDeleteDocument(id: number): void {
  void data.removeDocument(id)
  detailOpen.value = false
  selectedDocument.value = null
}

function goExplorer(): void {
  setMode('explorer')
}

onMounted(() => {
  void settings.load()
  void data.loadAll()
})
</script>

<template>
  <div class="knowledge-view">
    <ModeOnboarding
      v-if="!onboarded"
      @select="setMode"
      @skip="skipOnboarding"
    />

    <template v-else>
      <header class="page-header">
        <div class="header-text">
          <h2 class="header-title">{{ t('knowledge.title') }}</h2>
          <p class="header-subtitle">{{ t(`knowledge.modes.${mode}.desc`) }}</p>
        </div>
      </header>

      <KnowledgeStatusBar
        :health="data.health.value"
        :settings="settings.settings.value"
        :mode="mode"
        @set-mode="setMode"
        @open-settings="settingsOpen = true"
        @refresh="data.loadAll"
      />

      <NSpin :show="data.loading.value" class="workspace-spin">
        <div class="knowledge-workspace">
          <KnowledgeSidebar
            :vaults="data.vaults.value"
            :documents="data.documents.value"
            :selected-vault-id="data.selectedVaultId.value"
            @select-vault="data.selectVault"
          />

          <main class="knowledge-main">
            <TasksModeView
              v-if="mode === 'tasks'"
              :documents="data.documents.value"
              :health="data.health.value"
              :loading="data.loading.value"
              @select-document="onSelectDocument"
              @delete-document="onDeleteDocument"
              @go-explorer="goExplorer"
            />

            <ExplorerModeView
              v-else-if="mode === 'explorer'"
              :vaults="data.vaults.value"
              :documents="data.documents.value"
              :health="data.health.value"
              :loading="data.loading.value"
              :settings="settings.settings.value"
              :api-key-input="settings.apiKeyInput.value"
              :saving-key="settings.savingKey.value"
              :can-save="settings.canSave.value"
              :validation-error="settings.validationError.value"
              v-model:status-filter="statusFilterModel"
              @add-vault="(p: string, n: string) => data.addVault(p, n)"
              @delete-vault="(id: number, cascade: boolean) => data.removeVault(id, cascade)"
              @delete-document="onDeleteDocument"
              @select-document="onSelectDocument"
              @update:api-key-input="(v: string) => (settings.apiKeyInput.value = v)"
              @save-key="settings.save"
            />

            <LegalModeView v-else-if="mode === 'legal'" />
            <LearningModeView v-else-if="mode === 'learning'" />
            <BatchModeView v-else-if="mode === 'batch'" />
          </main>
        </div>
      </NSpin>

      <KnowledgeDocumentDetail
        v-model:show="detailOpen"
        :document="selectedDocument"
        @delete="onDeleteDocument"
        @indexed="() => void data.reloadDocuments()"
      />

      <NDrawer v-model:show="settingsOpen" :width="420" placement="right">
        <NDrawerContent :title="t('knowledge.settings.title')" closable>
          <KnowledgeSettingsCard
            :settings="settings.settings.value"
            :api-key-input="settings.apiKeyInput.value"
            :saving-key="settings.savingKey.value"
            :can-save="settings.canSave.value"
            :validation-error="settings.validationError.value"
            @update:api-key-input="(v: string) => (settings.apiKeyInput.value = v)"
            @save="settings.save"
          />
        </NDrawerContent>
      </NDrawer>
    </template>
  </div>
</template>

<style scoped>
.knowledge-view {
  padding: 16px 24px;
  height: 100%;
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.page-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.header-title {
  margin: 0 0 4px;
  font-size: 20px;
  font-weight: 600;
}
.header-subtitle {
  margin: 0;
  opacity: 0.6;
  font-size: 13px;
}
.workspace-spin {
  flex: 1;
  min-height: 0;
}
.workspace-spin :deep(.n-spin-container),
.workspace-spin :deep(.n-spin-content) {
  height: 100%;
}
.knowledge-workspace {
  display: flex;
  gap: 0;
  height: 100%;
  min-height: 0;
  border: 1px solid var(--border-color, rgba(var(--text-primary-rgb), 0.06));
  border-radius: 8px;
  overflow: hidden;
  background: var(--card-color, rgba(var(--text-primary-rgb), 0.02));
}
.knowledge-main {
  flex: 1;
  padding: 16px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 12px;
  min-width: 0;
}
</style>
