<script setup lang="ts">
import PersonActivityPath from './PersonActivityPath.vue'
import { computed, onMounted, onBeforeUnmount, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { usePageLoadingState } from '@/composables/usePageLoading'
import { PERSON_ANIMATIONS, PERSON_AVATAR, personAvatarAnimation, type ChatAgentAvatar } from '@/utils/chat-agent-avatar'

import { personBot } from '../../../../../shared/person-bots'
import { deploymentUrl } from '@/utils/deployment-url'
import type { PersonTask, PersonFlow } from '@/api/person'
import { activityTasks, activityFlows, standaloneActivityTasks, attentionStates } from '@/utils/person-activity'
import { personFlowGroups, personFlowStageStatus, personFlowStatusKey } from '@/utils/person-flow'
const props = withDefaults(defineProps<{ count: number; expanded?: boolean; avatar?: ChatAgentAvatar; tasks?: PersonTask[]; flows?: PersonFlow[]; scope?: string }>(), { tasks: () => [], flows: () => [] })
const emit = defineEmits<{ open: []; task: [id: string]; flow: [id: string] }>()
const { t, locale } = useI18n()
const pageLoading = usePageLoadingState()
const avatar = computed(() => props.avatar || PERSON_AVATAR)
const opened = ref(false)
const root = ref<HTMLElement>()
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
const hasWork = computed(() => active.value.length > 0 || flows.value.length > 0 || props.count > 0)
watch(hasWork, (value, previous) => {
  clearTimeout(finishTimer)
  finishing.value = !value && previous
  if (finishing.value) finishTimer = setTimeout(() => { finishing.value = false; opened.value = false }, 3000)
})
watch(() => props.scope, () => { opened.value = false; finishing.value = false; clearTimeout(finishTimer); clearTimeout(completionTimer) })
const state = computed(() => completion.value || finishing.value ? 'done' : active.value.some(task => ['failed', 'interrupted'].includes(task.execution_state)) || flows.value.some(flow => flow.state === 'failed') ? 'error' : active.value.some(task => attentionStates.has(task.execution_state)) ? 'thinking' : 'searching')
const animation = computed(() => personAvatarAnimation(avatar.value, state.value) || PERSON_ANIMATIONS[state.value])
function dismiss(event: Event) { if (!root.value?.contains(event.target as Node)) opened.value = false }
function keydown(event: KeyboardEvent) { if (event.key === 'Escape' && opened.value) { opened.value = false; if (root.value?.contains(document.activeElement)) root.value?.querySelector<HTMLButtonElement>('button')?.focus() } }
function selectTask(id: string) { opened.value = false; emit('task', id) }
function stageImage(flow: PersonFlow, stage: PersonFlow['stages'][number]) {
  const bot = personBot(stage.bot_type)
  if (!bot) return avatar.value.src
  if (reducedMotion.value) return deploymentUrl(bot.avatar)
  const status = personFlowStageStatus(flow, stage)
  const animation = status === 'completed' ? 'done' : ['blocked', 'interrupted'].includes(status) ? 'error' : ['running', 'active'].includes(status) ? 'searching' : 'sleeping'
  return deploymentUrl(bot.animations[animation])
}
function stageClick(flow: PersonFlow, stage: PersonFlow['stages'][number]) {
  const tasks = stage.tasks.filter(task => task.status !== 'closed')
  if (tasks.length === 1) selectTask(tasks[0].id)
  else { opened.value = false; emit('flow', flow.id) }
}
function groupStyle(index: number) {
  const row = Math.floor(index / 3)
  const column = row % 2 ? 2 - index % 3 : index % 3
  return { left: `${90 + column * 220}px`, top: `${row * 160 + 14}px` }
}
function snakePath(count: number) {
  let path = 'M90 128'
  for (let index = 1; index < count; index++) {
    const row = Math.floor(index / 3)
    const column = row % 2 ? 2 - index % 3 : index % 3
    const x = 90 + column * 220, y = row * 160 + 128
    if (index % 3) path += ` H${x}`
    else { const edge = row % 2 ? 638 : -18; path += ` C${edge} ${y - 160} ${edge} ${y} ${x} ${y}` }
  }
  return path
}
function taskImage(task: PersonTask) {
  const bot = personBot(task.bot_type)
  const state = ['failed', 'interrupted'].includes(task.execution_state) ? 'error' : ['starting', 'running', 'stopping'].includes(task.execution_state) ? 'searching' : 'sleeping'
  if (bot) return deploymentUrl(reducedMotion.value ? bot.avatar : bot.animations[state])
  // Old servers may omit identity: use a neutral still, never another BOT's working animation.
  return PERSON_AVATAR.src
}
const formattedCount = computed(() => Math.max(props.count, active.value.length, flows.value.length).toLocaleString(locale.value))
const reducedMotion = ref(false)
let motionQuery: MediaQueryList | undefined
function syncMotion() { reducedMotion.value = motionQuery?.matches ?? false }
onMounted(() => {
  document.addEventListener('pointerdown', dismiss)
  document.addEventListener('keydown', keydown)
  motionQuery = window.matchMedia('(prefers-reduced-motion: reduce)')
  syncMotion()
  motionQuery.addEventListener('change', syncMotion)
})
onBeforeUnmount(() => { motionQuery?.removeEventListener('change', syncMotion); document.removeEventListener('pointerdown', dismiss); document.removeEventListener('keydown', keydown); clearTimeout(finishTimer); clearTimeout(completionTimer) })
</script>

<template>
  <div ref="root" class="person-task-activity" :class="{ 'is-expanded': opened }">
    <Transition name="person-task-island" appear>
      <section v-if="(hasWork || finishing || completion) && !pageLoading" class="activity-shell" data-theme-surface="card">
        <button type="button" class="person-task-island" :aria-expanded="opened" :aria-label="`${avatar.label} · ${t('person.backgroundTasks')} · ${formattedCount}`" @click="opened = !opened">
          <span class="person-task-island__avatar-slot" aria-hidden="true"><img class="person-task-island__avatar" :src="reducedMotion ? avatar.src : animation" alt="" width="48" height="48" /></span>
          <span class="person-task-island__label"><span><b>{{ standalone.length.toLocaleString(locale) }}</b> {{ t('person.backgroundTasks') }}</span><span><b>{{ flows.length.toLocaleString(locale) }}</b> {{ t('person.flows') }}</span></span>

          <span aria-hidden="true">{{ opened ? '−' : '+' }}</span>
        </button>
        <Transition name="activity-completion" mode="out-in">
          <button v-if="completion" :key="completion.key" class="activity-completion" @click="selectTask(completion.id)">
            <span aria-hidden="true">✓</span><span role="status">{{ t('person.states.finished') }} · {{ completion.title }}</span><span aria-hidden="true">›</span>
          </button>
        </Transition>
        <Transition name="activity-content">
          <div v-if="opened" class="activity-content">
            <div class="activity-scroll">
              <button v-for="task in standalone" :key="task.id" class="activity-row" @click="selectTask(task.id)">
                <img :src="taskImage(task)" alt="" width="40" height="40" /><span class="activity-task-text"><strong>{{ task.title }}</strong><small>{{ t(`person.states.${task.execution_state || 'pending'}`) }}</small><small v-if="task.summary">{{ task.summary }}</small></span><span>›</span>
              </button>
              <section v-for="flow in flows" :key="flow.id" class="activity-flow">
                <button class="activity-row activity-flow-title" @click="opened = false; emit('flow', flow.id)"><strong>{{ flow.title }}</strong><span>›</span></button>
                <div class="activity-snake-scroll">
                  <div class="activity-snake" :style="{ height: `${Math.ceil(personFlowGroups(flow).length / 3) * 160}px` }">
                    <svg width="648" :height="Math.ceil(personFlowGroups(flow).length / 3) * 160" aria-hidden="true">
                      <PersonActivityPath :path="snakePath(personFlowGroups(flow).length)" :progress-path="snakePath(personFlowGroups(flow).filter(group => flow.state === 'completed' || group.position <= flow.current_position).length)" />
                    </svg>
                    <ol class="activity-stages">
                      <li v-for="(group, index) in personFlowGroups(flow)" :key="group.position" :style="groupStyle(index)" :class="{ current: group.position === flow.current_position, done: group.completed === group.stages.length }">
                        <span class="activity-stage-marker">{{ index + 1 }}</span>
                        <div class="activity-bots">
                          <button v-for="stage in group.stages" :key="stage.id" class="activity-stage" @click="stageClick(flow, stage)">
                            <img :src="stageImage(flow, stage)" alt="" width="48" height="48" />
                            <span>{{ stage.session_title || stage.goal }}</span>
                            <small>{{ t(personFlowStatusKey(personFlowStageStatus(flow, stage))) }}</small>
                          </button>
                        </div>
                      </li>
                    </ol>
                  </div>
                </div>
              </section>
              <p v-if="finishing" role="status">{{ t('person.states.finished') }}</p>
            </div>
            <button class="activity-all" @click="opened = false; emit('open')">{{ t('person.tasks') }} ›</button>
          </div>
        </Transition>
      </section>
    </Transition>
  </div>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;

.person-task-activity {
  position: absolute;
  z-index: 5;
  top: 12px;
  left: 50%;
  width: min(280px, calc(100% - 32px));
  transform: translateX(-50%);
  pointer-events: none;
}
.person-task-island {
  position: relative;
  display: flex;
  align-items: center;
  gap: 12px;
  width: 100%;
  height: 60px;
  padding: 5px 18px 5px 6px;
  border: 0;
  border-radius: 999px;
  background: transparent;
  color: $text-primary;

  cursor: pointer;
  pointer-events: auto;
  -webkit-app-region: no-drag;
  font: inherit;
  text-align: start;
  -webkit-tap-highlight-color: transparent;
}
.person-task-island:hover { border-color: $accent-primary; }
.person-task-island:focus-visible { outline: 2px solid $accent-primary; outline-offset: 3px; }
.person-task-island__avatar-slot { width: 48px; height: 48px; flex-shrink: 0; }
.person-task-island__avatar { position: absolute; inset-inline-start: 7px; top: 50%; transform: translateY(-50%); object-fit: contain; border-radius: 50%; }
.person-task-island__label { display: flex; flex: 1; min-width: 0; flex-direction: column; gap: 2px; }
.person-task-island__label strong { font-size: 14px; font-weight: 600; letter-spacing: .2px; }
.person-task-island__label > span { color: $text-secondary; font-size: 11px; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.person-task-island__count { font-size: 22px; font-weight: 600; font-variant-numeric: tabular-nums; color: $accent-primary; }
.person-task-island__chevron { flex-shrink: 0; color: $text-muted; }
.person-task-island-enter-active { transition: clip-path 460ms cubic-bezier(.22, 1, .36, 1), transform 460ms cubic-bezier(.22, 1, .36, 1), opacity 180ms ease; }
.person-task-island-leave-active { transition: clip-path 240ms ease-in, transform 240ms ease-in, opacity 180ms ease-in; }
.person-task-island-enter-from, .person-task-island-leave-to { clip-path: inset(0 calc(50% - 24px) round 999px); transform: translateY(-5px); opacity: 0; }
.person-task-island-enter-to, .person-task-island-leave-from { clip-path: inset(0 0 round 999px); transform: translateY(0); opacity: 1; }
.person-task-island-enter-active .person-task-island__avatar { transition: inset-inline-start 460ms cubic-bezier(.22, 1, .36, 1); }
.person-task-island-leave-active .person-task-island__avatar { transition: inset-inline-start 240ms ease-in; }
.person-task-island-enter-from .person-task-island__avatar, .person-task-island-leave-to .person-task-island__avatar { inset-inline-start: calc(50% - 24px); }
.person-task-island-enter-active :is(.person-task-island__label, .person-task-island__count, .person-task-island__chevron) { transition: opacity 180ms ease 140ms; }
.person-task-island-enter-from :is(.person-task-island__label, .person-task-island__count, .person-task-island__chevron) { opacity: 0; }
@media (prefers-reduced-motion: reduce) {
  .person-task-island-enter-active, .person-task-island-leave-active { transition: none; }
  .person-task-island-enter-active :is(.person-task-island__avatar, .person-task-island__label, .person-task-island__count, .person-task-island__chevron), .person-task-island-leave-active .person-task-island__avatar { transition: none; }
}

.person-task-activity { transition: width 360ms cubic-bezier(.22,1,.36,1); }
.person-task-activity.is-expanded { width: min(440px, calc(100% - 24px)); }
.activity-shell { background: $bg-card; border: var(--border-width, 1px) solid $border-color; border-radius: 30px; overflow: hidden; pointer-events: auto; }
.activity-content { padding: 0 14px 12px; }
.activity-scroll { max-height: min(48vh, 400px); overflow-y: auto; overscroll-behavior: contain; }
.activity-row { display:flex; align-items:center; justify-content:space-between; gap:10px; width:100%; padding:10px 4px; border:0; background:transparent; color:$text-primary; font:inherit; text-align:start; cursor:pointer; }
.activity-row:hover, .activity-all:hover { color:$accent-primary; }
.activity-row:focus-visible, .activity-all:focus-visible { outline:2px solid $accent-primary; outline-offset:-2px; }
.activity-task-text { display:grid; gap:4px; min-width:0; }
.activity-task-text strong, .activity-stage > span { overflow-wrap:anywhere; }
.activity-task-text small { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.activity-content small { color:$text-secondary; font-size:11px; }
.activity-flow + .activity-flow, .activity-row + .activity-row { border-top:1px solid $border-color; }
.activity-stages { list-style:none; padding:0 0 0 6px; margin:0; }
.activity-stages > li { display:flex; gap:10px; padding:8px 0; border-inline-start:2px solid $border-color; padding-inline-start:10px; flex-wrap:wrap; }
.activity-stages > li.current { border-color:$accent-primary; }
.activity-stages > li.done { color:$text-muted; }
.activity-role { display:flex; align-items:center; gap:6px; }
.activity-role img { border-radius:50%; object-fit:contain; }
.activity-stage { flex:1 1 130px; display:grid; gap:4px; min-width:0; }
.activity-all { display:block; margin:10px 0 0 auto; border:0; padding:6px; background:transparent; color:$text-secondary; cursor:pointer; font:inherit; }
.activity-label-enter-active, .activity-label-leave-active { transition:opacity 140ms,transform 140ms; }
.activity-label-enter-from { opacity:0; transform:translateY(4px); }
.activity-label-leave-to { opacity:0; transform:translateY(-4px); }
.activity-content-enter-active, .activity-content-leave-active { transition:opacity 180ms,transform 220ms; }
.activity-content-enter-from, .activity-content-leave-to { opacity:0; transform:translateY(-6px); }
@media (prefers-reduced-motion: reduce) { .person-task-activity, .activity-label-enter-active, .activity-label-leave-active, .activity-content-enter-active, .activity-content-leave-active { transition:none; } }

.activity-completion { display:flex; gap:8px; align-items:center; width:100%; padding:8px 18px 12px; border:0; background:transparent; color:$accent-primary; font:inherit; text-align:start; cursor:pointer; }
.activity-completion > span:nth-child(2) { flex:1; overflow-wrap:anywhere; }
.activity-completion:focus-visible { outline:2px solid $accent-primary; outline-offset:-3px; }
.activity-completion-enter-active, .activity-completion-leave-active { transition:opacity 180ms,transform 260ms; }
.activity-completion-enter-from { opacity:0; transform:translateY(6px); }
.activity-completion-leave-to { opacity:0; transform:translateY(-6px); }
.activity-stage-move, .activity-stage-enter-active, .activity-stage-leave-active { transition:transform 360ms cubic-bezier(.22,1,.36,1),opacity 220ms; }
.activity-stage-enter-from, .activity-stage-leave-to { opacity:0; transform:translateX(-8px); }
.activity-stages > li { transition:border-color 320ms,color 240ms; }
.activity-stage-marker { animation:stage-handoff 420ms cubic-bezier(.22,1,.36,1); }
@keyframes stage-handoff { from { transform:scale(.65); opacity:.3; } to { transform:scale(1); opacity:1; } }
@media (prefers-reduced-motion: reduce) {
 .activity-stage-marker { animation:none; }
 .activity-stages > li, .activity-stage-move, .activity-stage-enter-active, .activity-stage-leave-active, .activity-completion-enter-active, .activity-completion-leave-active { transition:none; }
}

/* Approved capsule: quiet surfaces, compact task rows and an open serpentine map. */
.person-task-activity.is-expanded { width:min(696px,calc(100% - 24px)); }
.activity-shell { border:0; }
.person-task-island__avatar { position:static; transform:none; }
.person-task-island__label b { color:$text-primary; font-size:16px; margin-inline-end:6px; }
.activity-row + .activity-row, .activity-flow + .activity-flow { border:0; }
.activity-task-text { flex:1; }
.activity-scroll { max-height:min(65vh,600px); }
.activity-flow-title { margin-top:16px; }
.activity-snake-scroll { overflow-x:auto; }
.activity-snake { position:relative; width:648px; }
.activity-snake svg { position:absolute; inset:0; pointer-events:none; overflow:visible; }
.activity-track, .activity-progress { fill:none; stroke:$border-color; stroke-width:2; stroke-linecap:round; }
.activity-track { stroke-dasharray:2 6; }
.activity-progress { stroke:$accent-primary; opacity:.55; }
.activity-stages { padding:0; margin:0; list-style:none; }
.activity-stages > li { position:absolute; width:190px; transform:translateX(-50%); display:block; border:0; padding:0; text-align:center; }
.activity-stage-marker { color:$text-muted; font-size:10px; }
.activity-bots { display:flex; justify-content:center; gap:6px; }
.activity-stage { border:0; padding:0; background:transparent; color:$text-primary; font:inherit; cursor:pointer; display:flex; flex-direction:column; align-items:center; flex:0 1 62px; min-width:0; }
.activity-stage img { object-fit:contain; }
.activity-stage > span { font-size:11px; max-width:68px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.activity-stage small { font-size:10px; }
.activity-stage:focus-visible { outline:2px solid $accent-primary; outline-offset:2px; }
</style>
