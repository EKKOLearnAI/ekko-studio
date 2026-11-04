import { computed, onScopeDispose, ref } from 'vue'

export function useTaskDrawerLayout() {
  const query = window.matchMedia('(max-width: 768px)')
  const isMobile = ref(query.matches)
  const update = (event: MediaQueryListEvent) => { isMobile.value = event.matches }
  query.addEventListener('change', update)
  onScopeDispose(() => query.removeEventListener('change', update))
  const drawerWidth = computed(() => isMobile.value ? '100vw' : 'min(1200px, calc(100vw - 64px))')
  return { isMobile, drawerWidth }
}
