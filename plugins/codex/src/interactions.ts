import { randomUUID } from 'node:crypto'
import { StudioError, type AgentInteractionChoice, type AgentOutputEvent, type AgentRunHandle } from '@ekko-studio/plugin-sdk'

type Output = AgentOutputEvent extends infer T ? T extends AgentOutputEvent ? Omit<T, 'producerSequence'> : never : never
type Response = Parameters<NonNullable<AgentRunHandle['respond']>>[0]
interface Question { id: string; prompt: string; choices: AgentInteractionChoice[]; allowText: boolean }

const text = (value: unknown, limit: number): value is string => typeof value === 'string' && !!value.trim() && value.length <= limit

function questions(value: unknown): Question[] {
  if (!Array.isArray(value) || !value.length || value.length > 32) throw new Error('Invalid Codex questions')
  const ids = new Set<string>()
  return value.map(question => {
    if (!question || !text(question.id, 256) || ids.has(question.id) || !text(question.question, 15359)
      || typeof question.header !== 'string' || question.header.length > 1024
      || (question.isOther !== undefined && typeof question.isOther !== 'boolean')
      || (question.isSecret !== undefined && typeof question.isSecret !== 'boolean')) throw new Error('Invalid Codex question')
    // Ordinary persisted interactions are not a credential channel.
    if (question.isSecret) throw new StudioError('CAPABILITY_UNSUPPORTED', 'Secret input requires a credential interaction')
    ids.add(question.id)
    const options = question.options ?? []
    if (!Array.isArray(options) || options.length > 32) throw new Error('Invalid Codex options')
    const labels = new Set<string>()
    const choices = options.map((option, index) => {
      if (!option || !text(option.label, 1024) || labels.has(option.label)
        || typeof option.description !== 'string' || option.description.length > 4096) throw new Error('Invalid Codex option')
      labels.add(option.label)
      return { id: `option-${index}`, label: option.label, description: option.description }
    })
    return { id: question.id, prompt: [question.header, question.question].filter(Boolean).join('\n'),
      choices, allowText: !choices.length || question.isOther === true }
  })
}

/** One native request can have several independently persisted Studio questions. */
export function codexInteractions(emit: (event: Output) => void) {
  const pending = new Map<string, { kind: 'approval' | 'clarification'; choices: AgentInteractionChoice[]; allowText: boolean; finish(answer: string | null): void }>()
  const withdrawn = new Set<string>()
  let count = 0

  function ask(question: Omit<Question, 'id'>, kind: 'approval' | 'clarification', signal: AbortSignal): Promise<string | null> {
    if (signal.aborted) return Promise.resolve(null)
    if (pending.size >= 64 || ++count > 512) throw new Error('Codex interaction limit exceeded')
    const requestId = randomUUID()
    return new Promise((resolve, reject) => {
      const finish = (answer: string | null) => {
        signal.removeEventListener('abort', abort)
        pending.delete(requestId)
        resolve(answer)
      }
      const abort = () => {
        try { if (signal.reason === 'native-resolved') { withdrawn.add(requestId); emit({ type: 'interaction.withdrawn', requestId }) } }
        catch (error) { reject(error) }
        finally { finish(null) }
      }
      pending.set(requestId, { ...question, kind, finish })
      signal.addEventListener('abort', abort, { once: true })
      try { emit({ type: 'interaction.requested', requestId, kind, ...question }) }
      catch (error) { reject(error); finish(null) }
    })
  }

  return {
    async request(method: string, params: Record<string, any>, signal: AbortSignal): Promise<unknown> {
      if (method === 'item/tool/requestUserInput') {
        const list = questions(params.questions)
        if (pending.size + list.length > 64 || count + list.length > 512) throw new Error('Codex interaction limit exceeded')
        const answers = await Promise.all(list.map(async question => {
          const { id, ...input } = question
          return [id, { answers: [await ask(input, 'clarification', signal)].filter(answer => answer !== null) }]
        }))
        return { answers: Object.fromEntries(answers) }
      }
      if (!['item/commandExecution/requestApproval', 'item/fileChange/requestApproval'].includes(method)) throw new Error('Unsupported Codex client request')
      const choices = ['accept', 'decline', 'cancel'].filter(choice => !Array.isArray(params.availableDecisions) || params.availableDecisions.includes(choice))
      if (!choices.length) return { decision: 'cancel' }
      const decision = await ask({ allowText: false,
        prompt: [params.reason, params.command, params.cwd, params.grantRoot].filter(value => typeof value === 'string').join('\n').slice(0, 16384) || 'Codex requests permission',
        choices: choices.map(id => ({ id, label: id === 'accept' ? 'Allow once' : id === 'decline' ? 'Decline' : 'Cancel turn' })),
      }, 'approval', signal)
      return { decision: decision ?? 'cancel' }
    },
    respond(response: Response): void | { status: 'withdrawn' } {
      if (withdrawn.has(response.requestId)) return { status: 'withdrawn' }
      const entry = pending.get(response.requestId)
      const choice = entry?.choices.find(choice => choice.id === response.choiceId)
      if (!entry || (response.choiceId !== undefined && (!choice || response.text !== undefined))
        || (response.choiceId === undefined && (!entry.allowText || !text(response.text, 16384)))) {
        throw new StudioError('INVALID_ARGUMENT', 'Invalid Codex interaction response')
      }
      entry.finish(choice ? entry.kind === 'approval' ? choice.id : choice.label : response.text!)
    },
    close(): void { for (const entry of pending.values()) entry.finish(null) },
  }
}
