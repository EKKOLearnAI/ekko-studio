<script setup lang="ts">
import { onMounted, onBeforeUnmount, ref, watch, nextTick } from 'vue'
import { NButton, NInput, NSelect } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import Konva from 'konva'
import { drawAnnotation, imageElement } from './render'
import type { Annotation } from './api'
const props = defineProps<{ image: string; modelValue: Annotation[]; rough: boolean }>()
const emit = defineEmits<{ 'update:modelValue': [Annotation[]] }>()
const { t } = useI18n()
const container = ref<HTMLDivElement>(); const tool = ref('select'); const color = ref('#dc2626'); const width = ref(3); const text = ref(''); const selected = ref('')
const history: Annotation[][] = []; const future: Annotation[][] = []
let stage: Konva.Stage | undefined; let scale = 1; let observer: ResizeObserver | undefined; let drawing: number[] | null = null
const copy = (value: Annotation[]) => JSON.parse(JSON.stringify(value)) as Annotation[]
function commit(value: Annotation[]) { history.push(copy(props.modelValue)); future.length = 0; emit('update:modelValue', value) }
function undo() { const value = history.pop(); if (value) { future.push(copy(props.modelValue)); emit('update:modelValue', value) } }
function redo() { const value = future.pop(); if (value) { history.push(copy(props.modelValue)); emit('update:modelValue', value) } }
function remove() { commit(props.modelValue.filter(a => a.id !== selected.value)); selected.value = '' }
function editText() { commit(props.modelValue.map(a => a.id === selected.value ? { ...a, content: text.value } : a)) }
let generation = 0
async function draw() {
  const current = ++generation
  if (!container.value || !props.image) return
  const img = await imageElement(props.image)
  if (current !== generation || !container.value) return
  stage?.destroy(); scale = Math.min(1, (container.value.clientWidth || 800) / img.naturalWidth)
  stage = new Konva.Stage({ container: container.value, width: img.naturalWidth * scale, height: img.naturalHeight * scale, scaleX: scale, scaleY: scale })
  const layer = new Konva.Layer(); stage.add(layer)
  layer.add(new Konva.Image({ image: img, width: img.naturalWidth, height: img.naturalHeight, listening: false }))
  for (const a of props.modelValue) {
    const shape = new Konva.Shape({ draggable: tool.value === 'select', sceneFunc(context) { drawAnnotation(context._context, a, props.rough) }, hitFunc(context, shape) { context.beginPath(); context.rect(...a.bbox); context.closePath(); context.fillStrokeShape(shape) } })
    shape.on('click tap', () => { selected.value = a.id; text.value = a.content })
    shape.on('dragend', () => {
      const dx = shape.x(); const dy = shape.y()
      const x = Math.max(0, Math.min(img.naturalWidth - a.bbox[2], a.bbox[0] + dx)); const y = Math.max(0, Math.min(img.naturalHeight - a.bbox[3], a.bbox[1] + dy))
      commit(props.modelValue.map(item => item.id === a.id ? { ...a, bbox: [x, y, a.bbox[2], a.bbox[3]], points: a.points?.map((n, i) => n + (i % 2 ? dy : dx)) } : item))
    })
    layer.add(shape)
  }
  stage.on('mousedown touchstart', () => {
    if (tool.value === 'select') return
    const p = stage!.getPointerPosition(); if (!p) return
    drawing = [p.x / scale, p.y / scale]
  })
  stage.on('mousemove touchmove', () => {
    if (!drawing || tool.value !== 'pen') return
    const p = stage!.getPointerPosition(); if (p) drawing.push(p.x / scale, p.y / scale)
  })
  stage.on('mouseup touchend', () => {
    if (!drawing) return
    const p = stage!.getPointerPosition(); const [x, y] = drawing as [number, number]
    const endX = p ? p.x / scale : x + 60; const endY = p ? p.y / scale : y + 40
    const a: Annotation = { id: crypto.randomUUID(), kind: tool.value, content: text.value, color: color.value, width: width.value, bbox: [Math.min(x, endX), Math.min(y, endY), Math.max(60, Math.abs(endX - x)), Math.max(30, Math.abs(endY - y))] }
    if (a.kind === 'pen') a.points = drawing
    if (a.kind === 'comment' || a.kind === 'badge') a.bbox = [x, y, 220, 40]
    drawing = null; commit([...props.modelValue, a])
  })
}
watch(() => [props.image, props.modelValue, props.rough, tool.value], () => void nextTick(draw), { deep: true })
watch(() => props.image, () => { history.length = 0; future.length = 0; selected.value = '' })
onMounted(() => { observer = new ResizeObserver(() => void draw()); if (container.value) observer.observe(container.value); void draw() })
onBeforeUnmount(() => { generation++; observer?.disconnect(); stage?.destroy() })
</script>
<template>
  <div class="annotator" tabindex="0" @keydown.delete.prevent="remove" @keydown.backspace.self.prevent="remove">
    <div class="toolbar">
      <NSelect v-model:value="tool" :options="['select','pen','circle','comment','badge'].map(value => ({ value, label: t(`grading.${value}`) }))" style="width:160px" />
      <input v-model="color" type="color" :aria-label="t('grading.color')"><input v-model.number="width" type="range" min="1" max="12" :aria-label="t('grading.width')">
      <NButton @click="undo">{{ t('grading.undo') }}</NButton><NButton @click="redo">{{ t('grading.redo') }}</NButton>
      <NButton :disabled="!selected" @click="remove">{{ t('grading.remove') }}</NButton>
      <NInput v-model:value="text" :placeholder="t('grading.text')" style="width:220px" />
      <NButton :disabled="!selected" @click="editText">{{ t('grading.save') }}</NButton>
    </div>
    <div ref="container" class="canvas" />
  </div>
</template>
<style scoped lang="scss">
.annotator {
  min-width: 0;

  /* 工具栏 = 终端 prompt */
  .toolbar {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    padding: 8px 12px;
    margin: 0 0 8px;
    background: linear-gradient(180deg, var(--theme-card-bg, var(--theme-card-bg, var(--bg-card))), var(--theme-card-bg, var(--theme-card-bg, var(--bg-card))));
    border: 1px solid rgba(var(--success-rgb), 0.2);
    border-radius: 6px;
    font-family: 'JetBrains Mono', 'Fira Code', 'Cascadia Code', 'Consolas', monospace;
    color: var(--success);
    box-shadow: 0 0 12px rgba(var(--success-rgb), 0.063), inset 0 0 12px rgba(var(--success-rgb), 0.031);
    position: relative;
    align-items: center;

    /* 终端 prompt 前缀 */
    &::before {
      content: '$ ';
      color: var(--success);
      text-shadow: 0 0 6px var(--success);
      margin-right: 4px;
      align-self: center;
      animation: pulse 2s ease-in-out infinite;
    }

    /* 工具栏整体悬停描边 */
    &:hover { border-color: rgba(var(--success-rgb), 0.667); box-shadow: 0 0 18px rgba(var(--success-rgb), 0.125), inset 0 0 18px rgba(var(--success-rgb), 0.063); }

    /* 覆盖 naive-ui 控件 */
    :deep(.n-button) {
      background: var(--theme-card-bg, var(--theme-card-bg, var(--bg-card))) !important;
      border: 1px solid rgba(var(--success-rgb), 0.267) !important;
      color: var(--success) !important;
      font-family: inherit;
      letter-spacing: 0.03em;
      transition: all 0.15s ease;
      &:hover {
        border-color: var(--success) !important;
        color: var(--success) !important;
        background: var(--theme-card-bg, var(--theme-card-bg, var(--bg-card))) !important;
        text-shadow: 0 0 6px var(--success);
      }
      &:disabled { opacity: 0.4; }
    }

    :deep(.n-select) {
      .n-base-selection { background: var(--theme-card-bg, var(--theme-card-bg, var(--bg-card))) !important; border-color: rgba(var(--success-rgb), 0.267) !important; }
      .n-base-selection__content { color: var(--success) !important; font-family: inherit; }
    }

    :deep(.n-input) {
      .n-input__input-el { background: var(--theme-card-bg, var(--theme-card-bg, var(--bg-card))) !important; color: var(--success) !important; font-family: inherit; }
      .n-input__border { border-color: rgba(var(--success-rgb), 0.267) !important; }
    }

    /* 颜色选择器 */
    input[type='color'] {
      width: 32px;
      height: 28px;
      border: 1px solid rgba(var(--success-rgb), 0.267);
      border-radius: 4px;
      background: var(--theme-card-bg, var(--theme-card-bg, var(--bg-card)));
      padding: 0;
      cursor: pointer;
      &::-webkit-color-swatch-wrapper { padding: 2px; }
      &::-webkit-color-swatch { border: none; border-radius: 2px; }
    }

    /* 笔宽滑块 */
    input[type='range'] {
      width: 120px;
      accent-color: var(--success);
      filter: drop-shadow(0 0 4px #00ff88aa);
    }
  }

  /* 画布 = 终端 CRT 屏 */
  .canvas {
    width: 100%;
    /* 黑色 CRT + 极淡绿色扫描线 + 网格底 */
    background-color: var(--theme-card-bg, var(--theme-card-bg, var(--bg-card)));
    background-image:
      repeating-linear-gradient(0deg, transparent 0 2px, rgba(var(--success-rgb), 0.031) 2px 3px),
      linear-gradient(transparent calc(100% - 1px), rgba(var(--success-rgb), 0.082) 100%),
      linear-gradient(90deg, transparent calc(100% - 1px), rgba(var(--success-rgb), 0.082) 100%);
    background-size: 100% 100%, 24px 24px, 24px 24px;
    border: 1px solid rgba(var(--success-rgb), 0.2);
    border-radius: 6px;
    overflow: hidden;
    position: relative;
    box-shadow: 0 0 24px rgba(var(--success-rgb), 0.082), inset 0 0 24px rgba(var(--success-rgb), 0.063);

    /* 画布四角的扫描装饰 */
    &::before, &::after {
      content: '';
      position: absolute;
      width: 18px;
      height: 18px;
      border: 1px solid var(--success);
      pointer-events: none;
      z-index: 1;
    }
    &::before {
      top: 4px; left: 4px;
      border-right: none; border-bottom: none;
    }
    &::after {
      bottom: 4px; right: 4px;
      border-left: none; border-top: none;
    }
  }

  &:focus { outline: none; }
}

@keyframes pulse {
  50% { opacity: 0.5; }
}
</style>
