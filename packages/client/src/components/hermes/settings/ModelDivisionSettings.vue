<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { NButton, NSelect, NSpin, NEmpty, useMessage } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import WorkflowModelSelector from '@/components/hermes/workflow/WorkflowModelSelector.vue'
import { useModelsStore } from '@/stores/hermes/models'
import { updateDefaultModel } from '@/api/hermes/system'
import { fetchConfig, updateConfigSection } from '@/api/hermes/config'

const { t } = useI18n()
const message = useMessage()
const modelsStore = useModelsStore()

const mainProvider = ref('')
const mainModel = ref('')
const childProvider = ref('')
const childModel = ref('')
const savingMain = ref(false)
const savingChild = ref(false)
const childReasoning = ref<string | null>(null)

const reasoningEffortOptions = computed(() => [
  { label: t('chat.reasoningEffort.options.none'), value: 'none' },
  { label: t('chat.reasoningEffort.options.minimal'), value: 'minimal' },
  { label: t('chat.reasoningEffort.options.low'), value: 'low' },
  { label: t('chat.reasoningEffort.options.medium'), value: 'medium' },
  { label: t('chat.reasoningEffort.options.high'), value: 'high' },
  { label: t('chat.reasoningEffort.options.xhigh'), value: 'xhigh' },
  { label: t('chat.reasoningEffort.options.max'), value: 'max' },
  { label: t('chat.reasoningEffort.options.ultra'), value: 'ultra' },
])

onMounted(async () => {
  if (modelsStore.providers.length === 0) {
    await modelsStore.fetchProviders()
  }
  try {
    const cfg = await fetchConfig(['model', 'delegation'])
    mainProvider.value = cfg.model?.provider || ''
    mainModel.value = cfg.model?.default || ''
    childProvider.value = cfg.delegation?.provider || ''
    childModel.value = cfg.delegation?.model || ''
    childReasoning.value = cfg.delegation?.reasoning_effort || null
  } catch (e: any) {
    message.error(e?.message || t('settings.modelDivision.loadFailed'))
  }
})

async function saveMainModel() {
  if (!mainModel.value) {
    message.warning(t('settings.modelDivision.mainModelRequired'))
    return
  }
  savingMain.value = true
  try {
    await updateDefaultModel({ default: mainModel.value, provider: mainProvider.value || undefined })
    message.success(t('settings.modelDivision.saved'))
  } catch (e: any) {
    message.error(e?.message || t('settings.modelDivision.saveFailed'))
  } finally {
    savingMain.value = false
  }
}

async function saveChildModel() {
  if (!childModel.value) {
    message.warning(t('settings.modelDivision.childModelRequired'))
    return
  }
  savingChild.value = true
  try {
    await updateConfigSection('delegation', {
      model: childModel.value,
      provider: childProvider.value || undefined,
      reasoning_effort: childReasoning.value || undefined,
    })
    message.success(t('settings.modelDivision.saved'))
  } catch (e: any) {
    message.error(e?.message || t('settings.modelDivision.saveFailed'))
  } finally {
    savingChild.value = false
  }
}
</script>

<template>
  <section class="model-division-settings">
    <NSpin :show="modelsStore.loading">
      <div v-if="modelsStore.providers.length === 0" class="empty-hint">
        <NEmpty :description="t('settings.models.noProviders')" />
      </div>

      <div v-else class="division-cards">
        <!-- 主模型（指导/规划） -->
        <div class="division-card">
          <div class="division-card-header">
            <h4 class="division-title">{{ t('settings.modelDivision.mainTitle') }}</h4>
            <span class="role-badge leader">{{ t('settings.modelDivision.mainRole') }}</span>
          </div>
          <p class="division-desc">{{ t('settings.modelDivision.mainDesc') }}</p>
          <p class="division-hint">{{ t('settings.modelDivision.mainHint') }}</p>
          <div class="division-row">
            <WorkflowModelSelector
              :provider="mainProvider"
              :model="mainModel"
              :groups="modelsStore.providers"
              @select="({ provider, model }) => { mainProvider = provider; mainModel = model }"
            />
            <NButton type="primary" size="small" :loading="savingMain" @click="saveMainModel">
              {{ t('settings.modelDivision.save') }}
            </NButton>
          </div>
        </div>

        <!-- 子模型（执行/干活） -->
        <div class="division-card">
          <div class="division-card-header">
            <h4 class="division-title">{{ t('settings.modelDivision.childTitle') }}</h4>
            <span class="role-badge worker">{{ t('settings.modelDivision.childRole') }}</span>
          </div>
          <p class="division-desc">{{ t('settings.modelDivision.childDesc') }}</p>
          <div class="division-row">
            <WorkflowModelSelector
              :provider="childProvider"
              :model="childModel"
              :groups="modelsStore.providers"
              @select="({ provider, model }) => { childProvider = provider; childModel = model }"
            />
            <NButton type="primary" size="small" :loading="savingChild" @click="saveChildModel">
              {{ t('settings.modelDivision.save') }}
            </NButton>
          </div>
          <div class="division-row effort-row">
            <span class="effort-label">{{ t('settings.modelDivision.reasoningEffort') }}</span>
            <NSelect
              v-model:value="childReasoning"
              :options="reasoningEffortOptions"
              size="small"
              class="effort-select"
              clearable
              :placeholder="t('settings.modelDivision.reasoningInherit')"
            />
            <span class="effort-hint">{{ t('settings.modelDivision.reasoningHint') }}</span>
          </div>
        </div>
      </div>
    </NSpin>
  </section>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;

.model-division-settings {
  margin-top: 16px;
}

.empty-hint {
  padding: 40px 0;
}

.division-cards {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.division-card {
  border: 1px solid $border-color;
  border-radius: $radius-md;
  padding: 16px;
  background: $bg-card;
}

.division-card-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 6px;
}

.division-title {
  margin: 0;
  font-size: 14px;
  font-weight: 600;
  color: $text-primary;
}

.role-badge {
  font-size: 11px;
  padding: 2px 8px;
  border-radius: 10px;
  font-weight: 500;

  &.leader {
    background: rgba(var(--accent-primary-rgb), 0.12);
    color: $accent-primary;
  }

  &.worker {
    background: rgba(var(--success-rgb), 0.12);
    color: $success;
  }
}

.division-desc {
  margin: 0 0 12px;
  color: $text-secondary;
  font-size: 12px;
  line-height: 1.4;
}

.division-hint {
  margin: 0 0 12px;
  color: $text-muted;
  font-size: 11px;
  line-height: 1.4;
}

.division-row {
  display: flex;
  align-items: center;
  gap: 10px;

  .workflow-model-selector {
    flex: 1;
  }
}

.effort-row {
  margin-top: 10px;
  padding-top: 10px;
  border-top: 1px dashed $border-light;
}

.effort-label {
  flex-shrink: 0;
  color: $text-secondary;
  font-size: 12px;
}

.effort-select {
  width: 160px;
}

.effort-hint {
  color: $text-muted;
  font-size: 11px;
  line-height: 1.3;
}
</style>
