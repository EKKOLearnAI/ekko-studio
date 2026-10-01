/**
 * Abort handler — cancels in-progress runs (both API server and CLI bridge).
 */

import type { Server, Socket } from 'socket.io'
import { updateSession, updateSessionStats } from '../../repositories/session-store'
import { logger } from '../../public/logging'
import { chatCodingAgentRunManager as codingAgentRunManager } from '../../public/chat-agent-runtime'
import {
  abortChatEkkoBackgroundTasks as abortGlobalEkkoBackgroundTasks,
  hasChatEkkoBackgroundTasks as hasGlobalEkkoBackgroundTasks,
} from '../../public/chat-agent-runtime'
import { flushBridgePendingToDb } from './bridge-message'
import { flushResponseRunToDb } from './response-stream'
import { replaceState } from './compression'
import { calcAndUpdateUsage } from './usage'
import { finalizeAbortedRunUsage } from './terminal-usage'
import type { QueuedRun, SessionState } from './types'

const ABORT_BRIDGE_SYNC_TIMEOUT_MESSAGE = 'Hermes Agent did not confirm stop before timeout. Local run state was released so you can continue.'

function isBridgeRunSource(source?: string): boolean {
  return source === 'cli' || source === 'global_agent' || source === 'workflow' || source === 'group_chat'
}

function settleInterruptedBackgroundTasks(state: SessionState): Array<Record<string, unknown>> {
  const timestamp = Date.now() / 1000
  const completed: Array<Record<string, unknown>> = []
  state.backgroundTasks = state.backgroundTasks || {}
  for (const [subagentId, task] of Object.entries(state.backgroundTasks)) {
    if (String(task.status || '').toLowerCase() !== 'running') continue
    const snapshot = {
      ...task,
      subagent_id: subagentId,
      status: 'interrupted',
      last_event: 'subagent.complete',
      updated_at: timestamp,
      completed_at: timestamp,
    }
    state.backgroundTasks[subagentId] = snapshot
    completed.push({
      ...snapshot,
      event: 'subagent.complete',
      timestamp,
    })
  }
  return completed
}

export async function handleAbort(
  nsp: ReturnType<Server['of']>,
  socket: Socket,
  sessionId: string,
  sessionMap: Map<string, SessionState>,
  bridge: any,
  runQueuedItem: (socket: Socket, sessionId: string, next: QueuedRun, fallbackProfile?: string) => void,
) {
  let state = sessionMap.get(sessionId)
  const hasCodingAgentRun = codingAgentRunManager.hasSession(sessionId)
  const hasEkkoBackgroundTasks = hasGlobalEkkoBackgroundTasks(sessionId)
  if (!state && (hasCodingAgentRun || hasEkkoBackgroundTasks)) {
    state = { messages: [], isWorking: true, events: [], queue: [], source: 'coding_agent' }
    sessionMap.set(sessionId, state)
  }
  const isCodingAgentRun = state?.source === 'coding_agent' || hasCodingAgentRun || hasEkkoBackgroundTasks
  if (
    (!state?.isWorking && !hasCodingAgentRun && !hasEkkoBackgroundTasks) ||
    (state && !isCodingAgentRun && !state.runId && !state.abortController)
  ) {
    logger.info({ sessionId }, '[chat-run-socket][abort] ignored: no active run')
    if (state) {
      if (state.queueInsertion) {
        emitToSession(nsp, socket, sessionId, 'run.queue_insertion.updated', {
          event: 'run.queue_insertion.updated',
          generation: state.queueInsertion.generation,
          run_id: state.queueInsertion.runId,
          queue_id: state.queueInsertion.queueId,
          runtime: state.queueInsertion.runtime,
          phase: 'cancelled',
          guarantee: state.queueInsertion.guarantee,
          reason: 'hard_stop',
        })
        state.queueInsertion = undefined
      }
      state.isWorking = false
      state.isAborting = false
      state.abortController = undefined
      state.runId = undefined
      state.events = []
    }
    emitToSession(nsp, socket, sessionId, 'abort.completed', {
      event: 'abort.completed',
      synced: false,
      ignored: true,
    })
    return
  }

  const activeState = state
  if (!activeState) return

  if (activeState.queueInsertion) {
    emitToSession(nsp, socket, sessionId, 'run.queue_insertion.updated', {
      event: 'run.queue_insertion.updated',
      generation: activeState.queueInsertion.generation,
      run_id: activeState.queueInsertion.runId,
      queue_id: activeState.queueInsertion.queueId,
      runtime: activeState.queueInsertion.runtime,
      phase: 'cancelled',
      guarantee: activeState.queueInsertion.guarantee,
      reason: 'hard_stop',
    })
    activeState.queueInsertion = undefined
  }

  const runId = activeState.runId
  activeState.isAborting = true
  replaceState(sessionMap, sessionId, 'abort.started', {
    event: 'abort.started',
    run_id: runId,
    graceMs: 5000,
  })
  emitToSession(nsp, socket, sessionId, 'abort.started', {
    event: 'abort.started',
    run_id: runId,
    graceMs: 5000,
  })
  logger.info({ sessionId, runId }, '[chat-run-socket][abort] started')

  // Workflow sessions can be backed either by Hermes bridge runs or by scoped
  // coding-agent runners. Prefer the coding-agent runtime when it owns the
  // session; otherwise source='workflow' is misclassified as a bridge run and
  // bridge.interrupt returns "unknown session" while the coding agent keeps
  // running.
  const shouldAbortThroughBridge = isBridgeRunSource(activeState.source) && !isCodingAgentRun

  // Flush in-memory assistant text to DB before aborting the stream.
  if (shouldAbortThroughBridge) {
    flushBridgePendingToDb(activeState, sessionId)
  } else {
    flushResponseRunToDb(activeState, sessionId)
  }

  if (shouldAbortThroughBridge) {
    let interruptResult: any = null
    try {
      interruptResult = await bridge.interrupt(sessionId, 'Aborted by user', activeState.profile)
      const interruptedDelegationIds = Array.isArray(interruptResult?.background_delegation_ids)
        ? interruptResult.background_delegation_ids.map((value: unknown) => String(value || '').trim()).filter(Boolean)
        : []
      for (const delegationId of interruptedDelegationIds) {
        activeState.backgroundDelegations = activeState.backgroundDelegations || {}
        const previous = activeState.backgroundDelegations[delegationId]
        activeState.backgroundDelegations[delegationId] = {
          delegationId,
          status: 'interrupted',
          profile: previous?.profile || activeState.profile || 'default',
          updatedAt: Date.now(),
        }
        emitToSession(nsp, socket, sessionId, 'delegation.updated', {
          event: 'delegation.updated',
          delegation_id: delegationId,
          status: 'interrupted',
          delivery_status: 'cancelled',
        })
      }
      for (const task of settleInterruptedBackgroundTasks(activeState)) {
        emitToSession(nsp, socket, sessionId, 'subagent.complete', task)
      }
    } catch (err) {
      logger.warn(err, '[chat-run-socket][abort] failed to interrupt CLI bridge for session %s', sessionId)
    }
    try {
      await bridge.goalPause?.(sessionId, 'user-interrupted', activeState.profile)
      activeState.queue = activeState.queue.filter(item => !item.goalContinuation)
    } catch (err) {
      logger.debug(err, '[chat-run-socket][abort] goal pause-on-interrupt skipped for session %s', sessionId)
    }
    if (interruptResult?.synced === false) {
      replaceState(sessionMap, sessionId, 'abort.timeout', {
        event: 'abort.timeout',
        run_id: runId,
        synced: false,
        message: ABORT_BRIDGE_SYNC_TIMEOUT_MESSAGE,
      })
      emitToSession(nsp, socket, sessionId, 'abort.timeout', {
        event: 'abort.timeout',
        run_id: runId,
        synced: false,
        message: ABORT_BRIDGE_SYNC_TIMEOUT_MESSAGE,
      })
      logger.warn({ sessionId, runId }, '[chat-run-socket][abort] CLI bridge interrupt did not sync before timeout')
      try {
        await bridge.destroy?.(sessionId, activeState.profile)
      } catch (err) {
        logger.warn(err, '[chat-run-socket][abort] failed to destroy timed-out CLI bridge session %s', sessionId)
      }
      await markAbortCompleted(nsp, socket, sessionId, runId || 'bridge_abort_timeout', sessionMap, runQueuedItem, false)
      return
    }
  } else if (isCodingAgentRun) {
    activeState.abortController?.abort()
    codingAgentRunManager.stop(sessionId, { reportClosed: false })
    if (hasEkkoBackgroundTasks) {
      await abortGlobalEkkoBackgroundTasks(sessionId)
      for (const task of settleInterruptedBackgroundTasks(activeState)) {
        emitToSession(nsp, socket, sessionId, 'subagent.complete', task)
      }
    }
  } else if (activeState.abortController) {
    activeState.abortController.abort()
  }

  await markAbortCompleted(nsp, socket, sessionId, runId || 'response_stream', sessionMap, runQueuedItem)
}

export async function markAbortCompleted(
  nsp: ReturnType<Server['of']>,
  socket: Socket,
  sessionId: string,
  runId: string,
  sessionMap: Map<string, SessionState>,
  runQueuedItem: (socket: Socket, sessionId: string, next: QueuedRun, fallbackProfile?: string) => void,
  synced = true,
) {
  const state = sessionMap.get(sessionId)
  if (!state) return

  const profile = state.profile
  const runUsage = finalizeAbortedRunUsage(sessionId, runId, state)
  const usagePayload = runUsage ? { run_usage: runUsage, message_id: runUsage.assistantMessageId } : {}
  updateSessionStats(sessionId)
  const emit = (event: string, payload: any) => {
    nsp.to(`session:${sessionId}`).emit(event, { ...payload, session_id: sessionId })
  }
  await calcAndUpdateUsage(sessionId, state, emit, { nativeSource: state.nativeUsageSource })

  state.isWorking = false
  state.isAborting = false
  state.profile = undefined
  state.abortController = undefined
  state.runId = undefined
  state.responseRun = undefined
  state.activeRunMarker = undefined
  state.finalizeRunUsage = undefined
  state.nativeUsageSource = undefined

  // Process queued messages after abort completes
  if (state.queue.length > 0) {
    const next = state.queue.shift()!
    state.isWorking = true
    state.isAborting = false
    state.profile = next.profile || profile
    state.source = next.source
    logger.info('[chat-run-socket][abort] dequeuing queued run for session %s (remaining: %d)', sessionId, state.queue.length)
    replaceState(sessionMap, sessionId, 'abort.completed', {
      event: 'abort.completed',
      run_id: runId,
      synced,
      queue_length: state.queue.length + 1,
      ...usagePayload,
    })
    emitToSession(nsp, socket, sessionId, 'abort.completed', {
      event: 'abort.completed',
      run_id: runId,
      synced,
      queue_length: state.queue.length + 1,
      ...usagePayload,
    })
    emitToSession(nsp, socket, sessionId, 'run.queued', {
      event: 'run.queued',
      queue_length: state.queue.length,
    })
    state.events = []
    runQueuedItem(socket, sessionId, next, profile || 'default')
    return
  }

  try {
    updateSession(sessionId, {
      ended_at: Math.floor(Date.now() / 1000),
      end_reason: 'abort',
    })
  } catch (err) {
    logger.warn(err, '[chat-run-socket][abort] failed to write cancellation end marker for session %s', sessionId)
  }

  state.events = []
  emitToSession(nsp, socket, sessionId, 'abort.completed', {
    event: 'abort.completed',
    run_id: runId,
    synced,
    ...usagePayload,
  })
  logger.info({ sessionId, runId, synced }, '[chat-run-socket][abort] completed')
}

function emitToSession(nsp: ReturnType<Server['of']>, socket: Socket, sessionId: string, event: string, payload: any) {
  const tagged = { ...payload, session_id: sessionId }
  nsp.to(`session:${sessionId}`).emit(event, tagged)
  if (!nsp.adapter.rooms.get(`session:${sessionId}`)?.size && socket.connected) {
    socket.emit(event, tagged)
  }
}
