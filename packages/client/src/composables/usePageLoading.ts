import { computed, inject, onScopeDispose, ref, type InjectionKey, type Ref } from 'vue'

export const pageLoadingKey: InjectionKey<Readonly<Ref<boolean>>> = Symbol('page-loading')
export const pageLoadingTaskKey: InjectionKey<(pending: Readonly<Ref<boolean>>) => () => void> = Symbol('page-loading-task')

export function usePageLoadingState() {
  return inject(pageLoadingKey, ref(false))
}

/** Include child data/render preparation in its enclosing page's readiness. */
export function usePageLoadingTask(pending: () => boolean) {
  const register = inject(pageLoadingTaskKey, undefined)
  const release = register?.(computed(pending))
  onScopeDispose(() => release?.())
}
