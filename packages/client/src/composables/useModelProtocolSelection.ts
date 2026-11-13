import { ref, watch, type Ref } from 'vue'
import { isCodingAgentApiMode, normalizeCodingAgentApiMode, type CodingAgentApiMode } from '@/api/coding-agents'
import type { ProviderApiMode } from '@/api/studio/provider-api-mode'
import type { AvailableModelGroup } from '@/api/hermes/system'
import { configuredProviderApiMode } from '@/utils/codingAgentProviders'

type Selection = { provider: string; model: string; apiMode?: ProviderApiMode }

/** Keep a cancelled protocol choice out of the saved model selection. */
export function useModelProtocolSelection(apply: (selection: Selection) => void, disabled: Ref<boolean>) {
  const pending = ref<Selection | null>(null)
  const show = ref(false)
  const apiMode = ref<CodingAgentApiMode>('chat_completions')
  function cancel() { show.value = false; pending.value = null }
  function select(selection: Selection, current?: Selection, automatic = false) {
    if (disabled.value) return
    const sameModel = current?.provider === selection.provider && current.model === selection.model
    if (automatic && !sameModel && isCodingAgentApiMode(selection.apiMode)) {
      cancel()
      apply(selection)
      return
    }
    pending.value = selection
    apiMode.value = normalizeCodingAgentApiMode(
      sameModel ? current.apiMode : selection.apiMode,
      normalizeCodingAgentApiMode(selection.apiMode, 'chat_completions'),
    )
    show.value = true
  }
  function selectInherited(selection: Selection, current?: Selection, group?: AvailableModelGroup) {
    if (disabled.value) return
    const sameModel = current?.provider === selection.provider && current.model === selection.model
    // Existing presets have no protocol provenance; preserve every valid saved choice.
    if (sameModel && isCodingAgentApiMode(current.apiMode)) {
      cancel()
      apply({ ...selection, apiMode: current.apiMode })
      return
    }
    const configured = configuredProviderApiMode(group, selection.model)
    const conflictingSelection = selection.apiMode !== undefined && selection.apiMode !== configured
    const unsupportedCurrent = sameModel && !!current.apiMode && !isCodingAgentApiMode(current.apiMode)
    if (configured && !conflictingSelection && !unsupportedCurrent) {
      cancel()
      apply({ ...selection, apiMode: configured })
      return
    }
    select({ ...selection, apiMode: configured || selection.apiMode }, current)
  }
  function confirm() {
    if (disabled.value || !pending.value) return
    const selection = { ...pending.value, apiMode: apiMode.value }
    cancel()
    apply(selection)
  }
  watch(disabled, value => { if (value) cancel() })
  return { show, apiMode, select, selectInherited, confirm, cancel }
}
