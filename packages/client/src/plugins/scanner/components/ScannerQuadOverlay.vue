<script setup lang="ts">
/**
 * ScannerQuadOverlay - 视频/图片上的文档选框覆盖层。
 *
 * - quad 为归一化坐标（0..1，相对容器）；
 * - 支持拖动 4 个角点微调选框（拖动时发射 update:quad）；
 * - 视觉上区分「自动检测」与「手动锁定」；
 * - 拖动后选框保持手动锁定（不再实时跟随），由上层「重置选框」恢复。
 */
import { computed } from 'vue'
import type { Quad } from '../vision/types'

const props = withDefaults(defineProps<{
  quad: Quad | null
  /** 是否允许拖动角点。默认 true。 */
  editable?: boolean
  /** 选框是否由用户手动锁定（视觉/行为提示）。 */
  manual?: boolean
}>(), {
  quad: null,
  editable: true,
  manual: false,
})

const emit = defineEmits<{
  (e: 'update:quad', quad: Quad): void
  (e: 'drag-start'): void
}>()

const POINTS = [0, 1, 2, 3] as const

const strokeColor = computed(() => (props.manual ? '#ffb020' : '#4a90d9'))
const cornerAt = (i: number) => props.quad ? props.quad[i]! : { x: 0, y: 0 }

const polygonPoints = computed(() => {
  if (!props.quad) return ''
  return props.quad.map(p => `${p.x},${p.y}`).join(' ')
})

const handleStyle = (i: number) => {
  const p = cornerAt(i)
  return { left: `${p.x * 100}%`, top: `${p.y * 100}%` }
}

let dragIndex = -1
let dragging = false

function onHandlePointerDown(event: PointerEvent, index: number) {
  if (!props.editable || !props.quad) return
  dragIndex = index
  dragging = true
  ;(event.currentTarget as HTMLElement).setPointerCapture(event.pointerId)
  emit('drag-start')
}

function onHandlePointerMove(event: PointerEvent) {
  if (!dragging || dragIndex < 0 || !props.quad) return
  const rect = (event.currentTarget as HTMLElement).parentElement!.getBoundingClientRect()
  const x = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width))
  const y = Math.min(1, Math.max(0, (event.clientY - rect.top) / rect.height))
  const next: Quad = [
    { x: props.quad[0]!.x, y: props.quad[0]!.y },
    { x: props.quad[1]!.x, y: props.quad[1]!.y },
    { x: props.quad[2]!.x, y: props.quad[2]!.y },
    { x: props.quad[3]!.x, y: props.quad[3]!.y },
  ]
  const p = next[dragIndex]!
  p.x = x
  p.y = y
  emit('update:quad', next)
}

function endDrag(event: PointerEvent) {
  if (!dragging) return
  dragging = false
  dragIndex = -1
  ;(event.currentTarget as HTMLElement).releasePointerCapture?.(event.pointerId)
}
</script>

<template>
  <div v-if="quad" class="scanner-quad-overlay">
    <!-- 选框面与边线（vector-effect 保证线条粗细不被拉伸） -->
    <svg class="quad-svg" viewBox="0 0 1 1" preserveAspectRatio="none">
      <polygon
        class="quad-fill"
        :points="polygonPoints"
        :fill="strokeColor"
        fill-opacity="0.10"
      />
      <polyline
        class="quad-edge"
        :points="`${polygonPoints} ${props.quad ? props.quad[0]!.x + ',' + props.quad[0]!.y : ''}`"
        :stroke="strokeColor"
        fill="none"
      />
    </svg>
    <!-- 角点拖柄 -->
    <button
      v-for="i in POINTS"
      :key="i"
      type="button"
      class="quad-handle"
      :class="{ 'is-editable': editable }"
      :style="handleStyle(i)"
      :disabled="!editable"
      @pointerdown.prevent.stop="onHandlePointerDown($event, i)"
      @pointermove.prevent.stop="onHandlePointerMove"
      @pointerup.prevent.stop="endDrag"
      @pointercancel.prevent.stop="endDrag"
      @lostpointercapture="endDrag"
    >
      <span class="quad-handle-core" />
    </button>
  </div>
</template>

<style scoped>
.scanner-quad-overlay {
  position: absolute;
  inset: 0;
  pointer-events: none;
}

.quad-svg {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  overflow: visible;
}

.quad-edge {
  stroke-width: 2.5;
  vector-effect: non-scaling-stroke;
  stroke-linejoin: round;
}

.quad-handle {
  position: absolute;
  width: 44px;
  height: 44px;
  margin: -22px 0 0 -22px;
  padding: 0;
  border: 0;
  background: transparent;
  pointer-events: auto;
  cursor: grab;
  touch-action: none;
}

.quad-handle-core {
  position: absolute;
  left: 15px;
  top: 15px;
  width: 14px;
  height: 14px;
  border-radius: 50%;

  /* theme-exception: preview -- Fixed contrast keeps camera and paper preview controls visible. */
  border: 2px solid #fff;

  background: var(--accent-info, #4a90d9);

  /* theme-exception: preview -- Fixed contrast keeps camera and paper preview controls visible. */
  box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.35);
  box-sizing: border-box;
}

.quad-handle.is-editable:hover .quad-handle-core,
.quad-handle.is-editable:active .quad-handle-core {
  transform: scale(1.25);
}

.quad-handle:disabled {
  cursor: default;
}
</style>
