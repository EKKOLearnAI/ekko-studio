<script setup lang="ts">
import { computed } from 'vue'
import { BaseEdge, EdgeLabelRenderer, getSmoothStepPath, type EdgeProps } from '@vue-flow/core'
import {
  workflowSelfLoopGeometry,
  type WorkflowHandlePosition,
  type WorkflowSelfLoopGeometry,
} from '@/utils/workflow-edge-authoring'

const props = defineProps<EdgeProps>()
const emit = defineEmits<{ edit: [edgeId: string] }>()

const nodeBounds = computed(() => ({
  left: props.sourceNode.computedPosition.x,
  top: props.sourceNode.computedPosition.y,
  right: props.sourceNode.computedPosition.x + props.sourceNode.dimensions.width,
  bottom: props.sourceNode.computedPosition.y + props.sourceNode.dimensions.height,
}))

const targetBounds = computed(() => ({
  left: props.targetNode.computedPosition.x,
  top: props.targetNode.computedPosition.y,
  right: props.targetNode.computedPosition.x + props.targetNode.dimensions.width,
  bottom: props.targetNode.computedPosition.y + props.targetNode.dimensions.height,
}))

function smoothStepGeometry(): WorkflowSelfLoopGeometry {
  const [path, defaultLabelX, defaultLabelY] = getSmoothStepPath({
    sourceX: props.sourceX,
    sourceY: props.sourceY,
    sourcePosition: props.sourcePosition,
    targetX: props.targetX,
    targetY: props.targetY,
    targetPosition: props.targetPosition,
  })
  const source = nodeBounds.value
  const target = targetBounds.value
  const horizontalGap = source.right <= target.left
    ? { start: source.right, end: target.left }
    : target.right <= source.left
      ? { start: target.right, end: source.left }
      : null
  const verticalGap = source.bottom <= target.top
    ? { start: source.bottom, end: target.top }
    : target.bottom <= source.top
      ? { start: target.bottom, end: source.top }
      : null

  if (horizontalGap && horizontalGap.end - horizontalGap.start >= 300) {
    return { path, labelX: (horizontalGap.start + horizontalGap.end) / 2, labelY: defaultLabelY - 22 }
  }
  if (verticalGap && verticalGap.end - verticalGap.start >= 42) {
    return { path, labelX: defaultLabelX, labelY: (verticalGap.start + verticalGap.end) / 2 }
  }
  return {
    path,
    labelX: horizontalGap ? (horizontalGap.start + horizontalGap.end) / 2 : defaultLabelX,
    labelY: Math.min(source.top, target.top) - 30,
  }
}

const geometry = computed(() => props.source === props.target
  ? workflowSelfLoopGeometry({
      sourceX: props.sourceX,
      sourceY: props.sourceY,
      sourcePosition: props.sourcePosition as WorkflowHandlePosition,
      targetX: props.targetX,
      targetY: props.targetY,
      targetPosition: props.targetPosition as WorkflowHandlePosition,
      nodeBounds: nodeBounds.value,
    })
  : smoothStepGeometry(),
)

const displayLabel = computed(() => typeof props.label === 'string' ? props.label : '')
const labelPosition = computed(() => ({
  transform: `translate(-50%, -50%) translate(${geometry.value.labelX}px, ${geometry.value.labelY}px)`,
}))

function editEdge() {
  emit('edit', props.id)
}
</script>

<template>
  <BaseEdge
    :id="id"
    :path="geometry.path"
    :marker-start="markerStart"
    :marker-end="markerEnd"
    :interaction-width="interactionWidth"
    :style="style"
  />
  <EdgeLabelRenderer v-if="displayLabel">
    <button
      type="button"
      class="workflow-canvas-edge-label nodrag nopan"
      data-testid="workflow-edge-condition-label"
      :data-edge-id="id"
      :style="labelPosition"
      :title="displayLabel"
      @click.stop
      @dblclick.stop="editEdge"
      @keydown.enter.stop.prevent="editEdge"
      @keydown.space.stop.prevent="editEdge"
    >
      {{ displayLabel }}
    </button>
  </EdgeLabelRenderer>
</template>

<style scoped>
.workflow-canvas-edge-label {
  position: absolute;
  z-index: 8;
  max-width: 300px;
  overflow: hidden;
  padding: calc(5px * var(--spacing-scale, 1)) calc(9px * var(--spacing-scale, 1));
  border: var(--border-width, 1px) solid var(--border-color);
  border-radius: var(--radius-component, 7px);
  background: var(--theme-card-bg, var(--bg-card));
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.12);
  color: var(--text-primary);
  font: inherit;
  font-size: calc(var(--font-size-base, 14px) * 12 / 14);
  font-weight: 600;
  line-height: var(--line-height, 1.3);
  text-overflow: ellipsis;
  white-space: nowrap;
  pointer-events: all;
  cursor: pointer;
}

.workflow-canvas-edge-label:hover,
.workflow-canvas-edge-label:focus-visible {
  border-color: var(--accent-info);
  outline: none;
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--accent-info) 20%, transparent);
}
</style>
