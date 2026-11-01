import { createHash } from 'node:crypto'
import { realpathSync } from 'node:fs'
import type { PersonExecution, PersonTask, PersonTaskOrigin } from '../../contracts/person'
import { personError, personText } from '../../contracts/person'
import { personRequirements } from '../../contracts/person-flow'
import { getPersonExecution, personDb, personEvent } from '../../repositories/person-store'
import { assertPersonTaskActor } from './task-flow'
import { gitIdentity, personGitDirty } from './execution-contract'

export function personCandidate(task: PersonTask, run: PersonExecution, output: string) {
  const contract = personRequirements(task).contract
  const head = contract?.git ? gitIdentity(task.workspace).head : undefined
  const candidate = createHash('sha256').update(JSON.stringify({ execution: run.id, head, output })).digest('hex')
  return { execution_id: run.id, candidate, ...(head ? { head } : {}), state: 'pending' as const }
}

/** A successful model run is a candidate. The owning role must check explicit acceptance criteria. */
export function acceptPersonCandidate(task: PersonTask, input: Record<string, unknown>, origin?: PersonTaskOrigin) {
  assertPersonTaskActor(task, origin)
  const requirements = personRequirements(task), review = requirements.verification
  if (!review || review.state !== 'pending' || task.status !== 'open' || review.execution_id !== task.execution_id || task.pending_count)
    throw personError('No current candidate awaiting acceptance', 409)
  const run = getPersonExecution(task.owner_user_id, review.execution_id)
  if (requirements.contract && realpathSync(task.workspace) !== requirements.contract.workspace)
    throw personError('Candidate workspace changed', 409)
  if (requirements.contract?.git) {
    const actual = gitIdentity(task.workspace), expected = requirements.contract.git
    if (actual.common_directory !== expected.common_directory || actual.branch !== expected.branch)
      throw personError('Candidate repository or branch changed', 409)
  }
  if (requirements.contract?.git && personGitDirty(task.workspace))
    throw personError('Candidate has uncommitted changes; commit and rerun verification first', 409)
  if (run.state !== 'finished' || run.requirements_revision !== task.requirements_revision
    || personCandidate(task, run, run.output).candidate !== review.candidate || input.candidate !== review.candidate)
    throw personError('Candidate changed; rerun and verify the new result', 409)
  const evidence = personText(input.evidence, 'acceptance evidence', 4000)
  requirements.verification = { ...review, state: 'accepted', evidence }
  const ongoing = requirements.flow && !requirements.flow.completed
    || personDb().prepare("SELECT 1 FROM person_schedules WHERE task_id=? AND state IN ('active','paused')").get(task.id)
  personDb().prepare("UPDATE session_tasks SET requirements_json=?,status=?,completion_evidence=?,completed_at=?,updated_at=?,revision=revision+1 WHERE id=?")
    .run(JSON.stringify(requirements), ongoing ? 'open' : 'completed', evidence, ongoing ? null : Date.now(), Date.now(), task.id)
  personEvent(run, 'candidate.accepted', { candidate: review.candidate, head: review.head || '', evidence })
}
