import type { Server, Socket } from 'socket.io'
import { authenticateUserToken, isAuthEnabled, type AuthenticatedUser } from '../public/auth'
import { userCanAccessProfile } from '../public/users'
import { logger } from '../public/logging'
import { configureRunChatPetObserver } from '../public/pet-events'

const PET_STATE_NAMESPACE = '/pet-state'
const DEFAULT_PROFILE = 'default'

export interface PetActivity {
  busy?: boolean
  reasoning?: boolean
  toolRunning?: boolean
  awaitingInput?: boolean
  error?: boolean
  justCompleted?: boolean
  celebrate?: boolean
}

export type PetState = 'idle' | 'run' | 'review' | 'failed' | 'wave' | 'jump' | 'waiting'

export interface PetStateSnapshot {
  profile: string
  state: PetState
  activity: PetActivity
  updatedAt: number
  sessionId?: string
  runId?: string
  activeTools: string[]
  awaiting: Array<'approval' | 'clarify' | 'input'>
}

export interface PetActivityUpdate {
  profile?: string | null
  activity: PetActivity
  replace?: boolean
}

function normalizeProfile(value: unknown): string {
  const profile = typeof value === 'string' ? value.trim() : ''
  return profile || DEFAULT_PROFILE
}

export function derivePetState(activity: PetActivity): PetState {
  if (activity.error) return 'failed'
  if (activity.celebrate) return 'jump'
  if (activity.justCompleted) return 'wave'
  if (activity.awaitingInput) return 'waiting'
  if (activity.toolRunning) return 'run'
  if (activity.reasoning) return 'review'
  if (activity.busy) return 'run'
  return 'idle'
}

function canAccessProfile(user: AuthenticatedUser | undefined, profile: string): boolean {
  if (!user || user.role === 'super_admin') return true
  return userCanAccessProfile(user.id, profile)
}

class PetStateRegistry {
  private snapshots = new Map<string, PetStateSnapshot>()
  private runProfiles = new Map<string, string>()
  private flashTimers = new Map<string, ReturnType<typeof setTimeout>>()

  get(profile: string): PetStateSnapshot {
    const normalized = normalizeProfile(profile)
    return this.snapshots.get(normalized) ?? {
      profile: normalized,
      state: 'idle',
      activity: {},
      updatedAt: Date.now(),
      activeTools: [],
      awaiting: [],
    }
  }

  update(update: PetActivityUpdate): PetStateSnapshot {
    const profile = normalizeProfile(update.profile)
    const previous = this.get(profile)
    const activity = update.replace ? { ...update.activity } : { ...previous.activity, ...update.activity }
    const snapshot: PetStateSnapshot = {
      ...previous,
      profile,
      state: derivePetState(activity),
      activity,
      updatedAt: Date.now(),
    }
    this.snapshots.set(profile, snapshot)
    return snapshot
  }

  applyRunChatEvent(profileInput: string | null | undefined, event: string, payload: Record<string, unknown>): PetStateSnapshot {
    const sessionId = stringValue(payload.session_id)
    const runId = stringValue(payload.run_id)
    const knownProfile = sessionId ? this.runProfiles.get(sessionId) : ''
    const profile = normalizeProfile(profileInput || knownProfile)
    if (sessionId) this.runProfiles.set(sessionId, profile)

    const previous = this.get(profile)
    const tools = new Set(previous.activeTools)
    const awaiting = new Set(previous.awaiting)
    let activity: PetActivity = { ...previous.activity }

    switch (event) {
      case 'run.queued':
      case 'run.started':
        activity = { busy: true }
        awaiting.clear()
        tools.clear()
        break
      case 'tool.started':
        activity.busy = true
        activity.toolRunning = true
        tools.add(stringValue(payload.tool_name) || stringValue(payload.toolName) || stringValue(payload.name) || 'tool')
        break
      case 'tool.completed':
      case 'tool.failed': {
        const toolName = stringValue(payload.tool_name) || stringValue(payload.toolName) || stringValue(payload.name)
        if (toolName) tools.delete(toolName)
        else tools.clear()
        activity.toolRunning = tools.size > 0
        break
      }
      case 'reasoning.delta':
      case 'thinking.delta':
      case 'reasoning.available':
      case 'moa.aggregating':
        activity.busy = true
        activity.reasoning = true
        break
      case 'message.delta':
        activity.busy = true
        activity.reasoning = false
        break
      case 'approval.requested':
        awaiting.add('approval')
        activity.busy = false
        activity.awaitingInput = true
        activity.reasoning = false
        activity.toolRunning = false
        break
      case 'clarify.requested':
        awaiting.add('clarify')
        activity.busy = false
        activity.awaitingInput = true
        activity.reasoning = false
        activity.toolRunning = false
        break
      case 'approval.resolved':
        awaiting.delete('approval')
        activity.awaitingInput = awaiting.size > 0
        break
      case 'clarify.resolved':
        awaiting.delete('clarify')
        activity.awaitingInput = awaiting.size > 0
        break
      case 'run.completed':
        activity = { justCompleted: true }
        awaiting.clear()
        tools.clear()
        this.scheduleFlashClear(profile, 'justCompleted')
        break
      case 'run.failed':
        activity = { error: true }
        awaiting.clear()
        tools.clear()
        this.scheduleFlashClear(profile, 'error')
        break
      case 'abort.completed':
        activity = {}
        awaiting.clear()
        tools.clear()
        break
      default:
        break
    }

    const snapshot: PetStateSnapshot = {
      profile,
      sessionId: sessionId || previous.sessionId,
      runId: runId || previous.runId,
      state: derivePetState(activity),
      activity,
      updatedAt: Date.now(),
      activeTools: Array.from(tools),
      awaiting: Array.from(awaiting),
    }
    this.snapshots.set(profile, snapshot)
    return snapshot
  }

  private scheduleFlashClear(profile: string, key: 'error' | 'justCompleted'): void {
    const existing = this.flashTimers.get(profile)
    if (existing) clearTimeout(existing)
    const timer = setTimeout(() => {
      const current = this.get(profile)
      if (!current.activity[key]) return
      const activity = { ...current.activity, [key]: false }
      const snapshot: PetStateSnapshot = {
        ...current,
        state: derivePetState(activity),
        activity,
        updatedAt: Date.now(),
      }
      this.snapshots.set(profile, snapshot)
      activeServer?.broadcast(snapshot)
    }, 1600)
    this.flashTimers.set(profile, timer)
  }
}

const registry = new PetStateRegistry()
let activeServer: PetStateSocketServer | null = null

export function getPetStateSnapshot(profile?: string | null): PetStateSnapshot {
  return registry.get(normalizeProfile(profile))
}

export function publishPetActivity(update: PetActivityUpdate): PetStateSnapshot {
  const snapshot = registry.update(update)
  activeServer?.broadcast(snapshot)
  return snapshot
}

export function observeRunChatPetEvent(profile: string | null | undefined, event: string, payload: Record<string, unknown>): PetStateSnapshot {
  const snapshot = registry.applyRunChatEvent(profile, event, payload)
  activeServer?.broadcast(snapshot)
  return snapshot
}

configureRunChatPetObserver(observeRunChatPetEvent)

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

export class PetStateSocketServer {
  private readonly nsp: ReturnType<Server['of']>

  constructor(io: Server) {
    this.nsp = io.of(PET_STATE_NAMESPACE)
    activeServer = this
  }

  init(): void {
    this.nsp.use(this.authMiddleware.bind(this))
    this.nsp.on('connection', this.onConnection.bind(this))
    logger.info('[pet-state-socket] Socket.IO ready at /pet-state')
  }

  broadcast(snapshot: PetStateSnapshot): void {
    this.nsp.to(this.profileRoom(snapshot.profile)).emit('pet.state.updated', snapshot)
  }

  private async authMiddleware(socket: Socket, next: (err?: Error) => void): Promise<void> {
    if (!await isAuthEnabled()) {
      next()
      return
    }

    const token = socket.handshake.auth?.token as string | undefined
    const user = await authenticateUserToken(token || '')
    if (!user) {
      next(new Error('Authentication failed'))
      return
    }

    const profile = normalizeProfile(socket.handshake.query?.profile)
    if (!canAccessProfile(user, profile)) {
      next(new Error('Profile access denied'))
      return
    }

    socket.data.user = user
    socket.data.profile = profile
    next()
  }

  private onConnection(socket: Socket): void {
    const profile = normalizeProfile(socket.data.profile)
    void socket.join(this.profileRoom(profile))
    socket.emit('pet.state.snapshot', registry.get(profile))

    socket.on('pet.state.get', (ack?: (snapshot: PetStateSnapshot) => void) => {
      if (typeof ack === 'function') {
        ack(registry.get(profile))
      }
    })
  }

  private profileRoom(profile: string): string {
    return `profile:${normalizeProfile(profile)}`
  }
}
