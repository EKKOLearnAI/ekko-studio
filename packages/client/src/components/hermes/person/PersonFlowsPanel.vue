<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { NInput } from 'naive-ui'
import type { PersonFlow } from '@/api/person'
import SessionTaskIcon from '@/components/common/SessionTaskIcon.vue'
import { personFlowGroups, personFlowState, personFlowStatusKey, type PersonFlowStage } from '@/utils/person-flow'
import PersonFlowCard from './PersonFlowCard.vue'

const props = defineProps<{ flows: PersonFlow[]; saving: boolean }>()
const emit = defineEmits<{ action: [flow: PersonFlow, action: 'stop' | 'resume']; openResult: [sessionId: string, messageId: number]; openTask: [taskId: string]; openConversation: [sessionId: string] }>()
const { t } = useI18n()
const expanded = ref<string | null>(null)
const search = ref('')
const filter = ref<'all' | PersonFlow['state']>('all')
const visibleFlows = computed(() => props.flows.slice(0,50))
const filters = computed(() => [
  { value:'all' as const,label:t('person.flowAll'),count:visibleFlows.value.length },
  { value:'active' as const,label:t('person.flowInProgress'),count:visibleFlows.value.filter(flow => flow.state === 'active').length },
  { value:'failed' as const,label:t('person.states.failed'),count:visibleFlows.value.filter(flow => flow.state === 'failed').length },
  { value:'stopped' as const,label:t('person.flowStopped'),count:visibleFlows.value.filter(flow => flow.state === 'stopped').length },
  { value:'completed' as const,label:t('person.states.completed'),count:visibleFlows.value.filter(flow => flow.state === 'completed').length },
])
const name = (stage: PersonFlowStage) => stage.session_title || t('person.chat')
const rows = computed(() => visibleFlows.value.filter(flow => {
  const query = search.value.trim().toLocaleLowerCase()
  return (filter.value === 'all' || flow.state === filter.value) && (!query || [flow.title,flow.goal,...flow.stages.map(name)].some(text => text.toLocaleLowerCase().includes(query)))
}).map(flow => ({ flow,groups:personFlowGroups(flow),status:personFlowState(flow),completed:flow.stages.filter(stage => stage.state === 'completed').length })))
watch(rows,value => { if (!value.some(row => row.flow.id === expanded.value)) expanded.value=null })
const toggle = (id: string) => { expanded.value=expanded.value === id ? null : id }
</script>

<template>
  <section class="person-panel flow-panel">
    <header class="panel-heading"><div><h2>{{ t('person.flows') }}</h2><p>{{ t('person.flowHint') }}</p></div></header>
    <div v-if="!visibleFlows.length" class="panel-empty">{{ t('person.empty') }}</div>
    <template v-else>
      <div class="flow-toolbar">
        <div class="flow-filters" role="group" :aria-label="t('person.flows')">
          <button v-for="item in filters" :key="item.value" type="button" :class="{ selected:filter === item.value }" :aria-pressed="filter === item.value" @click="filter=item.value">
            {{ item.label }}<span>{{ item.count }}</span>
          </button>
        </div>
        <NInput v-model:value="search" class="flow-search" size="small" clearable :placeholder="t('person.flowSearch')" :input-props="{ 'aria-label':t('person.flowSearch') }">
          <template #prefix><SessionTaskIcon name="search" :size="14" /></template>
        </NInput>
      </div>
      <div v-if="!rows.length" class="panel-empty">{{ t('person.flowNoMatches') }}</div>
      <ul v-else class="flow-list">
        <li v-for="row in rows" :key="row.flow.id" class="flow-entry" :class="{ 'flow-entry--expanded':expanded === row.flow.id }">
          <button type="button" class="flow-row" :aria-expanded="expanded === row.flow.id" :aria-controls="`flow-detail-${row.flow.id}`" :aria-labelledby="`flow-title-${row.flow.id}`" :aria-describedby="`flow-meta-${row.flow.id}`" @click="toggle(row.flow.id)">
            <span class="flow-row-main">
              <span :id="`flow-title-${row.flow.id}`" class="flow-row-title">{{ row.flow.title }}</span>
              <span class="flow-route" :title="row.groups.map(group => group.stages.map(name).join(' ∥ ')).join(' → ')">
                <template v-for="(group,index) in row.groups" :key="group.position">
                  <span v-if="index" class="flow-route-arrow" aria-hidden="true">→</span>
                  <span class="flow-route-group" :class="{ 'flow-route-group--current':row.flow.state === 'active' && group.position === row.flow.current_position }" :title="group.stages.map(name).join(' ∥ ')">
                    {{ group.stages.map(name).join(' ∥ ') }}
                  </span>
                </template>
              </span>
            </span>
            <span :id="`flow-meta-${row.flow.id}`" class="flow-row-meta">
              <span class="flow-row-status" :class="`flow-row-status--${row.status}`"><span aria-hidden="true" />{{ t(personFlowStatusKey(row.status)) }}</span>
              <span class="flow-row-progress" :aria-label="t('person.flowRoleProgress',{ completed:row.completed,total:row.flow.stages.length })">{{ row.completed }}/{{ row.flow.stages.length }}</span>
            </span>
            <SessionTaskIcon name="chevron-down" class="flow-row-chevron" :size="14" />
          </button>
          <div v-show="expanded === row.flow.id" :id="`flow-detail-${row.flow.id}`" class="flow-detail">
            <PersonFlowCard v-if="expanded === row.flow.id" :flow="row.flow" :saving="saving" embedded
              @action="(item,action) => emit('action',item,action)" @open-result="(sessionId,messageId) => emit('openResult',sessionId,messageId)"
              @open-task="emit('openTask',$event)" @open-conversation="emit('openConversation',$event)" />
          </div>
        </li>
      </ul>
    </template>
  </section>
</template>

<style scoped lang="scss">
@use './person-panels';
@use '@/styles/variables' as *;

.flow-panel .panel-heading { margin-bottom: 20px; }
.flow-toolbar { display: flex; align-items: center; justify-content: space-between; gap: 16px; margin-bottom: 12px; }
.flow-filters { display: flex; flex-wrap: wrap; gap: 4px; min-width: 0; }
.flow-filters button { display: inline-flex; align-items: center; gap: 7px; padding: 6px 10px; border: 0; border-radius: var(--radius-component, 7px); background: transparent; color: $text-secondary; font: inherit; font-size: 12px; white-space: nowrap; cursor: pointer; }
.flow-filters button span { color: $text-muted; font-size: 10px; font-variant-numeric: tabular-nums; }
.flow-filters button.selected { color: $text-primary; background: rgba(var(--accent-primary-rgb), .05); font-weight: 600; }
.flow-search { width: 230px; flex-shrink: 0; }
.flow-list { padding: 0; margin: 0; list-style: none; border-block-start: 1px solid $border-light; }
.flow-entry { border-block-end: 1px solid $border-light; }
.flow-row { display: flex; align-items: center; gap: 18px; width: 100%; min-height: 72px; padding: 12px 10px; border: 0; background: transparent; color: $text-primary; font: inherit; text-align: start; cursor: pointer; }
.flow-row:hover, .flow-entry--expanded > .flow-row { background: rgba(var(--accent-primary-rgb), .04); }
.flow-row:focus-visible, .flow-filters button:focus-visible { outline: 2px solid $accent-primary; outline-offset: -2px; border-radius: var(--radius-component, 6px); }
.flow-row-main { display: flex; flex: 1; flex-direction: column; gap: 5px; min-width: 0; }
.flow-row-title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 13px; font-weight: 600; line-height: 1.6; }
.flow-route { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; color: $text-muted; font-size: 11px; line-height: 1.5; }

.flow-route-group--current { color: $text-secondary; }
.flow-route-arrow { margin-inline: 8px; opacity: .6; }
.flow-row-meta { display: flex; align-items: center; gap: 28px; flex-shrink: 0; }
.flow-row-status { display: inline-flex; align-items: center; gap: 6px; min-width: 72px; font-size: 11px; color: $text-muted; white-space: nowrap; }
.flow-row-status > span { width: 5px; height: 5px; border-radius: 50%; background: currentColor; }
.flow-row-status--active { color: var(--accent-info); }
.flow-row-status--completed { color: $success; }
.flow-row-status--blocked { color: $error; }
.flow-row-status--waiting_user { color: $warning; }
.flow-row-progress { min-width: 32px; font-size: 11px; font-variant-numeric: tabular-nums; color: $text-muted; text-align: end; }
.flow-row-chevron { flex-shrink: 0; color: $text-muted; }
.flow-entry--expanded .flow-row-chevron { transform: rotate(180deg); }
.flow-detail { padding-block: 2px 16px; }
@media (max-width: 640px) {
  .flow-toolbar { flex-direction: column; align-items: stretch; gap: 12px; }
  .flow-filters { justify-content: space-between; }
  .flow-filters button { gap: 5px; padding-inline: 6px; font-size: 11px; }
  .flow-search { width: 100%; }
  .flow-row { gap: 10px; padding-inline: 3px; min-height: 76px; }
  .flow-row-meta { align-items: flex-end; flex-direction: column; gap: 5px; }
  .flow-row-status { min-width: 0; font-size: 10px; }
  .flow-row-progress { font-size: 10px; }
  .flow-route { font-size: 10px; }
  .flow-route-arrow { margin-inline: 5px; }
  .flow-row-chevron { width: 12px; }
}
</style>
