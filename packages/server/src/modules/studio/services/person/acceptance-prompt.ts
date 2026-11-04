import type { PersonAcceptanceConfig, PersonAcceptanceReport } from '../../contracts/person-acceptance'
import type { ContentBlock } from '../../contracts/runs/session'
import type { PersonResultDelivery } from '../../public/person-runtime'
import { resolve } from 'node:path'

interface Snapshot {
  requirements: { goal: string; acceptance: PersonAcceptanceConfig }
  prior_inputs?: ContentBlock[][]
  input?: ContentBlock[]
}

function readableInput(blocks: ContentBlock[]) {
  return blocks.map(block => block.type === 'text' ? block.text : `${block.name}: ${block.path}${block.context ? `\n${block.context}` : ''}`).join('\n\n')
}

export function acceptanceFindings(report: PersonAcceptanceReport, config: PersonAcceptanceConfig, failedOnly = false, evidenceDirectory?: string) {
  return report.checks.filter(check => !failedOnly || check.status === 'failed').map((check,index) => [
    failedOnly ? `### Issue ${index+1}` : `### ${config.criteria.find(criterion => criterion.id === check.criterion_id)?.text || check.criterion_id}`,
    `Result: ${check.status}\n${check.findings}`,
    ...(check.issues || []).filter(issue=>!failedOnly || issue.disposition==='repair').map(issue=>`Product issue (${issue.disposition}): ${issue.description}\n${issue.reason}`),
    ...check.evidence.map(item => `Evidence: ${evidenceDirectory ? resolve(evidenceDirectory,item.path) : item.path} — ${item.description}`),
  ].join('\n\n')).join('\n\n')
}

export function botVerificationPrompt(snapshot: Snapshot, workerOutput: string, directory: string,
  previous: Array<Record<string,unknown>>) {
  const config = snapshot.requirements.acceptance
  const inputs = [...(snapshot.prior_inputs || []).map(readableInput), readableInput(snapshot.input || [])].filter(Boolean)
  return [
    '# Independent acceptance review',
    'Inspect the deliverables and verify every criterion below. Run the application, browser and visual checks when required. Developer output and previous reports are reference material, not proof. Do not repair the product or change task status. Clearly distinguish unresolved product defects within the requested scope from coverage limitations or unrelated future improvements. A non-blocking label does not make an in-scope defect resolved: report it for repair before final acceptance. Do not expand the product scope.',
    config.initial_request?.content ? `## Original user request\n\n${config.initial_request.content}` : '',
    config.initial_goal!==snapshot.requirements.goal ? `## Original goal\n\n${config.initial_goal}` : '',
    `## Product requirements\n\n${snapshot.requirements.goal}`,
    inputs.length ? `## Follow-up requirements and repair context\n\n${inputs.join('\n\n')}` : '',
    `## Acceptance checklist\n\n${config.criteria.map((criterion, i) => `${i + 1}. ${criterion.text}`).join('\n')}`,
    `## Development handoff\n\n${workerOutput.slice(0,60000)}`,
    previous.length ? `## Earlier reviews\n\n${previous.map(round => {
      let conclusion = ''
      if (round.report_json) {
        const report = JSON.parse(String(round.report_json)) as PersonAcceptanceReport
        conclusion = `${report.summary}\n\n${acceptanceFindings(report,config)}`
      }
      return `### Round ${round.ordinal}\n\n${conclusion || String(round.raw_output || '').slice(0,12000)}${round.error ? `\n\nReview issue: ${round.error}` : ''}`
    }).join('\n\n')}` : '',
    `## Evidence and report\n\nSave your own nonempty check logs, screenshots and other evidence under:\n${directory}\n\nWrite a normal report in the language of the original request. Explain whether the requirements are satisfied, what you actually checked for each item, concrete defects and their impact, and where the evidence files are. If the environment or a user decision is missing, explain the blocker. No fixed response format is required. Bot will read your report, record the decision and send specific defects back to the original developer when needed.`,
  ].filter(Boolean).join('\n\n')
}

export function acceptanceReturnData(result: PersonResultDelivery) {
  const acceptance=result.acceptance!
  const criteria=acceptance.criteria as PersonAcceptanceConfig['criteria']
  const decision=acceptance.decision as PersonAcceptanceReport | undefined
  return [
    `# ${result.title}`,
    `Returned task: ${result.taskId}\nReturned execution: ${result.executionId}\nExecution status: ${result.status}`,
    `Development task: ${acceptance.development_task_id}\nDevelopment execution: ${acceptance.development_execution_id}\nVerification execution: ${acceptance.verification_execution_id || 'not dispatched'}\nNext action: ${acceptance.next_action}`,
    acceptance.automatic ? 'Automatic progression: the host dispatches verification, developer repairs and re-verification. Review and record the evidence-backed verdict; do not dispatch these transitions yourself.' : '',
    `Developer Bot: ${acceptance.developer_session_id}\nReviewing Bot: ${acceptance.reviewer_session_id}`,
    `## Acceptance criteria\n\n${criteria.map(criterion=>`- ${criterion.id}: ${criterion.text}`).join('\n')}`,
    acceptance.report_length && Number(acceptance.report_length)>result.output.length ? 'The report below is truncated. Read all report pages with bot_tasks_query before deciding.' : '',
    `## Returned report / development result\n\n${result.output}`,
    decision ? `## Recorded acceptance findings\n\n${decision.summary}\n\n${acceptanceFindings(decision,{criteria} as PersonAcceptanceConfig)}` : '',
    result.error ? `## Execution error\n\n${result.error}` : '',
  ].filter(Boolean).join('\n\n')
}
