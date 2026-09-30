import { listDshSessionPresets } from '@/api/coding-agents/dsh'

export interface DshSessionPresetChoice {
  id: string
  label: string
  unavailable: boolean
}

/**
 * DSH session preset roster for shared forms (e.g. category New Chat presets).
 * Keeps DSH transport inside the DSH client module; callers only handle ids.
 */
export async function loadDshSessionPresetChoices(): Promise<DshSessionPresetChoice[]> {
  const { presets } = await listDshSessionPresets()
  return presets.map(preset => ({
    id: preset.id,
    label: preset.name || preset.id,
    unavailable: Boolean(preset.unavailable),
  }))
}
