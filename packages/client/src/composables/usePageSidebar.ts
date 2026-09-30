import { computed, inject, onMounted, onUnmounted, ref, type InjectionKey, type Ref } from 'vue'

export interface MobileNavigation {
  open: Ref<boolean>
  target: Readonly<Ref<HTMLElement | null>>
}

export const mobileNavigationKey: InjectionKey<MobileNavigation> = Symbol('mobileNavigation')

export function useMobileNavigation() {
  return inject(mobileNavigationKey, null)
}

// Each page keeps its desktop collapse state; mobile pages share one drawer.
export function usePageSidebarState(desktopExpanded = true) {
  const navigation = useMobileNavigation()
  const query = typeof window === 'undefined' ? null : window.matchMedia('(max-width: 768px)')
  const isMobile = ref(query?.matches ?? false)
  const desktopOpen = ref(desktopExpanded)
  const mobileOpen = ref(false)
  const expanded = computed({
    get: () => isMobile.value ? (navigation?.open.value ?? mobileOpen.value) : desktopOpen.value,
    set: (value: boolean) => {
      if (isMobile.value) {
        if (navigation) navigation.open.value = value
        else mobileOpen.value = value
      } else desktopOpen.value = value
    },
  })

  function onViewportChange(event: MediaQueryListEvent) {
    isMobile.value = event.matches
    mobileOpen.value = false
  }
  onMounted(() => query?.addEventListener('change', onViewportChange))
  onUnmounted(() => query?.removeEventListener('change', onViewportChange))

  return { expanded, isMobile }
}
