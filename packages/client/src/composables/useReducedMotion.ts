import { onBeforeUnmount, onMounted, ref } from 'vue'

export function useReducedMotion() {
  const reducedMotion = ref(false)
  let query: MediaQueryList | undefined
  const sync = () => { reducedMotion.value = query?.matches ?? false }
  onMounted(() => {
    query = window.matchMedia('(prefers-reduced-motion: reduce)')
    sync()
    query.addEventListener('change', sync)
  })
  onBeforeUnmount(() => query?.removeEventListener('change', sync))
  return reducedMotion
}
