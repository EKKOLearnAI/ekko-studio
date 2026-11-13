export interface CodingAgentEnvironment {
  platform: NodeJS.Platform
  arch: string
  env: NodeJS.ProcessEnv
  exists(path: string): boolean
  findCommandPaths(command: string, env: NodeJS.ProcessEnv): Promise<string[]>
  output(command: string, args: string[]): Promise<string>
}

export function codingAgentEnvironmentError(message: string) {
  return Object.assign(new Error(message), { status: 422, code: 'coding_agent_environment_unavailable' })
}
