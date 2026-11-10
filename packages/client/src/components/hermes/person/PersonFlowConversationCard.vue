<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import type { PersonFlow } from '@/api/person'
import PersonPanelIcon from './PersonPanelIcon.vue'
import PersonFlowGraph from './PersonFlowGraph.vue'
import { personFlowState,personFlowStatusKey } from '@/utils/person-flow'
const props = defineProps<{flow:PersonFlow}>()
const emit = defineEmits<{open:[flow:PersonFlow]}>()
const {t} = useI18n()
const status = computed(() => personFlowState(props.flow))
const completed = computed(() => props.flow.stages.filter(stage => stage.state === 'completed').length)
</script>

<template>
  <button type="button" class="person-flow-conversation-card" data-theme-surface="card" :aria-label="`${t('person.flowViewChat')} · ${flow.title}`" @click="emit('open',flow)">
    <span class="flow-card-kicker"><PersonPanelIcon name="flows" :size="16" />{{t('person.flows')}}<span class="flow-card-status" :class="`flow-card-status--${status}`">{{t(personFlowStatusKey(status))}}</span></span>
    <strong class="flow-card-title" dir="auto">{{flow.title}}</strong>
    <PersonFlowGraph class="flow-card-route" :flow="flow" :interactive="false" />
    <span class="flow-card-footer"><span>{{t('person.flowRoleProgress',{completed,total:flow.stages.length})}}</span><span class="flow-card-open">{{t('person.flowViewChat')}}<PersonPanelIcon name="arrow" :size="15" /></span></span>
  </button>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;
.person-flow-conversation-card { box-sizing:border-box; display:flex; flex-direction:column; gap:12px; width:100%; max-width:var(--chat-max-width,900px); margin:0; margin-inline-end:auto; padding:16px 18px; background:$bg-card; color:$text-primary; border:var(--border-width,1px) solid $border-light; border-radius:var(--radius-component,12px); font:inherit; text-align:start; cursor:pointer; }
.person-flow-conversation-card:hover { border-color:$accent-primary; }
.person-flow-conversation-card:focus-visible { outline:2px solid $accent-primary; outline-offset:3px; }
.flow-card-kicker,.flow-card-footer,.flow-card-open { display:flex; align-items:center; gap:8px; }
.flow-card-kicker { color:$text-secondary; font-size:12px; }
.flow-card-status { margin-inline-start:auto; color:$text-muted; }
.flow-card-status--completed { color:$success; }
.flow-card-status--blocked { color:$error; }
.flow-card-title { font-size:15px; font-weight:600; overflow-wrap:anywhere; }
.flow-card-route { margin:0; }
.flow-card-footer { justify-content:space-between; flex-wrap:wrap; color:$text-muted; font-size:12px; }
.flow-card-open { color:$accent-primary; }
</style>
