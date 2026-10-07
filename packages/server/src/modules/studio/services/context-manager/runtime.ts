import { createHash, randomUUID } from 'node:crypto'
import { chmod, mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { config } from '../../public/config'
import { safeFileStore } from '../../public/safe-file-store'
import { getSession, getSessionDetail } from '../../repositories/session-store'
import { buildFullPrompt, callSummarizer } from '../context-compressor'
import { invalidateExternalContextUsage, updateContextTokenUsage } from '../chat-run/usage'
import type { SessionState } from '../chat-run/types'
import { getContextManagerSettings, type ContextManagerName } from './settings'
import { selectExternalContextUsage } from './usage'
import { getManagedContextManagerCaBundle } from './lifecycle'

export interface StudioContextManagerBinding {
  manager: 'native' | 'bili'
  proxyUrl: string
  conversationId: string
  allowNativeFallback: boolean
  caBundlePath?: string
}

type ObservedContextOwner = { manager: string; proxyUrl?: string; conversationId?: string }

function observedBinding(binding: StudioContextManagerBinding, owner?: ObservedContextOwner): StudioContextManagerBinding {
  if (!owner) return binding
  if (!['native', 'bili'].includes(owner.manager)) throw new Error('Unsupported context owner.')
  if (owner.conversationId && owner.conversationId !== binding.conversationId) throw new Error('Bili context identity mismatch.')
  return { ...binding, manager: owner.manager as 'native' | 'bili', proxyUrl: owner.proxyUrl || binding.proxyUrl }
}

interface ForkIdentity { rawId: string; ref: string; identityHash: string }
interface SnapshotMessage extends Omit<ForkIdentity, 'identityHash'> {
  identityHash?: string
  role: string
  text?: string
  contentType: string
  toolName?: string
  toolCallId?: string
  toolIsError?: boolean
}
interface BiliSnapshot {
  status?: string
  conversationId?: string
  sessionId?: string
  orderHash?: string
  ok: true
  protocolVersion: number
  parentRevision: string
  orderedMessages: ForkIdentity[]
  messages: SnapshotMessage[]
}
interface BranchMessage {
  role: string
  content: string
  tool_call_id?: string | null
  tool_name?: string | null
  tool_calls?: unknown[] | null
  tool_is_error?: boolean
}
interface ForkJournal {
  sourceHash?: string
  profile: string
  agent: ContextManagerName
  proxyUrl: string
  status: 'pending' | 'completed'
  request: Record<string, unknown>
  response?: Record<string, unknown>
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

export async function resolveStudioContextManager(profile: string, agent: ContextManagerName, sessionId: string): Promise<StudioContextManagerBinding> {
  const session = getSession(sessionId)
  if (session && session.profile !== profile) throw new Error('Context manager session belongs to another profile.')
  const settings = await getContextManagerSettings(profile)
  const caBundlePath = settings[agent].manager === 'bili'
    ? getManagedContextManagerCaBundle(profile, settings.proxyUrl) : undefined
  return { ...settings[agent], proxyUrl: settings.proxyUrl, conversationId: sessionId, allowNativeFallback: settings.allowNativeFallback,
    ...(caBundlePath ? { caBundlePath } : {}) }
}

async function publicRequest<T = Record<string, unknown>>(proxyUrl: string, path: string, body?: Record<string, unknown>): Promise<T> {
  const origin = new URL(proxyUrl)
  if (!['http:', 'https:'].includes(origin.protocol) || !['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname)
    || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) throw new Error('Invalid local bili origin.')
  const url = new URL(path, origin)
  if (url.origin !== origin.origin || !url.pathname.startsWith('/__bili/')) throw new Error('Invalid bili public endpoint.')
  const response = await fetch(url, {
    method: body ? 'POST' : 'GET',
    headers: { 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(10_000),
    redirect: 'error',
  })
  const result = await response.json() as Record<string, unknown>
  if (!response.ok || result?.ok !== true) throw new Error(`Bili ${url.pathname}: ${String(result?.code || response.status)} ${String(result?.error || 'public operation failed')}`)
  return result as T
}

function journalPath(profile: string, sessionId: string): string {
  return join(config.appHome, 'context-manager', 'forks', `${digest(JSON.stringify([profile, sessionId]))}.json`)
}

async function readJournal(profile: string, sessionId: string): Promise<ForkJournal | undefined> {
  try {
    const value = JSON.parse(await readFile(journalPath(profile, sessionId), 'utf8')) as ForkJournal
    if (value.profile !== profile || value.request?.childConversationId !== sessionId || !['pending', 'completed'].includes(value.status)) throw new Error('Invalid bili fork journal.')
    return value
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

async function writeJournal(profile: string, sessionId: string, journal: ForkJournal): Promise<void> {
  const path = journalPath(profile, sessionId)
  await mkdir(join(config.appHome, 'context-manager', 'forks'), { recursive: true, mode: 0o700 })
  await safeFileStore.updateText(path, () => JSON.stringify(journal))
  await chmod(path, 0o600)
}

type MessageProjection = Pick<SnapshotMessage, 'role' | 'text' | 'contentType' | 'toolName' | 'toolCallId' | 'toolIsError'>

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (value !== null && typeof value === 'object') {
    const object = value as Record<string, unknown>
    return `{${Object.keys(object).sort().map(key => `${JSON.stringify(key)}:${stableJson(object[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

function toolArgumentsMatch(left: string, right: string): boolean {
  if (left === right) return true
  try { return stableJson(JSON.parse(left)) === stableJson(JSON.parse(right)) } catch { return false }
}

function projectBranchMessages(messages: BranchMessage[]): MessageProjection[] {
  const result: MessageProjection[] = []
  const tools = new Map<string, string>()
  const addTool = (id: unknown, name: unknown, input: unknown) => {
    if (typeof id !== 'string' || !id || typeof name !== 'string' || !name || tools.has(id)
      || input === undefined) throw new Error('Bili branch mapping unavailable for tool identity.')
    const text = typeof input === 'string' ? input : JSON.stringify(input)
    tools.set(id, name)
    result.push({ role: 'assistant', contentType: 'tool-call', toolCallId: id, toolName: name, text })
  }
  for (const message of messages) {
    if (['system', 'command'].includes(message.role)) continue
    let content: unknown = message.content
    if (typeof content === 'string' && content.trimStart().startsWith('[')) {
      try {
        const parsed = JSON.parse(content)
        if (Array.isArray(parsed) && parsed.length && parsed.every(part => part && typeof part.type === 'string')) content = parsed
      } catch { /* Plain text that is not a serialized content array. */ }
    }
    if (message.role === 'tool') {
      if (typeof content !== 'string' || !message.tool_call_id || !tools.has(message.tool_call_id)) throw new Error('Bili branch mapping unavailable for tool result.')
      const name = tools.get(message.tool_call_id)!
      if (message.tool_name && message.tool_name !== name) throw new Error('Studio tool identity does not match bili raw history.')
      if (message.tool_is_error !== undefined && typeof message.tool_is_error !== 'boolean') throw new Error('Bili branch mapping unavailable for tool result status.')
      result.push({ role: 'tool', contentType: 'tool-result', text: content || '(no output)', toolCallId: message.tool_call_id, toolName: name, toolIsError: message.tool_is_error === true })
      continue
    }
    if (!['user', 'assistant'].includes(message.role)) throw new Error('Bili branch mapping unavailable for role.')
    if (Array.isArray(content)) {
      for (const part of content) {
        if (part?.type === 'text' && typeof part.text === 'string') {
          result.push({ role: message.role, contentType: 'text', text: part.text })
        } else if (part?.type === 'tool_use' && message.role === 'assistant') {
          addTool(part.id, part.name, part.input)
        } else if (part?.type === 'tool_result' && message.role === 'user' && typeof part.content === 'string' && tools.has(part.tool_use_id)) {
          if (part.is_error !== undefined && typeof part.is_error !== 'boolean') throw new Error('Bili branch mapping unavailable for tool result status.')
          result.push({ role: 'tool', contentType: 'tool-result', text: part.content, toolCallId: part.tool_use_id, toolName: tools.get(part.tool_use_id), toolIsError: part.is_error === true })
        } else throw new Error('Bili branch mapping unavailable for multimodal or opaque content.')
      }
    } else if (typeof content === 'string') {
      if (content || !message.tool_calls?.length) result.push({ role: message.role, contentType: 'text', text: content })
    } else throw new Error('Bili branch mapping unavailable for content.')
    if (message.tool_calls?.length) {
      if (message.role !== 'assistant') throw new Error('Bili branch mapping unavailable for tool role.')
      for (const value of message.tool_calls) {
        const call = value as { id?: string; name?: string; arguments?: unknown; rawArguments?: string; function?: { name?: string; arguments?: unknown } }
        if (!call || typeof call !== 'object') throw new Error('Bili branch mapping unavailable for tool call.')
        addTool(call.id, call.function?.name ?? call.name, call.function?.arguments ?? call.rawArguments ?? call.arguments)
      }
    }
  }
  return result
}

function validateSnapshot(snapshot: BiliSnapshot, conversationId?: string): void {
  if (snapshot.protocolVersion !== 1 || (snapshot.status !== undefined && snapshot.status !== 'exact')
    || !Array.isArray(snapshot.messages) || !Array.isArray(snapshot.orderedMessages)
    || snapshot.messages.length !== snapshot.orderedMessages.length) throw new Error('Bili branch mapping unavailable.')
  if (conversationId && (snapshot.conversationId !== conversationId || snapshot.sessionId !== conversationId)) throw new Error('Bili snapshot identity mismatch.')
  const rawIds = new Set<string>()
  const refs = new Set<string>()
  for (let i = 0; i < snapshot.messages.length; i++) {
    const raw = snapshot.messages[i]
    const identity = snapshot.orderedMessages[i]
    if (!identity || typeof identity.rawId !== 'string' || !identity.rawId || !/^m\d{5,}$/.test(identity.ref)
      || !/^[a-f0-9]{64}$/.test(identity.identityHash) || rawIds.has(identity.rawId) || refs.has(identity.ref)
      || raw.rawId !== identity.rawId || raw.ref !== identity.ref
      || (raw.identityHash !== undefined && raw.identityHash !== identity.identityHash)) throw new Error('Bili raw/ref identity mapping does not match.')
    rawIds.add(identity.rawId)
    refs.add(identity.ref)
    if (!['text', 'tool-call', 'tool-result'].includes(raw.contentType) || typeof raw.text !== 'string') throw new Error('Bili branch mapping unavailable for this content type.')
  }
  if (snapshot.orderHash !== undefined && snapshot.orderHash !== digest(JSON.stringify(snapshot.orderedMessages))) throw new Error('Bili raw/ref order hash does not match.')
}

/** Match the provider's split projection without inventing raw ids or dropping a tail. */
export function matchBiliBranchPrefix(snapshot: BiliSnapshot, messages: BranchMessage[]): ForkIdentity[] {
  validateSnapshot(snapshot)
  const projected = projectBranchMessages(messages)
  let cursor = 0
  for (; cursor < projected.length && cursor < snapshot.messages.length; cursor++) {
    const raw = snapshot.messages[cursor]
    const message = projected[cursor]
    const textMatches = message.contentType === 'tool-call'
      ? toolArgumentsMatch(raw.text!, message.text!) : raw.text === message.text
    if (message.role !== raw.role || message.contentType !== raw.contentType || !textMatches
      || message.toolCallId !== raw.toolCallId || message.toolName !== raw.toolName
      || (message.contentType === 'tool-result' && message.toolIsError !== (raw.toolIsError === true))) throw new Error('Studio branch content does not match bili raw history.')
  }
  if (cursor < projected.length) {
    // A complete outbound snapshot ending in input proves only one final text reply
    // can be pending. Never infer arbitrary missing user/tool/history messages.
    const tail = projected[cursor]
    const last = snapshot.messages[cursor - 1]
    if (projected.length !== cursor + 1 || !last || !['user', 'tool'].includes(last.role)
      || tail.role !== 'assistant' || tail.contentType !== 'text' || !tail.text) throw new Error('Studio branch tail does not match bili raw history.')
  }
  return snapshot.orderedMessages.slice(0, cursor).map(({ rawId, ref, identityHash }) => ({ rawId, ref, identityHash }))
}

function validateForkReceipt(response: Record<string, unknown>, request: Record<string, unknown>): void {
  if (!['exact', 'expanded'].includes(String(response.status))) throw new Error('Bili fork receipt is unavailable.')
  if (response.protocolVersion !== 1 || response.parentConversationId !== request.parentConversationId
    || response.childConversationId !== request.childConversationId || response.sessionId !== request.childConversationId
    || response.parentRevision !== request.parentRevision || typeof response.childRevision !== 'string' || !response.childRevision
    || stableJson(response.branchPoint) !== stableJson(request.branchPoint)) throw new Error('Bili returned a mismatched fork receipt.')
}

async function verifyChildSnapshot(journal: ForkJournal, response: Record<string, unknown>, initial = false): Promise<void> {
  const sessionId = String(journal.request.childConversationId)
  const snapshot = await publicRequest<BiliSnapshot>(journal.proxyUrl, `/__bili/plugin/snapshot?conversationId=${encodeURIComponent(sessionId)}`)
  validateSnapshot(snapshot, sessionId)
  const expected = journal.request.orderedMessages as ForkIdentity[]
  if (stableJson(snapshot.orderedMessages.slice(0, expected.length)) !== stableJson(expected)
    || (initial && (snapshot.orderedMessages.length !== expected.length || snapshot.parentRevision !== response.childRevision))) throw new Error('Bili child snapshot prefix does not match its fork receipt.')
}

async function completeJournal(profile: string, agent: ContextManagerName, sessionId: string, binding: StudioContextManagerBinding, journal: ForkJournal): Promise<Record<string, unknown>> {
  if (journal.agent !== agent || journal.proxyUrl !== binding.proxyUrl) throw new Error('Bili branch manager changed; restore its original proxy before continuing.')
  const response = journal.status === 'pending'
    ? await publicRequest(journal.proxyUrl, '/__bili/plugin/fork', journal.request) : journal.response
  if (!response) throw new Error('Bili fork receipt is unavailable.')
  validateForkReceipt(response, journal.request)
  // A receipt alone cannot prove the external state still exists or belongs to this child.
  await verifyChildSnapshot(journal, response)
  if (journal.status === 'pending') await writeJournal(profile, sessionId, { ...journal, status: 'completed', response })
  return response
}

const childOperations = new Map<string, Promise<void>>()

async function withChildLock<T>(profile: string, sessionId: string, operation: () => Promise<T>): Promise<T> {
  const key = journalPath(profile, sessionId)
  const previous = childOperations.get(key) ?? Promise.resolve()
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const next = previous.then(() => gate)
  childOperations.set(key, next)
  await previous
  try { return await operation() } finally {
    release()
    if (childOperations.get(key) === next) childOperations.delete(key)
  }
}

type ForkArguments = {
  profile: string; agent: ContextManagerName; parentSessionId: string; childSessionId: string; messages: BranchMessage[]
  owner?: ObservedContextOwner
}

export async function forkBiliConversation(args: ForkArguments): Promise<Record<string, unknown> | undefined> {
  return withChildLock(args.profile, args.childSessionId, () => forkBiliConversationUnlocked(args))
}

async function forkBiliConversationUnlocked(args: ForkArguments): Promise<Record<string, unknown> | undefined> {
  const binding = observedBinding(await resolveStudioContextManager(args.profile, args.agent, args.childSessionId),
    args.owner ? { ...args.owner, conversationId: args.childSessionId } : undefined)
  if (binding.manager !== 'bili') return undefined
  const sourceHash = digest(stableJson(projectBranchMessages(args.messages)))
  const prior = await readJournal(args.profile, args.childSessionId)
  if (prior) {
    if (prior.request.parentConversationId !== args.parentSessionId || prior.agent !== args.agent
      || prior.sourceHash !== sourceHash) throw new Error('Bili fork identity conflict.')
    return completeJournal(args.profile, args.agent, args.childSessionId, binding, prior)
  }
  const parent = getSession(args.parentSessionId)
  if (parent && parent.profile !== args.profile) throw new Error('Bili branch parent belongs to another profile.')
  const manifest = await publicRequest(binding.proxyUrl, '/__bili/plugin/manifest')
  const capability = (manifest.capabilities as { fork?: { protocolVersion?: number } } | undefined)?.fork
  if (capability?.protocolVersion !== 1) throw new Error('Bili public fork protocol is unavailable; upgrade bili before branching.')
  const snapshot = await publicRequest<BiliSnapshot>(binding.proxyUrl, `/__bili/plugin/snapshot?conversationId=${encodeURIComponent(args.parentSessionId)}`)
  validateSnapshot(snapshot, args.parentSessionId)
  const orderedMessages = matchBiliBranchPrefix(snapshot, args.messages)
  const journal: ForkJournal = {
    sourceHash,
    profile: args.profile, agent: args.agent, proxyUrl: binding.proxyUrl, status: 'pending',
    request: {
      protocolVersion: 1, parentConversationId: args.parentSessionId, childConversationId: args.childSessionId,
      parentRevision: snapshot.parentRevision, orderedMessages,
      branchPoint: { messageCount: orderedMessages.length, orderHash: digest(JSON.stringify(orderedMessages)) },
      idempotencyKey: randomUUID(),
    },
  }
  await writeJournal(args.profile, args.childSessionId, journal)
  const response = await publicRequest(binding.proxyUrl, '/__bili/plugin/fork', journal.request)
  validateForkReceipt(response, journal.request)
  await verifyChildSnapshot(journal, response, true)
  await writeJournal(args.profile, args.childSessionId, { ...journal, status: 'completed', response })
  return response
}

export async function ensureBiliConversation(profile: string, agent: ContextManagerName, sessionId: string, owner?: ObservedContextOwner): Promise<void> {
  await withChildLock(profile, sessionId, () => ensureBiliConversationUnlocked(profile, agent, sessionId, owner))
}

async function ensureBiliConversationUnlocked(profile: string, agent: ContextManagerName, sessionId: string, owner?: ObservedContextOwner): Promise<void> {
  const binding = observedBinding(await resolveStudioContextManager(profile, agent, sessionId), owner)
  if (binding.manager !== 'bili') return
  const journal = await readJournal(profile, sessionId)
  if (journal) {
    await completeJournal(profile, agent, sessionId, binding, journal)
    return
  }
  const session = getSession(sessionId)
  if (session?.parent_session_id) {
    const detail = getSessionDetail(sessionId)
    await forkBiliConversationUnlocked({ profile, agent, parentSessionId: session.parent_session_id, childSessionId: sessionId, messages: detail?.messages || [], owner: binding })
  }
}

export async function refreshExternalContextUsage(args: {
  sessionId: string; profile: string; agent: ContextManagerName; model?: string | null; state: SessionState;
  emit: (event: string, payload: any) => void;
  owner?: ObservedContextOwner
}): Promise<boolean> {
  try {
    const binding = await resolveStudioContextManager(args.profile, args.agent, args.sessionId)
    const manager = args.owner?.manager ?? binding.manager
    args.state.contextOwner = { manager: manager === 'bili' ? 'bili' : 'native',
      conversationId: args.owner?.conversationId || binding.conversationId,
      proxyUrl: args.owner?.proxyUrl || binding.proxyUrl }
    if (manager !== 'bili') {
      if (args.state.externalContext) args.state.contextTokens = undefined
      args.state.externalContext = undefined
      args.state.contextManagerStatus = typeof args.state.contextTokens === 'number' && Number.isFinite(args.state.contextTokens) && args.state.contextTokens >= 0
        ? 'native' : 'unavailable'
      return false
    }
    const conversationId = args.owner?.conversationId || binding.conversationId
    if (conversationId !== args.sessionId) throw new Error('Bili context identity mismatch.')
    const status = await publicRequest(args.owner?.proxyUrl || binding.proxyUrl, `/__bili/plugin/status?conversationId=${encodeURIComponent(conversationId)}`)
    const usage = selectExternalContextUsage(status, { conversationId, model: args.model || '' })
    if (!usage) throw new Error('Bili context usage is unavailable, stale or belongs to another model.')
    args.state.externalContext = usage
    args.state.contextManagerStatus = 'active'
    updateContextTokenUsage(args.sessionId, args.state, args.emit, usage.tokens)
    return true
  } catch (error) {
    if (args.owner?.manager !== 'bili' && args.state.contextOwner?.manager !== 'bili' && !args.state.externalContext) throw error
    invalidateExternalContextUsage(args.sessionId, args.state, args.emit)
    return false
  }
}

export async function compactBiliConversation(args: {
  sessionId: string; profile: string; agent: ContextManagerName; model?: string | null; state: SessionState;
  emit: (event: string, payload: any) => void;
}): Promise<{ beforeTokens: number; afterTokens: number }> {
  const binding = observedBinding(await resolveStudioContextManager(args.profile, args.agent, args.sessionId), args.state.contextOwner)
  if (binding.manager !== 'bili') throw new Error('Bili does not own this conversation.')
  await ensureBiliConversation(args.profile, args.agent, args.sessionId, binding)
  const snapshot = await publicRequest<BiliSnapshot>(binding.proxyUrl, `/__bili/plugin/snapshot?conversationId=${encodeURIComponent(args.sessionId)}`)
  validateSnapshot(snapshot, args.sessionId)
  const before = await publicRequest(binding.proxyUrl, `/__bili/plugin/status?conversationId=${encodeURIComponent(args.sessionId)}`)
  if (before.conversationId !== args.sessionId || before.sessionId !== snapshot.sessionId || before.sessionRevision !== snapshot.parentRevision || !Array.isArray(before.compressibleRanges)) {
    throw new Error('Bili compression ranges are unavailable or their identity/revision changed.')
  }
  const firstUser = snapshot.messages.find(m => m.role === 'user')
  let prefix: BiliSnapshot['messages'] | undefined
  for (const range of before.compressibleRanges) {
    if (!range || typeof range.startRef !== 'string' || typeof range.endRef !== 'string') throw new Error('Invalid bili compression range.')
    const start = snapshot.messages.findIndex(m => m.ref === range.startRef)
    const end = snapshot.messages.findIndex(m => m.ref === range.endRef)
    if (start < 0 || end < start) throw new Error('Bili compression range mapping is unavailable.')
    let messages = snapshot.messages.slice(start, end + 1)
    if (range.count !== messages.length || messages.some(m => typeof m.text !== 'string' || m.role === 'system')) {
      throw new Error('Bili compression range contains protected or unrecoverable history.')
    }
    // The kernel may recommend the first user anchor although pruning retains it.
    const anchorIndex = firstUser ? messages.indexOf(firstUser) : -1
    if (anchorIndex >= 0) messages = messages.slice(anchorIndex + 1)
    if (messages.length >= 2 && !prefix) prefix = messages
  }
  if (!prefix) throw new Error('Not enough recoverable history to compress safely.')
  const session = getSession(args.sessionId)
  if (!session?.provider || !args.model) throw new Error('Bili compression requires the actual model and provider.')
  const source = prefix.map(m => `${m.ref} ${m.role}${m.toolName ? ` ${m.toolName}` : ''}\n${m.text}`).join('\n\n')
  const summary = await callSummarizer('', undefined, buildFullPrompt(source, 2000), [], 120_000, undefined, {
    profile: args.profile, sessionId: `bili-summary-${randomUUID()}`, model: args.model, provider: session.provider, allowHermesFallback: false,
  })
  const result = await publicRequest(binding.proxyUrl, '/__bili/plugin/tool', {
    conversationId: args.sessionId, tool: 'compress', expectedRevision: snapshot.parentRevision,
    args: { content: [{ startId: prefix[0].ref, endId: prefix[prefix.length - 1].ref, summary }] },
  })
  if (typeof result.result !== 'string' || /FAILED|error|nothing to compress/i.test(result.result)) throw new Error(String(result.result || 'Bili compression failed.'))
  const after = await publicRequest<BiliSnapshot>(binding.proxyUrl, `/__bili/plugin/snapshot?conversationId=${encodeURIComponent(args.sessionId)}`)
  validateSnapshot(after, args.sessionId)
  if (typeof after.parentRevision !== 'string' || !after.parentRevision || after.parentRevision === snapshot.parentRevision) {
    throw new Error('Bili did not commit a compression block.')
  }
  if (!await refreshExternalContextUsage({ ...args, owner: binding })) throw new Error('Bili compressed history, but effective usage is unavailable.')
  return { beforeTokens: Number(before.contextTokens || 0), afterTokens: args.state.externalContext!.tokens }
}