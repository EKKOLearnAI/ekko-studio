import { inject, ref, type InjectionKey, type Ref } from 'vue'

export const navigationRailKey: InjectionKey<Readonly<Ref<boolean>>> = Symbol('navigationRail')

export function useNavigationRail() {
  return inject(navigationRailKey, ref(false))
}
