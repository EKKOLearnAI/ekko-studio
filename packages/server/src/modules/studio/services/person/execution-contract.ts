import { execFileSync } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { personError, personText } from '../../contracts/person'
import type { PersonExecutionContract } from '../../contracts/person-project'
import type { PersonTask } from '../../contracts/person'
import { personRequirements } from '../../contracts/person-flow'
import { getPersonTask, personSettings } from '../../repositories/person-store'
import { existingDirectory, pathWithin, personRoleConfiguration, requirePersonProject } from './projects'
import { personWorkspace } from './workspace'

export function contractList(value: unknown, label: string): string[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > 20) throw personError(`Invalid ${label}`)
  return [...new Set(value.map(item => personText(item, label, 200)))]
}
function git(directory: string, args: string[]) {
  return execFileSync('git', ['-C', directory, ...args], { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}
export function gitIdentity(directory: string) {
  let branch = ''
  try { branch = git(directory, ['symbolic-ref', '--short', 'HEAD']) } catch { /* Read-only detached candidates are valid. */ }
  return { common_directory: realpathSync(git(directory, ['rev-parse', '--path-format=absolute', '--git-common-dir'])),
    branch, head: git(directory, ['rev-parse', 'HEAD']) }
}
export function personGitDirty(directory: string) {
  return !!git(directory, ['status', '--porcelain', '--untracked-files=all'])
}
export async function preparePersonContract(userId: number, sessionId: string, input: Record<string, unknown>, boundProjectId?: string): Promise<PersonExecutionContract> {
  const role = personRoleConfiguration(userId, sessionId)
  const bound = boundProjectId ?? role.project_id
  if (bound && input.project_id && input.project_id !== bound) throw personError('Task must use the bound project', 403)
  const projectId = bound || (input.project_id ? personText(input.project_id, 'project id', 100) : '')
  const project = projectId ? requirePersonProject(userId, projectId) : undefined
  const accountRoot = await existingDirectory(personWorkspace(userId))
  const workspace = await existingDirectory(input.workspace || project?.workspace || accountRoot)
  if (!pathWithin(accountRoot, workspace)) throw personError('Task is outside the account workspace', 403)
  if (project && ![project.workspace, project.worktree_root].filter(Boolean).some(root => pathWithin(root, workspace))) throw personError('Task is outside the project workspace', 403)
  const agents = personSettings(userId).settings.agents
  const agent = input.agent_id ? agents.find(a => a.id === input.agent_id) : agents.length === 1 ? agents[0] : undefined
  if (!agent || (role.allowed_agents.length && !role.allowed_agents.includes(agent.id))) throw personError('Choose an allowed execution agent')
  const mode = input.access_mode ?? 'write'
  if (mode !== 'write' && mode !== 'read') throw personError('Invalid access_mode')
  const resources = contractList(input.resources, 'resources')
  const dependencies = contractList(input.dependencies, 'dependencies')
  for (const id of dependencies) {
    const dependency = personRequirements(getPersonTask(userId, id)).contract
    if ((dependency?.project?.id || '') !== projectId) throw personError('Dependencies must belong to the same project', 403)
  }
  let identity: PersonExecutionContract['git']
  if (project?.repository) {
    if (mode === 'write' && (!project.worktree_root || !pathWithin(project.worktree_root, workspace)))
      throw personError('Repository writes require an independent branch worktree')
    identity = gitIdentity(workspace)
    if (gitIdentity(project.repository).common_directory !== identity.common_directory) throw personError('Worktree belongs to another repository', 403)
    if (mode === 'write' && (git(workspace, ['rev-parse', '--show-toplevel']) !== workspace
      || workspace === project.repository || !identity.branch)) throw personError('Use an independent branch worktree')
  }
  if (input.branch && input.branch !== identity?.branch) throw personError('Worktree branch does not match')
  return { version: 1, workspace, access_mode: mode,
    ...(project ? { project: { id: project.id, name: project.name, revision: project.revision, instructions: project.instructions } } : {}),
    role: { ...role, project_id: projectId }, agent: structuredClone(agent), ...(identity ? { git: identity } : {}),
    resources, dependencies, acceptance: input.acceptance ? personText(input.acceptance, 'acceptance', 4000) : '',
    authorization: input.authorization ? personText(input.authorization, 'authorization', 4000) : '' }
}
export function personContractHash(contract: PersonExecutionContract) {
  return createHash('sha256').update(JSON.stringify(contract)).digest('hex')
}
export function assertPersonContractCurrent(userId: number, contract: PersonExecutionContract) {
  const role = personRoleConfiguration(userId, contract.role.session_id)
  const agent = personSettings(userId).settings.agents.find(value => value.id === contract.agent.id)
  if (role.revision !== contract.role.revision || JSON.stringify(agent) !== JSON.stringify(contract.agent)
    || (contract.project && requirePersonProject(userId, contract.project.id).revision !== contract.project.revision))
    throw personError('Dispatch configuration changed; retry with the current scope', 409)
}
export async function verifyPersonTaskWorkspace(task: PersonTask) {
  const contract = personRequirements(task).contract
  const actual = await existingDirectory(task.workspace)
  if (contract && actual !== contract.workspace) throw personError('Task workspace identity changed', 409)
  if (contract) {
    const role = personRoleConfiguration(task.owner_user_id, task.session_id)
    if (role.allowed_agents.length && !role.allowed_agents.includes(contract.agent.id))
      throw personError('Role no longer permits this executor', 403)
  }
  if (contract?.project) {
    const project = requirePersonProject(task.owner_user_id, contract.project.id)
    if (![project.workspace, project.worktree_root].filter(Boolean).some(root => pathWithin(root, actual)))
      throw personError('Project no longer permits this workspace', 403)
  }
  if (contract?.git) {
    const now = gitIdentity(actual)
    if (now.common_directory !== contract.git.common_directory || now.branch !== contract.git.branch) throw personError('Task repository or branch changed; inspect before continuing', 409)
  }
  return actual
}
