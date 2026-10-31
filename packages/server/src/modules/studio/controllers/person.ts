import { forgetPersonMemory } from '../services/person/memory'
import type { Context } from 'koa'
import { personError, personRevision, personText } from '../contracts/person'
import { personSnapshot, configurePerson } from '../services/person/service'
import { personUser, personCapabilities, personModelCatalog } from '../services/person/catalog'
import { personTaskChat, continuePersonTask } from '../services/person/task-chat'
import { insertPersonTaskMessage, removePersonTaskMessage } from '../services/person/task-queue'
import { applyPersonTask } from '../services/person/tasks'
import { applyPersonSchedule } from '../services/person/schedules'
import { replyPersonQuestion } from '../services/person/runner'
import { listPersonTasks, taskPersonExecutions, personEvents } from '../services/person/service'
import { personExecutionModelCatalog } from '../services/person/agents'
import { clearPerson } from '../services/person/history'
import { personConversations, createPersonConversation, deletePersonConversation } from '../services/person/conversations'
import { requirePersonSession } from '../services/person/service'
import { controlPersonFlow, createPersonFlow } from '../services/person/stage-flows'
import { getPersonFlow, listPersonFlows } from '../services/person/service'

async function handle(ctx: Context, work: (id: number, body: Record<string, unknown>) => unknown) {
  ctx.set('Cache-Control', 'no-store')
  try {
    if (!ctx.state.user) throw personError('Studio login is required', 401)
    const body = ctx.request.body || {}
    if (typeof body !== 'object' || Array.isArray(body)) throw personError('Expected object')
    ctx.body = await work(ctx.state.user.id, body)
  } catch (error) {
    const status = Number((error as { status?: number }).status) || 500
    ctx.status = status; ctx.body = { error: status < 500 && error instanceof Error ? error.message : 'Person operation failed',
      ...((error as { code?: string }).code === 'PERSON_BOT_NAME_EXISTS' ? { code: 'PERSON_BOT_NAME_EXISTS' } : {}) }
  }
}
export const snapshot = (ctx: Context) => handle(ctx, id => personSnapshot(id, String(ctx.query.session_id || '')))
export const clear = (ctx: Context) => handle(ctx, (id, body) => clearPerson(id, body))
export const settings = (ctx: Context) => handle(ctx, (id, body) => configurePerson(id, body))
export const capabilities = (ctx: Context) => handle(ctx, id => ({ agents: personCapabilities(id), native_allowed: personUser(id).role === 'super_admin' }))
export const modelCatalog = (ctx: Context) => handle(ctx, id => personModelCatalog(id))
export const executionModelCatalog = (ctx: Context) => handle(ctx, id => personExecutionModelCatalog(id))
export const tasks = (ctx: Context) => handle(ctx, (id, body) => ({ tasks: listPersonTasks(id, String(body.search || '').slice(0,200), Math.max(0, Number(body.offset) || 0), { sessionId: body.session_id ? requirePersonSession(id, String(body.session_id)).id : undefined, status: ['open','completed','closed'].includes(String(body.status)) ? String(body.status) : '', order: String(body.order || ''), limit: Number(body.limit) }) }))
export const taskApply = (ctx: Context) => handle(ctx, (id, body) => applyPersonTask(id, body))
export const flows = (ctx: Context) => handle(ctx,(id,body)=>({ flows:body.flow_id ? [getPersonFlow(id,personText(body.flow_id,'flow_id',100))] : listPersonFlows(id,String(body.session_id || ''),Math.max(0,Number(body.offset)||0)) }))
export const flowApply = (ctx: Context) => handle(ctx,(id,body)=>body.action === 'create' ? createPersonFlow(id,body) : controlPersonFlow(id,body))
export const taskChat = (ctx: Context) => handle(ctx, id => personTaskChat(id, ctx.params.id, String(ctx.query.execution_id || '')))
export const taskContinue = (ctx: Context) => handle(ctx, (id, body) => continuePersonTask(id, ctx.params.id, body))
export const taskInsert = (ctx: Context) => handle(ctx, (id, body) => insertPersonTaskMessage(id, ctx.params.id, body))
export const taskRemove = (ctx: Context) => handle(ctx, (id, body) => removePersonTaskMessage(id, ctx.params.id, body))
export const executions = (ctx: Context) => handle(ctx, id => ({ executions: taskPersonExecutions(id, ctx.params.id) }))
export const events = (ctx: Context) => handle(ctx, id => ({ events: personEvents(id, ctx.params.id, Math.max(0, Number(ctx.query.after) || 0)) }))
export const schedules = (ctx: Context) => handle(ctx, (id, body) => applyPersonSchedule(id, body))
export const answer = (ctx: Context) => handle(ctx, (id, body) => replyPersonQuestion(id, ctx.params.id, personRevision(body.expected_revision), personText(body.answer, 'answer', 4000)))
export const memory = (ctx: Context) => handle(ctx, (id, body) => {
  if (body.forget !== true) throw personError('Save or correct memories through the Person conversation.')
  return forgetPersonMemory(id, personText(body.id, 'id', 100), personRevision(body.expected_revision))
})

export const conversations = (ctx: Context) => handle(ctx, id => personConversations(id, String(ctx.query.search || ''), Math.max(0, Number(ctx.query.offset) || 0)))
export const conversationCreate = (ctx: Context) => handle(ctx, (id, body) => createPersonConversation(id, body.title, body))
export const conversationDelete = (ctx: Context) => handle(ctx, (id, body) => deletePersonConversation(id, ctx.params.id, body.expected_history_revision))
