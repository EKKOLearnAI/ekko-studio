import type { PersonInteraction, PersonTask } from '../../contracts/person'
import { personRequirements } from '../../contracts/person-flow'

export function personTaskPrompt(
  task: Pick<PersonTask, 'title' | 'requirements_json'>,
  decisions: Pick<PersonInteraction, 'question' | 'answer' | 'answered_by'>[],
): string {
  const { goal, handoff, acceptance } = personRequirements(task)
  const sections = [`# ${task.title}`, goal]
  if (acceptance) sections.push('## Development handoff\n\nDeliver runnable artifacts, their paths, startup instructions and known limitations. Your assignment is implementation and development checks. The host assigns independent acceptance to a separate verifier; do not perform or report that acceptance.')
  if (handoff) {
    const context = [
      handoff.execution_id ? `Source execution: ${handoff.execution_id}` : '',
      handoff.message,
      handoff.output ? `### Previous result\n\n${handoff.output}` : '',
    ].filter(Boolean)
    if (context.length) sections.push(`## Previous stage handoff\n\n${context.join('\n\n')}`)
  }
  if (decisions.length) {
    sections.push(`## Answered questions\n\n${decisions.map(decision =>
      `### ${decision.question}\n\nAnswer (${decision.answered_by}): ${decision.answer}`,
    ).join('\n\n')}`)
  }
  return sections.join('\n\n')
}
