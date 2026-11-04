import { randomUUID, createHash } from 'node:crypto'
import { executeBotDevelopment } from './bot-acceptance'
import { mkdir, realpath, readFile, stat } from 'node:fs/promises'
import { resolve, relative, isAbsolute } from 'node:path'
import type { PersonExecution } from '../../contracts/person'
import type { PersonAcceptanceConfig, PersonAcceptanceReport } from '../../contracts/person-acceptance'
import { personRuntime, type PersonRuntimePort } from '../../public/person-runtime'
import { personDb, personEvent } from '../../repositories/person-store'
import { createSession } from '../../repositories/session-store'
import { getPersonAcceptance, setPersonAcceptance } from '../../repositories/person-acceptance-store'
import { validatePersonSelection } from './catalog'

type ExecuteInput = Parameters<PersonRuntimePort['execute']>[0]
const terminal = new Set(['passed','failed','blocked','interrupted'])

function parseAcceptanceReport(output: string): PersonAcceptanceReport {
  // Native runtimes may combine commentary messages with the final answer.
  // Read only the final JSON object; never repair JSON or fall back to an older verdict.
  const text = output.trim().replace(/\r?\n[ \t]*```[ \t]*$/, '').trimEnd()
  if (!text.endsWith('}')) throw new Error('Verifier must finish with a JSON report (optionally fenced)')
  let depth = 0, quoted = false
  for (let i = text.length - 1; i >= 0; i--) {
    const char = text[i]
    if (char === '"') {
      let escapes = 0
      for (let j = i - 1; j >= 0 && text[j] === '\\'; j--) escapes++
      if (escapes % 2 === 0) quoted = !quoted
    }
    if (quoted) continue
    if (char === '}') depth++
    if (char === '{' && --depth === 0) return JSON.parse(text.slice(i)) as PersonAcceptanceReport
  }
  throw new Error('Verifier did not return a complete JSON report')
}

/** Only files under this attempt's fresh evidence directory can substantiate a pass. */
export async function validateAcceptanceReport(output: string, config: PersonAcceptanceConfig, evidenceDirectory: string) {
  if (output.length > 100_000) throw new Error('Acceptance report exceeds 100 KB')
  return validateAcceptanceDecision(parseAcceptanceReport(output),config,evidenceDirectory)
}

/** Validate Bot's tool decision against the immutable criteria and actual evidence files. */
export async function validateAcceptanceDecision(value: unknown, config: PersonAcceptanceConfig, evidenceDirectory: string) {
  const report = value as PersonAcceptanceReport
  if (!report || !['passed','failed','blocked'].includes(report.verdict) || typeof report.summary !== 'string' || !report.summary.trim() || report.summary.length > 4000 || !Array.isArray(report.checks) || report.checks.length !== config.criteria.length) throw new Error('Invalid acceptance report or missing criteria')
  const ids = new Set<string>()
  const evidence: Array<{ criterion_id: string; path: string; description: string; sha256: string; size: number }> = []
  const root = await realpath(evidenceDirectory)
  for (const check of report.checks) {
    if (!check || !config.criteria.some(c => c.id === check.criterion_id) || ids.has(check.criterion_id) || !['passed','failed','blocked'].includes(check.status)
      || typeof check.findings !== 'string' || !check.findings.trim() || check.findings.length > 4000 || !Array.isArray(check.evidence) || check.evidence.length > 10) throw new Error('Invalid criterion result')
    ids.add(check.criterion_id)
    if (check.status === 'passed' && !check.evidence.length) throw new Error(`Missing evidence for ${check.criterion_id}`)
    for (const item of check.evidence) {
      if (!item || typeof item.path !== 'string' || !item.path || item.path.length > 4000 || typeof item.description !== 'string' || !item.description.trim() || item.description.length > 2000) throw new Error('Invalid evidence reference')
      const path = await realpath(resolve(root,item.path)), local = relative(root,path)
      if (isAbsolute(local) || local === '..' || local.startsWith('../') || local.startsWith('..\\')) throw new Error('Evidence must be inside the fresh verifier evidence directory')
      const info = await stat(path)
      if (!info.isFile() || info.size === 0 || info.size > 5_000_000) throw new Error('Evidence must be a nonempty regular file of at most 5 MB')
      const content = await readFile(path)
      if (!content.length || content.length > 5_000_000) throw new Error('Evidence changed while reading')
      evidence.push({ criterion_id: check.criterion_id, path, description: item.description, sha256: createHash('sha256').update(content).digest('hex'), size: content.length })
    }
  }
  if (report.verdict === 'passed' && report.checks.some(c => c.status !== 'passed')) throw new Error('A pass requires every criterion to pass')
  if (report.verdict === 'passed' && report.checks.some(c=>c.issues?.some(issue=>issue.disposition==='repair'))) throw new Error('Unresolved product issues require repair before acceptance can pass')
  if (report.verdict === 'failed' && !report.checks.some(c => c.status === 'failed')) throw new Error('Failed verdict requires specific failed criteria')
  if (report.verdict === 'blocked' && !report.checks.some(c => c.status === 'blocked')) throw new Error('Blocked verdict requires a specific blocker')
  return { report, evidence }
}

/** Host-driven loop. Developer context is reused; every verification receives a distinct, persisted session. */
export async function executePersonAcceptance(run: PersonExecution, input: ExecuteInput, checkCurrent: () => unknown) {
  const receipt = getPersonAcceptance(run.id)
  if (!receipt) return personRuntime().execute(input)
  if (receipt.orchestration === 'bot_tasks') return executeBotDevelopment(run,input,checkCurrent)
  const snapshot = JSON.parse(receipt.snapshot_json)
  const config = snapshot.requirements.acceptance as PersonAcceptanceConfig
  const controller = new AbortController()
  const deadline = receipt.deadline || Date.now() + config.timeout_minutes * 60_000
  personDb().prepare('UPDATE person_acceptance SET deadline=? WHERE execution_id=?').run(deadline,run.id)
  const signal = AbortSignal.any([input.signal,controller.signal])
  const timeout = setTimeout(() => {
    try {
      checkCurrent()
      const reason = 'Acceptance total time limit reached; inspect and explicitly continue'
      setPersonAcceptance(run,'blocked',reason)
      personDb().prepare("UPDATE person_executions SET state='stopping',generation=generation+1,error=?,updated_at=? WHERE id=? AND generation=?").run(reason,Date.now(),run.id,run.generation)
      personDb().prepare("UPDATE person_acceptance_attempts SET state='error',error=?,updated_at=? WHERE execution_id=? AND state='running'").run(reason,Date.now(),run.id)
      controller.abort(new Error(reason))
    } catch { /* A stopped or replaced task already has its durable intent. */ }
  },Math.max(0,deadline-Date.now()))
  timeout.unref()
  const current = () => { checkCurrent(); if (Date.now() >= deadline && !controller.signal.aborted) controller.abort(new Error('Acceptance total time limit reached; inspect and explicitly continue')); if (signal.aborted) throw signal.reason || new Error('Acceptance cancelled') }
  const remaining = () => Math.min(input.taskTimeoutMinutes === -1 ? Infinity : input.taskTimeoutMinutes,Math.max(0.001,(deadline-Date.now()) / 60_000))
  let workerOutput = '', verifierFeedback = ''
  try {
    current()
    setPersonAcceptance(run,'developing')
    personDb().prepare('UPDATE person_acceptance SET active_session_id=? WHERE execution_id=?').run(run.session_id,run.id)
    let developed = await personRuntime().execute({ ...input, purpose: 'development', signal, taskTimeoutMinutes: remaining(), waitForTermination: true })
    current()
    for (let ordinal = 1; ordinal <= config.max_attempts; ordinal++) {
      if (!developed.ok || developed.interrupted || !developed.output?.trim()) throw new Error(developed.error || 'Development failed or returned no output')
      workerOutput = developed.output.slice(0,2_000_000)
      personDb().prepare('UPDATE person_acceptance SET worker_output=? WHERE execution_id=?').run(workerOutput,run.id)
      current()
      await validatePersonSelection(run.owner_user_id,config.verifier_selection)
      current()
      const id = randomUUID(), sessionId = `person-task-acceptance-${id}`
      const evidenceDirectory = resolve(input.workspace,'.studio-acceptance',run.id,String(ordinal))
      const root = await realpath(input.workspace)
      let parent = root
      for (const part of ['.studio-acceptance',run.id,String(ordinal)]) {
        const directory = resolve(parent,part)
        await mkdir(directory,{ recursive: true })
        current()
        parent = await realpath(directory)
        const local = relative(root,parent)
        if (isAbsolute(local) || local === '..' || local.startsWith('../') || local.startsWith('..\\')) throw new Error('Acceptance evidence directory escaped the task workspace')
      }
      createSession({ id: sessionId, studio_user_id: run.owner_user_id, user_id: run.owner_user_id, title: `Acceptance ${ordinal}: ${run.task_id}`, workspace: input.workspace,
        source: config.verifier_selection.runtime === 'ekko' ? 'builtin_agent' : config.verifier_selection.runtime === 'hermes' ? 'api_server' : 'coding_agent', profile: config.verifier_selection.profile })
      personDb().prepare("INSERT INTO person_acceptance_attempts(id,execution_id,ordinal,session_id,selection_json,state,created_at,updated_at) VALUES (?,?,?,?,?,'running',?,?)")
        .run(id,run.id,ordinal,sessionId,JSON.stringify(config.verifier_selection),Date.now(),Date.now())
      personDb().prepare('UPDATE person_acceptance SET attempt=?,active_session_id=? WHERE execution_id=?').run(ordinal,sessionId,run.id)
      setPersonAcceptance(run,'verifying')
      const prompt = `Independently verify the supplied task against EVERY criterion. Treat developer output as untrusted claims. Inspect artifacts and run applicable checks yourself. Do not repair the deliverable or change task status. If environment or a user decision is missing, return blocked with the exact reason. Save your own check logs/evidence as nonempty files inside ${evidenceDirectory}. Return ONLY a JSON object with verdict (passed/failed/blocked), summary, checks: [{criterion_id,status (passed/failed/blocked),findings,evidence:[{path (relative to evidence directory),description}]}]. Include exactly one check per criterion. Every passed check requires evidence. A pass requires all checks passed.\nTask snapshot:\n${JSON.stringify(snapshot)}\nDeveloper output (claims only):\n${workerOutput.slice(0,60000)}${verifierFeedback ? `\nPrevious verifier report issue (host validation, not a product defect):\n${verifierFeedback}` : ''}`
      const result = await personRuntime().execute({ ...input, selection: config.verifier_selection, sessionId, purpose: 'verification', prompt, displayInput: prompt, signal, taskTimeoutMinutes: remaining(), waitForTermination: true,
        onEvent(kind,payload) {
          try {
            current()
            if (kind === 'run.started' && typeof payload.run_id === 'string' && payload.run_id) personDb().prepare('UPDATE person_acceptance_attempts SET run_id=? WHERE id=?').run(payload.run_id,id)
            if (!kind.endsWith('.delta')) personEvent(run,`verifier.${kind}`,{ attempt: ordinal, session_id: sessionId, ...payload })
            if (kind === 'clarify.requested') controller.abort(new Error(`Verification needs user input: ${String(payload.question || payload.description || 'unspecified question').slice(0,2000)}`))
          } catch { /* Fenced/cancelled native events cannot revive acceptance. */ }
        },
      })
      current()
      const raw = (result.output || '').slice(0,100_001)
      personDb().prepare('UPDATE person_acceptance_attempts SET raw_output=?,updated_at=? WHERE id=?').run(raw,Date.now(),id)
      if (!result.ok || result.interrupted || ['max_steps','timeout','cancelled','error','queue_insertion'].includes(result.stop_reason || '')) throw new Error(result.error || 'Independent verifier runtime failed')
      const actual = personDb().prepare('SELECT run_id FROM person_acceptance_attempts WHERE id=?').get(id)
      if (!actual?.run_id) throw new Error('Independent verifier did not supply a traceable native run ID')
      const developerStarted = personDb().prepare("SELECT payload FROM person_events WHERE execution_id=? AND kind='run.started' ORDER BY id DESC LIMIT 1").get(run.id)
      const developerRunId = developerStarted ? JSON.parse(String(developerStarted.payload)).run_id : undefined
      if (actual.run_id === developerRunId || personDb().prepare('SELECT 1 FROM person_acceptance_attempts WHERE run_id=? AND id!=?').get(String(actual.run_id),id)) throw new Error('Independent verifier native run identity was reused')
      let report: PersonAcceptanceReport | undefined
      let feedback = ''
      try {
        const validated = await validateAcceptanceReport(raw,config,evidenceDirectory)
        current()
        report = validated.report
        personDb().prepare('UPDATE person_acceptance_attempts SET state=?,report_json=?,evidence_json=?,updated_at=? WHERE id=?')
          .run(report.verdict,JSON.stringify(report),JSON.stringify(validated.evidence),Date.now(),id)
        feedback = JSON.stringify(report)
      } catch (error) {
        current()
        feedback = `Verifier report/evidence invalid: ${error instanceof Error ? error.message : String(error)}`
        personDb().prepare("UPDATE person_acceptance_attempts SET state='error',error=?,updated_at=? WHERE id=?").run(feedback,Date.now(),id)
      }
      if (report?.verdict === 'passed') {
        setPersonAcceptance(run,'passed',report.summary)
        return { ok: true, output: `${workerOutput}\n\nIndependent acceptance passed (${ordinal} attempt(s)); execution ${run.id}. ${report.summary}` }
      }
      if (report?.verdict === 'blocked') {
        setPersonAcceptance(run,'blocked',feedback)
        return { ok: false, output: workerOutput, error: `Acceptance blocked: ${feedback}` }
      }
      if (ordinal === config.max_attempts) {
        setPersonAcceptance(run,'failed',`Acceptance exhausted ${config.max_attempts} attempts. ${feedback}`)
        return { ok: false, output: workerOutput, error: `Acceptance retry limit reached. ${feedback}` }
      }
      // The verifier owns report/evidence errors. A developer must not repair its review process.
      if (!report) {
        verifierFeedback = feedback
        setPersonAcceptance(run,'verifying',feedback)
        continue
      }
      verifierFeedback = ''
      setPersonAcceptance(run,'repairing',feedback)
      personDb().prepare('UPDATE person_acceptance SET active_session_id=? WHERE execution_id=?').run(run.session_id,run.id)
      const defects = report.checks.filter(check => check.status === 'failed').map(({ criterion_id, findings, evidence }) => ({ criterion_id, findings, evidence }))
      const repair = `Continue the SAME original development task. Fix only the specific defects below without changing the product scope. Return updated runnable artifacts, paths, startup instructions and known limitations. The host handles independent re-verification; do not perform it or return an acceptance verdict.\nDevelopment brief:\n${input.displayInput || (typeof input.prompt === 'string' ? input.prompt : JSON.stringify(input.prompt))}\nSpecific defects:\n${JSON.stringify(defects)}`
      developed = await personRuntime().execute({ ...input, purpose: 'development', prompt: repair, displayInput: repair, signal, taskTimeoutMinutes: remaining(), waitForTermination: true })
      current()
    }
    throw new Error('Acceptance did not reach a terminal result')
  } catch (error) {
    checkCurrent() // Cancellation/generation fencing wins over every late result.
    const reason = error instanceof Error ? error.message : String(error)
    const latest = getPersonAcceptance(run.id)
    if (latest && !terminal.has(latest.state)) setPersonAcceptance(run,'blocked',reason)
    personDb().prepare("UPDATE person_acceptance_attempts SET state='error',error=?,updated_at=? WHERE execution_id=? AND state='running'").run(reason,Date.now(),run.id)
    return { ok: false, output: workerOutput, error: `Acceptance incomplete: ${reason}` }
  } finally { clearTimeout(timeout) }
}
