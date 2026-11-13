<script setup lang="ts">
import { computed, defineAsyncComponent, onMounted, ref, watch } from 'vue'
import { NButton, NInput, NInputNumber, NModal, NSelect } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import { useChatStore } from '@/stores/hermes/chat'
import { useRealtimeModelStore } from '@/stores/hermes/realtime-model'
import { fetchPracticeSkills, type PracticeSkillListItem } from '@/api/hermes/skills'
import { safeGetJSON, safeSetJSON } from '@/utils/safe-storage'
import { normalizePracticeSkill, resolveSkillLanguage, skillLanguageCodes, type PracticeSkillManifest } from '@/utils/practice-skill'
import type { PracticeSessionConfig } from '@/utils/practice-mode'
const OmniRealtimeStage = defineAsyncComponent(() => import('./OmniRealtimeStage.vue'))
const SpeechPracticeStage = defineAsyncComponent(() => import('./SpeechPracticeStage.vue'))
const props = defineProps<{ mode: 'omni' | 'practice' }>()
const emit = defineEmits<{ close: [] }>()
const { t } = useI18n()
const chat = useChatStore()
const realtime = useRealtimeModelStore()
const started = ref(false), saving = ref(false), error = ref('')
const key = () => `hermes_practice_config_v1:${chat.activeSessionId || ''}`
const defaultConfig: PracticeSessionConfig = { language: 'zh', direction: '', difficulty: 'intermediate', durationMinutes: 0 }
const storedConfig = safeGetJSON<PracticeSessionConfig | null>(key(), null)
const config = ref<PracticeSessionConfig>(storedConfig && ['zh', 'en', 'ja', 'ko'].includes(storedConfig.language) && ['beginner', 'intermediate', 'advanced'].includes(storedConfig.difficulty) ? { ...defaultConfig, ...storedConfig } : defaultConfig)
const model = ref(realtime.config.model), apiKey = ref(realtime.config.apiKey)
const skills = ref<PracticeSkillListItem[]>([]), skill = ref(config.value.skillRef ? `${config.value.skillRef.category}/${config.value.skillRef.name}` : '')
const selectedSkill = computed(() => {
  const entry = skills.value.find(item => `${item.category}/${item.name}` === skill.value)
  return entry ? normalizePracticeSkill({ ...entry, kind: 'skill' }, entry.manifest as PracticeSkillManifest) : null
})
const boundLanguages = computed(() => selectedSkill.value ? skillLanguageCodes(selectedSkill.value) : null)
watch(selectedSkill, selected => {
  const language = selected && resolveSkillLanguage(selected, config.value.language)
  if (language && ['zh', 'en', 'ja', 'ko'].includes(language)) config.value.language = language as PracticeSessionConfig['language']
})
const languageOptions = computed(() => ['zh', 'en', 'ja', 'ko'].filter(value => !boundLanguages.value || boundLanguages.value.includes(value)).map(value => ({ value, label: t(`speechPractice.lang.${value}`) })))
const difficultyOptions = computed(() => ['beginner', 'intermediate', 'advanced'].map((value, i) => ({ value, label: t(['speechPractice.diffBeginner', 'speechPractice.diffIntermediate', 'speechPractice.diffAdvanced'][i]) })))
const skillOptions = computed(() => [{ label: t('speechPractice.skillDefault'), value: '' }, ...skills.value.filter(item => item.enabled).map(item => ({ value: `${item.category}/${item.name}`, label: item.name }))])
const modelOptions = ['qwen3.8-omni-flash-realtime', 'qwen3.8-omni-plus-realtime'].map(value => ({ value, label: value }))
onMounted(async () => {
  await realtime.loadFromServer(null, { force: true })
  model.value = realtime.config.model
  apiKey.value = realtime.config.apiKey
  if (props.mode === 'practice') skills.value = await fetchPracticeSkills()
})
async function start() {
  saving.value = true; error.value = ''
  try {
    const saved = await realtime.updateConfig({ model: model.value, apiKey: apiKey.value.trim() })
    if (!saved.ok) { error.value = saved.error || t('models.realtimeSaveFailed'); return }
    if (!chat.activeSessionId) chat.newChat({ source: 'cli', agent: 'hermes' })
    if (props.mode === 'practice') {
      const selected = skills.value.find(item => `${item.category}/${item.name}` === skill.value)
      config.value.skillRef = selected ? { category: selected.category, name: selected.name } : undefined
      safeSetJSON(key(), config.value)
    }
    started.value = true
  } catch (cause) { error.value = cause instanceof Error ? cause.message : String(cause) }
  finally { saving.value = false }
}
</script>
<template>
  <NModal v-if="!started" :show="true" preset="card" class="local-realtime-config" :style="{ width: 'min(520px, calc(100vw - 32px))' }" :title="t(mode === 'practice' ? 'speechPractice.entry' : 'omniRealtime.entry')" @update:show="value => { if (!value) emit('close') }">
    <div class="local-realtime-config__fields">
      <label>{{ t('models.realtimeApiKey') }}<NInput v-model:value="apiKey" type="password" show-password-on="click" autocomplete="off" /></label>
      <label>{{ t('omniRealtime.modelPickerLabel') }}<NSelect v-model:value="model" :options="modelOptions" /></label>
      <template v-if="mode === 'practice'">
        <label>{{ t('speechPractice.skill') }}<NSelect v-model:value="skill" :options="skillOptions" /></label>
        <label>{{ t('speechPractice.language') }}<NSelect v-model:value="config.language" :options="languageOptions" :disabled="boundLanguages?.length === 1" /></label>
        <label>{{ t('speechPractice.direction') }}<NInput v-model:value="config.direction" :maxlength="200" :placeholder="t('speechPractice.directionPlaceholder')" /></label>
        <label>{{ t('speechPractice.difficulty') }}<NSelect v-model:value="config.difficulty" :options="difficultyOptions" /></label>
        <label>{{ t('speechPractice.duration') }}<NInputNumber v-model:value="config.durationMinutes" :min="0" :max="180" :precision="0" /></label>
      </template>
      <p v-if="error" role="alert">{{ error }}</p>
      <NButton type="primary" :loading="saving" @click="start">{{ t(mode === 'practice' ? 'speechPractice.startSession' : 'omniRealtime.entry') }}</NButton>
    </div>
  </NModal>
  <SpeechPracticeStage v-else-if="mode === 'practice'" :has-dashscope-key="Boolean(realtime.config.apiKey)" :config="config" @close="emit('close')" />
  <OmniRealtimeStage v-else :has-dashscope-key="Boolean(realtime.config.apiKey)" @close="emit('close')" />
</template>
<style scoped lang="scss">
.local-realtime-config { width: min(520px, calc(100vw - 32px)); }
.local-realtime-config__fields { display: grid; gap: 16px; }
.local-realtime-config__fields label { display: grid; gap: 8px; }
.local-realtime-config__fields [role="alert"] { color: var(--error); }
</style>
