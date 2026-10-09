<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { chatSessionAgentAvatar } from '@/utils/chat-agent-avatar'
import type { AGENT_OPTIONS } from '@/utils/agent-options'

type AgentOption = typeof AGENT_OPTIONS[number]
const props = defineProps<{
  value: AgentOption['value']
  options: readonly AgentOption[]
  disabled?: boolean
  loading?: boolean
}>()
const emit = defineEmits<{ 'update:value': [value: AgentOption['value']] }>()
const { t } = useI18n()
const viewport = ref<HTMLElement>()
const effects = ref<HTMLElement>()
const loop = computed(() => props.options.length > 5)
const cards = computed(() => Array.from({ length: loop.value ? 3 : 1 }, () => props.options).flat())
const activePosition = ref(0)
type EmberEdge = 'left' | 'right' | 'top' | 'bottom'
const random = (min: number, max: number) => min + Math.random() * (max - min)
const emberSlots = (['left', 'right', 'top', 'bottom'] as const).flatMap(edge => {
  const count = edge === 'bottom' ? 3 : 7
  return Array.from({ length: count }, (_, slot) => ({ edge, slot, count }))
})
let motionQuery: MediaQueryList | undefined
function createEmber(edge: EmberEdge, slot: number, count: number) {
  const outward = edge === 'left' ? -1 : edge === 'right' ? 1 : 0
  const reduced = motionQuery?.matches
  return {
    position: (slot + random(.12, .88)) / count,
    inset: random(3, 7), size: random(2.2, 3.4), brightness: random(.7, 1),
    rise: reduced ? random(24, 36) : random(32, 48),
    duration: reduced ? random(4600, 6800) : random(3000, 5600),
    phase: random(0, 5600), cycle: -1,
    wind: [0, ...Array.from({ length: 5 }, () => outward ? outward * random(1, 10) : random(-10, 10))],
  }
}
function createEmbers() { return emberSlots.map(ember => createEmber(ember.edge, ember.slot, ember.count)) }
let embers = createEmbers()
let effectFrame: number | null = null
let effectBounds = ''
let effectCard: HTMLElement | null = null
let halos: HTMLElement[] = []
let rim: HTMLElement | null = null
let foil: HTMLElement | null = null
let foilBeams: HTMLElement[] = []
let sweep: HTMLElement | null = null
let emberElements: HTMLElement[] = []

function paintCardInterior(now: number) {
  const seconds = motionQuery?.matches ? 0 : now / 1000
  const phase = seconds / 8 * Math.PI * 2
  const x = Math.sin(phase), y = Math.cos(phase)
  if (foil) foil.style.transform = `translate(${7 * x}%, ${5 * y}%) rotate(${24 * x}deg) scale(1.08)`
  foilBeams.forEach((beam, index) => {
    beam.style.transform = `translateX(${(index ? -1 : 1) * 13 * x}%) rotate(${29 + 7 * y}deg)`
    beam.style.opacity = String(.25 + (index ? .2 : .5) * (1 + y) / 2)
  })
  if (sweep) {
    const progress = (seconds / 4 + .2) % 1
    sweep.style.transform = `translateX(${-72 + 144 * progress}%)`
    sweep.style.opacity = String(.2 + .45 * Math.sin(progress * Math.PI))
  }
}

function paintEffects(now: number) {
  // A foreground layer and numeric transforms also work with desktop CSS animations disabled.
  const layer = effects.value
  const card = viewport.value?.querySelector<HTMLElement>('.agent-card.active')
  if (!layer || !card) return
  if (effectCard !== card) {
    effectCard = card
    halos = Array.from(card.querySelectorAll<HTMLElement>('.agent-card-halo'))
    rim = card.querySelector<HTMLElement>('.agent-card-rim')
    foil = card.querySelector<HTMLElement>('.agent-card-foil')
    foilBeams = Array.from(card.querySelectorAll<HTMLElement>('.agent-card-foil-beam'))
    sweep = card.querySelector<HTMLElement>('.agent-card-sweep')
  }
  const root = layer.parentElement!.getBoundingClientRect()
  const rect = card.getBoundingClientRect()
  const bounds = `${rect.left - root.left}:${rect.top - root.top}:${rect.width}:${rect.height}`
  if (bounds !== effectBounds) {
    effectBounds = bounds
    Object.assign(layer.style, { left: `${rect.left - root.left}px`, top: `${rect.top - root.top}px`,
      width: `${rect.width}px`, height: `${rect.height}px` })
  }
  emberElements.forEach((element, index) => {
    const { edge, slot, count } = emberSlots[index]
    let ember = embers[index]
    const elapsed = now + ember.phase
    const cycle = Math.floor(elapsed / ember.duration)
    if (ember.cycle !== cycle) {
      const path = createEmber(edge, slot, count)
      ember = embers[index] = { ...path, duration: ember.duration, phase: ember.phase, cycle }
      element.style.width = element.style.height = `${ember.size}px`
    }
    const progress = elapsed / ember.duration - cycle
    const segment = Math.min(4, Math.floor(progress * 5))
    const drift = ember.wind[segment] + (ember.wind[segment + 1] - ember.wind[segment]) * (progress * 5 - segment)
    const x = edge === 'left' ? -ember.inset : edge === 'right' ? rect.width + ember.inset : rect.width * ember.position
    const y = edge === 'top' ? -ember.inset : edge === 'bottom' ? rect.height + ember.inset : rect.height * ember.position
    const opacity = progress < .08 ? 0 : progress < .22 ? (progress - .08) / .14 : (1 - progress) / .78
    element.style.opacity = String(opacity * ember.brightness)
    element.style.transform = `translate(${x + drift}px, ${y + 4 - (ember.rise + 4) * progress}px) scale(${.4 + Math.sin(progress * Math.PI) * .6})`
  })
  const pace = motionQuery?.matches ? .65 : 1
  const pulse = (Math.sin(now / 4800 * Math.PI * 2 * pace) + 1) / 2
  if (halos[0]) halos[0].style.opacity = String(.24 + pulse * .16)
  if (halos[1]) halos[1].style.opacity = String(.1 + (1 - pulse) * .08)
  if (rim) rim.style.backgroundPosition = `${100 - pulse * 100}% ${20 + pulse * 60}%`
  paintCardInterior(now)
}

function animateEffects(now: number) {
  effectFrame = null
  if (document.hidden) return
  paintEffects(now)
  effectFrame = requestAnimationFrame(animateEffects)
}
function syncEffectVisibility() {
  if (document.hidden) {
    stopPointerDrag()
    if (effectFrame !== null) cancelAnimationFrame(effectFrame)
    effectFrame = null
  } else if (effectFrame === null) effectFrame = requestAnimationFrame(animateEffects)
}
function syncEffectMotion() { embers = createEmbers() }

function onCardPointerMove(event: PointerEvent, position: number) {
  if (event.pointerType !== 'mouse' || position !== activePosition.value || pointer?.moved || props.disabled) return
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return
  const card = event.currentTarget as HTMLElement
  const rect = card.getBoundingClientRect()
  const x = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width))
  const y = Math.min(1, Math.max(0, (event.clientY - rect.top) / rect.height))
  card.style.setProperty('--px', `${(x - .5) * 9}px`)
  card.style.setProperty('--py', `${(y - .5) * 7}px`)
  card.style.setProperty('--mx', `${x * 100}%`)
  card.style.setProperty('--my', `${y * 100}%`)
  card.style.setProperty('--sheen', '.7')
}

function resetCardPointer(event: PointerEvent) {
  const card = event.currentTarget as HTMLElement
  for (const prop of ['--px', '--py', '--mx', '--my', '--sheen']) card.style.removeProperty(prop)
}
let observer: ResizeObserver | undefined
let selectionTimer: ReturnType<typeof setTimeout> | undefined
let movingTo: number | null = null
let centeredLayout: { width: number; height: number; cardWidth: number } | undefined
let pointer: { id: number; x: number; left: number; moved: boolean } | null = null
let suppressClick = false
let rebaseFrame: number | undefined

function slots() {
  return Array.from(viewport.value?.querySelectorAll<HTMLElement>('.agent-card-slot') || [])
}

function center(position: number, smooth = false) {
  const el = viewport.value
  const slot = slots()[position]
  if (!el || !slot) return
  activePosition.value = position
  movingTo = position
  centeredLayout = { width: el.clientWidth, height: el.clientHeight, cardWidth: slot.offsetWidth }
  clearTimeout(selectionTimer)
  el.scrollTo({ left: slot.offsetLeft + slot.offsetWidth / 2 - el.clientWidth / 2,
    behavior: smooth && !window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'smooth' : 'instant' })
  selectionTimer = setTimeout(() => { finishScroll(); movingTo = null }, smooth ? 1200 : 50)
}

async function syncSelection() {
  await nextTick()
  const index = props.options.findIndex(option => option.value === props.value)
  if (index < 0) return
  const position = cards.value[activePosition.value]?.value === props.value
    ? activePosition.value : index + (loop.value ? props.options.length : 0)
  center(position)
}

function select(position: number) {
  if (props.disabled || suppressClick) return
  emit('update:value', cards.value[position].value)
  center(position, true)
}

function onScroll() {
  const el = viewport.value
  if (!el || props.disabled || movingTo !== null) return
  const middle = el.scrollLeft + el.clientWidth / 2
  const allSlots = slots()
  if (centeredLayout && (centeredLayout.width !== el.clientWidth
    || centeredLayout.height !== el.clientHeight
    || centeredLayout.cardWidth !== allSlots[0]?.offsetWidth)) {
    // Form and window resizes change card geometry, not the selected Agent.
    void syncSelection()
    return
  }
  let closest = 0
  let distance = Infinity
  allSlots.forEach((slot, index) => {
    const delta = Math.abs(slot.offsetLeft + slot.offsetWidth / 2 - middle)
    if (delta < distance) { distance = delta; closest = index }
  })
  activePosition.value = closest
  const option = cards.value[closest]
  if (option && option.value !== props.value) emit('update:value', option.value)
  // Rebase the repeating row without changing the position within a card.
  const count = props.options.length
  if (loop.value && (closest < count || closest >= count * 2)) {
    const next = closest < count ? closest + count : closest - count
    const delta = allSlots[next].offsetLeft - allSlots[closest].offsetLeft
    el.scrollLeft += delta
    activePosition.value = next
    if (pointer) pointer.left += delta
  }
}

function onPointerDown(event: PointerEvent) {
  movingTo = null
  clearTimeout(selectionTimer)
  if (event.pointerType !== 'mouse' || event.button !== 0 || props.disabled || !viewport.value) return
  pointer = { id: event.pointerId, x: event.clientX, left: viewport.value.scrollLeft, moved: false }
  suppressClick = false
}

function onPointerMove(event: PointerEvent) {
  if (!pointer || !viewport.value || event.pointerId !== pointer.id) return
  // Mouseup may occur outside the window before the row captures the pointer.
  if (!(event.buttons & 1)) { stopPointerDrag(); return }
  const delta = event.clientX - pointer.x
  if (!pointer.moved && Math.abs(delta) > 5) {
    pointer.moved = true
    viewport.value.setPointerCapture(event.pointerId)
  }
  if (pointer.moved) { event.preventDefault(); viewport.value.scrollLeft = pointer.left - delta }
}

function stopPointerDrag() {
  if (!pointer) return
  const id = pointer.id
  suppressClick = pointer.moved
  pointer = null
  if (viewport.value?.hasPointerCapture(id)) viewport.value.releasePointerCapture(id)
}

function onPointerUp(event: PointerEvent) {
  if (event.pointerId === pointer?.id) stopPointerDrag()
}

function finishScroll() {
  const el = viewport.value
  const target = movingTo === null ? null : slots()[movingTo]
  // An earlier scroll can finish before the new centering animation has reached its card.
  if (el && target && Math.abs(el.scrollLeft - (target.offsetLeft + target.offsetWidth / 2 - el.clientWidth / 2)) > 1) return
  const position = movingTo
  clearTimeout(selectionTimer)
  movingTo = null
  const count = props.options.length
  if (el && position !== null && loop.value && (position < count || position >= count * 2)) {
    // The clicked card has already animated to its selected size. Switching
    // to the middle copy must not replay that animation on a different node.
    const next = position < count ? position + count : position - count
    const allSlots = slots()
    const source = allSlots[position].querySelector<HTMLElement>('.agent-card')!
    const destination = allSlots[next].querySelector<HTMLElement>('.agent-card')!
    for (const key of ['--px', '--py', '--mx', '--my', '--sheen']) {
      const value = source.style.getPropertyValue(key)
      if (value) destination.style.setProperty(key, value)
      else destination.style.removeProperty(key)
    }
    el.classList.add('agent-card-viewport--rebasing')
    activePosition.value = next
    el.scrollLeft += allSlots[next].offsetLeft - allSlots[position].offsetLeft
    if (rebaseFrame !== undefined) cancelAnimationFrame(rebaseFrame)
    void nextTick(() => {
      if (!el.isConnected) return
      // Apply the selected styles before restoring normal transitions.
      void destination.offsetWidth
      rebaseFrame = requestAnimationFrame(() => {
        el.classList.remove('agent-card-viewport--rebasing')
        rebaseFrame = undefined
      })
    })
    return
  }
  onScroll()
}

function onWheel() {
  clearTimeout(selectionTimer)
  movingTo = null
}

function onKeydown(event: KeyboardEvent) {
  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key) || props.disabled) return
  event.preventDefault()
  const count = props.options.length
  if (!count) return
  const index = props.options.findIndex(option => option.value === props.value)
  const next = event.key === 'Home' ? 0 : event.key === 'End' ? count - 1
    : (index + (event.key === 'ArrowRight' ? 1 : -1) + count) % count
  suppressClick = false
  select(next + (loop.value ? count : 0))
  nextTick(() => slots()[activePosition.value]?.querySelector<HTMLButtonElement>('button')?.focus({ preventScroll: true }))
}

watch(() => props.value, () => {
  if (cards.value[activePosition.value]?.value !== props.value) void syncSelection()
})
watch(activePosition, syncEffectMotion)
watch(() => props.options, () => {
  activePosition.value = Math.max(0, props.options.findIndex(option => option.value === props.value))
    + (loop.value ? props.options.length : 0)
  void syncSelection()
}, { deep: true })
onMounted(() => {
  observer = new ResizeObserver(() => { void syncSelection() })
  if (viewport.value) observer.observe(viewport.value)
  motionQuery = window.matchMedia('(prefers-reduced-motion: reduce)')
  motionQuery.addEventListener('change', syncEffectMotion)
  // Listen before bubbling can be stopped by controls outside the card row.
  window.addEventListener('pointerup', onPointerUp, true)
  window.addEventListener('pointercancel', onPointerUp, true)
  window.addEventListener('blur', stopPointerDrag)
  document.addEventListener('visibilitychange', syncEffectVisibility)
  emberElements = Array.from(effects.value?.querySelectorAll<HTMLElement>('.agent-card-ember') || [])
  syncEffectMotion()
  syncEffectVisibility()
  void syncSelection()
})
onUnmounted(() => {
  stopPointerDrag()
  observer?.disconnect(); clearTimeout(selectionTimer)
  if (rebaseFrame !== undefined) cancelAnimationFrame(rebaseFrame)
  if (effectFrame !== null) cancelAnimationFrame(effectFrame)
  motionQuery?.removeEventListener('change', syncEffectMotion)
  window.removeEventListener('pointerup', onPointerUp, true)
  window.removeEventListener('pointercancel', onPointerUp, true)
  window.removeEventListener('blur', stopPointerDrag)
  document.removeEventListener('visibilitychange', syncEffectVisibility)
})
</script>

<template>
  <div class="agent-cards" :aria-label="t('chat.agent')" :aria-busy="loading">
    <div ref="viewport" class="agent-card-viewport" @scroll.passive="onScroll" @scrollend="finishScroll" @wheel.passive="onWheel" @keydown="onKeydown"
      @pointerdown="onPointerDown" @pointermove="onPointerMove" @pointerup="onPointerUp" @pointercancel="onPointerUp" @lostpointercapture="onPointerUp">
      <div class="agent-card-track">
        <div v-for="(option, position) in cards" :key="`${option.value}-${position}`" class="agent-card-slot">
          <button type="button" class="agent-card" :data-agent="option.value" :class="{ active: position === activePosition }"
            :disabled="disabled" :aria-label="option.label" :aria-pressed="position === activePosition"
            :aria-hidden="loop && Math.abs(position - activePosition) > 2 ? true : undefined"
            :tabindex="position === activePosition ? 0 : -1" @click="select(position)"
            @pointermove="onCardPointerMove($event, position)" @pointerleave="resetCardPointer">
            <span class="agent-card-aura" aria-hidden="true">
              <span class="agent-card-halo"></span><span class="agent-card-halo second"></span>
            </span>
            <span class="agent-card-surface">
              <span class="agent-card-art" aria-hidden="true">
                <span class="agent-card-stone"><img :src="chatSessionAgentAvatar({ codingAgentId: option.value }).src" alt="" draggable="false" /></span>
              </span>
              <span class="agent-card-name" :class="{ long: option.label.length > 11 }">{{ option.label }}</span>
              <span class="agent-card-mark" aria-hidden="true"></span>
              <span class="agent-card-foil-lines" aria-hidden="true"></span>
              <span class="agent-card-foil" aria-hidden="true"></span>
              <span class="agent-card-foil-beam" aria-hidden="true"></span><span class="agent-card-foil-beam second" aria-hidden="true"></span>
              <span class="agent-card-sweep" aria-hidden="true"></span>
              <span class="agent-card-glare" aria-hidden="true"></span>
            </span>
            <span class="agent-card-rim" aria-hidden="true"></span>
          </button>
        </div>
      </div>
    </div>
    <span ref="effects" class="agent-card-effects" aria-hidden="true">
      <i v-for="ember in emberSlots" :key="`${ember.edge}-${ember.slot}`" class="agent-card-ember" :data-edge="ember.edge"></i>
    </span>
    <span class="agent-card-side-fade" aria-hidden="true"></span><span class="agent-card-side-fade right" aria-hidden="true"></span>
  </div>
</template>

<style scoped lang="scss">
.agent-cards {
  --card-width: clamp(64px, calc((100cqh - 84px) / 1.4), 176px); --card-gap: 14px;
  --logo-size: calc(var(--card-width) * .47); --logo-gap: clamp(6px, calc(var(--card-width) * .1), 18px);
  position: relative; container-type: size; min-width: 0; width: 100%;
}
.agent-card-viewport {
  position: relative; height: 100%; display: flex; align-items: center;
  overflow-x: auto; scrollbar-width: none; overscroll-behavior-x: contain;
  &::-webkit-scrollbar { display: none; }
}
.agent-card-viewport--rebasing .agent-card,
.agent-card-viewport--rebasing .agent-card * { transition: none !important; }
.agent-card-track {
  display: flex; flex: none; align-items: center; gap: var(--card-gap); width: max-content;
  // Keep the entire upward particle path inside the scrolling viewport.
  padding: 54px max(0px, calc((100cqw - var(--card-width)) / 2)) 30px;
}
.agent-card-slot { width: var(--card-width); flex: none; user-select: none; }
.agent-card {
  --mx: 55%; --my: 38%; --sheen: 0;
  position: relative; isolation: isolate; display: block; width: 100%; aspect-ratio: 1 / 1.4; padding: 3px;
  border: 0; border-radius: 16px; cursor: pointer; font: inherit;
  background: linear-gradient(135deg, #b68a38, #f4d986 16%, #fff0b1 25%, #c89940 43%, #efd17e 61%, #a97829 80%, #f2d38a);
  box-shadow: 0 6px 16px #30433409, inset 0 0 0 1px #ba913b55;
  transform: scale(.88); opacity: .7; transition: transform .14s ease-out, opacity .14s, box-shadow .14s;
  &.active {
    transform: scale(1); opacity: 1;
    background: linear-gradient(135deg, #c79328, #ffe391 14%, #fff5ca 25%, #d7a136 43%, #ffdf82 61%, #bd8525 81%, #ffedaa);
    box-shadow: 0 19px 28px -17px #69511c45, 0 0 0 1px #fff0b2b3, 0 0 12px 2px #efbd4f50, 0 0 29px 5px #efc96538;
  }
  &:focus-visible { outline: 2px solid var(--accent-primary); outline-offset: 7px; }
  &:disabled { cursor: default; }
}
.agent-card-surface {
  position: relative; isolation: isolate; overflow: hidden; display: flex; height: 100%; align-items: center;
  justify-content: center; flex-direction: column; gap: var(--logo-gap); padding: calc(var(--card-width) * .08); border-radius: 13px;
  color: #fffbea;
  background: radial-gradient(ellipse at 100% 100%, #dcece066, transparent 62%),
    radial-gradient(ellipse at 6% 8%, #fce8aa88, transparent 56%),
    radial-gradient(ellipse at 100% 35%, #73c6b755, transparent 54%),
    linear-gradient(145deg, #8e977f 0%, #646f60 23%, #bead73 46%, #828d79 65%, #8eac9b 100%);
  &::before {
    content: ''; position: absolute; inset: 0; z-index: 3; pointer-events: none; opacity: .36;
    background-image: radial-gradient(#fff 1px, transparent 1px); background-size: 25px 25px;
    mask-image: linear-gradient(transparent, #000);
  }
  &::after { content: ''; position: absolute; inset: 7px; z-index: 6; border: 1px solid #ffffff8c; border-radius: 12px; pointer-events: none; }
}
.agent-card-aura {
  position: absolute; inset: 0; z-index: -1; border-radius: inherit; pointer-events: none;
  opacity: 0; transition: opacity .5s;
  .active & { opacity: 1; }
}
.agent-card-halo {
  position: absolute; inset: -4px; border-radius: 24px; background: #f5c851; filter: blur(9px); opacity: .3;
  &.second {
    inset: -6px; border-radius: 26px; background: #ffdb86; filter: blur(14px); opacity: .14;
  }
}
.agent-card-effects { position: absolute; z-index: 12; pointer-events: none; }
.agent-card-ember {
  position: absolute; left: 0; top: 0; width: 3px; height: 3px; border-radius: 50%; pointer-events: none;
  background: #f4c45e; box-shadow: 0 0 4px 1px #d79c3d88; opacity: 0;
}
.agent-card-rim {
  position: absolute; inset: 0; z-index: 9; padding: 3px; border-radius: inherit; pointer-events: none;
  background: linear-gradient(115deg, transparent 24%, #fffce3 32%, #fff4b9 35%, transparent 43%, transparent 66%, #fff5c466 72%, transparent 80%);
  background-size: 300% 200%;
  mask: linear-gradient(#fff 0 0) content-box, linear-gradient(#fff 0 0); mask-composite: exclude;
  opacity: 0; transition: opacity .45s;
  .active & { opacity: .9; }
}
.agent-card-art { position: relative; z-index: 4; width: calc(var(--logo-size) * 1.16); height: calc(var(--logo-size) * 1.16); flex: none; }
.agent-card-stone {
  position: absolute; width: var(--logo-size); height: var(--logo-size); left: 50%; top: 50%;
  display: grid; place-items: center; border-radius: 26%;
  background: linear-gradient(135deg, #ffffffeb, #ffffff95); border: 1px solid #ffffffee;
  box-shadow: 10px 18px 26px #9b895522, inset 0 1px 2px #fff;
  transform: translate(-50%, -50%) rotate(-9deg) rotateX(7deg); transition: transform .2s;
  .active & { transform: translate(calc(-50% - var(--px, 0px)), calc(-50% - var(--py, 0px))) rotate(-9deg) rotateX(7deg); }
  img { width: 62%; height: 62%; object-fit: contain; border-radius: 22%; clip-path: inset(0 round 22%); pointer-events: none; }
}
.agent-card-name {
  position: relative; z-index: 5; flex: none; width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  font-size: clamp(11px, calc(var(--card-width) * .108), 19px); font-weight: 650; letter-spacing: -.7px; text-align: center; line-height: 1.1;
  text-shadow: 0 2px 8px #22332977;
  &.long { font-size: clamp(9px, calc(var(--card-width) * .08), 14px); }
}
.agent-card-mark {
  position: relative; z-index: 4; flex: none; width: 18%; height: 1px; pointer-events: none;
  background: linear-gradient(90deg, transparent, #e8d598b3, transparent);
}
.agent-card-foil-lines {
  position: absolute; inset: 0; z-index: 3; pointer-events: none; opacity: .65;
  background: repeating-linear-gradient(115deg, transparent 0 4px, #fff2 5px, transparent 6px);
}
.agent-card-foil {
  position: absolute; inset: -35%; z-index: 1; pointer-events: none;
  background: conic-gradient(from 190deg at 42% 38%, #303d3300 0deg, #fff2c199 20deg,
    #bde0d499 40deg, #e6eadd55 53deg, #e8c77c88 68deg, #3f483500 99deg,
    #3f473755 150deg, #ffe4a899 179deg, #ebf2d888 193deg, #7acbbb55 211deg,
    #f0ddac55 229deg, #34392e00 260deg, #c3d1bd55 315deg, #313a2e00);
  mix-blend-mode: screen; filter: blur(calc(var(--card-width) * .009));
  opacity: .55; transition: opacity .45s;
  .active & { opacity: .86; will-change: transform; }
  .active:hover & { opacity: .95; }
}
.agent-card-foil-beam {
  position: absolute; z-index: 2; left: 24%; top: -38%; width: 100%; height: 210%; pointer-events: none;
  background: linear-gradient(90deg, transparent, #fff9e322 1%, transparent 3%, #d6efdf35 44%, #fffbe277 47%, transparent 48%);
  transform: rotate(29deg); opacity: .45;
  &.second { left: -44%; top: -22%; opacity: .25; }
  .active & { will-change: transform, opacity; }
}
.agent-card-sweep {
  position: absolute; inset: 0; z-index: 2; pointer-events: none; opacity: .2;
  background: linear-gradient(112deg, transparent 30%, #fffbea55 45%, #fffffaaa 49%, #e0f6e944 53%, transparent 64%);
  transform: translateX(-43.2%);
  .active & { will-change: transform, opacity; }
}
.agent-card-glare {
  position: absolute; inset: 0; z-index: 8; pointer-events: none; border-radius: inherit;
  background: radial-gradient(ellipse at var(--mx) var(--my), #ffffff75, transparent 60%);
  opacity: var(--sheen); mix-blend-mode: screen; transition: opacity .2s;
}
.agent-card-side-fade {
  position: absolute; inset: 0 auto 0 0; width: 70px; z-index: 10; pointer-events: none;
  background: linear-gradient(90deg, var(--bg-main-surface), transparent);
  &.right { left: auto; right: 0; transform: rotate(180deg); }
}
.dark .agent-card { opacity: 1; }
.dark .agent-card.active { box-shadow: 0 22px 33px -17px #0009, 0 0 0 1px #fff0b27a, 0 0 14px 2px #efbd4f60, 0 0 32px 5px #efc96538; }
@media (max-width: 768px) {
  .agent-cards { container-type: inline-size; --card-width: clamp(82px, calc((100cqw - 24px) / 4), 134px); --card-gap: 6px; --logo-size: calc(var(--card-width) * .62); --logo-gap: clamp(6px, 2vw, 12px); }
  .agent-card-viewport { height: auto; }
  .agent-card-track { padding-top: 50px; padding-bottom: 26px; }
  .agent-card { border-radius: 9px; padding: 1.5px; opacity: .78; }
  .agent-card.active { z-index: 2; box-shadow: 0 9px 15px -8px #69511c45, 0 0 0 1px #fff0b299, 0 0 9px 1px #efbd4f50, 0 0 17px 2px #efc96530; }
  .dark .agent-card.active { box-shadow: 0 9px 15px -8px #0009, 0 0 0 1px #fff0b27a, 0 0 10px 1px #efbd4f60, 0 0 18px 2px #efc96538; }
  .agent-card-surface { border-radius: 7.5px; padding: 8px 4px; &::before { background-size: 12px 12px; } &::after { inset: 3px; border-radius: 5px; border-color: #ffffff70; } }
  .agent-card-rim { padding: 1.5px; }
  .agent-card-halo { inset: -2px; border-radius: 11px; filter: blur(5px); }
  .agent-card-halo.second { inset: -3px; border-radius: 12px; filter: blur(8px); }
  .agent-card-stone { border-radius: 26%; box-shadow: 3px 6px 10px #9b895522, inset 0 1px 2px #fff; img { width: calc(var(--card-width) * .4); height: calc(var(--card-width) * .4); } }
  .agent-card-name, .agent-card-name.long { font-size: clamp(9px, 2.55vw, 12px); letter-spacing: -.15px; line-height: 1.3; }
  .agent-card-side-fade { width: 6px; }
}
@media (max-width: 480px) {
  .agent-cards { --card-width: clamp(144px, 44cqw, 190px); --card-gap: 12px; --logo-gap: 14px; }
  .agent-card { border-radius: 14px; padding: 2px; }
  .agent-card-surface { border-radius: 12px; padding: 12px 8px; &::after { inset: 5px; border-radius: 9px; } }
  .agent-card-rim { padding: 2px; }
  .agent-card-halo { border-radius: 17px; }
  .agent-card-halo.second { border-radius: 18px; }
  .agent-card-name {
    font-size: 16px; line-height: 1.25; white-space: normal; text-overflow: clip; overflow-wrap: anywhere;
    &.long { font-size: 13px; }
  }
  .agent-card-side-fade { width: 16px; }
}
@media (max-width: 480px) and (max-height: 640px) {
  .agent-cards { --card-width: clamp(112px, min(44cqw, calc((100svh - 370px) / 1.4)), 190px); --logo-gap: 10px; }
  .agent-card-track { padding-top: 40px; padding-bottom: 20px; }
  .agent-card-name { font-size: 14px; &.long { font-size: 12px; } }
}
@media (prefers-reduced-motion: reduce) {
  .agent-card, .agent-card-stone { transition: none; }
}
</style>
