<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { NButton, NInput, NSpin } from 'naive-ui'
import { personTeamMemories, PERSON_DEFAULT_TEAM_ID, type PersonMemory, type PersonTeam } from '@/api/person'
import PersonPanelIcon from './PersonPanelIcon.vue'
import { PERSON_AVATAR } from '@/utils/chat-agent-avatar'

const props = defineProps<{ teams: PersonTeam[]; teamId: string; memories: PersonMemory[]; saving: boolean }>()
const emit = defineEmits<{ forget: [memory: PersonMemory, teamId: string] }>()
const { t } = useI18n()
const search = ref('')
const selectedTeamId = ref('')
const items = ref<PersonMemory[]>([])
const loading = ref(false)
const error = ref('')

const selectedTeam = computed(() => props.teams.find(team => team.id === selectedTeamId.value) || props.teams[0])
const filtered = computed(() => items.value.filter(memory => memory.content.toLocaleLowerCase().includes(search.value.trim().toLocaleLowerCase())))

watch(() => [props.teamId, props.teams.map(team => team.id).join(',')], () => {
  if (!props.teams.some(team => team.id === selectedTeamId.value)) selectedTeamId.value = props.teamId || props.teams[0]?.id || ''
}, { immediate: true })
// The snapshot already carries the conversation's team; other teams load on demand.
watch(selectedTeamId, async id => {
  if (!id) { items.value = []; return }
  if (id === props.teamId) { items.value = props.memories.map(memory => ({ ...memory })); return }
  loading.value = true; error.value = ''
  try { items.value = (await personTeamMemories(id)).memories } catch (e) { error.value = String(e); items.value = [] }
  finally { loading.value = false }
}, { immediate: true })
watch(() => props.memories, value => { if (selectedTeamId.value === props.teamId) items.value = value.map(memory => ({ ...memory })) })
</script>

<template>
  <section class="person-panel">
    <header class="panel-heading"><div><h2>{{ t('person.memoryTitle') }}</h2><p>{{ t('person.memoryHint') }}</p></div></header>
    <div class="team-layout">
      <aside class="team-list" :aria-label="t('person.teamsTitle')">
        <div v-for="team in teams" :key="team.id" class="team-item" :class="{ selected: team.id === selectedTeam?.id }">
          <button type="button" class="team-select" :aria-pressed="team.id === selectedTeam?.id" @click="selectedTeamId = team.id">
            <span class="team-name" :title="team.name">{{ team.name }}</span>
            <span v-if="team.id === PERSON_DEFAULT_TEAM_ID" class="team-badge">{{ t('person.defaultTeam') }}</span>
          </button>
        </div>
        <p v-if="!teams.length" class="panel-empty-hint">{{ t('person.teamsEmpty') }}</p>
      </aside>
      <div class="team-body">
        <div class="panel-toolbar">
          <span class="panel-count"><strong>{{ items.length }}</strong>{{ t('person.savedMemories') }}</span>
          <NInput v-model:value="search" class="panel-search" clearable :placeholder="t('person.search')" :input-props="{ 'aria-label': t('person.search') }"><template #prefix><PersonPanelIcon name="search" :size="16" /></template></NInput>
        </div>
        <p v-if="error" class="memory-error" role="alert">{{ error }}</p>
        <NSpin v-if="loading" />
        <div v-else-if="filtered.length" class="panel-grid">
          <article v-for="memory in filtered" :key="memory.id" class="panel-tile memory-tile" data-theme-surface="card">
            <div class="tile-top"><span class="tile-icon"><PersonPanelIcon name="memory" /></span><span class="tile-meta">{{ t('person.savedMemory') }}</span></div>
            <p class="memory-content">{{ memory.content }}</p>
            <footer class="tile-footer"><span class="tile-meta">{{ PERSON_AVATAR.label }} · {{ t('person.memory') }}</span><NButton quaternary size="small" :disabled="saving" @click="emit('forget', memory, selectedTeam?.id || '')">{{ t('person.forget') }}</NButton></footer>
          </article>
        </div>
        <div v-else class="panel-empty"><PersonPanelIcon name="memory" :size="36" /><h3>{{ t('person.empty') }}</h3><p v-if="!search">{{ t('person.memoryEmpty') }}</p></div>
      </div>
    </div>
  </section>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;
@use './person-panels';
.memory-tile { min-height: 245px; }
.memory-content { margin: 0 0 28px; font-size: 15px; line-height: 1.85; white-space: pre-wrap; overflow-wrap: anywhere; }
.memory-error { color: $error; font-size: 12px; margin: 0 0 8px; }
.team-layout { display: grid; grid-template-columns: minmax(160px, 220px) minmax(0, 1fr); gap: 18px; align-items: start; }
.team-list { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
.team-item { display: flex; align-items: center; min-width: 0; border: var(--border-width, 1px) solid transparent;
  border-radius: var(--radius-component, 8px); }
.team-item:hover { background: rgba(var(--accent-primary-rgb), .06); }
.team-item.selected { border-color: $accent-primary; background: rgba(var(--accent-primary-rgb), .1); }
.team-select { flex: 1; min-width: 0; display: flex; align-items: center; gap: 8px; padding: 9px 10px;
  background: transparent; color: $text-primary; font: inherit; font-size: 13px; text-align: start; border: 0; cursor: pointer; }
.team-select:focus-visible { outline: 2px solid $accent-primary; outline-offset: 2px; border-radius: var(--radius-component, 8px); }
.team-name { flex: 1; min-width: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.team-badge { flex-shrink: 0; font-size: 10.5px; padding: 1px 6px; border-radius: 999px; border: 1px solid $border-color; color: $text-secondary; }
.team-body { min-width: 0; }
.panel-empty-hint { font-size: 12px; color: $text-secondary; }
@media (max-width: 720px) {
  .team-layout { grid-template-columns: minmax(0, 1fr); }
  .team-list { flex-direction: row; overflow-x: auto; padding-bottom: 4px; }
  .team-item { width: auto; white-space: nowrap; }
}
</style>
