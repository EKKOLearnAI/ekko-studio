<script setup lang="ts">
import PageLoading from '@/components/common/PageLoading.vue'
import PageHeader from '@/components/layout/PageHeader.vue'
import { ref, onMounted, computed, defineAsyncComponent } from 'vue'
import { NButton, useMessage } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import { fetchMemory, saveMemory, type MemoryData } from '@/api/hermes/skills'
import { useProfilesStore } from '@/stores/hermes/profiles'

const MarkdownRenderer = defineAsyncComponent(async () => (await import('@/components/hermes/chat/MarkdownRenderer.vue')).default)

const { t } = useI18n()
const message = useMessage()
const profilesStore = useProfilesStore()
const loading = ref(true)
const data = ref<MemoryData | null>(null)
const editingSection = ref<'memory' | 'user' | 'soul' | null>(null)
const editContent = ref('')
const saving = ref(false)

onMounted(loadMemory)

async function loadMemory() {
  loading.value = true
  try {
    if (!profilesStore.activeProfileName || profilesStore.profiles.length === 0) {
      await profilesStore.fetchProfiles()
    }
    data.value = await fetchMemory()
  } catch (err: any) {
    console.error('Failed to load memory:', err)
    message.error(t('memory.loadFailed'))
  } finally {
    loading.value = false
  }
}

function startEdit(section: 'memory' | 'user' | 'soul') {
  editingSection.value = section
  editContent.value = data.value?.[section] || ''
}

function cancelEdit() {
  editingSection.value = null
  editContent.value = ''
}

async function handleSave() {
  if (!editingSection.value) return
  saving.value = true
  try {
    await saveMemory(editingSection.value, editContent.value)
    await loadMemory()
    editingSection.value = null
    editContent.value = ''
    message.success(t('common.saved'))
  } catch (err: any) {
    message.error(`${t('common.saveFailed')}: ${err.message}`)
  } finally {
    saving.value = false
  }
}

function formatTime(ts: number | null): string {
  if (!ts) return ''
  return new Date(ts).toLocaleString([], {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

const memoryEmpty = computed(() => !data.value?.memory?.trim())
const userEmpty = computed(() => !data.value?.user?.trim())
const soulEmpty = computed(() => !data.value?.soul?.trim())

const displayMemory = computed(() => (data.value?.memory || '').replace(/§/g, '\n\n'))
const displayUser = computed(() => (data.value?.user || '').replace(/§/g, '\n\n'))
const displaySoul = computed(() => (data.value?.soul || '').replace(/§/g, '\n\n'))
</script>

<template>
  <PageLoading :show="loading && !data" class="memory-view">
    <PageHeader>
    <header class="page-header">
      <h2 class="header-title">{{ t('memory.title') }}</h2>
      <NButton size="small" quaternary @click="loadMemory">
        <template #icon>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <polyline points="23 4 23 10 17 10" />
            <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
          </svg>
        </template>
        {{ t('memory.refresh') }}
      </NButton>
    </header>
    </PageHeader>

    <div class="memory-content">
      <div v-if="loading && !data" class="memory-loading"></div>
      <div v-else class="memory-sections">
          <!-- My Notes -->
          <div class="memory-section">
            <div class="section-header">
              <div class="section-title-row">
                <span class="section-icon">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                    <polyline points="14 2 14 8 20 8" />
                    <line x1="16" y1="13" x2="8" y2="13" />
                    <line x1="16" y1="17" x2="8" y2="17" />
                  </svg>
                </span>
                <span class="section-title">{{ t('memory.myNotes') }}</span>
                <span v-if="data?.memory_mtime" class="section-mtime">{{ formatTime(data.memory_mtime) }}</span>
              </div>
              <NButton v-if="editingSection !== 'memory'" size="tiny" quaternary @click="startEdit('memory')">
                <template #icon>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                    <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
                    <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
                  </svg>
                </template>
                {{ t('common.edit') }}
              </NButton>
            </div>

            <!-- View mode -->
            <div v-if="editingSection !== 'memory'" class="section-body">
              <MarkdownRenderer v-if="!memoryEmpty" :content="displayMemory" />
              <p v-else class="empty-text">{{ t('memory.noNotes') }}</p>
            </div>

            <!-- Edit mode -->
            <div v-else class="section-edit">
              <textarea
                v-model="editContent"
                class="edit-textarea"
                :placeholder="t('memory.notesPlaceholder')"
                spellcheck="false"
              ></textarea>
              <div class="edit-actions">
                <NButton size="small" @click="cancelEdit">{{ t('common.cancel') }}</NButton>
                <NButton size="small" type="primary" :loading="saving" @click="handleSave">{{ t('common.save') }}</NButton>
              </div>
            </div>
          </div>

          <!-- User Profile -->
          <div class="memory-section">
            <div class="section-header">
              <div class="section-title-row">
                <span class="section-icon">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                    <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
                    <circle cx="12" cy="7" r="4" />
                  </svg>
                </span>
                <span class="section-title">{{ t('memory.userProfile') }}</span>
                <span v-if="data?.user_mtime" class="section-mtime">{{ formatTime(data.user_mtime) }}</span>
              </div>
              <NButton v-if="editingSection !== 'user'" size="tiny" quaternary @click="startEdit('user')">
                <template #icon>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                    <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
                    <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
                  </svg>
                </template>
                {{ t('common.edit') }}
              </NButton>
            </div>

            <!-- View mode -->
            <div v-if="editingSection !== 'user'" class="section-body">
              <MarkdownRenderer v-if="!userEmpty" :content="displayUser" />
              <p v-else class="empty-text">{{ t('memory.noProfile') }}</p>
            </div>

            <!-- Edit mode -->
            <div v-else class="section-edit">
              <textarea
                v-model="editContent"
                class="edit-textarea"
                :placeholder="t('memory.profilePlaceholder')"
                spellcheck="false"
              ></textarea>
              <div class="edit-actions">
                <NButton size="small" @click="cancelEdit">{{ t('common.cancel') }}</NButton>
                <NButton size="small" type="primary" :loading="saving" @click="handleSave">{{ t('common.save') }}</NButton>
              </div>
            </div>
          </div>

          <!-- Soul -->
          <div class="memory-section">
            <div class="section-header">
              <div class="section-title-row">
                <span class="section-icon">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                    <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2z" />
                    <path d="M8 14s1.5 2 4 2 4-2 4-2" />
                    <line x1="9" y1="9" x2="9.01" y2="9" />
                    <line x1="15" y1="9" x2="15.01" y2="9" />
                  </svg>
                </span>
                <span class="section-title">{{ t('memory.soul') }}</span>
                <span v-if="data?.soul_mtime" class="section-mtime">{{ formatTime(data.soul_mtime) }}</span>
              </div>
              <NButton v-if="editingSection !== 'soul'" size="tiny" quaternary @click="startEdit('soul')">
                <template #icon>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                    <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
                    <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
                  </svg>
                </template>
                {{ t('common.edit') }}
              </NButton>
            </div>

            <!-- View mode -->
            <div v-if="editingSection !== 'soul'" class="section-body">
              <MarkdownRenderer v-if="!soulEmpty" :content="displaySoul" />
              <p v-else class="empty-text">{{ t('memory.noSoul') }}</p>
            </div>

            <!-- Edit mode -->
            <div v-else class="section-edit">
              <textarea
                v-model="editContent"
                class="edit-textarea"
                :placeholder="t('memory.soulPlaceholder')"
                spellcheck="false"
              ></textarea>
              <div class="edit-actions">
                <NButton size="small" @click="cancelEdit">{{ t('common.cancel') }}</NButton>
                <NButton size="small" type="primary" :loading="saving" @click="handleSave">{{ t('common.save') }}</NButton>
              </div>
            </div>
          </div>
        </div>
    </div>
  </PageLoading>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;

.memory-view {
  height: 100%;
  display: flex;
  flex-direction: column;
}

.memory-content {
  flex: 1;
  overflow: hidden;
  padding: 20px;
  display: flex;
  flex-direction: column;
}

.memory-loading {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 13px;
  color: $text-muted;
}

.memory-sections {
  display: flex;
  gap: 16px;
  flex: 1;
  min-height: 0;

  @media (max-width: $breakpoint-mobile) {
    flex-direction: column;
  }
}

.memory-section {
  flex: 1;
  min-height: 0;
  border: 1px solid $border-color;
  border-radius: $radius-md;
  overflow: hidden;
  display: flex;
  flex-direction: column;
}

.section-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 16px;
  background: $bg-secondary;
  border-bottom: 1px solid $border-color;
  flex-shrink: 0;
}

.section-title-row {
  display: flex;
  align-items: center;
  gap: 8px;
}

.section-icon {
  color: $text-secondary;
  display: flex;
}

.section-title {
  font-size: 14px;
  font-weight: 600;
  color: $text-primary;
}

.section-mtime {
  font-size: 11px;
  color: $text-muted;
}

.section-body {
  flex: 1;
  overflow-y: auto;
  padding: 16px;
  min-height: 0;
}

.empty-text {
  color: $text-muted;
  font-style: italic;
  font-size: 13px;
}

.section-edit {
  flex: 1;
  display: flex;
  flex-direction: column;
  padding: 12px 16px;
  min-height: 0;
}

.edit-textarea {
  flex: 1;
  width: 100%;
  min-height: 0;
  padding: 12px;
  border: 1px solid $border-color;
  border-radius: $radius-sm;
  background: $bg-input;
  color: $text-primary;
  font-family: $font-code;
  font-size: 13px;
  line-height: 1.6;
  resize: none;
  outline: none;

  &:focus {
    border-color: $accent-primary;
  }
}

.edit-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 10px;
}
</style>
