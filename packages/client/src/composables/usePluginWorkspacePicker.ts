import { onScopeDispose, shallowRef } from 'vue'
import type { ClientWorkspacePickerOptions, ClientWorkspaceSelection } from '../../../plugin-sdk/src'

interface PickerRequest { profile: string; current: string }

export function usePluginWorkspacePicker() {
  const request = shallowRef<PickerRequest | null>(null)
  let pending: { finish(value: ClientWorkspaceSelection | null): void } | null = null

  function open(profile: string, options: ClientWorkspacePickerOptions = {}, signal: AbortSignal): Promise<ClientWorkspaceSelection | null> {
    if (pending) return Promise.reject(new Error('A workspace picker is already open for this plugin view'))
    if (!options || typeof options !== 'object' || Array.isArray(options)
      || options.current !== undefined && (typeof options.current !== 'string' || options.current.length > 4096 || options.current.includes('\0'))) {
      return Promise.reject(new Error('Invalid workspace picker options'))
    }
    if (signal.aborted) return Promise.resolve(null)
    return new Promise(resolve => {
      const entry = { finish(value: ClientWorkspaceSelection | null) {
        if (pending !== entry) return
        pending = null; request.value = null
        signal.removeEventListener('abort', cancel)
        resolve(value)
      } }
      const cancel = () => entry.finish(null)
      pending = entry
      signal.addEventListener('abort', cancel, { once: true })
      request.value = { profile, current: options.current?.trim() || '' }
    })
  }
  function choose(workspace: string) {
    const active = request.value
    if (!active || typeof workspace !== 'string' || !workspace.trim() || workspace.length > 4096 || workspace.includes('\0')) return
    pending?.finish({ profile: active.profile, workspace: workspace.trim() })
  }
  function cancel() { pending?.finish(null) }
  onScopeDispose(cancel)
  return { request, open, choose, cancel }
}
