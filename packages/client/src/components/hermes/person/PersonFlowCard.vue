<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { NAlert, NButton, NProgress } from 'naive-ui'
import type { PersonFlow } from '@/api/person'
import SessionTaskIcon from '@/components/common/SessionTaskIcon.vue'
import { chatSessionAgentAvatar, personAvatarStyle } from '@/utils/chat-agent-avatar'
import { personFlowDependencies, personFlowGroups, personFlowStageStatus, personFlowState, personFlowStatusKey, type PersonFlowStage, type PersonFlowStatus } from '@/utils/person-flow'

const props = defineProps<{ flow: PersonFlow; saving: boolean; embedded?: boolean }>()
const emit = defineEmits<{ action: [flow: PersonFlow, action: 'stop' | 'resume']; openResult: [sessionId: string, messageId: number]; openTask: [taskId: string]; openConversation: [sessionId: string] }>()
const { t, locale } = useI18n()
const groups = computed(() => personFlowGroups(props.flow))
const completed = computed(() => props.flow.stages.filter(stage => stage.state === 'completed').length)
const current = computed(() => groups.value.find(group => group.position === props.flow.current_position))
const name = (stage: PersonFlowStage) => stage.session_title || t('person.chat')
const names = (stages: PersonFlowStage[]) => new Intl.ListFormat(locale.value,{ style:'short',type:'conjunction' }).format(stages.map(name))
const status = (stage: PersonFlowStage) => personFlowStageStatus(props.flow,stage)
const avatar = (stage: PersonFlowStage) => chatSessionAgentAvatar({ id:stage.session_id,bot_type:stage.bot_type || undefined })
const label = (value: PersonFlowStatus) => t(personFlowStatusKey(value))
const flowState = computed(() => personFlowState(props.flow))
const summary = computed(() => {
  if (props.flow.state === 'stopped') return t('person.flowStoppedHint')
  if (props.flow.state === 'completed') return t('person.states.completed')
  if (props.flow.state === 'failed') return t('person.flowBlocked')
  const group = current.value
  if (!group) return ''
  return group.stages.length > 1 ? t('person.flowParallelSummary',{ total:group.stages.length,completed:group.completed })
    : t('person.flowSerialSummary',{ names:names(group.stages) })
})
function dependencyLabel(stage: PersonFlowStage) {
  const waiting = personFlowDependencies(props.flow,stage)
  return waiting.length ? t('person.flowWaitingFor',{ names:names(waiting) }) : t('person.flowWaitingDependencies')
}
</script>

<template>
  <article class="flow-card" :class="{ 'flow-card--embedded':embedded }" :aria-label="flow.title">
    <header class="flow-header">
      <div class="flow-heading">
        <span v-if="!embedded" class="flow-status" :class="`flow-status--${flowState}`" role="status">
          <SessionTaskIcon :name="flowState === 'completed' ? 'completed' : flowState === 'interrupted' ? 'closed' : 'circle'" :size="13" />{{ label(flowState) }}
        </span>
        <h3 v-if="!embedded">{{ flow.title }}</h3>
        <p class="flow-description">{{ flow.goal }}</p>
      </div>
      <NButton v-if="flow.state !== 'completed'" :disabled="saving" size="small" secondary @click="emit('action',flow,['stopped','failed'].includes(flow.state) ? 'resume' : 'stop')">
        {{ t(['stopped','failed'].includes(flow.state) ? 'person.resume' : 'person.stopFlow') }}
      </NButton>
    </header>
    <div class="flow-overview" aria-live="polite">
      <p>{{ summary }}</p><span>{{ t('person.flowRoleProgress',{ completed,total:flow.stages.length }) }}</span>
    </div>
    <NProgress type="line" :percentage="Math.round(completed / Math.max(1,flow.stages.length) * 100)" :show-indicator="false" :height="3" color="var(--success)" />
    <NAlert v-if="flow.error" type="warning" class="flow-error">{{ flow.error }}</NAlert>
    <ol class="flow-graph">
      <li v-for="(group,index) in groups" :key="group.position" class="flow-group" :class="{ 'flow-group--parallel':group.stages.length > 1, 'flow-group--last':index === groups.length - 1, 'flow-group--wrapped':group.stages.length > 3 }" :style="{ '--flow-columns':Math.min(3,group.stages.length) }">
        <div class="flow-group-heading">
          <span class="flow-step-number" aria-hidden="true">{{ index + 1 }}</span>
          <h4>{{ t('person.flowStep',{ number:index + 1 }) }}</h4>
          <span v-if="group.stages.length > 1" class="flow-parallel-label">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="M12 3v5M5 15v-5h14v5M5 19v2m14-2v2M2 15h6v4H2zm14 0h6v4h-6z" /></svg>
            {{ t('person.parallelRoles',{ count:group.stages.length }) }}
          </span>
          <span class="flow-group-progress">{{ t('person.flowGroupProgress',{ completed:group.completed,total:group.stages.length }) }}</span>
        </div>
        <div class="flow-branches">
          <div v-for="stage in group.stages" :key="stage.id" class="flow-lane">
            <section class="flow-role" :class="`flow-role--${status(stage)}`" data-theme-surface="card" :aria-label="name(stage)">
              <header class="flow-role-header">
                <img class="flow-role-avatar" :src="avatar(stage).src" :style="personAvatarStyle(avatar(stage))" alt="" width="48" height="48" />
                <div class="flow-role-identity">
                  <button type="button" class="flow-role-name" :aria-label="t('person.flowOpenConversation',{ name:name(stage) })" @click="emit('openConversation',stage.session_id)">{{ name(stage) }}</button>
                  <span class="flow-status" :class="`flow-status--${status(stage)}`" role="status">
                    <SessionTaskIcon :name="stage.state === 'completed' ? 'completed' : 'circle'" :size="12" />{{ label(status(stage)) }}
                  </span>
                </div>
              </header>
              <p class="flow-role-goal">{{ stage.goal }}</p>
              <p v-if="stage.state === 'pending'" class="flow-dependency"><SessionTaskIcon :size="13" name="circle" />{{ dependencyLabel(stage) }}</p>
              <p v-else-if="stage.delivery_error" class="flow-dependency flow-dependency--error">{{ stage.delivery_error }}</p>
              <details v-if="stage.tasks.length" class="flow-worker-details">
                <summary><SessionTaskIcon :size="14" /><span>{{ t('person.flowWorkerTasks',{ count:stage.tasks.length }) }}</span><SessionTaskIcon name="chevron-down" :size="12" /></summary>
                <ul><li v-for="task in stage.tasks" :key="task.id">
                  <button type="button" class="flow-worker" @click="emit('openTask',task.id)">
                    <img :src="chatSessionAgentAvatar({ agent:task.agent || 'ekko-agent' }).src" alt="" width="22" height="22" />
                    <span>{{ task.title }}<small>{{ t(`person.states.${task.execution_state || task.status}`) }}</small></span><SessionTaskIcon name="open" :size="12" />
                  </button>
                </li></ul>
              </details>
              <div v-if="stage.result_message_id" class="flow-role-footer">
                <NButton text size="small" type="primary" @click="emit('openResult',stage.session_id,stage.result_message_id)">{{ t('person.viewResult') }}<template #icon><SessionTaskIcon name="open" :size="14" /></template></NButton>
              </div>
            </section>
          </div>
        </div>
        <div v-if="groups[index + 1]" class="flow-handoff">
          <SessionTaskIcon name="arrow-down" :size="17" /><span>{{ t('person.flowNextRoles',{ names:names(groups[index + 1].stages) }) }}</span>
          <small v-if="group.position === flow.current_position && group.completed < group.stages.length && flow.state === 'active'">{{ t('person.waitingForRoles') }}</small>
        </div>
      </li>
    </ol>
  </article>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;
@use '@/styles/person-avatar' as person-avatar;
@use '../tasks/task-status' as task-status;

.flow-card { padding: 26px; margin-bottom: 24px; border: var(--border-width, 1px) solid $border-light; border-radius: var(--radius-component, 16px); color: $text-primary; }
.flow-card--embedded { padding: 18px; margin: 0; border: 0; border-radius: 0; }
.flow-card--embedded .flow-description { margin-top: 0; }
.flow-card--embedded .flow-overview { margin-top: 16px; }
.flow-header { display: flex; align-items: flex-start; justify-content: space-between; gap: 24px; }
.flow-heading { min-width: 0; }
.flow-heading > .flow-status { margin-bottom: 12px; }
.flow-heading h3 { margin: 0; font-size: 21px; font-weight: 600; line-height: 1.45; letter-spacing: -.4px; overflow-wrap: anywhere; }
.flow-description { margin: 9px 0 0; max-width: 75ch; color: $text-secondary; font-size: 13px; line-height: 1.7; white-space: pre-wrap; overflow-wrap: anywhere; }
.flow-header > .n-button { flex-shrink: 0; }
.flow-overview { display: flex; justify-content: space-between; gap: 16px; align-items: baseline; margin: 25px 0 11px; font-size: 12px; color: $text-secondary; }
.flow-overview p { margin: 0; overflow-wrap: anywhere; }
.flow-overview > span { flex-shrink: 0; font-variant-numeric: tabular-nums; color: $text-muted; }
.flow-error { margin-top: 16px; }
.flow-graph { display: flex; flex-direction: column; padding: 0; margin: 28px auto 0; list-style: none; max-width: 1040px; }
.flow-group { min-width: 0; --flow-gap: 16px; }
.flow-group-heading { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; min-height: 28px; margin-bottom: 16px; }
.flow-step-number { display: grid; place-items: center; width: 23px; height: 23px; border: 1px solid $border-light; border-radius: 50%; font-size: 11px; color: $text-muted; font-variant-numeric: tabular-nums; }
.flow-group-heading h4 { margin: 0; font-size: 12px; font-weight: 600; }
.flow-parallel-label { display: inline-flex; align-items: center; gap: 5px; margin-inline-start: 7px; color: $text-secondary; font-size: 11px; }
.flow-group-progress { margin-inline-start: auto; font-size: 11px; color: $text-muted; font-variant-numeric: tabular-nums; }
.flow-branches { position: relative; display: grid; grid-template-columns: repeat(var(--flow-columns), minmax(0, 1fr)); gap: var(--flow-gap); }
.flow-group:not(.flow-group--parallel) .flow-branches { max-width: 440px; margin-inline: auto; }
.flow-group--parallel .flow-branches { padding-block: 20px; }
.flow-group--parallel .flow-branches::before, .flow-group--parallel .flow-branches::after { content: ''; position: absolute; inset-inline: calc((100% - (var(--flow-columns) - 1) * var(--flow-gap)) / var(--flow-columns) / 2); border-top: 1px solid $border-light; }
.flow-group--parallel .flow-branches::before { top: 0; }
.flow-group--parallel .flow-branches::after { bottom: 0; }
.flow-lane { position: relative; min-width: 0; display: flex; }
.flow-group--parallel .flow-lane::before, .flow-group--parallel .flow-lane::after { content: ''; position: absolute; inset-inline-start: 50%; height: 20px; border-inline-start: 1px solid $border-light; }
.flow-group--parallel .flow-lane::before { top: -20px; }
.flow-group--parallel .flow-lane::after { bottom: -20px; }
.flow-group--last .flow-branches::after, .flow-group--last .flow-lane::after { display: none; }
.flow-group--last.flow-group--parallel .flow-branches { padding-bottom: 0; }
.flow-group--wrapped .flow-branches { padding: 0; }
.flow-group--wrapped .flow-branches::before, .flow-group--wrapped .flow-branches::after, .flow-group--wrapped .flow-lane::before, .flow-group--wrapped .flow-lane::after { display: none; }
.flow-role { display: flex; flex-direction: column; gap: 14px; flex: 1; min-width: 0; min-height: 175px; padding: 20px; background: $bg-card; border: var(--border-width, 1px) solid $border-light; border-radius: var(--radius-component, 12px); }
.flow-role--active, .flow-role--running { border-color: rgba(var(--accent-info-rgb), .45); }
.flow-role--blocked { border-color: rgba(var(--error-rgb), .45); }
.flow-role-header { display: flex; align-items: center; gap: 12px; min-width: 0; }
.flow-role-avatar { @include person-avatar.person-avatar(48px); flex-shrink: 0; }
.flow-role-identity { display: flex; flex-direction: column; align-items: flex-start; gap: 5px; min-width: 0; }
.flow-role-name { padding: 0; border: 0; background: transparent; color: $text-primary; font: inherit; font-size: 14px; line-height: 1.5; font-weight: 600; text-align: start; overflow-wrap: anywhere; cursor: pointer; }
.flow-role-name:hover { text-decoration: underline; text-underline-offset: 3px; }
.flow-role-name:focus-visible, .flow-worker:focus-visible, summary:focus-visible { outline: 2px solid $accent-primary; outline-offset: 4px; border-radius: var(--radius-component, 4px); }
.flow-role-goal { margin: 0; font-size: 13px; line-height: 1.75; color: $text-secondary; white-space: pre-wrap; overflow-wrap: anywhere; }
.flow-status { @include task-status.badge; padding: 2px 7px; font-size: 10px; }
.flow-status--completed { @include task-status.completed; }
.flow-status--active, .flow-status--running { color: var(--accent-info); background: rgba(var(--accent-info-rgb), .07); border-color: transparent; }
.flow-status--blocked { color: $error; background: rgba(var(--error-rgb), .07); border-color: transparent; }
.flow-status--waiting_user, .flow-status--waiting_approval, .flow-status--waiting_person { color: $warning; background: rgba(var(--warning-rgb), .07); border-color: transparent; }
.flow-status--interrupted, .flow-status--waiting_dependencies, .flow-status--waiting_reply { color: $text-muted; }
.flow-dependency { display: flex; align-items: flex-start; gap: 6px; margin: 0; font-size: 11px; line-height: 1.7; color: $text-muted; overflow-wrap: anywhere; }
.flow-dependency svg { flex-shrink: 0; margin-top: 3px; }
.flow-dependency--error { color: $error; }
.flow-role-footer { margin-top: auto; }
.flow-worker-details { margin-top: auto; padding-top: 10px; border-top: 1px solid $border-light; }
summary { display: flex; align-items: center; gap: 7px; list-style: none; font-size: 11px; line-height: 1.7; color: $text-muted; cursor: pointer; }
summary::-webkit-details-marker { display: none; }
summary span { flex: 1; }
details[open] summary > svg:last-child { transform: rotate(180deg); }
.flow-worker-details ul { padding: 0; margin: 10px 0 0; list-style: none; }
.flow-worker { display: flex; align-items: center; gap: 8px; width: 100%; padding: 5px 0; border: 0; background: transparent; font: inherit; color: $text-secondary; text-align: start; cursor: pointer; }
.flow-worker > img, .flow-worker > svg { flex-shrink: 0; object-fit: contain; }
.flow-worker > span { flex: 1; min-width: 0; font-size: 11px; overflow-wrap: anywhere; }
.flow-worker small { display: block; margin-top: 3px; font-size: 10px; color: $text-muted; }
.flow-handoff { display: flex; flex-direction: column; align-items: center; gap: 6px; padding: 16px 0 22px; font-size: 11px; color: $text-secondary; }
.flow-handoff > svg { color: $text-muted; }
.flow-handoff small { font-size: 10px; color: $text-muted; }
@media (max-width: 640px) {
  .flow-card { padding: 17px 14px; }
  .flow-header { gap: 12px; }
  .flow-heading h3 { font-size: 18px; }
  .flow-description { font-size: 12px; }
  .flow-header > .n-button { font-size: 11px; }
  .flow-overview { align-items: flex-start; flex-direction: column; gap: 5px; margin-top: 18px; }
  .flow-group { --flow-gap: 12px; }
  .flow-parallel-label { margin-inline-start: 0; }
  .flow-group-progress { font-size: 10px; }
  .flow-branches { grid-template-columns: minmax(0, 1fr); }
  .flow-group--parallel .flow-branches { padding: 0; padding-inline-start: 14px; border-inline-start: 1px solid $border-light; }
  .flow-group--parallel .flow-branches::before, .flow-group--parallel .flow-branches::after, .flow-group--parallel .flow-lane::after { display: none; }
  .flow-group--parallel .flow-lane::before { inset-inline-start: -14px; top: 50%; width: 14px; height: 0; border-inline-start: 0; border-top: 1px solid $border-light; }
  .flow-role { padding: 16px; min-height: 0; gap: 12px; }
  .flow-handoff { padding-block: 14px 18px; }
}
</style>
