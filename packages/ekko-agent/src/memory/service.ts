import { createHash, randomUUID } from 'node:crypto'
import { ALWAYS_RECALLED_MEMORY_KINDS } from './recall-policy'
import {
  buildMemoryContextPrompt,
  selectMemoryNodesByTokenBudget,
} from './context'
import {
  DEFAULT_AUTOMATIC_MEMORY_TOKEN_BUDGET,
  DEFAULT_MEMORY_RECENT_MESSAGE_LIMIT,
  DEFAULT_MEMORY_SEARCH_RESULT_LIMIT,
} from '../config'
import { resolveMemoryQuery } from './retrieval'
import { enhanceMemoryRecall } from './jev-recall'
import { reviewMemoryWrites } from './jev-write-review'
import { throwIfMemoryRunAborted } from './jev-policy'
import { canonicalizeMemoryDraft, memoryKindForCanonicalKey, normalizeMemoryNode } from './schema'
import { memoryScopeAllowed, normalizeMemoryScopes, PROFILE_MEMORY_SCOPE } from './scope'
import { stableJson } from './store'
import type {
  MemoryAuditEvent,
  MemoryAuditQuery,
  MemoryBatchInput,
  MemoryBatchOperation,
  MemoryBatchResult,
  MemoryContext,
  MemoryCreateInput,
  MemoryDeleteInput,
  MemoryExpireInput,
  MemoryForgetInput,
  MemoryForgetResult,
  MemoryMessage,
  MemoryMessageListInput,
  MemoryMessageRole,
  MemoryNode,
  MemoryWriteInput,
  MemoryWriteResult,
  MemoryQuery,
  MemoryQueryResult,
  MemoryRuntimeIdentity,
  MemoryWritePolicy,
  MemoryStore,
  MemoryStoreMutation,
  MemoryUpdateInput,
} from './types'

const MEMORY_CANDIDATE_LIMIT = 500
const MAX_MEMORY_SEARCH_RESULTS = 50
export interface MemoryServiceOptions {
  store?: MemoryStore
  enabled?: boolean
  warning?: string
  storageMode?: 'persistent' | 'ephemeral'
  onWarning?: (error: unknown) => void
  recentMessageLimit?: number
  automaticRecallTokenBudget?: number
  searchResultLimit?: number
  /** @deprecated Use searchResultLimit. Automatic recall now uses automaticRecallTokenBudget. */
  nodeLimit?: number
}

export interface MemoryCaptureMessage {
  id?: string
  role: MemoryMessageRole
  content: string
  metadata?: Record<string, unknown>
  createdAt?: string
}

interface PreparedMemoryMutation {
  result: MemoryWriteResult
  mutation?: MemoryStoreMutation
  conflictKey?: string
}

export class MemoryService {
  private readonly store?: MemoryStore
  private enabled: boolean
  private recentMessageLimit: number
  private automaticRecallTokenBudget: number
  private searchResultLimit: number
  private readonly warnings = new Set<string>()
  private readonly storageMode: 'persistent' | 'ephemeral'
  private readonly onWarning?: (error: unknown) => void
  private captureQueue: Promise<void> = Promise.resolve()

  constructor(options: MemoryServiceOptions = {}) {
    this.store = options.store
    this.onWarning = options.onWarning
    this.storageMode = options.storageMode ?? 'persistent'
    this.enabled = options.enabled ?? Boolean(options.store)
    this.recentMessageLimit = options.recentMessageLimit ?? DEFAULT_MEMORY_RECENT_MESSAGE_LIMIT
    this.automaticRecallTokenBudget = positiveInteger(
      options.automaticRecallTokenBudget,
      DEFAULT_AUTOMATIC_MEMORY_TOKEN_BUDGET,
    )
    this.searchResultLimit = memorySearchLimit(
      options.searchResultLimit ?? options.nodeLimit,
      DEFAULT_MEMORY_SEARCH_RESULT_LIMIT,
    )
    if (options.warning) this.warnings.add(options.warning)
  }

  configure(options: Pick<
    MemoryServiceOptions,
    | 'enabled'
    | 'recentMessageLimit'
    | 'automaticRecallTokenBudget'
    | 'searchResultLimit'
  >): void {
    this.enabled = options.enabled ?? Boolean(this.store)
    this.recentMessageLimit = options.recentMessageLimit ?? DEFAULT_MEMORY_RECENT_MESSAGE_LIMIT
    this.automaticRecallTokenBudget = positiveInteger(
      options.automaticRecallTokenBudget,
      DEFAULT_AUTOMATIC_MEMORY_TOKEN_BUDGET,
    )
    this.searchResultLimit = memorySearchLimit(
      options.searchResultLimit,
      DEFAULT_MEMORY_SEARCH_RESULT_LIMIT,
    )
  }

  get isEnabled(): boolean {
    return this.enabled && Boolean(this.store)
  }

  get toolUnavailableReason(): string | undefined {
    return this.storageMode === 'ephemeral'
      ? 'Persistent Ekko memory is unavailable. The active store is ephemeral, so its contents cannot determine whether durable memories exist and memory mutations are disabled for this run.'
      : undefined
  }

  async captureMessages(identity: MemoryRuntimeIdentity, messages: MemoryCaptureMessage[]): Promise<string[]> {
    if (!this.isEnabled || !this.store) return []
    const ids: string[] = []
    try {
      let parentId: string | undefined
      const occurrences = new Map<string, number>()
      for (let index = 0; index < messages.length; index += 1) {
        const message = messages[index]
        const signature = messageSignature(message)
        const occurrence = occurrences.get(signature) || 0
        occurrences.set(signature, occurrence + 1)
        const id = message.id || deterministicMessageId(identity.sessionId, occurrence, message)
        await this.store.appendMessage({
          id,
          sessionId: identity.sessionId,
          parentId,
          role: message.role,
          content: message.content,
          metadata: message.metadata,
          createdAt: message.createdAt || new Date().toISOString(),
        })
        ids.push(id)
        parentId = id
      }
    } catch (error) {
      this.recordWarning(error)
    }
    return ids
  }

  async retrieve(
    identity: MemoryRuntimeIdentity,
    queryText?: string,
    overrides: Partial<MemoryQuery> = {},
  ): Promise<MemoryContext> {
    if (!this.isEnabled || !this.store) return this.disabledContext()
    try {
      const baseQuery = memoryQuery(identity, overrides)
      const recallQueryText = queryText || overrides.queryText
      const hasExactQuery = Boolean(overrides.key || overrides.kinds?.length || overrides.valueJson !== undefined)
      const contextualKinds = automaticRecallKinds(recallQueryText)
      const exactCandidatesPromise = hasExactQuery
        ? this.store.queryNodes({ ...baseQuery, queryText: undefined, limit: MEMORY_CANDIDATE_LIMIT })
        : Promise.all([
            this.store.queryNodes({
              ...baseQuery,
              queryText: undefined,
              kinds: ALWAYS_RECALLED_MEMORY_KINDS,
              limit: MEMORY_CANDIDATE_LIMIT,
            }),
            this.store.queryNodes({
              ...baseQuery,
              queryText: undefined,
              types: ['correction'],
              limit: MEMORY_CANDIDATE_LIMIT,
            }),
            contextualKinds.length
              ? this.store.queryNodes({
                  ...baseQuery,
                  queryText: undefined,
                  kinds: contextualKinds,
                  limit: MEMORY_CANDIDATE_LIMIT,
                })
              : Promise.resolve([]),
          ]).then(groups => uniqueMemoryNodes(groups.flat()))
      const [recentMessages, relevantCandidates, exactCandidates] = await Promise.all([
        this.store.listRecentMessages({ sessionId: identity.sessionId, limit: this.recentMessageLimit }),
        this.store.queryNodes({
          ...baseQuery,
          queryText: recallQueryText,
          limit: MEMORY_CANDIDATE_LIMIT,
        }),
        exactCandidatesPromise,
      ])
      const baseline = resolveMemoryQuery(
        exactCandidates,
        relevantCandidates,
        recallQueryText,
        overrides.limit === undefined ? Number.MAX_SAFE_INTEGER : positiveInteger(overrides.limit, 1),
        new Date(),
      )
      const result = await enhanceMemoryRecall(this.store, baseQuery, recallQueryText, baseline)
      const selection = selectMemoryNodesByTokenBudget(
        [...result.exact, ...result.relevant],
        this.automaticRecallTokenBudget,
      )
      const nodes = selection.nodes
      return {
        recentMessages,
        activeTasks: nodes.filter(node => node.type === 'task'),
        relevantNodes: nodes,
        constraints: nodes.filter(node => node.type === 'constraint' || node.type === 'correction'),
        preferences: nodes.filter(node => node.type === 'preference'),
        usedMemoryIds: nodes.map(node => node.id),
        diagnostics: {
          enabled: true,
          storeStatus: this.warnings.size ? 'degraded' : 'ok',
          warnings: [...this.warnings],
          retrievedNodeCount: nodes.length,
          omittedNodeCount: result.omitted.length + selection.omittedNodeIds.length,
          tokenBudget: this.automaticRecallTokenBudget,
          usedTokens: selection.usedTokens,
        },
      }
    } catch (error) {
      throwIfMemoryRunAborted()
      this.recordWarning(error)
      return this.degradedContext()
    }
  }

  async search(identity: MemoryRuntimeIdentity, query: MemoryQuery): Promise<MemoryQueryResult> {
    if (!this.isEnabled || !this.store) return { exact: [], relevant: [], omitted: [] }
    const scoped = memoryQuery(identity, query)
    const limit = memorySearchLimit(query.limit, this.searchResultLimit)
    const [relevantCandidates, exactCandidates] = await Promise.all([
      this.store.queryNodes({ ...scoped, limit: MEMORY_CANDIDATE_LIMIT }),
      query.key || query.kinds?.length || query.valueJson !== undefined
        ? this.store.queryNodes({ ...scoped, queryText: undefined, limit: MEMORY_CANDIDATE_LIMIT })
        : Promise.resolve([]),
    ])
    return resolveMemoryQuery(
      exactCandidates,
      relevantCandidates,
      query.queryText,
      limit,
    )
  }

  async get(id: string, identity?: Partial<MemoryRuntimeIdentity>): Promise<MemoryNode | undefined> {
    if (!this.isEnabled || !this.store) return undefined
    const node = await this.store.getNode(id)
    return node && isNodeAccessible(node, identity) ? node : undefined
  }

  async list(query: MemoryQuery = {}): Promise<MemoryNode[]> {
    if (!this.isEnabled || !this.store) return []
    return this.store.queryNodes({
      ...query,
      profileId: query.profileId || 'default',
    })
  }

  async create(input: MemoryCreateInput): Promise<MemoryWriteResult> {
    return this.write({
      ...input,
      operation: 'create',
    })
  }

  async update(id: string, input: MemoryUpdateInput): Promise<MemoryWriteResult> {
    return this.write({
      ...input,
      operation: 'update',
      targetId: id,
      node: input.node ?? {},
    })
  }

  async expire(id: string, input: MemoryExpireInput): Promise<MemoryWriteResult> {
    return this.write({
      ...input,
      operation: 'expire',
      targetId: id,
      node: {},
    })
  }

  async delete(id: string, input: MemoryDeleteInput): Promise<MemoryForgetResult> {
    return this.forget({
      ...input,
      id,
    })
  }

  async listMessages(input: MemoryMessageListInput): Promise<MemoryMessage[]> {
    if (!this.isEnabled || !this.store) return []
    if (input.afterMessageId) {
      return this.store.listMessagesAfter({
        sessionId: input.sessionId,
        messageId: input.afterMessageId,
        limit: input.limit,
      })
    }
    return this.store.listRecentMessages({
      sessionId: input.sessionId,
      limit: input.limit ?? this.recentMessageLimit,
    })
  }

  async listAuditEvents(query: MemoryAuditQuery = {}): Promise<MemoryAuditEvent[]> {
    if (!this.isEnabled || !this.store) return []
    return this.store.listAuditEvents({
      ...query,
      profileId: query.profileId || 'default',
    })
  }

  async write(input: MemoryWriteInput): Promise<MemoryWriteResult> {
    if (!this.isEnabled || !this.store) return { accepted: false, reason: 'Memory store is disabled.' }
    const prepared = await this.prepareWrite(input)
    const review = await reviewMemoryWrites(this.store, [prepared.mutation], input.identity)
    if (review) return { accepted: false, reason: review.reason }
    throwIfMemoryRunAborted()
    if (prepared.mutation) await this.store.applyMutations([prepared.mutation])
    return prepared.result
  }

  async applyBatch(input: MemoryBatchInput): Promise<MemoryBatchResult> {
    if (!this.isEnabled || !this.store) {
      return { accepted: false, done: true, results: [], reason: 'Memory store is disabled.' }
    }
    if (!Array.isArray(input.operations) || !input.operations.length) {
      return { accepted: false, done: true, results: [], reason: 'operations must contain at least one memory change.' }
    }

    const prepared: PreparedMemoryMutation[] = []
    const claimedKeys = new Map<string, number>()
    for (const [index, operation] of input.operations.entries()) {
      const mutation = operation.operation === 'delete'
        ? await this.prepareDelete({
            ...operation,
            actor: input.actor,
            identity: input.identity,
          })
        : await this.prepareWrite({
            ...operation,
            actor: input.actor,
            identity: input.identity,
            explicitUserIntent: operation.explicitUserIntent ?? input.explicitUserIntent,
          })
      if (!mutation.result.accepted) {
        return {
          accepted: false,
          done: true,
          results: [],
          failedOperationIndex: index,
          reason: `Operation ${index + 1}: ${mutation.result.reason || 'Memory mutation was rejected.'} No operations were applied.`,
        }
      }
      if (mutation.conflictKey) {
        const previous = claimedKeys.get(mutation.conflictKey)
        if (previous !== undefined) {
          return {
            accepted: false,
            done: true,
            results: [],
            failedOperationIndex: index,
            reason: `Operation ${index + 1} conflicts with operation ${previous + 1}; one atomic batch cannot mutate the same memory slot twice. No operations were applied.`,
          }
        }
        claimedKeys.set(mutation.conflictKey, index)
      }
      prepared.push(mutation)
    }

    const review = await reviewMemoryWrites(this.store, prepared.map(item => item.mutation), input.identity)
    if (review) return { accepted: false, done: true, results: [], failedOperationIndex: review.index, reason: review.reason }
    throwIfMemoryRunAborted()
    try {
      await this.store.applyMutations(prepared.flatMap(item => item.mutation ? [item.mutation] : []))
    } catch (error) {
      return {
        accepted: false,
        done: true,
        results: [],
        reason: `Atomic memory batch failed and was rolled back: ${error instanceof Error ? error.message : String(error)}`,
      }
    }
    return {
      accepted: true,
      done: true,
      results: prepared.map(item => item.result),
    }
  }

  private async prepareWrite(input: MemoryWriteInput): Promise<PreparedMemoryMutation> {
    const store = this.store!
    const actor = input.actor || 'ekko-agent'
    if (input.operation === 'expire') {
      if (!input.targetId) return rejectedMutation('expire requires targetId.')
      const target = await this.get(input.targetId, input.identity)
      if (!target) return rejectedMutation('Memory node not found.')
      const revisionError = validateExpectedRevision(target, input.expectedRevision)
      if (revisionError) return rejectedMutation(revisionError)
      const updatedAt = new Date().toISOString()
      const node: MemoryNode = {
        ...target,
        status: 'expired',
        revision: target.revision + 1,
        updatedAt,
      }
      return {
        result: { accepted: true, nodeId: input.targetId, action: 'expired', node },
        mutation: {
          type: 'status',
          nodeId: input.targetId,
          status: 'expired',
          reason: input.reason,
          actor,
          expectedRevision: input.expectedRevision,
          sessionId: input.identity?.sessionId,
          updatedAt,
        },
        conflictKey: `node:${target.id}`,
      }
    }
    if (input.operation === 'update' || input.operation === 'supersede') {
      if (!input.targetId) return rejectedMutation(`${input.operation} requires targetId.`)
      const target = await this.get(input.targetId, input.identity)
      if (!target || target.status !== 'active') return rejectedMutation('Active memory node not found.')
      const revisionError = validateExpectedRevision(target, input.expectedRevision)
      if (revisionError) return rejectedMutation(revisionError)
      const slot = memoryKindForCanonicalKey(target.key)
      if (!slot) return rejectedMutation('Memory has no server-controlled canonical key.')
      const changesValue = input.node.valueJson !== undefined || input.valuePatch !== undefined || Boolean(input.unsetValueFields?.length)
      if (changesValue && (!input.node.title?.trim() || !input.node.content?.trim())) {
        return rejectedMutation('A value-changing memory update requires title and content derived from its supporting user evidence.')
      }
      const valueJson = applyValuePatch(
        input.node.valueJson === undefined ? target.valueJson : input.node.valueJson,
        input.valuePatch,
        input.unsetValueFields,
      )
      const canonical = canonicalizeMemoryDraft(slot.kind, slot.itemKey, {
        ...target,
        ...input.node,
        id: undefined,
        parentId: target.id,
        supersedesId: target.id,
        profileId: target.profileId,
        scope: target.scope,
        origin: input.identity?.origin || target.origin,
        key: target.key,
        domain: target.domain,
        categoryPath: target.categoryPath,
        type: target.type,
        valueJson,
        revision: target.revision + 1,
        status: 'active',
        sourceMessageIds: uniqueValues([...target.sourceMessageIds, ...(input.node.sourceMessageIds || [])]),
        createdAt: undefined,
      })
      if (!canonical.accepted) return rejectedMutation(canonical.reason)
      const normalized = normalizeMemoryNode({
        draft: canonical.draft,
        identity: writableIdentityForNode(input.identity, target),
        explicitUserIntent: input.explicitUserIntent,
      })
      if (!normalized.accepted) return rejectedMutation(normalized.reason)
      const now = new Date().toISOString()
      const node: MemoryNode = { id: randomUUID(), ...normalized.node, updatedAt: now }
      return {
        result: { accepted: true, nodeId: node.id, action: 'updated', node },
        mutation: {
          type: 'supersede',
          oldNodeId: target.id,
          newNode: node,
          reason: input.reason,
          actor,
          sessionId: input.identity?.sessionId,
        },
        conflictKey: `node:${target.id}`,
      }
    }

    const canonical = canonicalizeMemoryDraft(input.kind, input.itemKey, {
      ...input.node,
      ...(input.scope ? { scope: input.scope } : {}),
      ...(input.identity?.origin ? { origin: input.identity.origin } : {}),
    })
    if (!canonical.accepted) return rejectedMutation(canonical.reason)
    const normalized = normalizeMemoryNode({
      draft: canonical.draft,
      identity: input.identity,
      explicitUserIntent: input.explicitUserIntent,
    })
    if (!normalized.accepted) return rejectedMutation(normalized.reason)
    const now = new Date().toISOString()
    let node: MemoryNode = { id: randomUUID(), ...normalized.node, revision: 1, updatedAt: now }
    const existing = (await store.queryNodes({
      ...memoryQuery(input.identity as MemoryRuntimeIdentity, {
        key: node.key,
        scopes: [node.scope || PROFILE_MEMORY_SCOPE],
        includeExpired: false,
      }),
      limit: 2,
    }))[0]
    if (existing && stableJson(existing.valueJson) === stableJson(node.valueJson) && existing.content === node.content) {
      return { result: { accepted: true, nodeId: existing.id, action: 'noop', node: existing } }
    }
    if (existing) {
      node = {
        ...node,
        revision: existing.revision + 1,
        parentId: existing.id,
        supersedesId: existing.id,
        sourceMessageIds: uniqueValues([...existing.sourceMessageIds, ...node.sourceMessageIds]),
      }
      return {
        result: { accepted: true, nodeId: node.id, action: 'updated', node },
        mutation: {
          type: 'supersede',
          oldNodeId: existing.id,
          newNode: node,
          reason: input.reason,
          actor,
          sessionId: input.identity?.sessionId,
        },
        conflictKey: `node:${existing.id}`,
      }
    }

    return {
      result: { accepted: true, nodeId: node.id, action: 'created', node },
      mutation: {
        type: 'upsert',
        node,
        audit: {
          eventType: 'create',
          sessionId: input.identity?.sessionId,
          profileId: node.profileId,
          actor,
          reason: input.reason,
          payload: { type: node.type, key: node.key },
        },
      },
      conflictKey: `slot:${memoryNodeSlotKey(node)}`,
    }
  }

  private async prepareDelete(
    input: Extract<MemoryBatchOperation, { operation: 'delete' }> & {
      actor?: string
      identity?: Partial<MemoryRuntimeIdentity>
    },
  ): Promise<PreparedMemoryMutation> {
    const target = await this.get(input.targetId, input.identity)
    if (!target) return rejectedMutation('Memory node not found.')
    const revisionError = validateExpectedRevision(target, input.expectedRevision)
    if (revisionError) return rejectedMutation(revisionError)
    const mode = input.mode || 'soft'
    const updatedAt = new Date().toISOString()
    const node: MemoryNode = mode === 'soft'
      ? {
          ...target,
          status: 'deleted',
          revision: target.revision + 1,
          updatedAt,
        }
      : target
    return {
      result: { accepted: true, nodeId: target.id, action: 'deleted', node },
      mutation: {
        type: 'delete',
        nodeId: target.id,
        mode,
        reason: input.reason,
        actor: input.actor || 'ekko-agent',
        expectedRevision: input.expectedRevision,
        sessionId: input.identity?.sessionId,
        updatedAt,
      },
      conflictKey: `node:${target.id}`,
    }
  }

  async forget(input: MemoryForgetInput): Promise<MemoryForgetResult> {
    const mode = input.mode || 'soft'
    if (!this.isEnabled || !this.store) {
      return { deletedIds: [], mode, reason: 'Memory store is disabled.' }
    }
    const hasBroadSelector = Boolean(
      input.domain ||
      input.categoryPathPrefix?.length ||
      input.type ||
      input.key ||
      input.valueJson !== undefined,
    )
    if (
      !input.all &&
      !input.targets?.length &&
      !input.id &&
      !hasBroadSelector
    ) {
      return { deletedIds: [], mode, reason: 'A memory selector is required.' }
    }
    const selectorCount = Number(input.all === true) +
      Number(Boolean(input.targets?.length)) +
      Number(Boolean(input.id)) +
      Number(hasBroadSelector)
    if (selectorCount > 1) {
      return { deletedIds: [], mode, reason: 'Use exactly one memory selector: all, targets, id, or a broad query.' }
    }
    const exactTargets = input.targets?.length
      ? [...new Map(input.targets.map(target => [target.id, target])).values()]
      : undefined
    const expectedRevisions = new Map<string, number>()
    let candidates: MemoryNode[] = []
    if (exactTargets) {
      const resolved = await Promise.all(exactTargets.map(async target => ({
        target,
        node: await this.get(target.id, input.identity),
      })))
      const missing = resolved.find(item => !item.node)
      if (missing) return { deletedIds: [], mode, reason: `Memory node not found: ${missing.target.id}` }
      candidates = resolved.map(item => item.node!)
      for (const { target, node } of resolved) {
        const revisionError = validateExpectedRevision(node!, target.expectedRevision)
        if (revisionError) return { deletedIds: [], mode, reason: revisionError }
        expectedRevisions.set(target.id, target.expectedRevision)
      }
    } else if (input.id) {
      candidates = [await this.get(input.id, input.identity)].filter((node): node is MemoryNode => Boolean(node))
    } else {
      const baseQuery = memoryQuery(input.identity as MemoryRuntimeIdentity, {
        domain: input.all ? undefined : input.domain,
        categoryPathPrefix: input.all ? undefined : input.categoryPathPrefix,
        types: input.all || !input.type ? undefined : [input.type],
        key: input.all ? undefined : input.key,
        valueJson: input.all ? undefined : input.valueJson,
        includeExpired: true,
      })
      for (let offset = 0; ; offset += 500) {
        const page = await this.store.queryNodes({ ...baseQuery, limit: 500, offset })
        candidates.push(...page)
        if (page.length < 500) break
      }
    }
    if (!candidates.length) return { deletedIds: [], mode, reason: 'No matching memory was found.' }
    if (input.id) {
      const revisionError = validateExpectedRevision(candidates[0], input.expectedRevision)
      if (revisionError) return { deletedIds: [], mode, reason: revisionError }
    }
    try {
      await this.store.applyMutations(candidates.map(node => ({
        type: 'delete' as const,
        nodeId: node.id,
        mode,
        reason: input.reason,
        actor: input.actor || 'ekko-agent',
        expectedRevision: expectedRevisions.get(node.id) ?? (input.id ? input.expectedRevision : node.revision),
        sessionId: input.identity?.sessionId,
      })))
    } catch (error) {
      return {
        deletedIds: [],
        mode,
        reason: `Atomic memory deletion failed and was rolled back: ${error instanceof Error ? error.message : String(error)}`,
      }
    }
    const deletedIds = candidates.map(node => node.id)
    return {
      deletedIds,
      deletedMemories: candidates.filter(node => deletedIds.includes(node.id)).map(node => ({
        ...node,
        status: mode === 'soft' ? 'deleted' : node.status,
        revision: mode === 'soft' ? node.revision + 1 : node.revision,
      })),
      mode,
    }
  }

  scheduleCapture(
    identity: MemoryRuntimeIdentity,
    messages: MemoryCaptureMessage[],
    writePolicy: MemoryWritePolicy = 'automatic',
  ): void {
    if (!this.isEnabled || !this.store) return
    if (writePolicy === 'explicit-only' && !hasExplicitMemoryIntent(messages)) return
    this.captureQueue = this.captureQueue
      .then(() => this.captureMessages(identity, messages).then(() => undefined))
      .catch(error => this.recordWarning(error))
  }

  async drain(): Promise<void> {
    await this.captureQueue
  }

  close(): void {
    this.store?.close()
  }

  contextPrompt(context: MemoryContext): string {
    return buildMemoryContextPrompt(context)
  }

  private disabledContext(): MemoryContext {
    return emptyContext({
      enabled: false,
      storeStatus: 'disabled',
      warnings: [...this.warnings],
      retrievedNodeCount: 0,
      omittedNodeCount: 0,
    })
  }

  private degradedContext(): MemoryContext {
    return emptyContext({
      enabled: true,
      storeStatus: 'degraded',
      warnings: [...this.warnings],
      retrievedNodeCount: 0,
      omittedNodeCount: 0,
    })
  }

  private recordWarning(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error)
    this.warnings.add(message)
    try {
      this.onWarning?.(error)
    } catch {
      // Diagnostics must never replace the underlying memory degradation path.
    }
  }
}

function memoryQuery(identity: Partial<MemoryRuntimeIdentity> | undefined, overrides: Partial<MemoryQuery>): MemoryQuery {
  return {
    ...overrides,
    profileId: identity?.profileId || 'default',
    scopes: overrides.scopes ?? normalizeMemoryScopes(identity?.recallScopes),
  }
}

function positiveInteger(value: number | undefined, fallback: number): number {
  if (!Number.isFinite(value)) return fallback
  return Math.max(1, Math.floor(Number(value)))
}

function memorySearchLimit(value: number | undefined, fallback: number): number {
  return Math.min(positiveInteger(value, fallback), MAX_MEMORY_SEARCH_RESULTS)
}

function automaticRecallKinds(queryText: string | undefined): NonNullable<MemoryQuery['kinds']> {
  const text = String(queryText || '').normalize('NFKC').toLowerCase()
  if (!text) return []
  const kinds = new Set<NonNullable<MemoryQuery['kinds']>[number]>()
  for (const rule of AUTOMATIC_RECALL_KIND_RULES) {
    if (rule.pattern.test(text)) {
      for (const kind of rule.kinds) kinds.add(kind)
    }
  }
  return [...kinds]
}

function uniqueMemoryNodes(nodes: MemoryNode[]): MemoryNode[] {
  const seen = new Set<string>()
  return nodes.filter(node => {
    if (seen.has(node.id)) return false
    seen.add(node.id)
    return true
  })
}

const AUTOMATIC_RECALL_KIND_RULES: Array<{
  kinds: NonNullable<MemoryQuery['kinds']>
  pattern: RegExp
}> = [
  { kinds: ['profile_name'], pattern: /\bname\b|姓名|名字|叫什么|称呼/ },
  { kinds: ['home_location'], pattern: /\bhome\b|\blocation\b|\bcity\b|\bwhere (?:do|does) .{0,40}\blive\b|常住|住在|家住|城市|所在地/ },
  { kinds: ['occupation'], pattern: /\bjob\b|\boccupation\b|\bcareer\b|\bemployer\b|职业|上班|任职|工作单位|我的工作/ },
  { kinds: ['timezone_preference'], pattern: /\btimezone\b|\btime zone\b|时区|当地时间/ },
  { kinds: ['general_preference'], pattern: /\bprefer(?:ence|s|red)?\b|\bmy preferences?\b|偏好|喜欢|习惯用/ },
  { kinds: ['workflow_preference'], pattern: /\bworkflow\b|\bprocess\b|工作流|流程|协作方式/ },
  { kinds: ['tool_preference'], pattern: /\btool(?:ing|s)?\b|\beditor\b|\bide\b|工具|编辑器/ },
  { kinds: ['personal_relationship'], pattern: /\brelationship\b|\bfamily\b|\bfriend\b|家人|家庭|朋友|关系/ },
  { kinds: ['habit_routine'], pattern: /\bhabit\b|\broutine\b|\bdaily\b|\bweekly\b|习惯|日常|每天|每周/ },
  { kinds: ['environment_fact'], pattern: /\benvironment\b|\bdevice\b|\bmachine\b|\bos\b|环境|设备|电脑|系统/ },
  { kinds: ['project_context'], pattern: /\bproject\b|\brepository\b|\brepo\b|\bcodebase\b|项目|代码库|仓库/ },
  { kinds: ['long_term_goal'], pattern: /\bgoal\b|\blong[- ]term\b|长期目标|目标|规划/ },
  { kinds: ['durable_decision'], pattern: /\bdecision\b|\bdecide(?:d)?\b|决定|决策|选定/ },
  { kinds: ['food_avoidance'], pattern: /\bfood\b|\beat\b|\bdish\b|\bcook\b|\bmenu\b|\brestaurant\b|\ballerg(?:y|ic)\b|吃|菜|餐|食物|忌口|过敏|做饭|烹饪/ },
]

function deterministicMessageId(sessionId: string, occurrence: number, message: MemoryCaptureMessage): string {
  return createHash('sha256')
    .update(sessionId)
    .update('\0')
    .update(String(occurrence))
    .update('\0')
    .update(message.role)
    .update('\0')
    .update(message.content)
    .update('\0')
    .update(stableJson(message.metadata || {}))
    .digest('hex')
}

function messageSignature(message: MemoryCaptureMessage): string {
  return createHash('sha256')
    .update(message.role)
    .update('\0')
    .update(message.content)
    .update('\0')
    .update(stableJson(message.metadata || {}))
    .digest('hex')
}

export function hasExplicitMemoryIntent(messages: MemoryCaptureMessage[]): boolean {
  const latestUser = [...messages].reverse().find(message => message.role === 'user')?.content || ''
  return /(?:记住|记下来|保存(?:到|为)?记忆|以后(?:都|请)?|从现在起|更正.{0,8}(?:记忆|偏好|信息)|更新.{0,8}(?:记忆|偏好|信息)|remember|from now on|update my memory)/i.test(latestUser)
    || hasExplicitMemoryForgetIntent(messages)
}

export function hasExplicitMemoryForgetIntent(messages: MemoryCaptureMessage[]): boolean {
  const latestUser = [...messages].reverse().find(message => message.role === 'user')?.content || ''
  const chineseIntent = /(?:忘掉|忘记|别记|不再记)|(?:删除|清掉|清除|清空)(?:掉|一下)?(?:(?:我(?:的)?|你(?:的|(?:所)?(?:保存|记住|记录)的)?|已保存(?:的)?|这(?:条|些)?|(?:所有|全部)(?:的)?)){0,3}(?:记忆|偏好|记录)|(?:删除|清掉|清除|清空)(?:掉|一下)?(?:我的|关于我的)(?:个人)?信息/giu
  const englishIntent = /\bforget\b|\b(?:delete|clear|erase)\s+(?:that|this|my|the|all|every).{0,20}\b(?:memories|memory|preference|record)s?\b/giu
  return hasNonNegatedIntent(latestUser, chineseIntent)
    || hasNonNegatedIntent(latestUser, englishIntent)
}

export function hasExplicitMemoryForgetAllIntent(messages: MemoryCaptureMessage[]): boolean {
  const latestUser = [...messages].reverse().find(message => message.role === 'user')?.content || ''
  const chineseForgetAll = /(?:忘掉|忘记|删除|清掉|清除|清空)/.test(latestUser)
    && /(?:所有|全部)/.test(latestUser)
    && /(?:记忆|偏好|记录|信息)/.test(latestUser)
  return chineseForgetAll
    || /(?:forget|delete|clear|erase).{0,16}(?:all|every).{0,16}(?:memories|memory|preferences|records)/i.test(latestUser)
}

function rejectedMutation(reason: string): PreparedMemoryMutation {
  return { result: { accepted: false, reason } }
}

function memoryNodeSlotKey(node: MemoryNode): string {
  return stableJson([node.profileId, node.scope || PROFILE_MEMORY_SCOPE, node.key])
}

function hasNonNegatedIntent(text: string, pattern: RegExp): boolean {
  for (const match of text.matchAll(pattern)) {
    const prefix = text.slice(Math.max(0, match.index! - 12), match.index)
    if (!/(?:不要|别|禁止|不得|不能|不可|无需|无须|切勿|do\s+not|don't|never)\s*$/iu.test(prefix)) return true
  }
  return false
}

function validateExpectedRevision(node: MemoryNode, expectedRevision: number | undefined): string | undefined {
  if (!Number.isInteger(expectedRevision) || Number(expectedRevision) < 1) {
    return 'Mutation requires expectedRevision from memory_search, memory_get, or the injected memory card.'
  }
  if (node.revision !== expectedRevision) {
    return `Memory revision mismatch: expected ${expectedRevision}, current ${node.revision}. Search again before mutating.`
  }
  return undefined
}

function applyValuePatch(
  base: unknown,
  patch: Record<string, unknown> | undefined,
  unsetFields: string[] | undefined,
): unknown {
  if (!patch && !unsetFields?.length) return base
  if (!base || typeof base !== 'object' || Array.isArray(base)) {
    return patch ? { ...patch } : base
  }
  const output = { ...(base as Record<string, unknown>), ...(patch || {}) }
  for (const field of unsetFields || []) delete output[field]
  return output
}

function uniqueValues(values: string[]): string[] {
  return [...new Set(values.map(value => value.trim()).filter(Boolean))]
}

function emptyContext(diagnostics: MemoryContext['diagnostics']): MemoryContext {
  return {
    recentMessages: [],
    activeTasks: [],
    relevantNodes: [],
    constraints: [],
    preferences: [],
    usedMemoryIds: [],
    diagnostics,
  }
}

function isNodeAccessible(node: MemoryNode, identity: Partial<MemoryRuntimeIdentity> | undefined): boolean {
  if ((identity?.profileId || 'default') !== node.profileId) return false
  if (identity?.recallScopes?.length) return memoryScopeAllowed(node.scope, identity.recallScopes)
  // Session-bound callers are runtime actors and inherit the safe profile-only
  // default. Sessionless callers are administrative APIs that already own the
  // profile and need to inspect scoped cards for maintenance.
  return !identity?.sessionId || memoryScopeAllowed(node.scope, [PROFILE_MEMORY_SCOPE])
}

function writableIdentityForNode(
  identity: Partial<MemoryRuntimeIdentity> | undefined,
  node: MemoryNode,
): Partial<MemoryRuntimeIdentity> {
  if (identity?.writeScopes?.length) return identity
  return {
    ...identity,
    writeScopes: [node.scope || PROFILE_MEMORY_SCOPE],
    defaultWriteScope: node.scope || PROFILE_MEMORY_SCOPE,
  }
}
