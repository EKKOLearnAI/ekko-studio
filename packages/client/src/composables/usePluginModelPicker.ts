import { onScopeDispose, shallowRef } from 'vue'
import { fetchAvailableModelsForProfile, type AvailableModelsResponse } from '@/api/hermes/system'
import { providerModelApiMode } from '@/utils/codingAgentProviders'
import type { ClientModelPickerOptions, ClientModelSelection } from '../../../plugin-sdk/src'

interface PickerRequest {
  profile: string
  current?: ClientModelPickerOptions['current']
  catalog: AvailableModelsResponse
}

/** Keep catalog credentials in the host and bind every choice to the owning view. */
export function usePluginModelPicker() {
  const request = shallowRef<PickerRequest | null>(null)
  let pending: { finish(value: ClientModelSelection | null, error?: unknown): void } | null = null

  function open(profile: string, options: ClientModelPickerOptions = {}, signal: AbortSignal): Promise<ClientModelSelection | null> {
    if (pending) return Promise.reject(new Error('A model picker is already open for this plugin view'))
    if (!options || typeof options !== 'object' || Array.isArray(options)
      || options.current !== undefined && (!options.current || typeof options.current.provider !== 'string' || typeof options.current.model !== 'string')) {
      return Promise.reject(new Error('Invalid model picker options'))
    }
    if (signal.aborted) return Promise.resolve(null)
    return new Promise((resolve, reject) => {
      const controller = new AbortController()
      const entry = { finish(value: ClientModelSelection | null, error?: unknown) {
        if (pending !== entry) return
        pending = null; request.value = null
        signal.removeEventListener('abort', cancel)
        controller.abort()
        if (error !== undefined) reject(error); else resolve(value)
      } }
      const cancel = () => entry.finish(null)
      pending = entry
      signal.addEventListener('abort', cancel, { once: true })
      void fetchAvailableModelsForProfile(profile, controller.signal).then(catalog => {
        if (pending === entry) request.value = { profile, current: options.current, catalog }
      }).catch(error => entry.finish(null, error))
    })
  }
  function choose(selection: { provider: string; model: string }) {
    const active = request.value
    if (!active) return
    const group = active.catalog.groups.find(group => group.provider === selection.provider && group.provider !== 'moa')
    if (!group || !(group.models.includes(selection.model) || active.catalog.custom_models?.[group.provider]?.includes(selection.model))
      || group.model_meta?.[selection.model]?.disabled) return
    const apiMode = providerModelApiMode(group, selection.model)
    pending?.finish({ profile: active.profile, provider: group.provider, model: selection.model, ...(apiMode ? { apiMode } : {}) })
  }
  function cancel() { pending?.finish(null) }
  function displayName(model: string, provider: string) {
    const catalog = request.value?.catalog
    return catalog?.model_aliases?.[provider]?.[model]
      || catalog?.groups.find(group => group.provider === provider)?.model_meta?.[model]?.alias || model
  }
  onScopeDispose(cancel)
  return { request, open, choose, cancel, displayName }
}
