import { onBeforeUnmount, watch, type Ref } from 'vue'
import { usePageLoadingState } from './usePageLoading'

/** Reveal each loaded conversation without remounting its transcript or composer. */
export function useChatSurfaceReveal(surface: Ref<HTMLElement | null>, sessionKey: () => string, ready: () => boolean) {
  const pageLoading = usePageLoadingState()
  let selection = ''
  let revealed = false
  let animation: Animation | undefined
  watch([surface, sessionKey, ready, pageLoading], ([element, key, loaded, covered]) => {
    if (key !== selection || !element) {
      animation?.cancel()
      selection = key
      revealed = false
    }
    if (!element || !key || !loaded || covered || revealed) return
    revealed = true
    if (typeof element.animate !== 'function' || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return
    animation = element.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 1500, easing: 'ease' })
  }, { immediate: true, flush: 'post' })
  onBeforeUnmount(() => animation?.cancel())
}
