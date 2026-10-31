<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import type { PersonFlow } from '@/api/person'
import { useReducedMotion } from '@/composables/useReducedMotion'
import { chatSessionAgentAvatar, personAvatarAnimation } from '@/utils/chat-agent-avatar'
import { personFlowAnimation, personFlowGroups, personFlowStageStatus, personFlowStatusKey } from '@/utils/person-flow'
import { personFlowLayout } from '@/utils/person-flow-layout'

const props = defineProps<{ flow: PersonFlow }>()
const emit = defineEmits<{ open: [flow: PersonFlow] }>()
const { t, locale } = useI18n()
const reducedMotion = useReducedMotion()
const graph = ref<HTMLElement>()
const width = ref(0), rtl = ref(false)
let observer: ResizeObserver | undefined
let frame = 0
const groups = computed(() => personFlowGroups(props.flow).map(group => ({ ...group, bots: group.stages.map(stage => {
  const avatar = chatSessionAgentAvatar({ id: stage.session_id, bot_type: stage.bot_type || undefined })
  const status = personFlowStageStatus(props.flow, stage)
  const name = stage.session_title || avatar.label
  return { stage, avatar,
    animation: personAvatarAnimation(avatar, personFlowAnimation(status)) || avatar.src,
    label: `${props.flow.title} · ${name} · ${stage.goal} · ${t(personFlowStatusKey(status))}` }
}) })))
const layout = computed(() => personFlowLayout(groups.value.map(group => group.bots.length), width.value, rtl.value))
const bots = computed(() => groups.value.flatMap(group => group.bots))
const edges = computed(() => layout.value.edges.map(edge => {
  const source = groups.value[edge.from]
  const passed = source.completed === source.stages.length
  return { ...edge,passed }
}))
function measure() {
  cancelAnimationFrame(frame)
  frame = requestAnimationFrame(() => {
    if (!graph.value) return
    width.value = graph.value.clientWidth
    rtl.value = getComputedStyle(graph.value).direction === 'rtl'
  })
}
watch(locale, measure)
onMounted(() => {
  observer = new ResizeObserver(measure)
  if (graph.value) observer.observe(graph.value)
})
onBeforeUnmount(() => { observer?.disconnect(); cancelAnimationFrame(frame) })
</script>

<template>
  <div ref="graph" class="person-flow-graph" :style="{ height: `${layout.height}px` }" @click.self="emit('open',flow)">
    <svg class="flow-edges" :viewBox="`0 0 ${Math.max(1,width)} ${Math.max(1,layout.height)}`" aria-hidden="true">
      <path v-for="edge in edges" :key="edge.from" class="route-line" :class="edge.passed ? 'route-passed' : 'route-pending'"
        :d="edge.path" :data-from="edge.from" :data-to="edge.to" :data-source="edge.source" :data-target="edge.target" />
    </svg>
    <ol class="flow-steps" :aria-label="flow.title">
      <li v-for="(bot,index) in bots" :key="bot.stage.id" class="flow-step" :data-row="layout.nodes[index].row" :data-group="layout.nodes[index].group" :data-turn="layout.nodes[index].turn"
        :style="{ left: `${layout.nodes[index].x}px`, top: `${layout.nodes[index].y}px`, width: `${layout.nodes[index].width}px`, height: `${layout.nodes[index].height}px` }">
        <button type="button" class="bot-sprite" :title="bot.label" :aria-label="bot.label" aria-haspopup="dialog" @click="emit('open',flow)">
          <img :src="reducedMotion ? bot.avatar.src : bot.animation" alt="" width="32" height="32" />
        </button>
      </li>
    </ol>
  </div>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;
.person-flow-graph { position: relative; width: 100%; margin: 0 0 12px; cursor: pointer; }
.flow-edges { position: absolute; inset: 0; width: 100%; height: 100%; pointer-events: none; }
.route-line { fill: none; stroke: currentColor; stroke-width: 1.6; stroke-linecap: round; stroke-linejoin: round; vector-effect: non-scaling-stroke; }
.route-pending { color: $text-muted; opacity: .45; stroke-dasharray: 3 5; }
.route-passed { color: $success; stroke-dasharray: none; }
.flow-steps { padding: 0; margin: 0; list-style: none; }
.flow-step { position: absolute; }
.bot-sprite { display: block; width: 32px; height: 32px; padding: 0; border: 0; border-radius: 6px; background: transparent; cursor: pointer; }
.bot-sprite img { display: block; width: 32px; height: 32px; object-fit: contain; }
.bot-sprite:hover { opacity: .85; }
.bot-sprite:focus-visible { outline: 2px solid $accent-primary; outline-offset: 1px; }
</style>
