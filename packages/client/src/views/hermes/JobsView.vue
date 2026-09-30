<script setup lang="ts">
import PageLoading from '@/components/common/PageLoading.vue'
import PageHeader from '@/components/layout/PageHeader.vue'
import { ref, computed, onMounted } from 'vue'
import { NButton, NTooltip } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import JobsPanel from '@/components/hermes/jobs/JobsPanel.vue'
import JobRunHistory from '@/components/hermes/jobs/JobRunHistory.vue'
import JobFormModal from '@/components/hermes/jobs/JobFormModal.vue'
import { useJobsStore } from '@/stores/hermes/jobs'
import { useProfilesStore } from '@/stores/hermes/profiles'

const { t } = useI18n()
const jobsStore = useJobsStore()
const profilesStore = useProfilesStore()
const showModal = ref(false)
const editingJob = ref<string | null>(null)
const selectedJobId = ref<string | null>(null)
const sortBy = ref<'time' | 'name'>('name')
const sortAsc = ref(true)
const activeProfileName = computed(() => profilesStore.activeProfileName || 'default')

const jobNameMap = computed(() => {
  const map: Record<string, string> = {}
  for (const job of jobsStore.jobs) {
    const id = job.job_id || job.id
    map[id] = job.name
  }
  return map
})

async function ensureProfileSelection() {
  if (!profilesStore.activeProfileName || profilesStore.profiles.length === 0) {
    await profilesStore.fetchProfiles()
  }
}

async function reloadJobsForProfile() {
  selectedJobId.value = null
  jobsStore.jobs = []
  await ensureProfileSelection()
  await jobsStore.fetchJobs()
}

const initializing = ref(true)

onMounted(() => {
  void reloadJobsForProfile().finally(() => { initializing.value = false })
})

function openCreateModal() {
  editingJob.value = null
  showModal.value = true
}

function openEditModal(jobId: string) {
  editingJob.value = jobId
  showModal.value = true
}

function handleModalClose() {
  showModal.value = false
  editingJob.value = null
}

async function handleSave() {
  await jobsStore.fetchJobs()
  handleModalClose()
}

function handleSelectJob(jobId: string | null) {
  selectedJobId.value = selectedJobId.value === jobId ? null : jobId
}

function toggleSort(field: 'time' | 'name') {
  if (sortBy.value === field) {
    sortAsc.value = !sortAsc.value
  } else {
    sortBy.value = field
    sortAsc.value = true
  }
}

function arrowIcon(field: 'time' | 'name'): string {
  if (sortBy.value !== field) return '↕'
  return sortAsc.value ? '↑' : '↓'
}
</script>

<template>
  <PageLoading :show="initializing || (jobsStore.loading && jobsStore.jobs.length === 0)" class="jobs-view">
    <PageHeader>
    <header class="page-header">
      <h2 class="header-title">{{ t('jobs.title') }}</h2>
      <div class="header-actions">
        <div class="sort-toggle">
          <NTooltip>
            <template #trigger>
              <NButton
                size="tiny"
                :type="sortBy === 'name' ? 'primary' : 'default'"
                @click="toggleSort('name')"
              >
                {{ t('jobs.sortByName') }} <span class="sort-arrow">{{ arrowIcon('name') }}</span>
              </NButton>
            </template>
            {{ sortBy === 'name' ? (sortAsc ? t('jobs.sortAsc') : t('jobs.sortDesc')) : t('jobs.sortByNameHint') }}
          </NTooltip>
          <NTooltip>
            <template #trigger>
              <NButton
                size="tiny"
                :type="sortBy === 'time' ? 'primary' : 'default'"
                @click="toggleSort('time')"
              >
                {{ t('jobs.sortByTime') }} <span class="sort-arrow">{{ arrowIcon('time') }}</span>
              </NButton>
            </template>
            {{ sortBy === 'time' ? (sortAsc ? t('jobs.sortAsc') : t('jobs.sortDesc')) : t('jobs.sortByTimeHint') }}
          </NTooltip>
        </div>
        <span class="sort-divider"></span>
        <NButton type="primary" size="small" @click="openCreateModal">
          <template #icon>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
          </template>
          {{ t('jobs.createJob') }}
        </NButton>
      </div>
    </header>
    </PageHeader>

    <div class="jobs-split">
      <div class="jobs-top">
        <div>
          <JobsPanel
            :selected-job-id="selectedJobId"
            :sort-by="sortBy"
            :sort-asc="sortAsc"
            @edit="openEditModal"
            @select="handleSelectJob"
          />
        </div>
      </div>

      <div class="splitter" />

      <div class="jobs-bottom">
        <JobRunHistory
          :selected-job-id="selectedJobId"
          :job-name-map="jobNameMap"
          :profile-key="activeProfileName"
        />
      </div>
    </div>

    <JobFormModal
      v-if="showModal"
      :job-id="editingJob"
      @close="handleModalClose"
      @saved="handleSave"
    />
  </PageLoading>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;

.jobs-view {
  height: 100%;
  display: flex;
  flex-direction: column;
}

.jobs-split {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-height: 0;
}

.jobs-top {
  flex: 1;
  overflow-y: auto;
  padding: 20px;
  min-height: 120px;
}

.splitter {
  height: 1px;
  background: $border-light;
  flex-shrink: 0;
}

.jobs-bottom {
  flex: 1;
  min-height: 120px;
  overflow: hidden;
}

.header-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}

.sort-toggle {
  display: flex;
  gap: 4px;
}

.sort-arrow {
  margin-inline-start: 4px;
  font-size: 11px;
  line-height: 1;
}

.sort-divider {
  width: 1px;
  height: 16px;
  background: $border-color;
  flex-shrink: 0;
}
</style>
