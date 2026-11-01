import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, mkdirSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let db: DatabaseSync, root: string
let projects: typeof import('../../packages/server/src/modules/studio/services/person/projects')
let contracts: typeof import('../../packages/server/src/modules/studio/services/person/execution-contract')
let resources: typeof import('../../packages/server/src/modules/studio/repositories/person-resource-store')
let store: typeof import('../../packages/server/src/modules/studio/repositories/person-store')
const selection = { runtime: 'codex', mode: 'scoped', profile: 'default', provider: 'test', model: 'm' } as const

beforeEach(async () => {
  vi.resetModules()
  root = mkdtempSync(join(tmpdir(), 'person-project-'))
  db = new DatabaseSync(':memory:')
  vi.doMock('../../packages/server/src/modules/studio/infrastructure/database/index', () => ({ getDb: () => db, isSqliteAvailable: () => true }))
  vi.doMock('../../packages/server/src/modules/studio/public/config', () => ({ config: { appHome: root }, getWebUiHome: () => root }))
  vi.doMock('../../packages/server/src/modules/studio/services/person/catalog', () => ({
    personUser: (id: number) => ({ id, role: 'super_admin', profiles: ['default'] }),
    validatePersonSelection: vi.fn(async () => {}),
  }))
  vi.doMock('../../packages/server/src/modules/studio/public/chat-run', () => ({ getChatRunServer: () => ({ isSessionRunning: () => false }) }))
  const { initAllHermesTables } = await import('../../packages/server/src/modules/studio/infrastructure/database/schemas')
  initAllHermesTables()
  const { createSession } = await import('../../packages/server/src/modules/studio/repositories/session-store')
  createSession({ id: 'person-main-owner', studio_user_id: 1, user_id: 1, source: 'builtin_agent', agent_preset: 'person', title: 'Owner' })
  store = await import('../../packages/server/src/modules/studio/repositories/person-store')
  store.savePersonSettings(1, { ...store.personSettings(1).settings, workspace: root,
    agents: [{ id: 'worker', name: 'Backend', description: 'Only implement the authorized backend contract.', selection }] }, 0)
  projects = await import('../../packages/server/src/modules/studio/services/person/projects')
  contracts = await import('../../packages/server/src/modules/studio/services/person/execution-contract')
  resources = await import('../../packages/server/src/modules/studio/repositories/person-resource-store')
  for (const dir of ['alpha', 'beta', 'alpha/task-one', 'alpha/task-two']) mkdirSync(join(root, dir), { recursive: true })
})
afterEach(() => { db.close(); rmSync(root, { recursive: true, force: true }); vi.clearAllMocks() })

async function project(name = 'Alpha', workspace = 'alpha') {
  return projects.configurePersonProject(1, { name, workspace: join(root, workspace), instructions: `${name} only.`, expected_revision: 0 })
}
async function contract(overrides: Record<string, unknown> = {}) {
  return contracts.preparePersonContract(1, 'person-main-owner', { agent_id: 'worker', ...overrides })
}
function task(c: Awaited<ReturnType<typeof contract>>) {
  const t = store.createPersonTask(1, 'Task', 'Produce evidence', selection, c.workspace, 'person-main-owner')
  db.prepare('UPDATE session_tasks SET requirements_json=? WHERE id=?').run(JSON.stringify({ goal: 'Produce evidence', contract: c }), t.id)
  return store.getPersonTask(1, t.id)
}

it('binds each task directory and freezes project, role and worker instructions', async () => {
  const p = await project()
  await projects.configurePersonRole(1, 'person-main-owner', { project_id: p.id, instructions: 'Coordinate only this deliverable.', expected_revision: 0 })
  const c = await contract({ workspace: join(root, 'alpha/task-one'), acceptance: 'File contains the measured result.' })
  expect(c).toMatchObject({ workspace: join(root, 'alpha/task-one'), project: { id: p.id, revision: 1, instructions: 'Alpha only.' },
    agent: { id: 'worker', description: 'Only implement the authorized backend contract.' }, role: { instructions: 'Coordinate only this deliverable.' } })
  await projects.configurePersonProject(1, { id: p.id, name: p.name, workspace: p.workspace, instructions: 'New rules', expected_revision: 1 })
  expect(c.project?.instructions).toBe('Alpha only.')
  const { personTaskPrompt } = await import('../../packages/server/src/modules/studio/services/person/task-prompt')
  const prompt = personTaskPrompt(task(c), [])
  expect(prompt).toContain('Alpha only.')
  expect(prompt).toContain('Only implement the authorized backend contract.')
  expect(prompt).toContain('File contains the measured result.')
})

it('rejects foreign projects, stale edits and symlink escapes without creating directories', async () => {
  const p = await project()
  expect(() => projects.requirePersonProject(2, p.id)).toThrow('Project not found')
  await expect(projects.configurePersonProject(1, { ...p, expected_revision: 0 })).rejects.toThrow('changed')
  symlinkSync(join(root, 'beta'), join(root, 'alpha/escape'))
  await expect(contract({ project_id: p.id, workspace: join(root, 'alpha/escape') })).rejects.toThrow('project workspace')
  await expect(contract({ project_id: p.id, workspace: join(root, 'alpha/missing') })).rejects.toThrow()
})

it('lets disjoint tasks run concurrently but serializes overlapping writes and named resources', async () => {
  const p = await project()
  const one = task(await contract({ project_id: p.id, workspace: join(root, 'alpha/task-one'), resources: ['deployment:shared'] }))
  const two = task(await contract({ project_id: p.id, workspace: join(root, 'alpha/task-two'), resources: ['deployment:shared'] }))
  const runOne = store.enqueuePersonExecution(one), runTwo = store.enqueuePersonExecution(two)
  expect(resources.claimPersonResources(runOne)).toBe(true)
  expect(resources.claimPersonResources(runTwo)).toBe(false)
  resources.releasePersonResources(runOne.id)
  expect(resources.claimPersonResources(runTwo)).toBe(true)
  const parent = task(await contract({ project_id: p.id, workspace: join(root, 'alpha') }))
  expect(resources.claimPersonResources(store.enqueuePersonExecution(parent))).toBe(false)
})

it('allows shared reads, blocks a writer and does not expire locks while an old process may still write', async () => {
  const p = await project()
  const runs = []
  for (let i = 0; i < 2; i++) runs.push(store.enqueuePersonExecution(task(await contract({ project_id: p.id, access_mode: 'read' }))))
  expect(resources.claimPersonResources(runs[0])).toBe(true)
  expect(resources.claimPersonResources(runs[1])).toBe(true)
  db.prepare("UPDATE person_executions SET state='stopping',lease_until=0 WHERE id=?").run(runs[0].id)
  const write = store.enqueuePersonExecution(task(await contract({ project_id: p.id })))
  expect(resources.claimPersonResources(write)).toBe(false)
  resources.releasePersonResources(runs[0].id)
  resources.releasePersonResources(runs[1].id)
  expect(resources.claimPersonResources(write)).toBe(true)
})

it('keeps project identity host-bound and requires an allowed executor', async () => {
  const a = await project(), b = await project('Beta', 'beta')
  await projects.configurePersonRole(1, 'person-main-owner', { project_id: a.id, allowed_agents: ['worker'], expected_revision: 0 })
  await expect(contract({ project_id: b.id },)).rejects.toThrow('bound project')
  await expect(contract({ agent_id: 'unknown' })).rejects.toThrow()
})

it('does not retarget a role while queued tasks or undelivered results still depend on it', async () => {
  const a = await project(), b = await project('Beta', 'beta')
  await projects.configurePersonRole(1, 'person-main-owner', { project_id: a.id, expected_revision: 0 })
  store.enqueuePersonExecution(task(await contract()))
  await expect(projects.configurePersonRole(1, 'person-main-owner', { project_id: b.id, expected_revision: 1 })).rejects.toThrow('Wait')
})

it('tags messages atomically before other projects or account history can retrieve them', async () => {
  const a = await project(), b = await project('Beta', 'beta')
  const { addMessage, addMessages } = await import('../../packages/server/src/modules/studio/repositories/session-store')
  const { openPersonContextStore } = await import('../../packages/server/src/modules/studio/repositories/person-context-store')
  const alpha = addMessage({ session_id: 'person-main-owner', role: 'user', content: 'alpha secret keyword', personScope: { ownerUserId: 1, projectId: a.id } })!
  const beta = addMessages([{ session_id: 'person-main-owner', role: 'assistant', content: 'beta secret keyword', personScope: { ownerUserId: 1, projectId: b.id } }])[0]
  const shared = addMessage({ session_id: 'person-main-owner', role: 'user', content: 'shared keyword' })!
  const scope = (id: string) => openPersonContextStore(1, 'person-main-owner', db, id)
  expect(scope(a.id).recent().map(m => m.id)).toEqual([alpha])
  expect(scope(b.id).read(alpha)).toBeUndefined()
  expect(scope('').read(beta)).toBeUndefined()
  expect(scope('').recent().map(m => m.id)).toEqual([shared])
  expect(scope(a.id).search('keyword').evidence.map(m => m.id)).toEqual([alpha])
  expect(scope(b.id).search('keyword').evidence.map(m => m.id)).toEqual([beta])
  expect(() => addMessage({ session_id: 'person-main-owner', role: 'user', content: 'must roll back', personScope: { ownerUserId: 2, projectId: a.id } })).toThrow('scope')
  expect(db.prepare("SELECT id FROM messages WHERE content='must roll back'").get()).toBeUndefined()
  db.prepare('DELETE FROM messages WHERE id=?').run(alpha)
  expect(db.prepare('SELECT * FROM person_message_projects WHERE message_id=?').get(alpha)).toBeUndefined()
})

it('keeps project memory writes and deletion separate from other projects and account memory', async () => {
  const a = await project(), b = await project('Beta', 'beta')
  const { personMemory, personMemories, forgetPersonMemory, closePersonMemoryStores } = await import('../../packages/server/src/modules/studio/services/person/memory')
  try {
    const alpha = personMemory(1, 'person-main-owner', a.id)
    await alpha.service.write({ operation: 'create', kind: 'profile_name', identity: alpha.identity, reason: 'Explicit user instruction', node: { title: 'Project contact', content: 'Alpha contact: Alice', valueJson: 'Alice' } })
    const rows = await personMemories(1, a.id)
    expect(rows).toHaveLength(1)
    expect(await personMemories(1, b.id)).toEqual([])
    expect(await personMemories(1)).toEqual([])
    await expect(forgetPersonMemory(1, rows[0].id, rows[0].revision, b.id)).rejects.toThrow()
    expect(await personMemories(1, a.id)).toHaveLength(1)
    await forgetPersonMemory(1, rows[0].id, rows[0].revision, a.id)
    expect(await personMemories(1, a.id)).toEqual([])
  } finally { closePersonMemoryStores() }
})

it('requires independent repository worktrees, freezes the branch and invalidates changed candidates', async () => {
  const { execFileSync } = await import('node:child_process')
  const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: 'pipe' }).trim()
  const repo = join(root, 'alpha'), trees = join(root, 'trees')
  mkdirSync(trees)
  git(repo, 'init', '-b', 'main'); git(repo, 'config', 'user.email', 'test@example.invalid'); git(repo, 'config', 'user.name', 'Fixture')
  git(repo, 'commit', '--allow-empty', '-m', 'base')
  const one = join(trees, 'one'), two = join(trees, 'two')
  git(repo, 'worktree', 'add', '-b', 'task-one', one); git(repo, 'worktree', 'add', '-b', 'task-two', two)
  const p = await projects.configurePersonProject(1, { name: 'Repo', workspace: repo, repository: repo, worktree_root: trees, expected_revision: 0 })
  await expect(contract({ project_id: p.id })).rejects.toThrow('independent branch worktree')
  const c = await contract({ project_id: p.id, workspace: one, branch: 'task-one', acceptance: 'Tests pass on the committed candidate.' })
  const t = task(c), run = store.enqueuePersonExecution(t)
  const other = store.enqueuePersonExecution(task(await contract({ project_id: p.id, workspace: two })))
  expect(resources.claimPersonResources(run)).toBe(true)
  expect(resources.claimPersonResources(other)).toBe(true)
  const sharedBranch = join(trees, 'shared-branch')
  git(repo, 'worktree', 'add', '--force', sharedBranch, 'task-one')
  const conflicting = store.enqueuePersonExecution(task(await contract({ project_id: p.id, workspace: sharedBranch })))
  expect(resources.claimPersonResources(conflicting)).toBe(false)
  const { personCandidate, acceptPersonCandidate } = await import('../../packages/server/src/modules/studio/services/person/acceptance')
  const output = 'Verified tests on candidate'
  const candidate = personCandidate(t, run, output)
  db.prepare("UPDATE person_executions SET state='finished',output=? WHERE id=?").run(output, run.id)
  db.prepare('UPDATE session_tasks SET requirements_json=? WHERE id=?').run(JSON.stringify({ goal: 'Produce evidence', contract: c, verification: candidate }), t.id)
  git(one, 'commit', '--allow-empty', '-m', 'changed candidate')
  expect(() => acceptPersonCandidate(store.getPersonTask(1, t.id), { candidate: candidate.candidate, evidence: 'Old evidence' })).toThrow('Candidate changed')
  expect(store.getPersonTask(1, t.id).status).toBe('open')
  git(one, 'checkout', '-b', 'changed-branch')
  await expect(contracts.verifyPersonTaskWorkspace(t)).rejects.toThrow('branch changed')
})

it('inherits the flow project and records acceptance only for the current owner and returned candidate', async () => {
  const p = await project(), b = await project('Beta', 'beta')
  await projects.configurePersonRole(1, 'person-main-owner', { project_id: b.id, instructions: 'Implement approved deliverables.', expected_revision: 0 })
  const c = await contracts.preparePersonContract(1, 'person-main-owner', { acceptance: 'Check measured value', agent_id: 'worker' }, p.id)
  expect(c.role.project_id).toBe(p.id)
  const t = task(c), run = store.enqueuePersonExecution(t)
  const { personCandidate, acceptPersonCandidate } = await import('../../packages/server/src/modules/studio/services/person/acceptance')
  const output = 'Measured 42', verification = personCandidate(t, run, output)
  db.prepare("UPDATE person_executions SET state='finished',output=? WHERE id=?").run(output, run.id)
  db.prepare('UPDATE session_tasks SET requirements_json=? WHERE id=?').run(JSON.stringify({ goal: 'Produce evidence', contract: c, verification }), t.id)
  expect(() => acceptPersonCandidate(store.getPersonTask(1, t.id), { candidate: verification.candidate, evidence: '' })).toThrow('evidence')
  acceptPersonCandidate(store.getPersonTask(1, t.id), { candidate: verification.candidate, evidence: 'Read result file: measured 42, matches criterion.' })
  expect(store.getPersonTask(1, t.id)).toMatchObject({ status: 'completed', completion_evidence: 'Read result file: measured 42, matches criterion.' })
})

it('pins scheduled project work through role rebinding and rejects cross-project schedule access', async () => {
  const a = await project(), b = await project('Beta', 'beta')
  await projects.configurePersonRole(1, 'person-main-owner', { project_id: a.id, expected_revision: 0 })
  const { applyPersonSchedule, tickPersonSchedules } = await import('../../packages/server/src/modules/studio/services/person/schedules')
  const schedule = applyPersonSchedule(1, { action: 'create', mode: 'assistant', session_id: 'person-main-owner', title: 'Alpha report', goal: 'Read Alpha only',
    kind: 'once', expression: new Date(Date.now() + 60_000).toISOString(), timezone: 'UTC', idempotency_key: 'alpha-schedule' })
  await projects.configurePersonRole(1, 'person-main-owner', { project_id: b.id, expected_revision: 1 })
  const { personTools } = await import('../../packages/server/src/modules/studio/services/person/tools')
  const tools = personTools(1, 'main', undefined, 'person-main-owner', b.id)
  expect(await tools.find(t => t.name === 'bot_schedules_query')!.execute({})).toEqual([])
  await expect(tools.find(t => t.name === 'bot_schedule_apply')!.execute({ action: 'cancel', schedule_id: schedule.id, expected_revision: schedule.revision, idempotency_key: 'wrong-project' })).rejects.toThrow('project scope')
  tickPersonSchedules(schedule.next_at)
  expect(db.prepare('SELECT project_id FROM person_flows WHERE title=?').get('Alpha report')?.project_id).toBe(a.id)
})

it('does not replay an unrelated role transcript into a project task callback', async () => {
  const p = await project()
  const t = task(await contract({ project_id: p.id }))
  const { savePersonTaskOrigin } = await import('../../packages/server/src/modules/studio/services/person/delivery')
  savePersonTaskOrigin(1, t.id, { sessionId: 'person-main-owner', runId: 'origin', messages: [{ role: 'user', content: 'Other project confidential history' }] })
  const saved = JSON.parse(String(db.prepare('SELECT origin_json FROM person_task_origins WHERE task_id=?').get(t.id)?.origin_json))
  expect(JSON.stringify(saved.messages)).not.toContain('Other project')
  expect(JSON.stringify(saved.messages)).toContain(p.id)
  expect(JSON.stringify(saved.messages)).toContain('Produce evidence')
})
