import type { SessionState } from '../contracts/runs/session'

export interface ChatRunServerPort {
  emitExternalEvent?: (sessionId: string, event: string, payload: any) => void
  markExternalRunCompleted?: (sessionId: string, event: string) => void
}

export interface RunStateDependencies {
  applyResponseStreamEvent: (...args: any[]) => any
  calcAndUpdateUsage: (...args: any[]) => any
  completeWorkspaceRunCheckpoint: (...args: any[]) => any
  extractResponseText: (...args: any[]) => string
  flushResponseRunToDb: (...args: any[]) => any
  getChatRunServer: () => ChatRunServerPort | null
  getOrCreateSession: (...args: any[]) => SessionState
  startWorkspaceRunCheckpoint: (...args: any[]) => any
  updateContextTokenUsage: (...args: any[]) => any
}

let runStateDependencies: RunStateDependencies | null = null

export function configureRunState(dependencies: RunStateDependencies): void {
  runStateDependencies = dependencies
}

function configured(): RunStateDependencies {
  if (!runStateDependencies) throw new Error('Studio run state has not been configured')
  return runStateDependencies
}

export const applyResponseStreamEvent = (...args: any[]) => configured().applyResponseStreamEvent(...args)
export const calcAndUpdateUsage = (...args: any[]) => configured().calcAndUpdateUsage(...args)
export const completeWorkspaceRunCheckpoint = (...args: any[]) => configured().completeWorkspaceRunCheckpoint(...args)
export const extractResponseText = (...args: any[]) => configured().extractResponseText(...args)
export const flushResponseRunToDb = (...args: any[]) => configured().flushResponseRunToDb(...args)
export const getChatRunServer = (): ChatRunServerPort | null => configured().getChatRunServer()
export const getOrCreateSession = (...args: any[]): SessionState => configured().getOrCreateSession(...args)
export const startWorkspaceRunCheckpoint = (...args: any[]) => configured().startWorkspaceRunCheckpoint(...args)
export const updateContextTokenUsage = (...args: any[]) => configured().updateContextTokenUsage(...args)
