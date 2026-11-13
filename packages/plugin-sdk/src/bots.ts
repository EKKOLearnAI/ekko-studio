import type { Json } from './core'
import type { ApiQuery, JsonObject } from './host'
import type { SessionConnector } from './sessions'

/** BOT roles, conversation, tasks, collaboration, memory and schedules. */
export interface HostBots {
  list(query?: ApiQuery): Promise<Json>
  create(input: JsonObject & { title: string }): Promise<Json>
  get(sessionId: string): Promise<Json>
  configure(sessionId: string, input: JsonObject): Promise<Json>
  clear(sessionId: string, expectedHistoryRevision: number): Promise<Json>
  remove(sessionId: string, expectedHistoryRevision: number): Promise<Json>
  connect: SessionConnector
  models: { list(): Promise<Json>; agents(): Promise<Json>; execution(): Promise<Json> }
  tasks: {
    list(input?: JsonObject): Promise<Json>; apply(input: JsonObject): Promise<Json>
    messages(taskId: string, query?: ApiQuery): Promise<Json>
    send(taskId: string, input: JsonObject): Promise<Json>
    insert(taskId: string, input: JsonObject): Promise<Json>; remove(taskId: string, input: JsonObject): Promise<Json>
    executions(taskId: string): Promise<Json>; events(executionId: string, after?: number): Promise<Json>
  }
  flows: { list(input?: JsonObject): Promise<Json>; apply(input: JsonObject): Promise<Json>; messages(flowId: string, query?: ApiQuery): Promise<Json> }
  schedules: { apply(input: JsonObject): Promise<Json> }
  memory: { forget(id: string, expectedRevision: number): Promise<Json> }
  interactions: { answer(id: string, expectedRevision: number, answer: string): Promise<Json> }
}
