import { computed, inject, onScopeDispose, provide, reactive, watch, type InjectionKey } from 'vue'

interface ModelCatalogNoticeContext {
  changed: () => void
  blockers: Set<symbol>
}

const key: InjectionKey<ModelCatalogNoticeContext> = Symbol('model-catalog-notice')

export function provideModelCatalogNotice(changed: () => void) {
  const blockers = reactive(new Set<symbol>())
  provide(key, { changed, blockers })
  return computed(() => blockers.size > 0)
}

// Wait until the current edit or request finishes before showing the reminder.
// Components used outside the Models page do not need a notice provider.
export function useModelCatalogNotice(busy: () => boolean) {
  const context = inject(key, null)
  if (!context) return () => {}
  const blocker = Symbol()
  let disposed = false
  watch(busy, value => {
    if (value) context.blockers.add(blocker)
    else context.blockers.delete(blocker)
  }, { immediate: true, flush: 'sync' })
  onScopeDispose(() => {
    disposed = true
    context.blockers.delete(blocker)
  })
  return () => { if (!disposed) context.changed() }
}
