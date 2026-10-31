<script setup lang="ts">
import { computed, nextTick, onMounted, onBeforeUnmount, ref, useId, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import type { PersonFlow, PersonTask } from '@/api/person'
import { usePageLoadingState } from '@/composables/usePageLoading'
import { useReducedMotion } from '@/composables/useReducedMotion'
import { PERSON_ANIMATIONS, PERSON_AVATAR, personAvatarAnimation, type ChatAgentAvatar } from '@/utils/chat-agent-avatar'
import { personFlowAnimation, personFlowState, personFlowVisibleInActivity } from '@/utils/person-flow'
import SessionTaskIcon from '@/components/common/SessionTaskIcon.vue'
import PersonFlowGraph from './PersonFlowGraph.vue'

const props = defineProps<{ sessionId: string; count: number; tasks: PersonTask[]; flows: PersonFlow[]; flowCount?: number; avatar?: ChatAgentAvatar; name?: string }>()
const emit = defineEmits<{ openTask: [task: PersonTask]; openFlow: [flow: PersonFlow]; refresh: [] }>()
const { t, locale } = useI18n()
const pageLoading = usePageLoadingState()
const reducedMotion = useReducedMotion()
const avatar = computed(() => props.avatar || PERSON_AVATAR)
const name = computed(() => props.name || avatar.value.label)
const animation = computed(() => personAvatarAnimation(avatar.value, 'searching') || PERSON_ANIMATIONS.searching)
const activeFlows = computed(() => props.flows.filter(flow => personFlowVisibleInActivity(flow, props.sessionId)))
const flowsCount = computed(() => props.flowCount ?? activeFlows.value.length)
const activeTasks = computed(() => props.tasks.filter(task => task.status === 'open' && (task.running || ['pending','queued','starting','running','stopping','waiting_user','waiting_person','waiting_approval'].includes(task.execution_state))))
const visible = computed(() => (props.count > 0 || flowsCount.value > 0) && !pageLoading.value)
const formatted = (count: number) => count.toLocaleString(locale.value)
const compact = (count: number) => count > 99 ? `${formatted(99)}+` : formatted(count)
const label = computed(() => [name.value, ...(props.count ? [t('person.backgroundTasks'), formatted(props.count)] : []), ...(flowsCount.value ? [t('person.flows'), formatted(flowsCount.value)] : [])].join(' · '))
const expanded = ref(false), expandedFlow = ref<string | null>(null)
const activity = ref<HTMLElement>(), content = ref<HTMLElement>(), toggle = ref<HTMLButtonElement>(), nameElement = ref<HTMLElement>()
const width = ref(440), bodyHeight = ref(0), bodyMax = ref(460), truncatedName = ref(false)
const detailsId = useId()
let observer: ResizeObserver | undefined
let frame = 0
const height = computed(() => expanded.value ? 60 + Math.min(bodyHeight.value, bodyMax.value) : 60)
function measure() {
  if (!activity.value) return
  width.value = activity.value.clientWidth
  bodyMax.value = Math.max(0, Math.min(460, (activity.value.parentElement?.clientHeight || window.innerHeight) - 84))
  bodyHeight.value = content.value?.scrollHeight || 0
  truncatedName.value = !!nameElement.value && nameElement.value.scrollWidth > nameElement.value.clientWidth
}
function scheduleMeasure() {
  cancelAnimationFrame(frame)
  frame = requestAnimationFrame(measure)
}
function open() {
  expanded.value = !expanded.value
  if (expanded.value) { emit('refresh'); void nextTick(measure) }
}
function close(focus = false) { expanded.value = false; if (focus) toggle.value?.focus() }
function toggleFlow(id: string) { expandedFlow.value = expandedFlow.value === id ? null : id }
function openFlow(flow: PersonFlow) { close(); emit('openFlow',flow) }
function outside(event: PointerEvent) { if (expanded.value && !activity.value?.contains(event.target as Node)) close() }
function escape(event: KeyboardEvent) {
  if (event.key === 'Escape' && expanded.value) { event.stopPropagation(); close(true) }
}
function flowAnimation(flow: PersonFlow) { return personAvatarAnimation(avatar.value, personFlowAnimation(personFlowState(flow))) || animation.value }
function taskAnimation(task: PersonTask) {
  const state = ['starting','running','stopping'].includes(task.execution_state) ? 'searching' : 'sleeping'
  return personAvatarAnimation(avatar.value, state) || animation.value
}
watch(visible, value => { if (!value) close() })
watch(name, () => { void nextTick(measure) })
watch(activeFlows, (flows, previous) => {
  if (expandedFlow.value && !flows.some(flow => flow.id === expandedFlow.value)) expandedFlow.value = null
  if (!previous?.length) expandedFlow.value = flows[0]?.id || null
}, { immediate: true })
onMounted(() => {
  observer = new ResizeObserver(scheduleMeasure)
  if (activity.value) { observer.observe(activity.value); if (activity.value.parentElement) observer.observe(activity.value.parentElement) }
  if (content.value) observer.observe(content.value)
  document.addEventListener('pointerdown', outside)
  document.addEventListener('keydown', escape)
  window.addEventListener('resize', measure)
  measure()
})
// The content mounts when real activity first arrives, after the page loader has left.
watch([content, activity], ([body, root], [previousBody, previousRoot]) => {
  if (previousBody) observer?.unobserve(previousBody)
  if (previousRoot) observer?.unobserve(previousRoot)
  if (body) observer?.observe(body)
  if (root) { observer?.observe(root); if (root.parentElement) observer?.observe(root.parentElement) }
  void nextTick(measure)
})
onBeforeUnmount(() => {
  observer?.disconnect()
  cancelAnimationFrame(frame)
  document.removeEventListener('pointerdown', outside)
  document.removeEventListener('keydown', escape)
  window.removeEventListener('resize', measure)
})
</script>

<template>
  <div ref="activity" class="person-task-activity">
    <span class="activity-announcement" role="status" aria-live="polite" aria-atomic="true">{{ visible ? label : '' }}</span>
    <Transition name="person-task-island" appear>
      <section v-if="visible" class="person-task-island" :class="{ 'person-task-island--expanded': expanded }" data-theme-surface="card" :style="{ height: `${height}px`, '--activity-open-width': `${width}px` }">
        <button ref="toggle" type="button" class="person-task-island__toggle" :aria-label="label" :aria-expanded="expanded" :aria-controls="detailsId" @click="open">
          <span class="person-task-island__avatar-slot" aria-hidden="true"><img class="person-task-island__avatar" :src="reducedMotion ? avatar.src : animation" alt="" width="52" height="52" /></span>
          <span class="person-task-island__label" aria-hidden="true">
            <strong ref="nameElement" :title="name">{{ name }}</strong>
            <span class="person-task-island__counters">
              <span v-if="count > 0" class="activity-counter" :title="`${t('person.backgroundTasks')} · ${formatted(count)}`"><SessionTaskIcon :size="13" /><span>{{ compact(count) }}</span></span>
              <span v-if="flowsCount > 0" class="activity-counter" :title="`${t('person.flows')} · ${formatted(flowsCount)}`">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="M12 6v6M5 17v-5h14v5" /><rect x="9" y="1" width="6" height="5" rx="1" /><rect x="2" y="17" width="6" height="5" rx="1" /><rect x="16" y="17" width="6" height="5" rx="1" /></svg>
                <span>{{ compact(flowsCount) }}</span>
              </span>
            </span>
          </span>
          <SessionTaskIcon name="chevron-down" class="person-task-island__chevron" :size="14" />
        </button>
        <div :id="detailsId" class="activity-details" :inert="!expanded" :aria-hidden="!expanded" :style="{ maxHeight: `${bodyMax}px` }">
          <div ref="content" class="activity-content">
            <p v-if="truncatedName" class="activity-full-name">{{ name }}</p>
            <ul class="activity-list">
              <li v-for="task in activeTasks" :key="`task-${task.id}`">
                <button type="button" class="activity-row" :title="task.title" @click="close(); emit('openTask', task)">
                  <img class="row-gif" :src="reducedMotion ? avatar.src : taskAnimation(task)" alt="" width="38" height="38" />
                  <span class="row-title">{{ task.title }}</span>
                </button>
              </li>
              <li v-for="flow in activeFlows" :key="`flow-${flow.id}`">
                <div class="activity-flow-heading">
                  <button type="button" class="activity-row activity-flow-row" :title="flow.title" :aria-expanded="expandedFlow === flow.id" :aria-controls="`${detailsId}-${flow.id}`" @click="toggleFlow(flow.id)">
                    <img class="row-gif" :src="reducedMotion ? avatar.src : flowAnimation(flow)" alt="" width="38" height="38" />
                    <span class="row-title">{{ flow.title }}</span>
                  </button>
                  <button type="button" class="flow-preview-toggle" :aria-label="`${t(expandedFlow === flow.id ? 'common.collapse' : 'common.expand')} · ${flow.title}`" :aria-expanded="expandedFlow === flow.id" :aria-controls="`${detailsId}-${flow.id}`" @click="toggleFlow(flow.id)">
                    <SessionTaskIcon name="chevron-down" class="row-chevron" :size="12" />
                  </button>
                </div>
                <div v-if="expandedFlow === flow.id" :id="`${detailsId}-${flow.id}`">
                  <PersonFlowGraph v-if="expanded" :flow="flow" @open="openFlow" />
                </div>
              </li>
            </ul>
          </div>
        </div>
      </section>
    </Transition>
  </div>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;
.person-task-activity { position: absolute; z-index: 5; top: 12px; left: 50%; width: min(440px, calc(100% - 32px)); transform: translateX(-50%); pointer-events: none; }
.activity-announcement { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
.person-task-island { width: min(280px, 100%); margin-inline: auto; padding: 0; border: 0; border-radius: 30px; background: $bg-card; color: $text-primary; overflow: hidden; pointer-events: auto; box-shadow: 0 6px 22px rgba(var(--text-primary-rgb), .05); transition: width 440ms cubic-bezier(.22, 1, .36, 1), height 440ms cubic-bezier(.22, 1, .36, 1), border-radius 440ms cubic-bezier(.22, 1, .36, 1), box-shadow 440ms ease; }
.person-task-island--expanded { width: 100%; border-radius: 24px; box-shadow: 0 14px 40px rgba(var(--text-primary-rgb), .07); }
.person-task-island__toggle { display: grid; grid-template-columns: 52px minmax(0, 1fr) 14px; align-items: center; gap: 8px; width: 100%; height: 60px; padding: 4px 14px 4px 6px; border: 0; border-radius: inherit; background: transparent; color: inherit; cursor: pointer; -webkit-app-region: no-drag; font: inherit; text-align: start; -webkit-tap-highlight-color: transparent; }
.person-task-island__toggle:focus-visible, .activity-row:focus-visible, .flow-preview-toggle:focus-visible { outline: 2px solid $accent-primary; outline-offset: -3px; }
.person-task-island__avatar-slot { position: relative; width: 52px; height: 52px; }
.person-task-island__avatar { display: block; width: 52px; height: 52px; object-fit: contain; }
.person-task-island__label { display: flex; min-width: 0; flex-direction: column; gap: 3px; }
.person-task-island__label > strong { font-size: 14px; line-height: 18px; font-weight: 600; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.person-task-island__counters { display: flex; align-items: center; gap: 14px; min-width: 0; }
.activity-counter { display: inline-flex; align-items: center; gap: 5px; color: $text-secondary; white-space: nowrap; font-size: 13px; line-height: 15px; font-variant-numeric: tabular-nums; }
.activity-counter > span { color: $accent-primary; }
.person-task-island__chevron { color: $text-muted; transition: transform 360ms cubic-bezier(.22, 1, .36, 1); }
.person-task-island--expanded .person-task-island__chevron { transform: rotate(180deg); }
.activity-details { box-sizing: border-box; width: var(--activity-open-width); overflow: auto; overscroll-behavior: contain; scrollbar-width: thin; opacity: 0; visibility: hidden; transform: translateY(4px); transition: opacity 130ms ease, transform 280ms ease, visibility 0s 180ms; }
.person-task-island--expanded .activity-details { opacity: 1; visibility: visible; transform: translateY(0); transition: opacity 200ms ease 100ms, transform 340ms cubic-bezier(.22, 1, .36, 1) 70ms, visibility 0s; }
.activity-content { padding: 0 15px 14px; }
.activity-full-name { margin: 0 2px 9px; padding: 3px 0 11px; font-size: 14px; line-height: 1.65; font-weight: 600; overflow-wrap: anywhere; }
.activity-list { padding: 0; margin: 0; list-style: none; }
.activity-row { display: flex; align-items: center; gap: 10px; width: 100%; min-height: 48px; padding: 5px 7px; border: 0; border-radius: 9px; background: transparent; color: inherit; font: inherit; text-align: start; cursor: pointer; }
.activity-row:hover { background: rgba(var(--text-primary-rgb), .035); }
.row-gif { width: 38px; height: 38px; flex-shrink: 0; object-fit: contain; }
.row-title { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 13px; }
.row-chevron { flex-shrink: 0; color: $text-muted; transition: transform 220ms ease; }
.flow-preview-toggle[aria-expanded='true'] .row-chevron { transform: rotate(180deg); }
.activity-flow-heading { display: flex; align-items: center; }
.activity-flow-row { flex: 1; min-width: 0; }
.flow-preview-toggle { display: grid; place-items: center; flex: 0 0 32px; height: 40px; padding: 0; border: 0; border-radius: 9px; background: transparent; color: $text-muted; cursor: pointer; }
.flow-preview-toggle:hover { background: rgba(var(--text-primary-rgb), .035); }
.person-task-island-enter-active { animation: activity-arrive 460ms cubic-bezier(.22, 1, .36, 1); }
.person-task-island-leave-active { transition: opacity 180ms ease-in, transform 240ms ease-in; }
.person-task-island-leave-to { opacity: 0; transform: translateY(-5px); }
@keyframes activity-arrive { from { clip-path: inset(0 calc(50% - 24px) round 30px); transform: translateY(-5px); opacity: 0; } to { clip-path: inset(0 0 round 30px); transform: translateY(0); opacity: 1; } }
@media (max-width: 640px) { .person-task-island:not(.person-task-island--expanded) { width: min(216px, 100%); } }
@media (prefers-reduced-motion: reduce) {
  .person-task-island, .person-task-island__chevron, .activity-details, .person-task-island--expanded .activity-details, .row-chevron { transition: none; }
  .person-task-island-enter-active { animation: none; }
}
</style>
