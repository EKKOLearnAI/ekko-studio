import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { chmod, mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { BrowserManager } from './browser-manager'
import {
  DEFAULT_BROWSER_TEXT_READ_LIMIT,
  MAX_BROWSER_TEXT_READ_LIMIT,
  type BrowserBrokerDescriptor,
  type BrowserInteractAction,
  type BrowserTextMode,
} from './browser-types'
import { publicBrowserUrl, redactBrowserText } from './browser-url'
import { snapshotOptions } from './browser-snapshot'

interface BrokerRequest {
  method?: unknown
  params?: unknown
  operation_id?: unknown
  run_metadata?: unknown
  client_pid?: unknown
}

interface Lease {
  clientId: string
  expiresAt: number
}

interface BrokerClient {
  token: string
  lastSeenAt: number
  pid?: number
}

const BODY_LIMIT = 1024 * 1024
const LEASE_TTL_MS = 60_000
const STOP_TIMEOUT_MS = 2_000

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function requiredString(value: unknown, name: string): string {
  const result = typeof value === 'string' ? value.trim() : ''
  if (!result || result.length > 4096) throw new Error(`${name} is required`)
  return result
}

function boundedInteger(value: unknown, name: string, fallback: number, minimum: number, maximum: number): number {
  if (value === undefined) return fallback
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`)
  }
  return value
}

function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left)
  const b = Buffer.from(right)
  return a.length === b.length && timingSafeEqual(a, b)
}

export class BrowserBroker {
  private server: Server | null = null
  private token = ''
  private descriptor: BrowserBrokerDescriptor | null = null
  private readonly leases = new Map<string, Lease>()
  private readonly leaseTimers = new Map<string, NodeJS.Timeout>()
  private readonly clients = new Map<string, BrokerClient>()
  private readonly queues = new Map<string, Promise<void>>()
  private readonly tabGenerations = new Map<string, number>()
  private activeOperations = 0
  private readonly capacityWaiters: Array<() => void> = []

  constructor(private readonly manager: BrowserManager, private readonly brokerRoot: string) {}

  async start(): Promise<BrowserBrokerDescriptor> {
    if (this.descriptor) return this.descriptor
    this.token = randomBytes(32).toString('base64url')
    const server = createServer((request, response) => { void this.handleHttp(request, response) })
    this.server = server
    server.on('clientError', (_error, socket) => socket.destroy())
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject)
        server.listen(0, '127.0.0.1', () => resolve())
      })
      const address = server.address()
      if (!address || typeof address === 'string') throw new Error('Browser Broker did not bind a TCP port')
      this.descriptor = {
        schema: 1,
        desktopPid: process.pid,
        endpoint: `http://127.0.0.1:${address.port}/v1`,
        token: this.token,
        instanceId: randomUUID(),
        createdAt: new Date().toISOString(),
      }
      await this.writeDescriptor(this.descriptor)
      return this.descriptor
    } catch (error) {
      this.server = null
      this.descriptor = null
      this.token = ''
      if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()))
      await rm(join(this.brokerRoot, 'broker.json'), { force: true }).catch(() => undefined)
      throw error
    }
  }

  async stop(timeoutMs = STOP_TIMEOUT_MS): Promise<void> {
    this.revokeAll()
    for (const timer of this.leaseTimers.values()) clearTimeout(timer)
    this.leaseTimers.clear()
    this.leases.clear()
    this.clients.clear()
    this.queues.clear()
    this.tabGenerations.clear()
    const server = this.server
    this.server = null
    this.descriptor = null
    this.token = ''
    await new Promise<void>((resolve) => {
      if (!server) {
        resolve()
        return
      }
      let settled = false
      const finish = () => {
        if (settled) return
        settled = true
        clearTimeout(timeout)
        resolve()
      }
      const timeout = setTimeout(() => {
        server.closeAllConnections?.()
        finish()
      }, Math.max(0, timeoutMs))
      server.close(finish)
      server.closeIdleConnections?.()
    })
    await rm(join(this.brokerRoot, 'broker.json'), { force: true }).catch(() => undefined)
  }

  revokeTab(tabId: string): void {
    this.tabGenerations.set(tabId, (this.tabGenerations.get(tabId) || 0) + 1)
    const timer = this.leaseTimers.get(tabId)
    if (timer) clearTimeout(timer)
    this.leaseTimers.delete(tabId)
    this.leases.delete(tabId)
    if (this.manager.state().tabs.some(tab => tab.id === tabId)) this.manager.cancelAgentOperation(tabId)
  }

  revokeAll(): void {
    const tabIds = new Set([...this.leases.keys(), ...this.queues.keys()])
    for (const tabId of tabIds) this.revokeTab(tabId)
    this.leases.clear()
  }

  private async handleHttp(request: IncomingMessage, response: ServerResponse): Promise<void> {
    response.setHeader('Content-Type', 'application/json; charset=utf-8')
    response.setHeader('Cache-Control', 'no-store')
    try {
      if (request.method !== 'POST' || (request.url !== '/v1' && request.url !== '/v1/session')) return this.send(response, 404, { error: 'Not found' })
      if (request.headers.origin) return this.send(response, 403, { error: 'Browser origins are not accepted' })
      this.cleanupExpiredLeases()
      const authorization = String(request.headers.authorization || '')
      const providedToken = authorization.startsWith('Bearer ') ? authorization.slice(7) : ''
      if (request.url === '/v1/session') {
        if (!providedToken || !safeEqual(providedToken, this.token)) return this.send(response, 401, { error: 'Unauthorized' })
        const registration = await this.readBody(request)
        const clientPid = registration.client_pid
        if (clientPid !== undefined && (typeof clientPid !== 'number' || !Number.isSafeInteger(clientPid) || clientPid <= 0)) {
          throw new Error('client_pid must be a positive integer')
        }
        const clientId = randomUUID()
        const clientToken = randomBytes(32).toString('base64url')
        this.clients.set(clientId, { token: clientToken, lastSeenAt: Date.now(), ...(clientPid === undefined ? {} : { pid: clientPid }) })
        return this.send(response, 200, { client_id: clientId, session_token: clientToken })
      }
      if (!providedToken) return this.send(response, 401, { error: 'Unauthorized' })
      const clientId = requiredString(request.headers['x-hermes-browser-client'], 'x-hermes-browser-client').slice(0, 200)
      const client = this.clients.get(clientId)
      if (!client || !providedToken || !safeEqual(providedToken, client.token)) return this.send(response, 401, { error: 'Unauthorized' })
      client.lastSeenAt = Date.now()
      const body = await this.readBody(request)
      const method = requiredString(body.method, 'method')
      const params = asObject(body.params)
      const operationId = typeof body.operation_id === 'string' && body.operation_id.trim()
        ? body.operation_id.trim().slice(0, 200)
        : randomUUID()
      const tabId = typeof params.tab_id === 'string' ? params.tab_id.trim() : ''
      const tabGeneration = tabId ? this.tabGenerations.get(tabId) || 0 : 0
      const result = tabId
        ? await this.queued(tabId, () => this.execute(clientId, method, params, operationId, tabGeneration))
        : await this.withCapacity(() => this.execute(clientId, method, params, operationId, tabGeneration))
      this.send(response, 200, { operation_id: operationId, result })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.send(response, /lease|control|cancel|takeover/i.test(message) ? 409 : 400, { error: message })
    }
  }

  private async execute(clientId: string, method: string, params: Record<string, unknown>, operationId: string, tabGeneration: number): Promise<unknown> {
    this.cleanupExpiredLeases()
    const tabId = typeof params.tab_id === 'string' ? params.tab_id.trim() : ''
    if (tabId && (this.tabGenerations.get(tabId) || 0) !== tabGeneration) {
      throw new Error('Browser operation was cancelled by user takeover')
    }
    const mutating = !['state', 'tabs.list', 'console.read'].includes(method)
    if (tabId && mutating) this.claimLease(tabId, clientId, method)
    if (tabId && mutating && method !== 'lease.release') {
      this.manager.setAgentControl(tabId, 'active', clientId.slice(0, 24), method)
    }
    try {
      switch (method) {
        case 'state':
        case 'tabs.list':
          return this.publicState()
        case 'tabs.create': {
          const tab = await this.manager.createTab(typeof params.url === 'string' ? params.url : 'about:blank', params.activate !== false)
          return this.publicTab(tab)
        }
        case 'tabs.activate':
          this.manager.activateTab(requiredString(params.tab_id, 'tab_id'))
          return this.publicState()
        case 'tabs.close': {
          const closingTabId = requiredString(params.tab_id, 'tab_id')
          const result = await this.manager.closeTab(closingTabId)
          const timer = this.leaseTimers.get(closingTabId)
          if (timer) clearTimeout(timer)
          this.leaseTimers.delete(closingTabId)
          this.leases.delete(closingTabId)
          void result
          return this.publicState()
        }
        case 'navigate': {
          const tab = await this.manager.navigate(requiredString(params.tab_id, 'tab_id'), requiredString(params.url, 'url'))
          return this.publicTab(tab)
        }
        case 'navigation.action': {
          const action = requiredString(params.action, 'action')
          if (action !== 'back' && action !== 'forward' && action !== 'reload' && action !== 'stop') throw new Error('Invalid browser navigation action')
          const tab = await this.manager.navigationAction(requiredString(params.tab_id, 'tab_id'), action)
          return this.publicTab(tab)
        }
        case 'snapshot':
          return await this.manager.snapshot(requiredString(params.tab_id, 'tab_id'), snapshotOptions({
            snapshotId: params.snapshot_id as string | undefined, selector: params.selector as string | undefined,
            query: params.query as string | undefined, interactiveOnly: params.interactive_only as boolean | undefined,
            offset: params.offset as number | undefined, limit: params.limit as number | undefined,
          }))
        case 'text.read': {
          const mode = params.mode === undefined ? 'innerText' : requiredString(params.mode, 'mode')
          if (mode !== 'innerText' && mode !== 'textContent') throw new Error('mode must be innerText or textContent')
          return await this.manager.readText(requiredString(params.tab_id, 'tab_id'), {
            snapshotId: requiredString(params.snapshot_id, 'snapshot_id'),
            ref: requiredString(params.ref, 'ref'),
            mode: mode as BrowserTextMode,
            offset: boundedInteger(params.offset, 'offset', 0, 0, Number.MAX_SAFE_INTEGER),
            limit: boundedInteger(params.limit, 'limit', DEFAULT_BROWSER_TEXT_READ_LIMIT, 1, MAX_BROWSER_TEXT_READ_LIMIT),
          })
        }
        case 'interact': {
          const tab = await this.manager.interact(requiredString(params.tab_id, 'tab_id'), asObject(params.action) as unknown as BrowserInteractAction)
          return { ...this.publicTab(tab), snapshot: tab.snapshot, snapshotError: tab.snapshotError, observation: tab.observation }
        }
        case 'interact.batch':
          return await this.manager.interactBatch(requiredString(params.tab_id, 'tab_id'), params.actions, params.snapshot_id, () => {
            if (!this.server || this.leases.get(tabId)?.clientId !== clientId || (this.tabGenerations.get(tabId) || 0) !== tabGeneration) {
              throw new Error('Browser batch was cancelled or its tab control was revoked')
            }
          })
        case 'screenshot':
          return await this.manager.screenshot(requiredString(params.tab_id, 'tab_id'), params.full_page === true)
        case 'console.read':
          return this.manager.consoleEntries(requiredString(params.tab_id, 'tab_id')).map(entry => ({
            ...entry,
            message: redactBrowserText(entry.message, 2000),
            sourceId: publicBrowserUrl(entry.sourceId),
          }))
        case 'console.clear':
          this.manager.clearConsole(requiredString(params.tab_id, 'tab_id'))
          return { ok: true }
        case 'lease.release':
          this.releaseLease(requiredString(params.tab_id, 'tab_id'), clientId)
          return { ok: true }
        default:
          throw new Error(`Unknown Browser Broker method: ${method}`)
      }
    } finally {
      if (tabId && (this.tabGenerations.get(tabId) || 0) !== tabGeneration) {
        if (this.manager.state().tabs.some(tab => tab.id === tabId)) this.manager.cancelAgentOperation(tabId)
        if (method !== 'interact.batch') throw new Error('Browser operation was cancelled by user takeover')
      }
      void operationId
    }
  }

  private publicTab(tab: ReturnType<BrowserManager['state']>['tabs'][number]) {
    return {
      id: tab.id,
      title: redactBrowserText(tab.title, 500),
      url: publicBrowserUrl(tab.url),
      loading: tab.loading,
      canGoBack: tab.canGoBack,
      canGoForward: tab.canGoForward,
      crashed: tab.crashed,
      agentControl: tab.agentControl,
    }
  }

  private publicState() {
    const state = this.manager.state()
    return {
      activeTabId: state.activeTabId,
      maxTabs: state.maxTabs,
      tabs: state.tabs.map(tab => this.publicTab(tab)),
    }
  }

  private claimLease(tabId: string, clientId: string, method: string): void {
    const lease = this.leases.get(tabId)
    if (lease && lease.expiresAt > Date.now() && lease.clientId !== clientId) {
      if (this.clientProcessIsAlive(lease.clientId)) {
        throw new Error(`Browser tab is controlled by another MCP client; user takeover is required before ${method}`)
      }
      const staleTimer = this.leaseTimers.get(tabId)
      if (staleTimer) clearTimeout(staleTimer)
      this.leaseTimers.delete(tabId)
      this.leases.delete(tabId)
      this.clients.delete(lease.clientId)
    }
    const expiresAt = Date.now() + LEASE_TTL_MS
    this.leases.set(tabId, { clientId, expiresAt })
    const previousTimer = this.leaseTimers.get(tabId)
    if (previousTimer) clearTimeout(previousTimer)
    const timer = setTimeout(() => {
      const current = this.leases.get(tabId)
      if (!current || current.clientId !== clientId || current.expiresAt > Date.now()) return
      this.leases.delete(tabId)
      this.leaseTimers.delete(tabId)
      if (this.manager.state().tabs.some(tab => tab.id === tabId)) this.manager.revokeAgentControl(tabId)
    }, LEASE_TTL_MS + 25)
    timer.unref?.()
    this.leaseTimers.set(tabId, timer)
  }

  private clientProcessIsAlive(clientId: string): boolean {
    const pid = this.clients.get(clientId)?.pid
    // Older clients do not report a PID, so retain the TTL-based behavior for them.
    if (!pid) return true
    try {
      process.kill(pid, 0)
      return true
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === 'EPERM'
    }
  }

  private releaseLease(tabId: string, clientId: string): void {
    const lease = this.leases.get(tabId)
    if (lease && lease.clientId !== clientId) throw new Error('Browser tab lease belongs to another MCP client')
    const timer = this.leaseTimers.get(tabId)
    if (timer) clearTimeout(timer)
    this.leaseTimers.delete(tabId)
    this.leases.delete(tabId)
    this.manager.revokeAgentControl(tabId)
  }

  private cleanupExpiredLeases(): void {
    const current = Date.now()
    for (const [tabId, lease] of this.leases) {
      if (lease.expiresAt > current) continue
      const timer = this.leaseTimers.get(tabId)
      if (timer) clearTimeout(timer)
      this.leaseTimers.delete(tabId)
      this.leases.delete(tabId)
      if (this.manager.state().tabs.some(tab => tab.id === tabId)) this.manager.revokeAgentControl(tabId)
    }
    for (const [clientId, client] of this.clients) {
      if (current - client.lastSeenAt > 24 * 60 * 60 * 1000) this.clients.delete(clientId)
    }
  }

  private async queued<T>(tabId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(tabId) || Promise.resolve()
    let release!: () => void
    const next = new Promise<void>(resolve => { release = resolve })
    const queued = previous.catch(() => undefined).then(() => next)
    this.queues.set(tabId, queued)
    await previous.catch(() => undefined)
    try {
      return await this.withCapacity(operation)
    } finally {
      release()
      if (this.queues.get(tabId) === queued) this.queues.delete(tabId)
    }
  }

  private async withCapacity<T>(operation: () => Promise<T>): Promise<T> {
    if (this.activeOperations >= 4) {
      await new Promise<void>(resolve => this.capacityWaiters.push(() => {
        // Reserve the released slot before waking the waiter so a newly
        // arriving operation cannot overtake it and exceed the global cap.
        this.activeOperations += 1
        resolve()
      }))
    } else {
      this.activeOperations += 1
    }
    try { return await operation() } finally {
      this.activeOperations -= 1
      this.capacityWaiters.shift()?.()
    }
  }

  private async readBody(request: IncomingMessage): Promise<BrokerRequest> {
    const chunks: Buffer[] = []
    let length = 0
    for await (const chunk of request) {
      const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      length += data.length
      if (length > BODY_LIMIT) throw new Error('Request body exceeds 1 MB')
      chunks.push(data)
    }
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as BrokerRequest
    if (!parsed || typeof parsed !== 'object') throw new Error('Request body must be an object')
    return parsed
  }

  private send(response: ServerResponse, status: number, body: unknown): void {
    if (!response.headersSent) response.statusCode = status
    response.end(JSON.stringify(body))
  }

  private async writeDescriptor(descriptor: BrowserBrokerDescriptor): Promise<void> {
    await mkdir(this.brokerRoot, { recursive: true, mode: 0o700 })
    await chmod(this.brokerRoot, 0o700)
    const destination = join(this.brokerRoot, 'broker.json')
    const temp = `${destination}.${process.pid}.tmp`
    await writeFile(temp, `${JSON.stringify(descriptor, null, 2)}\n`, { mode: 0o600 })
    await rm(destination, { force: true })
    await rename(temp, destination)
    await chmod(destination, 0o600)
  }
}
