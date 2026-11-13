/**
 * Web Browser Broker (spec-05): an HTTP RPC server whose contract is identical
 * to the Electron broker, so `bin/hermes-studio-mcp.mjs` can drive a
 * server-hosted browser with no changes on its side.
 *
 * The HTTP layer stays thin — parse, authenticate, dispatch — and all browser
 * behaviour lives in the injected `BrokerBrowserService`.
 */

import { randomBytes, randomUUID, timingSafeEqual } from 'crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'http'
import { logger } from '../../public/logging'
import {
  BROKER_NON_MUTATING_METHODS,
  asObject,
  boundedInteger,
  publicState,
  publicTab,
  requiredString,
  type BrokerAgentControl,
  type BrokerStateInput,
  type BrokerTabState,
} from './broker-projections'
import {
  BrokerLeaseTable,
  LEASE_TTL_MS,
  TAKEOVER_CANCEL_MESSAGE,
} from './broker-lease'
import {
  removeOwnedBrokerDescriptor,
  writeBrokerDescriptor,
  type BrowserBrokerDescriptorFile,
  type BrokerDescriptorOptions,
  type BrokerDescriptorWriteResult,
} from './broker-descriptor'
import {
  DEFAULT_BROWSER_TEXT_READ_LIMIT,
  MAX_BROWSER_TEXT_READ_LIMIT,
  type BrowserConsoleEntry,
  type BrowserInteractAction,
  type BrowserReadTextOptions,
  type BrowserReadTextResult,
  type BrowserScreenshot,
} from './automation'
import type { BrowserSnapshot } from './snapshot'
import { publicBrowserUrl, redactBrowserText } from './url-policy'

export const BROKER_BODY_LIMIT = 1024 * 1024
export const BROKER_STOP_TIMEOUT_MS = 2_000
export const BROKER_MAX_CONCURRENCY = 4
export const BROKER_UNKNOWN_METHOD = (method: string) => `Unknown Browser Broker method: ${method}`

export interface BrokerBrowserService {
  state(): BrokerStateInput
  createTab(url: string, activate: boolean): Promise<BrokerTabState>
  activateTab(tabId: string): void
  closeTab(tabId: string): Promise<void>
  navigate(tabId: string, url: string): Promise<BrokerTabState>
  navigationAction(tabId: string, action: 'back' | 'forward' | 'reload' | 'stop'): Promise<BrokerTabState>
  snapshot(tabId: string): Promise<BrowserSnapshot>
  readText(tabId: string, options: BrowserReadTextOptions & { snapshotId: string, ref: string }): Promise<BrowserReadTextResult>
  interact(tabId: string, action: BrowserInteractAction): Promise<BrokerTabState>
  screenshot(tabId: string, fullPage: boolean): Promise<BrowserScreenshot>
  consoleEntries(tabId: string): BrowserConsoleEntry[]
  clearConsole(tabId: string): void
  setAgentControl(tabId: string, control: BrokerAgentControl, label?: string, action?: string): void
  revokeAgentControl(tabId: string): void
  cancelAgentOperation(tabId: string): void
  hasTab(tabId: string): boolean
}

interface BrokerRequest {
  method?: unknown
  params?: unknown
  operation_id?: unknown
  run_metadata?: unknown
  client_pid?: unknown
}

export interface WebBrowserBrokerOptions extends BrokerDescriptorOptions {
  service: BrokerBrowserService
  /** Directory holding `broker.json`; defaults to `<webUiHome>/desktop-browser`. */
  brokerRoot?: string
  now?: () => number
}

function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left)
  const b = Buffer.from(right)
  return a.length === b.length && timingSafeEqual(a, b)
}

export class WebBrowserBroker {
  private readonly service: BrokerBrowserService
  private readonly options: WebBrowserBrokerOptions
  private readonly leases: BrokerLeaseTable
  private server: Server | null = null
  private token = ''
  private descriptor: BrowserBrokerDescriptorFile | null = null
  private descriptorWriteResult: BrokerDescriptorWriteResult | null = null
  private readonly queues = new Map<string, Promise<void>>()
  private activeOperations = 0
  private readonly capacityWaiters: Array<() => void> = []

  constructor(options: WebBrowserBrokerOptions) {
    this.options = options
    this.service = options.service
    this.leases = new BrokerLeaseTable({
      revokeAgentControl: tabId => this.service.revokeAgentControl(tabId),
      cancelTab: tabId => this.service.cancelAgentOperation(tabId),
      now: options.now,
    })
  }

  get descriptorFile(): BrowserBrokerDescriptorFile | null {
    return this.descriptor
  }

  get leaseTtlMs(): number {
    return LEASE_TTL_MS
  }

  get descriptorWrite(): BrokerDescriptorWriteResult | null {
    return this.descriptorWriteResult
  }

  async start(): Promise<BrowserBrokerDescriptorFile> {
    if (this.descriptor) return this.descriptor
    if (!this.options.service) throw new Error('Web Browser Broker requires a browser service')

    this.token = randomBytes(32).toString('base64url')
    const server = createServer((request, response) => {
      void this.handleHttp(request, response)
    })
    this.server = server
    server.on('clientError', (_error, socket) => socket.destroy())

    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject)
        server.listen(0, '127.0.0.1', () => resolve())
      })
      const address = server.address()
      if (!address || typeof address === 'string') {
        throw new Error('Browser Broker did not bind a TCP port')
      }
      const descriptor: BrowserBrokerDescriptorFile = {
        schema: 1,
        protocol: 'http:',
        desktopPid: process.pid,
        endpoint: `http://127.0.0.1:${address.port}/v1`,
        token: this.token,
        instanceId: randomUUID(),
        createdAt: new Date().toISOString(),
      }
      this.descriptor = descriptor
      this.descriptorWriteResult = await writeBrokerDescriptor(descriptor, this.options)
      if (this.descriptorWriteResult !== 'written') {
        logger.warn(
          '[browser-broker] descriptor not written (%s); listening on %s without being discoverable',
          this.descriptorWriteResult,
          descriptor.endpoint,
        )
      }
      return descriptor
    } catch (error) {
      this.server = null
      this.descriptor = null
      this.token = ''
      if (server.listening) {
        await new Promise<void>(resolve => server.close(() => resolve()))
      }
      throw error
    }
  }

  async stop(timeoutMs = BROKER_STOP_TIMEOUT_MS): Promise<void> {
    this.revokeAll()
    this.leases.dispose()
    this.queues.clear()
    const server = this.server
    const descriptor = this.descriptor
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

    if (descriptor) {
      await removeOwnedBrokerDescriptor(descriptor.instanceId, this.options).catch(() => undefined)
    }
  }

  /** User takeover entry point (spec-08): abort the tab and drop its lease. */
  revokeTab(tabId: string): void {
    this.leases.revokeTab(tabId)
  }

  revokeAll(): void {
    this.leases.revokeAll([...this.leases.leasedTabIds(), ...this.queues.keys()])
  }

  private async handleHttp(request: IncomingMessage, response: ServerResponse): Promise<void> {
    response.setHeader('Content-Type', 'application/json; charset=utf-8')
    response.setHeader('Cache-Control', 'no-store')
    try {
      if (request.method !== 'POST' || (request.url !== '/v1' && request.url !== '/v1/session')) {
        return this.send(response, 404, { error: 'Not found' })
      }
      if (request.headers.origin) {
        return this.send(response, 403, { error: 'Browser origins are not accepted' })
      }
      this.leases.cleanupExpired()

      const authorization = String(request.headers.authorization || '')
      const providedToken = authorization.startsWith('Bearer ') ? authorization.slice(7) : ''

      if (request.url === '/v1/session') {
        if (!providedToken || !safeEqual(providedToken, this.token)) {
          return this.send(response, 401, { error: 'Unauthorized' })
        }
        const registration = await this.readBody(request)
        const clientPid = registration.client_pid
        if (
          clientPid !== undefined
          && (typeof clientPid !== 'number' || !Number.isSafeInteger(clientPid) || clientPid <= 0)
        ) {
          throw new Error('client_pid must be a positive integer')
        }
        const clientId = randomUUID()
        const clientToken = randomBytes(32).toString('base64url')
        this.leases.registerClient(clientId, clientToken, typeof clientPid === 'number' ? clientPid : undefined)
        return this.send(response, 200, { client_id: clientId, session_token: clientToken })
      }

      if (!providedToken) return this.send(response, 401, { error: 'Unauthorized' })
      // Acceptance 7: a missing or empty client header is an authentication
      // failure, not a validation error.
      const clientId = String(request.headers['x-hermes-browser-client'] || '').trim().slice(0, 200)
      if (!clientId) return this.send(response, 401, { error: 'Unauthorized' })
      const client = this.leases.getClient(clientId)
      if (!client || !safeEqual(providedToken, client.token)) {
        return this.send(response, 401, { error: 'Unauthorized' })
      }
      this.leases.touchClient(clientId)

      const body = await this.readBody(request)
      const method = requiredString(body.method, 'method')
      const params = asObject(body.params)
      const operationId = typeof body.operation_id === 'string' && body.operation_id.trim()
        ? body.operation_id.trim().slice(0, 200)
        : randomUUID()
      const tabId = typeof params.tab_id === 'string' ? params.tab_id.trim() : ''
      const tabGeneration = tabId ? this.leases.generationOf(tabId) : 0

      const result = tabId
        ? await this.queued(tabId, () => this.execute(clientId, method, params, operationId, tabGeneration))
        : await this.withCapacity(() => this.execute(clientId, method, params, operationId, tabGeneration))

      this.send(response, 200, { operation_id: operationId, result })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.send(response, /lease|control|cancel|takeover/i.test(message) ? 409 : 400, { error: message })
    }
  }

  private async execute(
    clientId: string,
    method: string,
    params: Record<string, unknown>,
    operationId: string,
    tabGeneration: number,
  ): Promise<unknown> {
    this.leases.cleanupExpired()
    const tabId = typeof params.tab_id === 'string' ? params.tab_id.trim() : ''
    if (tabId && this.leases.generationOf(tabId) !== tabGeneration) {
      throw new Error(TAKEOVER_CANCEL_MESSAGE)
    }

    const mutating = !BROKER_NON_MUTATING_METHODS.includes(method)
    // `lease.release` must reach the ownership check instead of being turned
    // into a "controlled by another client" conflict, so it never claims.
    const claimsLease = mutating && method !== 'lease.release'
    if (tabId && claimsLease) this.leases.claim(tabId, clientId, method)
    if (tabId && claimsLease) {
      this.service.setAgentControl(tabId, 'active', clientId.slice(0, 24), method)
    }

    try {
      switch (method) {
        case 'state':
        case 'tabs.list':
          return publicState(this.service.state())
        case 'tabs.create': {
          const url = typeof params.url === 'string' ? params.url : 'about:blank'
          const tab = await this.service.createTab(url, params.activate !== false)
          return publicTab(tab)
        }
        case 'tabs.activate':
          this.service.activateTab(requiredString(params.tab_id, 'tab_id'))
          return publicState(this.service.state())
        case 'tabs.close': {
          const closingTabId = requiredString(params.tab_id, 'tab_id')
          await this.service.closeTab(closingTabId)
          // The lease for a closed tab dies with it.
          this.leases.release(closingTabId, clientId)
          return publicState(this.service.state())
        }
        case 'navigate': {
          const tab = await this.service.navigate(
            requiredString(params.tab_id, 'tab_id'),
            requiredString(params.url, 'url'),
          )
          return publicTab(tab)
        }
        case 'navigation.action': {
          const action = requiredString(params.action, 'action')
          if (action !== 'back' && action !== 'forward' && action !== 'reload' && action !== 'stop') {
            throw new Error('Invalid browser navigation action')
          }
          const tab = await this.service.navigationAction(
            requiredString(params.tab_id, 'tab_id'),
            action,
          )
          return publicTab(tab)
        }
        case 'snapshot':
          return await this.service.snapshot(requiredString(params.tab_id, 'tab_id'))
        case 'text.read': {
          const mode = params.mode === undefined ? 'innerText' : requiredString(params.mode, 'mode')
          if (mode !== 'innerText' && mode !== 'textContent') {
            throw new Error('mode must be innerText or textContent')
          }
          return await this.service.readText(requiredString(params.tab_id, 'tab_id'), {
            snapshotId: requiredString(params.snapshot_id, 'snapshot_id'),
            ref: requiredString(params.ref, 'ref'),
            mode,
            offset: boundedInteger(params.offset, 'offset', 0, 0, Number.MAX_SAFE_INTEGER),
            limit: boundedInteger(
              params.limit,
              'limit',
              DEFAULT_BROWSER_TEXT_READ_LIMIT,
              1,
              MAX_BROWSER_TEXT_READ_LIMIT,
            ),
          })
        }
        case 'interact': {
          const tab = await this.service.interact(
            requiredString(params.tab_id, 'tab_id'),
            asObject(params.action) as unknown as BrowserInteractAction,
          )
          return publicTab(tab)
        }
        case 'screenshot':
          return await this.service.screenshot(
            requiredString(params.tab_id, 'tab_id'),
            params.full_page === true,
          )
        case 'console.read':
          // Same projection as the desktop broker: message truncated, source
          // URL redacted, no raw CDP payload.
          return this.service.consoleEntries(requiredString(params.tab_id, 'tab_id')).map(entry => ({
            ...entry,
            message: redactBrowserText(entry.message, 2_000),
            sourceId: publicBrowserUrl(entry.sourceId),
          }))
        case 'console.clear':
          this.service.clearConsole(requiredString(params.tab_id, 'tab_id'))
          return { ok: true }
        case 'lease.release':
          this.leases.release(requiredString(params.tab_id, 'tab_id'), clientId)
          return { ok: true }
        default:
          throw new Error(BROKER_UNKNOWN_METHOD(method))
      }
    } finally {
      if (tabId && this.leases.generationOf(tabId) !== tabGeneration) {
        throw new Error(TAKEOVER_CANCEL_MESSAGE)
      }
      void operationId
    }
  }

  private async queued<T>(tabId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(tabId) || Promise.resolve()
    let release!: () => void
    const next = new Promise<void>(resolve => {
      release = resolve
    })
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
    if (this.activeOperations >= BROKER_MAX_CONCURRENCY) {
      await new Promise<void>(resolve => this.capacityWaiters.push(() => {
        // Reserve the released slot before waking the waiter so a newly
        // arriving operation cannot overtake it and exceed the global cap.
        this.activeOperations += 1
        resolve()
      }))
    } else {
      this.activeOperations += 1
    }
    try {
      return await operation()
    } finally {
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
      if (length > BROKER_BODY_LIMIT) throw new Error('Request body exceeds 1 MB')
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
}
