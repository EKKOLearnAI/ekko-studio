import { inject, type InjectionKey, type Ref } from 'vue'

export const pageHeaderTargetKey: InjectionKey<Readonly<Ref<HTMLElement | null>>> = Symbol('pageHeaderTarget')

export function usePageHeaderTarget() {
  return inject(pageHeaderTargetKey, null)
}
