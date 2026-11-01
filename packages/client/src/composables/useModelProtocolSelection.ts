import { ref, watch, type Ref } from 'vue'
import { normalizeCodingAgentApiMode, type CodingAgentApiMode } from '@/api/coding-agents'
import type { ProviderApiMode } from '@/api/studio/provider-api-mode'

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
    if (automatic && selection.apiMode && !sameModel
      && ['chat_completions', 'codex_responses', 'anthropic_messages'].includes(selection.apiMode)) {
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
  function confirm() {
    if (disabled.value || !pending.value) return
    const selection = { ...pending.value, apiMode: apiMode.value }
    cancel()
    apply(selection)
  }
  watch(disabled, value => { if (value) cancel() })
  return { show, apiMode, select, confirm, cancel }
}
