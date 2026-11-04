<script setup lang="ts">
import { nextTick, onMounted, onBeforeUnmount, ref, watch } from 'vue'
import { PERSON_BOTS } from '../../../../../shared/person-bots'
import { deploymentUrl } from '@/utils/deployment-url'
import { personBotLabel } from '@/utils/person-bot-label'

const props = defineProps<{ value: string; disabled?: boolean }>()
const emit = defineEmits<{ 'update:value': [value: string] }>()
const viewport = ref<HTMLElement>()
const count = PERSON_BOTS.length
const characters = [...PERSON_BOTS, ...PERSON_BOTS, ...PERSON_BOTS]
const activePosition = ref(count + Math.max(0, PERSON_BOTS.findIndex(bot => bot.type === props.value)))
const reducedMotion = ref(false)
const ready = ref(false)
const rebasing = ref(false)
const dragging = ref(false)
let motionQuery: MediaQueryList | undefined
let observer: ResizeObserver | undefined
let selectionTimer: ReturnType<typeof setTimeout> | undefined
let rebaseFrame: number | undefined
let movingTo: number | null = null
let centeredWidth = 0
let centeredSlotWidth = 0
let disposed = false
let pointer: { id: number; x: number; left: number; moved: boolean } | null = null
let suppressClick = false
let userScrolling = false

function syncMotion() { reducedMotion.value = motionQuery?.matches ?? false }
function playing(position: number) {
  return ready.value && !props.disabled && !reducedMotion.value && position === activePosition.value
}
function slots() { return Array.from(viewport.value?.querySelectorAll<HTMLElement>('.person-bot-slot') || []) }
function button(position: number) { return slots()[position]?.querySelector<HTMLButtonElement>('button') }

function rebase(position: number) {
  const el = viewport.value
  if (!el || (position >= count && position < count * 2)) return
  const next = position < count ? position + count : position - count
  const all = slots()
  const delta = all[next].offsetLeft - all[position].offsetLeft
  const hadFocus = document.activeElement === button(position)
  rebasing.value = true
  activePosition.value = next
  el.scrollLeft += delta
  if (pointer) pointer.left += delta
  if (hadFocus) button(next)?.focus({ preventScroll: true })
  if (rebaseFrame !== undefined) cancelAnimationFrame(rebaseFrame)
  void nextTick(() => {
    if (disposed) return
    // Apply the selected scale before enabling transitions on the middle copy.
    void button(next)?.offsetWidth
    rebaseFrame = requestAnimationFrame(() => { rebasing.value = false; rebaseFrame = undefined })
  })
}

function center(position: number, smooth = false) {
  const el = viewport.value, slot = slots()[position]
  if (!el || !slot || disposed) return
  activePosition.value = position
  movingTo = position
  centeredWidth = el.clientWidth
  centeredSlotWidth = slot.offsetWidth
  clearTimeout(selectionTimer)
  el.scrollTo({ left: slot.offsetLeft + slot.offsetWidth / 2 - el.clientWidth / 2,
    behavior: smooth && !reducedMotion.value ? 'smooth' : 'instant' })
  selectionTimer = setTimeout(() => {
    // A cancelled smooth scroll may never reach its target or fire scrollend.
    const target = movingTo === null ? null : slots()[movingTo]
    if (target && Math.abs(target.offsetLeft + target.offsetWidth / 2 - el.clientWidth / 2 - el.scrollLeft) > 1) userScrolling = true
    movingTo = null
    finishScroll()
  }, smooth ? 1200 : 50)
}

async function syncSelection() {
  await nextTick()
  if (disposed) return
  const index = PERSON_BOTS.findIndex(bot => bot.type === props.value)
  if (index < 0) return
  userScrolling = false
  center(characters[activePosition.value]?.type === props.value ? activePosition.value : count + index)
}

function select(position: number) {
  if (props.disabled || suppressClick) return
  userScrolling = false
  emit('update:value', characters[position].type)
  center(position, true)
}

function onScroll() {
  const el = viewport.value
  if (!el || props.disabled || movingTo !== null) return
  const all = slots()
  if (centeredWidth !== el.clientWidth || centeredSlotWidth !== all[0]?.offsetWidth) { void syncSelection(); return }
  // Native inertia can continue after pointerup or an earlier scrollend.
  if (!userScrolling) return
  const middle = el.scrollLeft + el.clientWidth / 2
  let closest = 0, distance = Infinity
  all.forEach((slot, position) => {
    const delta = Math.abs(slot.offsetLeft + slot.offsetWidth / 2 - middle)
    if (delta < distance) { distance = delta; closest = position }
  })
  activePosition.value = closest
  if (characters[closest].type !== props.value) emit('update:value', characters[closest].type)
  rebase(closest)
}

function finishScroll() {
  const el = viewport.value
  if (!el || disposed || pointer?.moved) return
  // Account for a final native scroll before ending the gesture. Keep its offset.
  if (movingTo === null) onScroll()
  const position = movingTo ?? activePosition.value, slot = slots()[position]
  if (!slot) return
  const delta = slot.offsetLeft + slot.offsetWidth / 2 - el.clientWidth / 2 - el.scrollLeft
  if (movingTo !== null && Math.abs(delta) > 1) return
  clearTimeout(selectionTimer)
  movingTo = null
  rebase(position)
}

function onWheel(event: WheelEvent) {
  const el = viewport.value
  if (!el || props.disabled || event.ctrlKey) return
  const delta = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY
  if (!delta) return
  const unit = event.deltaMode === WheelEvent.DOM_DELTA_LINE ? 16
    : event.deltaMode === WheelEvent.DOM_DELTA_PAGE ? el.clientWidth : 1
  event.preventDefault()
  userScrolling = true
  movingTo = null
  clearTimeout(selectionTimer)
  el.scrollBy({ left: delta * unit, behavior: 'instant' })
}

function onPointerDown(event: PointerEvent) {
  if (props.disabled || !viewport.value) return
  userScrolling = true
  movingTo = null
  clearTimeout(selectionTimer)
  suppressClick = false
  if (event.pointerType !== 'mouse' || event.button !== 0) return
  pointer = { id: event.pointerId, x: event.clientX, left: viewport.value.scrollLeft, moved: false }
}
function onPointerMove(event: PointerEvent) {
  if (!pointer || !viewport.value || event.pointerId !== pointer.id) return
  if (!(event.buttons & 1)) { stopDrag(); return }
  const delta = event.clientX - pointer.x
  if (!pointer.moved && Math.abs(delta) > 5) {
    pointer.moved = dragging.value = true
    viewport.value.setPointerCapture(event.pointerId)
  }
  if (pointer.moved) { event.preventDefault(); viewport.value.scrollLeft = pointer.left - delta }
}
function stopDrag() {
  if (!pointer) return
  const { id, moved } = pointer
  suppressClick = moved
  pointer = null
  dragging.value = false
  if (viewport.value?.hasPointerCapture(id)) viewport.value.releasePointerCapture(id)
  if (moved) finishScroll()
}
function onPointerUp(event: PointerEvent) {
  if (event.pointerId === pointer?.id) stopDrag()
}

function onOutsideInteraction(event: Event) {
  if (!(event.target instanceof Node) || viewport.value?.contains(event.target)) return
  userScrolling = false
  movingTo = null
  clearTimeout(selectionTimer)
}

function onKeydown(event: KeyboardEvent) {
  if (props.disabled || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
  event.preventDefault()
  suppressClick = false
  const candidate = event.key === 'Home' ? count : event.key === 'End' ? count * 2 - 1
    : activePosition.value + (event.key === 'ArrowRight' ? 1 : -1)
  const next = candidate < 0 ? candidate + count : candidate >= characters.length ? candidate - count : candidate
  select(next)
  void nextTick(() => button(activePosition.value)?.focus({ preventScroll: true }))
}

watch(() => props.value, () => {
  if (characters[activePosition.value]?.type !== props.value) void syncSelection()
})
watch(() => props.disabled, disabled => { if (disabled) { stopDrag(); void syncSelection() } })
onMounted(async () => {
  motionQuery = window.matchMedia('(prefers-reduced-motion: reduce)')
  syncMotion()
  motionQuery.addEventListener('change', syncMotion)
  observer = new ResizeObserver(() => {
    if (viewport.value && (viewport.value.clientWidth !== centeredWidth || slots()[0]?.offsetWidth !== centeredSlotWidth)) void syncSelection()
  })
  if (viewport.value) observer.observe(viewport.value)
  window.addEventListener('pointerup', onPointerUp, true)
  window.addEventListener('pointercancel', onPointerUp, true)
  window.addEventListener('pointerdown', onOutsideInteraction, true)
  window.addEventListener('focusin', onOutsideInteraction, true)
  window.addEventListener('blur', stopDrag)
  await syncSelection()
  if (!disposed) ready.value = true
})
onBeforeUnmount(() => {
  disposed = true
  stopDrag()
  observer?.disconnect()
  clearTimeout(selectionTimer)
  if (rebaseFrame !== undefined) cancelAnimationFrame(rebaseFrame)
  motionQuery?.removeEventListener('change', syncMotion)
  window.removeEventListener('pointerup', onPointerUp, true)
  window.removeEventListener('pointercancel', onPointerUp, true)
  window.removeEventListener('pointerdown', onOutsideInteraction, true)
  window.removeEventListener('focusin', onOutsideInteraction, true)
  window.removeEventListener('blur', stopDrag)
})
</script>

<template>
  <div class="person-bot-picker" :class="{ rebasing, dragging, 'is-disabled': disabled }">
    <div ref="viewport" class="person-bot-viewport" @scroll.passive="onScroll" @scrollend="finishScroll"
      @wheel="onWheel" @keydown="onKeydown" @pointerdown="onPointerDown" @pointermove="onPointerMove"
      @pointerup="onPointerUp" @pointercancel="onPointerUp" @lostpointercapture="onPointerUp">
      <div class="person-bot-track">
        <div v-for="(bot, position) in characters" :key="position" class="person-bot-slot">
          <button type="button" class="person-bot-option" :data-bot="bot.type"
            :class="{ selected: position === activePosition }"
            :aria-pressed="position === activePosition" :disabled="disabled"
            :aria-hidden="Math.abs(position - activePosition) > Math.floor(count / 2) ? true : undefined"
            :tabindex="position === activePosition ? 0 : -1"
            @click="select(position)">
            <img :src="deploymentUrl(playing(position) ? bot.animations.idle : bot.idleFrame)"
              alt="" width="160" height="160" draggable="false" />
            <span class="person-bot-name">{{ personBotLabel(bot) }}</span>
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;
.person-bot-picker {
  --bot-width: 160px;
  --bot-gap: 22px;
  container-type: inline-size;
  flex: none;
  min-width: 0;
  width: min(1040px, 100%);
  margin: 16px auto 0;
}
.person-bot-viewport {
  position: relative;
  direction: ltr;
  overflow-x: auto;
  scrollbar-width: none;
  overscroll-behavior-x: contain;
  touch-action: pan-x pan-y;
  mask-image: linear-gradient(90deg, transparent, $text-primary 24px, $text-primary calc(100% - 24px), transparent);
  &::-webkit-scrollbar { display: none; }
  .is-disabled & { overflow-x: hidden; touch-action: pan-y; }
}
.person-bot-track {
  display: flex;
  align-items: center;
  gap: var(--bot-gap);
  width: max-content;
  padding: 48px max(20px, calc((100cqw - var(--bot-width)) / 2)) 24px;
}
.person-bot-slot { flex: none; width: var(--bot-width); user-select: none; }
.person-bot-option {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  width: 100%;
  padding: 0 0 6px;
  border: 0;
  border-radius: $radius-md;
  background: transparent;
  color: $text-secondary;
  font: inherit;
  cursor: pointer;
  -webkit-tap-highlight-color: transparent;
  img {
    display: block; width: 100%; height: auto; aspect-ratio: 1; object-fit: contain;
    transform-origin: 50% 75%;
    transition: transform .2s ease;
  }
  &.selected img { transform: translateY(-4px) scale(1.24); }
  &:focus-visible, &.selected { color: $text-primary; }
  &:focus-visible { outline: 2px solid $accent-primary; outline-offset: 4px; }
  &:disabled { cursor: default; opacity: .5; }
  .dragging & { cursor: grabbing; }
  .rebasing & img { transition: none; }
}
.person-bot-name {
  position: relative;
  padding-bottom: 7px;
  font-size: 13px;
  line-height: 1.4;
  .selected & {
    font-weight: 600;
    &::after {
      content: '';
      position: absolute;
      bottom: 0;
      left: 50%;
      width: 16px;
      height: 2px;
      border-radius: 2px;
      background: $accent-primary;
      transform: translateX(-50%);
    }
  }
}
@media (max-width: $breakpoint-mobile) {
  .person-bot-picker { --bot-width: 124px; --bot-gap: 12px; margin: 8px auto 0; }
  .person-bot-track { padding-top: 36px; padding-bottom: 16px; }
  .person-bot-name { font-size: 12px; }
}
@media (prefers-reduced-motion: reduce) {
  .person-bot-option img { transition: none; }
}
</style>
