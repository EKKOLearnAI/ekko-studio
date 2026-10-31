<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { isRtlLocale } from '@/i18n/direction'
import type { PersonFlow } from '@/api/person'
import { personFlowGroups, personFlowStageStatus, personFlowStatusKey } from '@/utils/person-flow'
import { personBot } from '../../../../../shared/person-bots'
import { deploymentUrl } from '@/utils/deployment-url'
import PersonActivityPath from './PersonActivityPath.vue'

const props = defineProps<{ flow: PersonFlow; maxWidth: number; reducedMotion: boolean; fallbackAvatar: string }>()
const emit = defineEmits<{ task: [id: string]; flow: [id: string]; resize: [width: number] }>()
const { t, locale } = useI18n()
const groups = computed(() => personFlowGroups(props.flow))
const rtl = computed(() => isRtlLocale(locale.value))
const grid = ref<HTMLOListElement>()
const columns = ref(1)
const bounds = ref({ width: 0, height: 0 })
const points = ref<Array<{ x: number; y: number }>>([])
const gridGap = 28, gutter = 28
let observer: ResizeObserver | undefined
let frame: number | undefined
let disposed = false

function position(index: number, count = columns.value) {
  const row = Math.floor(index / count)
  return { row, column: row % 2 ? count - 1 - index % count : index % count }
}
function stageImage(stage: PersonFlow['stages'][number]) {
  const bot = personBot(stage.bot_type)
  if (!bot) return props.fallbackAvatar
  if (props.reducedMotion) return deploymentUrl(bot.avatar)
  const status = personFlowStageStatus(props.flow, stage)
  const state = status === 'completed' ? 'done' : ['blocked', 'interrupted'].includes(status) ? 'error'
    : ['running', 'active'].includes(status) ? 'searching' : 'sleeping'
  return deploymentUrl(bot.animations[state])
}
function selectStage(stage: PersonFlow['stages'][number]) {
  const tasks = stage.tasks.filter(task => task.status !== 'closed')
  if (tasks.length === 1) emit('task', tasks[0].id)
  else emit('flow', props.flow.id)
}
function measure() {
  frame = undefined
  if (disposed || !grid.value) return
  const nodes = Array.from(grid.value.children) as HTMLElement[]
  if (!nodes.length) return
  const widths = nodes.map(node => (node.querySelector('.activity-bots') as HTMLElement).offsetWidth)
  let count = Math.min(3, nodes.length)
  for (; count > 1; count--) {
    const widthsByColumn = Array.from({ length: count }, () => 0)
    widths.forEach((width, index) => {
      const { column } = position(index, count)
      widthsByColumn[column] = Math.max(widthsByColumn[column], width)
    })
    if (widthsByColumn.reduce((sum, width) => sum + width, 0) + gridGap * (count - 1) + gutter * 2 <= props.maxWidth) break
  }
  if (count !== columns.value) {
    columns.value = count
    void nextTick().then(scheduleMeasure)
    return
  }
  const next = { width: grid.value.offsetWidth, height: grid.value.offsetHeight }
  if (next.width !== bounds.value.width || next.height !== bounds.value.height) bounds.value = next
  // Grid stretches every node to the row's tallest text. The connector remains
  // below both names and status labels, including translated/multiline text.
  const nextPoints = nodes.map(node => ({ x: node.offsetLeft + node.offsetWidth / 2, y: node.offsetTop + node.offsetHeight - 12 }))
  if (JSON.stringify(nextPoints) !== JSON.stringify(points.value)) points.value = nextPoints
  emit('resize', next.width)
}
function scheduleMeasure() {
  if (!disposed && frame === undefined) frame = requestAnimationFrame(measure)
}
function observeNodes() {
  observer?.disconnect()
  if (grid.value) {
    observer?.observe(grid.value)
    for (const element of grid.value.querySelectorAll('.activity-bots')) observer?.observe(element)
  }
  scheduleMeasure()
}
const paths = computed(() => {
  const all = points.value
  if (!all.length) return { full: '', progress: '' }
  let path = `M${all[0].x} ${all[0].y}`
  const count = groups.value.filter(group => props.flow.state === 'completed' || group.position <= props.flow.current_position).length
  let progress = count ? path : ''
  for (let index = 1; index < all.length; index++) {
    const previous = all[index - 1], current = all[index]
    if (position(index).row === position(index - 1).row) path += ` H${current.x}`
    else {
      const turnRight = Boolean(position(index).row % 2) !== rtl.value
      const edge = turnRight ? bounds.value.width - 4 : 4
      path += ` C${edge} ${previous.y} ${edge} ${current.y} ${current.x} ${current.y}`
    }
    if (index < count) progress = path
  }
  return { full: path, progress }
})
watch(() => [props.flow, props.maxWidth, locale.value], () => void nextTick().then(observeNodes), { deep: true })
onMounted(() => {
  if (typeof ResizeObserver !== 'undefined') observer = new ResizeObserver(scheduleMeasure)
  observeNodes()
})
onBeforeUnmount(() => { disposed = true; observer?.disconnect(); if (frame !== undefined) cancelAnimationFrame(frame) })
</script>

<template>
  <section class="activity-flow">
    <button type="button" class="activity-flow-title" :title="flow.title" @click="emit('flow', flow.id)"><strong dir="auto">{{ flow.title }}</strong><span class="activity-flow-chevron" aria-hidden="true">›</span></button>
    <div class="activity-snake-scroll">
      <div class="activity-snake">
        <svg v-if="bounds.width" :width="bounds.width" :height="bounds.height" aria-hidden="true">
          <PersonActivityPath :path="paths.full" :progress-path="paths.progress" />
        </svg>
        <ol ref="grid" class="activity-stages" :style="{ gridTemplateColumns: `repeat(${columns}, max-content)` }">
          <li v-for="(group, index) in groups" :key="group.position" :style="{ gridColumn: position(index).column + 1, gridRow: position(index).row + 1 }" :class="{ current: group.position === flow.current_position, done: group.completed === group.stages.length }">
            <span class="activity-stage-marker" aria-hidden="true">{{ (index + 1).toLocaleString(locale) }}</span>
            <div class="activity-bots">
              <button v-for="stage in group.stages" :key="stage.id" type="button" class="activity-stage" :title="`${stage.session_title || stage.goal} · ${t(personFlowStatusKey(personFlowStageStatus(flow, stage)))}`" @click="selectStage(stage)">
                <img :src="stageImage(stage)" alt="" width="48" height="48" />
                <span dir="auto">{{ stage.session_title || stage.goal }}</span>
                <small>{{ t(personFlowStatusKey(personFlowStageStatus(flow, stage))) }}</small>
              </button>
            </div>
          </li>
        </ol>
      </div>
    </div>
  </section>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;
.activity-flow + .activity-flow { margin-block-start: 20px; }
.activity-flow-title { display:flex; align-items:center; justify-content:space-between; gap:12px; width:100%; padding:12px 4px; border:0; background:transparent; color:$text-primary; font:inherit; text-align:start; cursor:pointer; }
.activity-flow-title strong { font-size:14px; line-height:1.5; overflow-wrap:anywhere; min-width:0; }
.activity-flow-title > span { flex:none; }
.activity-flow-title:dir(rtl) > .activity-flow-chevron { transform:scaleX(-1); }
.activity-flow-title:hover { color:$accent-primary; }
.activity-flow-title:focus-visible, .activity-stage:focus-visible { outline:2px solid $accent-primary; outline-offset:-2px; border-radius:6px; }
.activity-snake-scroll { overflow-x:auto; overscroll-behavior-x:contain; }
.activity-snake { position:relative; width:max-content; margin-inline:auto; }
.activity-snake svg { position:absolute; inset:0; pointer-events:none; }
.activity-stages { position:relative; display:grid; gap:28px; list-style:none; padding:8px 28px 4px; margin:0; width:max-content; }
.activity-stages > li { display:flex; flex-direction:column; align-items:center; padding:0 0 32px; text-align:center; }
.activity-stage-marker { margin-bottom:6px; font-size:11px; line-height:1.5; color:$text-muted; }
.activity-bots { display:flex; align-items:flex-start; justify-content:center; gap:12px; width:max-content; }
.activity-stage { flex:none; display:flex; flex-direction:column; align-items:center; gap:4px; width:max-content; min-width:100px; max-width:156px; padding:0; border:0; background:transparent; color:$text-primary; font:inherit; cursor:pointer; }
.activity-stage img { flex:none; object-fit:contain; }
.activity-stage > span { display:block; width:100%; font-size:13px; line-height:1.5; white-space:normal; overflow-wrap:anywhere; }
.activity-stage small { display:block; width:100%; font-size:12px; line-height:1.5; color:$text-secondary; white-space:normal; overflow-wrap:anywhere; }
</style>
