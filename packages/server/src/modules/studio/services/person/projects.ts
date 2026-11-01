import { realpath, stat } from 'node:fs/promises'
import { isAbsolute, relative, sep } from 'node:path'
import { randomUUID } from 'node:crypto'
import { personError, personRevision, personText } from '../../contracts/person'
import type { PersonProject, PersonRoleConfiguration } from '../../contracts/person-project'
import { personDb, personSettings, personTransaction } from '../../repositories/person-store'
import { requirePersonSession, assertPersonBotNameAvailable } from '../../repositories/person-session-store'
import { personHasPendingWork } from '../../repositories/person-history-store'
import { personUpdated } from '../../repositories/person-updates'
import { getChatRunServer } from '../../public/chat-run'
import { personUser } from './catalog'
import { personWorkspace } from './workspace'
import { personBot } from '../../../../../../shared/person-bots'

export function pathWithin(root: string, path: string) {
  const local = relative(root, path)
  return !isAbsolute(local) && local !== '..' && !local.startsWith(`..${sep}`)
}
export async function existingDirectory(value: unknown) {
  const path = personText(value, 'workspace', 4000)
  if (!isAbsolute(path)) throw personError('Workspace must be an absolute directory')
  const canonical = await realpath(path)
  if (!(await stat(canonical)).isDirectory()) throw personError('Workspace must be a directory')
  return canonical
}
export function personProjects(userId: number): PersonProject[] {
  personUser(userId)
  return personDb().prepare('SELECT * FROM person_projects WHERE owner_user_id=? ORDER BY name,id').all(userId) as unknown as PersonProject[]
}
export function requirePersonProject(userId: number, id: string): PersonProject {
  personUser(userId)
  const row = personDb().prepare('SELECT * FROM person_projects WHERE id=? AND owner_user_id=?').get(id, userId) as unknown as PersonProject | undefined
  if (!row) throw personError('Project not found', 404)
  return row
}
export function personRoleConfiguration(userId: number, sessionId: string): PersonRoleConfiguration {
  requirePersonSession(userId, sessionId)
  const row = personDb().prepare('SELECT * FROM person_role_configuration WHERE session_id=? AND owner_user_id=?').get(sessionId, userId)
  return row ? { session_id: sessionId, project_id: String(row.project_id), instructions: String(row.instructions),
    allowed_agents: JSON.parse(String(row.allowed_agents_json)), revision: Number(row.revision) }
    : { session_id: sessionId, project_id: '', instructions: '', allowed_agents: [], revision: 0 }
}
function optionalText(value: unknown, name: string, max: number) {
  return value === undefined || value === '' ? '' : personText(value, name, max)
}
export async function configurePersonProject(userId: number, input: Record<string, unknown>) {
  personUser(userId)
  const id = input.id ? personText(input.id, 'project id', 100) : randomUUID()
  const old = input.id ? requirePersonProject(userId, id) : undefined
  const root = await existingDirectory(personWorkspace(userId))
  const workspace = await existingDirectory(input.workspace ?? old?.workspace)
  const repository = input.repository === undefined ? old?.repository || '' : input.repository ? await existingDirectory(input.repository) : ''
  const worktreeRoot = input.worktree_root === undefined ? old?.worktree_root || '' : input.worktree_root ? await existingDirectory(input.worktree_root) : ''
  for (const path of [workspace, repository, worktreeRoot].filter(Boolean)) {
    if (!pathWithin(root, path)) throw personError('Project paths must be within the account workspace', 403)
  }
  const name = personText(input.name ?? old?.name, 'project name', 100)
  const instructions = input.instructions === undefined ? old?.instructions || '' : optionalText(input.instructions, 'project instructions', 8000)
  const revision = personRevision(input.expected_revision)
  return personTransaction(() => {
    if ((old ? requirePersonProject(userId, id).revision : 0) !== revision) throw personError('Project changed; reload and retry', 409)
    personDb().prepare(`INSERT INTO person_projects VALUES (?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET name=excluded.name,workspace=excluded.workspace,repository=excluded.repository,
      worktree_root=excluded.worktree_root,instructions=excluded.instructions,revision=excluded.revision`)
      .run(id, userId, name, workspace, repository, worktreeRoot, instructions, revision + 1)
    personUpdated(userId)
    return requirePersonProject(userId, id)
  })
}
export async function configurePersonRole(userId: number, sessionId: string, input: Record<string, unknown>) {
  const session = requirePersonSession(userId, sessionId)
  const old = personRoleConfiguration(userId, sessionId)
  const projectId = input.project_id === undefined ? old.project_id : optionalText(input.project_id, 'project id', 100)
  if (projectId) requirePersonProject(userId, projectId)
  const instructions = input.instructions === undefined ? old.instructions : optionalText(input.instructions, 'role instructions', 8000)
  const allowed = input.allowed_agents === undefined ? old.allowed_agents : input.allowed_agents
  if (!Array.isArray(allowed) || allowed.length > 20 || allowed.some(id => typeof id !== 'string' || !personSettings(userId).settings.agents.some(agent => agent.id === id))) throw personError('Unknown execution agent')
  const title = input.title === undefined ? session.title : personText(input.title, 'BOT name', 100)
  const bot = input.bot_type === undefined ? session.bot_type || 'zhezhe' : personBot(input.bot_type)?.type
  if (!bot) throw personError('Unknown bot type')
  return personTransaction(() => {
    if (getChatRunServer()?.isSessionRunning?.(sessionId) || personHasPendingWork(userId, sessionId)) throw personError('Wait for replies, tasks and deliveries before changing this role', 409)
    if (personRoleConfiguration(userId, sessionId).revision !== personRevision(input.expected_revision)) throw personError('Role changed; reload and retry', 409)
    if (title !== session.title) assertPersonBotNameAvailable(userId, title!)
    personDb().prepare(`INSERT INTO person_role_configuration VALUES (?,?,?,?,?,?)
      ON CONFLICT(session_id) DO UPDATE SET project_id=excluded.project_id,instructions=excluded.instructions,
      allowed_agents_json=excluded.allowed_agents_json,revision=excluded.revision`)
      .run(sessionId, userId, projectId, instructions, JSON.stringify([...new Set(allowed)]), old.revision + 1)
    personDb().prepare('UPDATE sessions SET title=?,bot_type=? WHERE id=?').run(title, bot, sessionId)
    personUpdated(userId)
    return personRoleConfiguration(userId, sessionId)
  })
}
