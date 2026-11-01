export interface PersonProject {
  id: string
  owner_user_id: number
  name: string
  workspace: string
  repository: string
  worktree_root: string
  instructions: string
  revision: number
}
export interface PersonRoleConfiguration {
  session_id: string
  project_id: string
  instructions: string
  allowed_agents: string[]
  revision: number
}
/** Immutable dispatch evidence. Text is instruction context, not an authorization grant. */
export interface PersonExecutionContract {
  version: 1
  workspace: string
  access_mode: 'read' | 'write'
  project?: Pick<PersonProject, 'id' | 'name' | 'revision' | 'instructions'>
  role: PersonRoleConfiguration
  agent: { id: string; name: string; description: string; selection: import('./person').PersonSelection }
  git?: { common_directory: string; branch: string; head: string }
  resources: string[]
  dependencies: string[]
  acceptance: string
  authorization: string
}
