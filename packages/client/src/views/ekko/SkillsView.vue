<script setup lang="ts">
import PageLoading from '@/components/common/PageLoading.vue'
import PageHeader from '@/components/layout/PageHeader.vue'
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { NButton, NInput, useMessage } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import SkillDetail from '@/components/hermes/skills/SkillDetail.vue'
import SkillExternalDirsModal from '@/components/hermes/skills/SkillExternalDirsModal.vue'
import SkillImportModal from '@/components/hermes/skills/SkillImportModal.vue'
import SkillList from '@/components/hermes/skills/SkillList.vue'
import SkillSourceLegend from '@/components/hermes/skills/SkillSourceLegend.vue'
import type { SkillCategory, SkillFileEntry, SkillSource } from '@/api/hermes/skills'
import {
  deleteEkkoSkill,
  fetchEkkoExternalDirectories,
  fetchEkkoSkill,
  fetchEkkoSkillFile,
  fetchEkkoSkillFiles,
  fetchEkkoSkills,
  importEkkoSkill,
  saveEkkoExternalDirectories,
  toggleEkkoSkill,
  updateEkkoSkill,
  type EkkoSkillSummary,
} from '@/api/ekko/skills'

type SourceFilter = SkillSource | 'modified'

const { t } = useI18n()
const message = useMessage()
const skills = ref<EkkoSkillSummary[]>([])
const loading = ref(true)
const selectedCategory = ref('')
const selectedSkill = ref('')
const searchQuery = ref('')
const showSidebar = ref(true)
const sourceFilter = ref<SourceFilter | null>(null)
const showImportModal = ref(false)
const showExternalDirsModal = ref(false)
let mobileQuery: MediaQueryList | null = null

const categories = computed<SkillCategory[]>(() => {
  const grouped = new Map<string, SkillCategory['skills']>()
  for (const skill of skills.value) {
    const category = skill.category || 'misc'
    const entries = grouped.get(category) || []
    entries.push({
      name: skill.name,
      description: skill.description,
      enabled: skill.enabled,
      source: skill.source,
      ...(skill.sourcePath ? { sourcePath: skill.sourcePath } : {}),
    })
    grouped.set(category, entries)
  }
  return [...grouped.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, entries]) => ({
      name,
      description: '',
      skills: entries.sort((left, right) => left.name.localeCompare(right.name)),
    }))
})

const selectedSkillData = computed(() => skills.value.find(skill =>
  skill.name === selectedSkill.value && (skill.category || 'misc') === selectedCategory.value,
) || null)

const selectedReadonly = computed(() => selectedSkillData.value?.source !== 'local')

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function handleMobileChange(event: MediaQueryListEvent | MediaQueryList) {
  showSidebar.value = !event.matches
}

function ensureSelectedSkill() {
  if (selectedSkillData.value) return
  const first = skills.value[0]
  selectedCategory.value = first?.category || (first ? 'misc' : '')
  selectedSkill.value = first?.name || ''
}

async function loadSkills() {
  loading.value = true
  try {
    skills.value = await fetchEkkoSkills()
    ensureSelectedSkill()
  } catch (error) {
    message.error(`${t('ekkoConfig.loadFailed')}: ${errorMessage(error)}`)
  } finally {
    loading.value = false
  }
}

function handleSelect(category: string, skill: string) {
  selectedCategory.value = category
  selectedSkill.value = skill
  if (window.innerWidth <= 768) showSidebar.value = false
}

async function loadContent(_category: string, skill: string, filePath?: string): Promise<string> {
  return filePath ? fetchEkkoSkillFile(skill, filePath) : (await fetchEkkoSkill(skill)).content
}

async function loadFiles(_category: string, skill: string): Promise<SkillFileEntry[]> {
  return fetchEkkoSkillFiles(skill)
}

async function saveContent(_category: string, skill: string, content: string): Promise<void> {
  await updateEkkoSkill(skill, content)
}

async function removeSkill(_category: string, skill: string): Promise<void> {
  await deleteEkkoSkill(skill)
}

async function handleDeleted(category: string, skill: string) {
  if (selectedCategory.value === category && selectedSkill.value === skill) {
    selectedCategory.value = ''
    selectedSkill.value = ''
  }
  await loadSkills()
}

async function handleToggle(_category: string, name: string, enabled: boolean): Promise<void> {
  await toggleEkkoSkill(name, enabled)
  const skill = skills.value.find(candidate => candidate.name === name)
  if (skill) skill.enabled = enabled
}

async function handleImported() {
  showImportModal.value = false
  await loadSkills()
}

async function handleExternalDirsSaved() {
  showExternalDirsModal.value = false
  await loadSkills()
}

onMounted(() => {
  mobileQuery = window.matchMedia('(max-width: 768px)')
  handleMobileChange(mobileQuery)
  mobileQuery.addEventListener('change', handleMobileChange)
  void loadSkills()
})

onUnmounted(() => mobileQuery?.removeEventListener('change', handleMobileChange))
</script>

<template>
  <PageLoading :show="loading && skills.length === 0" class="skills-view">
    <PageHeader>
    <header class="page-header">
      <div class="skills-header-heading">
        <h2 class="header-title">{{ t('skills.title') }}</h2>
        <button v-if="!showSidebar" class="sidebar-toggle" @click="showSidebar = true">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <line x1="3" y1="12" x2="21" y2="12" />
            <line x1="3" y1="6" x2="21" y2="6" />
            <line x1="3" y1="18" x2="21" y2="18" />
          </svg>
        </button>
        <SkillSourceLegend v-model="sourceFilter" />
      </div>

      <div class="header-actions">
        <NButton class="header-action-btn" size="small" :title="t('skills.import')" @click="showImportModal = true">
          <template #icon>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
              <polyline points="17 8 12 3 7 8" />
              <line x1="12" y1="3" x2="12" y2="15" />
            </svg>
          </template>
          <span class="header-action-label">{{ t('skills.import') }}</span>
        </NButton>
        <NButton class="header-action-btn" size="small" :title="t('skills.externalDirs.manage')" @click="showExternalDirsModal = true">
          <template #icon>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
            </svg>
          </template>
          <span class="header-action-label">{{ t('skills.externalDirs.manage') }}</span>
        </NButton>
        <NInput v-model:value="searchQuery" :placeholder="t('skills.searchPlaceholder')" size="small" clearable style="width: 130px" />
      </div>
    </header>
    </PageHeader>

    <SkillImportModal
      v-if="showImportModal"
      :import-handler="importEkkoSkill"
      @close="showImportModal = false"
      @saved="handleImported"
    />
    <SkillExternalDirsModal
      v-if="showExternalDirsModal"
      :fetch-handler="fetchEkkoExternalDirectories"
      :save-handler="saveEkkoExternalDirectories"
      @close="showExternalDirsModal = false"
      @saved="handleExternalDirsSaved"
    />

    <div class="skills-content">
      <div v-if="loading && skills.length === 0" class="skills-loading"></div>
      <div v-else class="skills-layout">
        <div class="mobile-backdrop" :class="{ active: showSidebar }" @click="showSidebar = false" />
        <div v-if="showSidebar" class="skills-sidebar">
          <SkillList
            :categories="categories"
            :archived="[]"
            :selected-skill="selectedSkill ? `${selectedCategory}/${selectedSkill}` : null"
            :search-query="searchQuery"
            :source-filter="sourceFilter"
            :toggle-handler="handleToggle"
            :delete-handler="removeSkill"
            @select="handleSelect"
            @deleted="handleDeleted"
          />
        </div>
        <div class="skills-main">
          <SkillDetail
            v-if="selectedSkill"
            :category="selectedCategory"
            :skill="selectedSkill"
            :skill-name="selectedSkill"
            :readonly="selectedReadonly"
            :load-content="loadContent"
            :load-files="loadFiles"
            :save-content="saveContent"
            @saved="loadSkills"
          />
          <div v-else class="empty-detail">
            <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1" opacity="0.2">
              <polygon points="12 2 2 7 12 12 22 7 12 2" />
              <polyline points="2 17 12 22 22 17" />
              <polyline points="2 12 12 17 22 12" />
            </svg>
            <span>{{ t('skills.noSkills') }}</span>
          </div>
        </div>
      </div>
    </div>
  </PageLoading>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;
@use '@/styles/skills-manager' as skills-manager;

@include skills-manager.layout;

.header-actions { display: flex; align-items: center; gap: 8px; }

@media (max-width: $breakpoint-mobile) {
  .header-action-label { display: none; }
  .header-action-btn {
    width: 30px;
    padding: 0;

    :deep(.n-button__content) { justify-content: center; }
    :deep(.n-button__icon) { margin: 0; }
  }
}
</style>
