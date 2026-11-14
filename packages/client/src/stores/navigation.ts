import { onScopeDispose, ref } from 'vue'
import { defineStore } from 'pinia'
import { defaultNavigationSettings, validateNavigationSettings } from '../../../shared/navigation-settings'
import { getBaseUrl, getStoredUserId } from '@/api/client'
import { onAuthInvalidated } from '@/api/auth-invalidation'
import { getNavigationSettings, saveNavigationSettings } from '@/api/studio/navigation'

export const useNavigationStore = defineStore('navigation', () => {
  const items = ref(defaultNavigationSettings().items)
  const settingsOpen = ref(false)
  const loading = ref(false), loaded = ref(false), saving = ref(false), error = ref(false)
  let generation = 0, owner = '', pending: Promise<void> | undefined
  const identity = () => `${getBaseUrl()}:${getStoredUserId() || ''}`
  function reset() {
    generation++; owner = identity(); pending = undefined
    items.value = defaultNavigationSettings().items
    settingsOpen.value = false
    loading.value = loaded.value = saving.value = error.value = false
  }
  onScopeDispose(onAuthInvalidated(reset))
  async function load(force = false): Promise<void> {
    if (owner !== identity()) reset()
    if (pending) return pending
    if (loaded.value && !force || saving.value || !getStoredUserId()) return
    const current = generation
    loading.value = true; error.value = false
    pending = getNavigationSettings().then(value => {
      if (current !== generation || owner !== identity()) return
      items.value = validateNavigationSettings(value).items
      loaded.value = true
    }).catch(() => { if (current === generation) error.value = true }).finally(() => {
      if (current === generation) { loading.value = false; pending = undefined }
    })
    return pending
  }
  async function save(next: string[]): Promise<boolean> {
    if (owner !== identity()) { reset(); return false }
    if (!loaded.value || loading.value || saving.value) return false
    const value = validateNavigationSettings({ items: next })
    const previous = items.value, current = generation
    items.value = value.items; saving.value = true
    try {
      const saved = await saveNavigationSettings(value)
      if (current !== generation || owner !== identity()) return false
      items.value = validateNavigationSettings(saved).items
      return true
    } catch {
      if (current === generation) items.value = previous
      return false
    } finally { if (current === generation) saving.value = false }
  }
  return { items, settingsOpen, loading, loaded, saving, error, load, save }
})
