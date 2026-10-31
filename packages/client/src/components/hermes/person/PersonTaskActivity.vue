<script setup lang="ts">
import PersonActivityFlow from './PersonActivityFlow.vue'
import { computed, onMounted, onBeforeUnmount, ref, watch, useId } from 'vue'
import { useI18n } from 'vue-i18n'
import { usePageLoadingState } from '@/composables/usePageLoading'
import { PERSON_ANIMATIONS, PERSON_AVATAR, personAvatarAnimation, type ChatAgentAvatar } from '@/utils/chat-agent-avatar'

import { personBot } from '../../../../../shared/person-bots'
import { deploymentUrl } from '@/utils/deployment-url'
import type { PersonTask, PersonFlow } from '@/api/person'
import { activityTasks, activityFlows, standaloneActivityTasks, attentionStates } from '@/utils/person-activity'
const props = withDefaults(defineProps<{ count?: number; avatar?: ChatAgentAvatar; tasks?: PersonTask[]; flows?: PersonFlow[]; scope?: string }>(), { tasks: () => [], flows: () => [] })
const emit = defineEmits<{ task: [id: string]; flow: [id: string, stageId?: string] }>()
const { t, locale } = useI18n()
const pageLoading = usePageLoadingState()
const avatar = computed(() => props.avatar || PERSON_AVATAR)
const opened = ref(false)
const root = ref<HTMLElement>()
const contentId = useId()
const availableWidth = ref(700)
const flowWidths = ref<Record<string, number>>({})
let containerObserver: ResizeObserver | undefined
function rememberFlowWidth(id: string, width: number) {
  if (flowWidths.value[id] !== width) flowWidths.value = { ...flowWidths.value, [id]: width }
}
const active = computed(() => activityTasks(props.tasks))
const flows = computed(() => activityFlows(props.flows, active.value))
const standalone = computed(() => standaloneActivityTasks(active.value, flows.value))
type Completion = { id: string; title: string; key: string }
const completions = ref<Completion[]>([])
let completionTimer: ReturnType<typeof setTimeout> | undefined
let previousTasks = new Map<string, { done: boolean; execution: string }>()
let completionScope = props.scope
const completion = computed(() => completions.value[0])
function advanceCompletion() {
  if (completionTimer || !completions.value.length) return
  completionTimer = setTimeout(() => {
    completions.value.shift(); completionTimer = undefined; advanceCompletion()
  }, 3200)
}
watch(() => [props.scope, props.tasks, props.flows] as const, () => {
  if (completionScope !== props.scope) {
    completionScope = props.scope; previousTasks.clear(); completions.value = []
    clearTimeout(completionTimer); completionTimer = undefined
  }
  const items = new Map(props.flows.flatMap(flow => flow.stages.flatMap(stage => stage.tasks)).map(task => [task.id, task]))
  for (const task of props.tasks) items.set(task.id, task)
  for (const task of items.values()) {
    const done = task.status === 'completed' || task.execution_state === 'finished'
    const execution = ('execution_id' in task ? String(task.execution_id || '') : '')
    const previous = previousTasks.get(task.id)
    if (done && previous && !previous.done && (!previous.execution || !execution || previous.execution === execution)) {
      const key = `${task.id}:${execution}`
      if (!completions.value.some(item => item.key === key)) completions.value.push({ id: task.id, title: task.title, key })
    }
    previousTasks.set(task.id, { done, execution })
  }
  advanceCompletion()
}, { deep: true, immediate: true })
const finishing = ref(false)
let finishTimer: ReturnType<typeof setTimeout> | undefined
const hasWork = computed(() => active.value.length > 0 || flows.value.length > 0)
watch(() => ({ tasks: active.value.map(task => task.id), flows: flows.value.map(flow => flow.id) }), (current, previous) => {
  if (current.tasks.length || current.flows.length) { clearTimeout(finishTimer); finishing.value = false; return }
  if (!previous || !(previous.tasks.length || previous.flows.length)) return
  const completed = previous.tasks.every(id => props.tasks.some(task => task.id === id && (task.status === 'completed' || task.execution_state === 'finished'))) &&
    previous.flows.every(id => props.flows.some(flow => flow.id === id && flow.state === 'completed'))
  clearTimeout(finishTimer)
  finishing.value = completed
  if (completed) finishTimer = setTimeout(() => { finishing.value = false }, 3000)
})
const visible = computed(() => hasWork.value || finishing.value || !!completion.value)
watch(visible, value => { if (!value) opened.value = false })
watch(() => props.scope, () => { opened.value = false; finishing.value = false; clearTimeout(finishTimer); clearTimeout(completionTimer); completionTimer = undefined; flowWidths.value = {} })
const state = computed(() => completion.value || finishing.value ? 'done' : active.value.some(task => ['failed', 'interrupted'].includes(task.execution_state)) || flows.value.some(flow => flow.state === 'failed') ? 'error' : active.value.some(task => attentionStates.has(task.execution_state)) ? 'thinking' : 'searching')
const animation = computed(() => personAvatarAnimation(avatar.value, state.value) || PERSON_ANIMATIONS[state.value])
function dismiss(event: Event) { if (!root.value?.contains(event.target as Node)) opened.value = false }
function keydown(event: KeyboardEvent) { if (event.key === 'Escape' && opened.value) { opened.value = false; if (root.value?.contains(document.activeElement)) root.value?.querySelector<HTMLButtonElement>('button')?.focus() } }
function selectTask(id: string) { opened.value = false; emit('task', id) }
function selectFlow(id: string, stageId?: string) { opened.value = false; emit('flow', id, stageId) }
const expandedWidth = computed(() => Math.max(280, standalone.value.length ? 420 : 0, ...flows.value.map(flow => (flowWidths.value[flow.id] || 280) + 28)))
function taskImage(task: PersonTask) {
  const bot = personBot(task.bot_type)
  const state = ['failed', 'interrupted'].includes(task.execution_state) ? 'error' : ['starting', 'running', 'stopping'].includes(task.execution_state) ? 'searching' : 'sleeping'
  if (bot) return deploymentUrl(reducedMotion.value ? bot.avatar : bot.animations[state])
  // Old servers may omit identity: use a neutral still, never another BOT's working animation.
  return PERSON_AVATAR.src
}
const activityLabel = computed(() => `${avatar.value.label} · ${t('person.backgroundTasks')} · ${standalone.value.length.toLocaleString(locale.value)} · ${t('person.flows')} · ${flows.value.length.toLocaleString(locale.value)}`)
const reducedMotion = ref(false)
let motionQuery: MediaQueryList | undefined
function syncMotion() { reducedMotion.value = motionQuery?.matches ?? false }
onMounted(() => {
  const measureContainer = () => { availableWidth.value = Math.max(240, (root.value?.parentElement?.clientWidth || 724) - 24) }
  measureContainer()
  if (typeof ResizeObserver !== 'undefined' && root.value?.parentElement) {
    containerObserver = new ResizeObserver(measureContainer)
    containerObserver.observe(root.value.parentElement)
  }
  document.addEventListener('pointerdown', dismiss)
  document.addEventListener('keydown', keydown)
  motionQuery = window.matchMedia('(prefers-reduced-motion: reduce)')
  syncMotion()
  motionQuery.addEventListener('change', syncMotion)
})
onBeforeUnmount(() => { containerObserver?.disconnect(); motionQuery?.removeEventListener('change', syncMotion); document.removeEventListener('pointerdown', dismiss); document.removeEventListener('keydown', keydown); clearTimeout(finishTimer); clearTimeout(completionTimer); completionTimer = undefined })
</script>

<template>
  <div ref="root" class="person-task-activity" :class="{ 'is-expanded': opened }" :style="{ '--activity-width': `${expandedWidth}px` }">
    <Transition name="person-task-island" appear>
      <section v-if="visible && !pageLoading" class="activity-shell" data-theme-surface="card">
        <button type="button" class="person-task-island" :aria-expanded="opened" :aria-controls="contentId" :aria-label="activityLabel" @click="opened = !opened">
          <span class="person-task-island__avatar-slot" aria-hidden="true"><img class="person-task-island__avatar" :src="reducedMotion ? avatar.src : animation" alt="" width="48" height="48" /></span>
          <span class="person-task-island__label"><span><bdi class="activity-count">{{ standalone.length.toLocaleString(locale) }}</bdi> {{ t('person.backgroundTasks') }}</span><span><bdi class="activity-count">{{ flows.length.toLocaleString(locale) }}</bdi> {{ t('person.flows') }}</span><span v-if="completion && !opened" class="activity-completion-compact" role="status" :title="`${t('person.states.finished')} · ${completion.title}`">✓ {{ t('person.states.finished') }} · <bdi>{{ completion.title }}</bdi></span></span>
          <span aria-hidden="true">{{ opened ? '−' : '+' }}</span>
        </button>
        <Transition name="activity-completion" mode="out-in">
          <button v-if="completion && opened" :key="completion.key" class="activity-completion" @click="selectTask(completion.id)">
            <span aria-hidden="true">✓</span><span role="status">{{ t('person.states.finished') }} · <bdi>{{ completion.title }}</bdi></span><span aria-hidden="true">›</span>
          </button>
        </Transition>
        <Transition name="activity-content">
          <div v-if="opened" :id="contentId" class="activity-content">
            <div class="activity-scroll">
              <button v-for="task in standalone" :key="task.id" class="activity-row" type="button" :title="task.title" @click="selectTask(task.id)">
                <img :src="taskImage(task)" alt="" width="40" height="40" /><span class="activity-task-text"><strong dir="auto">{{ task.title }}</strong><small>{{ t(`person.states.${task.execution_state || 'pending'}`) }}</small><small v-if="task.summary" class="activity-task-summary" :title="task.summary" dir="auto">{{ task.summary }}</small></span><span class="activity-row-chevron" aria-hidden="true">›</span>
              </button>
              <PersonActivityFlow v-for="flow in flows" :key="flow.id" :flow="flow" :max-width="availableWidth - 28" :reduced-motion="reducedMotion" :fallback-avatar="avatar.src" @flow="selectFlow" @resize="rememberFlowWidth(flow.id, $event)" />
              <p v-if="finishing" role="status">{{ t('person.states.finished') }}</p>
            </div>
          </div>
        </Transition>
      </section>
    </Transition>
  </div>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;
.person-task-activity { position:absolute; z-index:5; top:12px; left:50%; width:min(300px,calc(100% - 24px)); transform:translateX(-50%); pointer-events:none; transition:width 320ms cubic-bezier(.22,1,.36,1); }
.person-task-activity.is-expanded { width:min(var(--activity-width,420px),calc(100% - 24px)); }
.activity-shell { background:$bg-card; border:0; border-radius:28px; overflow:hidden; pointer-events:auto; }
.person-task-island { display:flex; align-items:center; gap:12px; width:100%; min-height:64px; padding:8px 18px 8px 8px; border:0; border-radius:28px; background:transparent; color:$text-primary; cursor:pointer; -webkit-app-region:no-drag; font:inherit; text-align:start; -webkit-tap-highlight-color:transparent; }
.person-task-island__avatar-slot { width:48px; height:48px; flex:none; }
.person-task-island__avatar { object-fit:contain; }
.person-task-island__label { display:flex; flex-direction:column; flex:1; min-width:0; gap:2px; }
.person-task-island__label > span { font-size:13px; line-height:1.5; color:$text-secondary; overflow-wrap:anywhere; }
.person-task-island__label .activity-count { color:$text-primary; font-size:16px; font-weight:600; font-variant-numeric:tabular-nums; margin-inline-end:6px; }
.person-task-island__label .activity-completion-compact { color:$accent-primary; font-size:12px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.activity-content { padding:0 14px 14px; }
.activity-scroll { max-height:min(65vh,640px); overflow-y:auto; overscroll-behavior:contain; }
.activity-row { display:flex; align-items:center; gap:12px; width:100%; padding:12px 4px; border:0; border-radius:12px; background:transparent; color:$text-primary; font:inherit; text-align:start; cursor:pointer; }
.activity-row > img, .activity-row > span:last-child { flex:none; }
.activity-row:dir(rtl) > .activity-row-chevron { transform:scaleX(-1); }
.activity-row:hover { background:$bg-card-hover; }
.activity-task-text { flex:1; min-width:0; display:grid; gap:4px; }
.activity-task-text strong { font-size:14px; line-height:1.5; overflow-wrap:anywhere; }
.activity-task-text small { font-size:12px; line-height:1.5; color:$text-secondary; overflow-wrap:anywhere; }
.activity-task-summary { display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; overflow:hidden; }
.person-task-island:focus-visible, .activity-row:focus-visible, .activity-completion:focus-visible { outline:2px solid $accent-primary; outline-offset:-3px; }
.activity-completion { display:flex; align-items:center; gap:8px; width:100%; padding:6px 18px 12px; border:0; background:transparent; color:$accent-primary; font:inherit; font-size:13px; text-align:start; cursor:pointer; }
.activity-completion > span:nth-child(2) { flex:1; overflow-wrap:anywhere; }
.person-task-island-enter-active, .person-task-island-leave-active { transition:opacity 180ms,transform 240ms; }
.person-task-island-enter-from, .person-task-island-leave-to { opacity:0; transform:translateY(-5px) scale(.97); }
.activity-content-enter-active, .activity-content-leave-active, .activity-completion-enter-active, .activity-completion-leave-active { transition:opacity 180ms,transform 220ms; }
.activity-content-enter-from, .activity-content-leave-to, .activity-completion-enter-from, .activity-completion-leave-to { opacity:0; transform:translateY(-4px); }
@media(prefers-reduced-motion:reduce) { .person-task-activity, .person-task-island-enter-active, .person-task-island-leave-active, .activity-content-enter-active, .activity-content-leave-active, .activity-completion-enter-active, .activity-completion-leave-active { transition:none; } }
</style>
