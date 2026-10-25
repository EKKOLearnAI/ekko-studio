import { StudioError, type AgentRunHandle } from '@ekko-studio/plugin-sdk'
import type { Output } from './events'
import type { ClaudeRecord } from './rpc'

const string = (value: unknown, max: number): value is string => typeof value === 'string' && !!value && value.length <= max
const plain = (value: string) => value.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '')
type Response = Parameters<NonNullable<AgentRunHandle['respond']>>[0]

export function claudeInteractions(emit: (event: Output) => void, approvalRequired = true) {
  const native = new Map<string, { withdrawn: boolean; resolve(): void }>(), pending = new Map<string, { nativeId: string; choices: string[]; allowText: boolean; finish(value: string | null): void }>()
  const withdrawn = new Set<string>()
  const cancelledNative = new Set<string>()
  let count = 0
  const ask = (nativeId: string, index: number, prompt: string, choices: Array<{ id: string; label: string; description?: string }>, allowText: boolean, kind: 'approval' | 'clarification') => {
    if (pending.size >= 64 || ++count > 512) throw new StudioError('RESOURCE_EXHAUSTED', 'Claude interaction limit exceeded')
    const requestId = `${nativeId}:${index}`
    return new Promise<string | null>(resolve => {
      pending.set(requestId, { nativeId, choices: choices.map(choice => choice.id), allowText, finish(value) { pending.delete(requestId); resolve(value) } })
      emit({ type: 'interaction.requested', requestId, kind, prompt: plain(prompt).slice(0, 16384), choices, allowText })
    })
  }
  return {
    async request(event: ClaudeRecord): Promise<unknown> {
      const nativeId = event.request_id, request = event.request
      if (!string(nativeId, 200) || !request || typeof request !== 'object') throw new StudioError('INVALID_ARGUMENT', 'Invalid Claude control request')
      if (native.has(nativeId)) throw new StudioError('INVALID_ARGUMENT', 'Duplicate Claude control request')
      if (native.size >= 32) throw new StudioError('RESOURCE_EXHAUSTED', 'Claude control request limit exceeded')
      let resolve!: () => void
      const stopped = new Promise<null>(settle => { resolve = () => settle(null) })
      const entry = { withdrawn: false, resolve }; native.set(nativeId, entry)
      try {
        if (request.subtype === 'can_use_tool') {
          if (!string(request.tool_name, 256) || !request.input || typeof request.input !== 'object' || Array.isArray(request.input)) throw new StudioError('INVALID_ARGUMENT', 'Invalid Claude permission request')
          if (request.tool_name === 'AskUserQuestion') {
            const questions = request.input.questions
            if (!Array.isArray(questions) || !questions.length || questions.length > 16) throw new StudioError('INVALID_ARGUMENT', 'Invalid Claude questions')
            const answers: Record<string, string> = Object.create(null)
            for (let index = 0; index < questions.length; index++) {
              const question = questions[index]
              if (!string(question.question, 15000) || question.multiSelect === true || !Array.isArray(question.options) || question.options.length > 30) throw new StudioError('CAPABILITY_UNSUPPORTED', 'Claude multiple-selection questions require a supported interaction')
              const choices: Array<{ id: string; label: string; description?: string }> = question.options.map((option: any, i: number) => {
                if (!string(option.label, 1024) || (option.description !== undefined && !string(option.description, 4096))) throw new StudioError('INVALID_ARGUMENT', 'Invalid Claude answer option')
                return { id: String(i), label: option.label, ...(option.description ? { description: option.description } : {}) }
              })
              const answer = await Promise.race([ask(nativeId, index, [question.header, question.question].filter(part => typeof part === 'string').join('\n'), choices, true, 'clarification'), stopped])
              if (answer === null || entry.withdrawn) return { behavior: 'deny', message: 'Question withdrawn' }
              answers[question.question] = choices.find(choice => choice.id === answer)?.label || answer
            }
            return { behavior: 'allow', updatedInput: { ...request.input, answers } }
          }
          if (request.requires_user_interaction && request.tool_name !== 'ExitPlanMode') throw new StudioError('CAPABILITY_UNSUPPORTED', 'This Claude tool requires a native interaction surface')
          if (!approvalRequired) return { behavior: 'allow', updatedInput: request.input }
          const detail = JSON.stringify(request.input).slice(0, 12000)
          const answer = await Promise.race([ask(nativeId, 0, [request.title || request.tool_name, request.decision_reason, detail].filter(part => typeof part === 'string').join('\n'),
            [{ id: 'allow', label: 'Allow once' }, { id: 'deny', label: 'Decline' }], false, 'approval'), stopped])
          return answer === 'allow' && !entry.withdrawn ? { behavior: 'allow', updatedInput: request.input } : { behavior: 'deny', message: 'Permission declined' }
        }
        if (request.subtype === 'elicitation') {
          const schema = request.requested_schema
          if (request.mode === 'url' || !schema || schema.type !== 'object' || Object.keys(schema.properties || {}).length || (schema.required || []).length) throw new StudioError('CAPABILITY_UNSUPPORTED', 'MCP elicitation fields require a supported form or credential interaction')
          if (!approvalRequired) return { action: 'accept', content: {} }
          const answer = await Promise.race([ask(nativeId, 0, String(request.message || 'MCP confirmation required'), [{ id: 'accept', label: 'Allow once' }, { id: 'decline', label: 'Decline' }], false, 'approval'), stopped])
          return answer === 'accept' && !entry.withdrawn ? { action: 'accept', content: {} } : { action: entry.withdrawn ? 'cancel' : 'decline' }
        }
        throw new StudioError('CAPABILITY_UNSUPPORTED', 'Unsupported Claude native control request')
      } finally { native.delete(nativeId) }
    },
    withdraw(nativeId: string, notify = true) {
      const entry = native.get(nativeId)
      if (!entry) return
      cancelledNative.add(nativeId)
      entry.withdrawn = true; entry.resolve()
      for (const [id, question] of pending) if (question.nativeId === nativeId) {
        withdrawn.add(id); question.finish(null); if (notify) emit({ type: 'interaction.withdrawn', requestId: id })
      }
    },
    respond(input: Response): void | { status: 'withdrawn' } {
      if (withdrawn.has(input.requestId)) return { status: 'withdrawn' }
      const entry = pending.get(input.requestId)
      if (!entry || (input.choiceId !== undefined && (!entry.choices.includes(input.choiceId) || input.text !== undefined))
        || (input.choiceId === undefined && (!entry.allowText || !string(input.text, 16384)))) throw new StudioError('INVALID_ARGUMENT', 'Invalid Claude interaction response')
      entry.finish(input.choiceId ?? input.text!)
    },
    close(notify = true) {
      for (const id of native.keys()) this.withdraw(id, notify)
    },
    isWithdrawn(id: string) { return cancelledNative.has(id) },
  }
}
