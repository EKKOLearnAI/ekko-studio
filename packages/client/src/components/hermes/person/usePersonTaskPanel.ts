import { computed, onBeforeUnmount, onMounted, ref, type Ref } from 'vue'
import { useTaskDrawerLayout } from '@/components/hermes/tasks/useTaskDrawerLayout'

const storageKey = 'hermes.person.agentPanelWidth'

export function usePersonTaskPanel(panel: Readonly<Ref<HTMLElement | null>>) {
  const { isMobile } = useTaskDrawerLayout()
  const viewportWidth = ref(window.innerWidth)
  const availableWidth = ref(window.innerWidth)
  const preferredWidth = ref<number | null>(null)
  try {
    const saved = Number(localStorage.getItem(storageKey))
    if (Number.isFinite(saved) && saved >= 320) preferredWidth.value = saved
  } catch { /* Storage may be unavailable. */ }
  const maxWidth = computed(() => Math.max(320, availableWidth.value - 320))
  const width = computed(() => isMobile.value ? availableWidth.value
    : Math.min(maxWidth.value, Math.max(320, preferredWidth.value ?? viewportWidth.value / 3)))
  const direction = () => document.documentElement.dir === 'rtl' ? 1 : -1
  let start: { x: number; width: number } | null = null
  let observer: ResizeObserver | undefined

  function save() {
    try { localStorage.setItem(storageKey, String(preferredWidth.value)) } catch { /* Storage may be unavailable. */ }
  }
  function setWidth(value: number) {
    preferredWidth.value = Math.min(maxWidth.value, Math.max(320, value))
  }
  function move(event: PointerEvent) {
    if (start) setWidth(start.width + (event.clientX - start.x) * direction())
  }
  function stop() {
    if (!start) return
    start = null
    window.removeEventListener('pointermove', move)
    window.removeEventListener('pointerup', stop)
    window.removeEventListener('pointercancel', stop)
    save()
  }
  function startResize(event: PointerEvent) {
    if (isMobile.value || event.button !== 0) return
    event.preventDefault()
    start = { x: event.clientX, width: width.value }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', stop)
    window.addEventListener('pointercancel', stop)
  }
  function resizeWithKeyboard(event: KeyboardEvent) {
    if (isMobile.value || !['ArrowLeft', 'ArrowRight'].includes(event.key)) return
    event.preventDefault()
    setWidth(width.value + (event.key === 'ArrowRight' ? 32 : -32) * direction())
    save()
  }
  function measure() {
    viewportWidth.value = window.innerWidth
    availableWidth.value = panel.value?.parentElement?.clientWidth || window.innerWidth
    if (isMobile.value) stop()
  }
  onMounted(() => {
    measure()
    observer = new ResizeObserver(measure)
    if (panel.value?.parentElement) observer.observe(panel.value.parentElement)
    window.addEventListener('resize', measure)
  })
  onBeforeUnmount(() => {
    stop()
    observer?.disconnect()
    window.removeEventListener('resize', measure)
  })
  return { isMobile, width, maxWidth, startResize, resizeWithKeyboard }
}
