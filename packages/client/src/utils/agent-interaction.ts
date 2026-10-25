import type { AgentInteraction, AgentInteractionResponse } from '../../../studio-plugin-sdk/src/types'

export function agentInteractionLabels(interaction: AgentInteraction): string[] {
  const values = interaction.choices.map(choice => choice.description ? `${choice.label} · ${choice.description}` : choice.label)
  return values.map((label, index) => values.indexOf(label) !== values.lastIndexOf(label) ? `${label} (${index + 1})` : label)
}
export function agentInteractionResponse(interaction: AgentInteraction, response: string, idempotencyKey: string): AgentInteractionResponse | null {
  const index = agentInteractionLabels(interaction).indexOf(response)
  if (index !== -1) return { interactionId: interaction.id, idempotencyKey, choiceId: interaction.choices[index].id }
  if (interaction.kind === 'approval' || interaction.allowText === false || !response.trim()) return null
  return { interactionId: interaction.id, idempotencyKey, text: response }
}
