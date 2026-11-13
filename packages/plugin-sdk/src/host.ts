import type { Json } from './core'
import type { PluginBrowser, BrowserTransport } from './browser'
import type { SessionConnector, SessionListener } from './sessions'
import type { HostBots } from './bots'

export interface ApiRequest {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  query?: Record<string, string | number | boolean | undefined>
  body?: Json
}
export type ApiQuery = NonNullable<ApiRequest['query']>
export type JsonObject = Record<string, Json>
export interface SessionCreateInput {
  title?: string
  agent?: string
  mode?: 'scoped' | 'global'
}
export interface HostApi {
  agents: { list(): Promise<Json>; status(id: string): Promise<Json>; models(id: string, refresh?: boolean): Promise<Json>; settings(id: string): Promise<Json> }
  browser: PluginBrowser
  bots: HostBots

  request<T = Json>(path: string, options?: ApiRequest): Promise<T>
  models: { list(): Promise<Json>; respond(input: Record<string, Json>): Promise<Json> }
  sessions: {
    connect: SessionConnector
    list(query?: ApiQuery): Promise<Json>; get(id: string): Promise<Json>
    create(input?: SessionCreateInput): Promise<Json>
    /** Returns after the run starts/queues. Set wait:true to wait for completion. */
    run(id: string, input: string | JsonObject[], options?: JsonObject): Promise<Json>
    stop(id: string): Promise<Json>; remove(id: string): Promise<Json>
    rename(id: string, title: string): Promise<Json>
    archive(id: string, archived?: boolean): Promise<Json>
    setModel(id: string, model: JsonObject): Promise<Json>
    setWorkspace(id: string, workspace: string): Promise<Json>
    messages(id: string, query?: ApiQuery): Promise<Json>
  }
  groupChats: {
    list(): Promise<Json>; get(id: string): Promise<Json>
    create(input: JsonObject & { name: string; inviteCode: string }): Promise<Json>
    update(id: string, input: JsonObject): Promise<Json>; remove(id: string): Promise<Json>
    send(id: string, content: string | JsonObject[], mentions?: Json[]): Promise<Json>
    /** Interrupt one named agent using the same permissions as the chat UI. */
    stop(id: string, agentName: string): Promise<Json>
    messages(id: string, query?: ApiQuery): Promise<Json>
    agents: { list(id: string): Promise<Json>; add(id: string, input: JsonObject): Promise<Json>; update(id: string, agentId: string, input: JsonObject): Promise<Json>; remove(id: string, agentId: string): Promise<Json> }
  }
  workflows: {
    list(): Promise<Json>; get(id: string): Promise<Json>
    create(input: JsonObject & { name: string }): Promise<Json>
    update(id: string, input: JsonObject): Promise<Json>; remove(id: string): Promise<Json>
    run(id: string, input?: string): Promise<Json>; stop(id: string, runId: string): Promise<Json>
    runs(id: string): Promise<Json>; getRun(id: string, runId: string): Promise<Json>
    schedules: { list(id: string): Promise<Json>; create(id: string, input: JsonObject): Promise<Json>; update(id: string, scheduleId: string, input: JsonObject): Promise<Json>; remove(id: string, scheduleId: string): Promise<Json> }
  }
  files: { list(path?: string): Promise<Json>; read(path: string): Promise<Json> }
}
export function createHostApi(request: HostApi['request'], browserRequest?: BrowserTransport, sessionConnect?: SessionConnector): HostApi {
  const id = encodeURIComponent
  // This entire factory is serialized into the browser iframe; keep helpers local.
  const session = (value: string) => `/api/studio/sessions/${id(value)}`
  const room = (value: string) => `/api/studio/group-chat/rooms/${id(value)}`
  const workflow = (value: string) => `/api/studio/workflows/${id(value)}`
  const post = (path: string, body: Json = {}) => request(path, { method: 'POST', body })
  const remove = (path: string) => request(path, { method: 'DELETE' })
  const connect = (sessionId: string, listener: SessionListener, kind: 'chat' | 'bot' = 'chat') => {
    if (!sessionConnect) return Promise.reject(new Error('Live session transport is unavailable'))
    return sessionConnect(sessionId, listener, kind)
  }
  const person = '/api/studio/person'
  const task = (value: string) => `${person}/tasks/${id(value)}`
  const browser = async <T>(method: string, params: Record<string, Json> = {}): Promise<T> => {
    if (!browserRequest) throw new Error('Desktop browser transport is unavailable')
    return await browserRequest(method, params) as T
  }
  return { request, agents: {
    list: () => request('/api/studio/agents'),
    status: value => request(`/api/studio/agents/${id(value)}/status`),
    models: (value, refresh = false) => request(`/api/studio/agents/${id(value)}/models`, { query: { refresh } }),
    settings: value => post(`/api/studio/agents/${id(value)}/settings`),
  }, bots: {
    list: query => request(`${person}/conversations`, { query }),
    create: input => post(`${person}/conversations`, input),
    get: sessionId => request(person, { query: { session_id: sessionId } }),
    configure: (sessionId, input) => request(`${person}/settings`, { method: 'PUT', body: { ...input, session_id: sessionId } }),
    clear: (sessionId, expectedHistoryRevision) => post(`${person}/clear`, { session_id: sessionId, expected_history_revision: expectedHistoryRevision }),
    remove: (sessionId, expectedHistoryRevision) => request(`${person}/conversations/${id(sessionId)}`, { method: 'DELETE', body: { expected_history_revision: expectedHistoryRevision } }),
    connect: (sessionId, listener) => connect(sessionId, listener, 'bot'),
    models: { list: () => request(`${person}/models`), agents: () => request(`${person}/capabilities`), execution: () => request(`${person}/agent-models`) },
    tasks: {
      list: (input = {}) => post(`${person}/tasks/query`, input), apply: input => post(`${person}/tasks/apply`, input),
      messages: (value, query) => request(`${task(value)}/chat`, { query }), send: (value, input) => post(`${task(value)}/chat`, input),
      insert: (value, input) => post(`${task(value)}/queue/insert`, input), remove: (value, input) => post(`${task(value)}/queue/remove`, input),
      executions: value => request(`${task(value)}/executions`), events: (value, after = 0) => request(`${person}/executions/${id(value)}/events`, { query: { after } }),
    },
    flows: { list: (input = {}) => post(`${person}/flows/query`, input), apply: input => post(`${person}/flows/apply`, input), messages: (value, query) => request(`${person}/flows/${id(value)}/messages`, { query }) },
    schedules: { apply: input => post(`${person}/schedules/apply`, input) },
    memory: { forget: (value, expectedRevision) => post(`${person}/memory`, { id: value, expected_revision: expectedRevision, forget: true }) },
    interactions: { answer: (value, expectedRevision, answer) => post(`${person}/interactions/${id(value)}/answer`, { expected_revision: expectedRevision, answer }) },
  }, browser: {
    tabs: { list: () => browser('tabs.list'), create: (url = 'about:blank') => browser('tabs.create', { url }), close: tabId => browser('tabs.close', { tab_id: tabId }) },
    cdp: {
      attach: tabId => browser('cdp.attach', { tab_id: tabId }),
      send: (tabId, method, params = {}, sessionId) => browser('cdp.send', { tab_id: tabId, method, params, ...(sessionId ? { session_id: sessionId } : {}) }),
      events: (tabId, cursor = 0, limit = 32) => browser('cdp.events', { tab_id: tabId, cursor, limit }),
      release: tabId => browser('lease.release', { tab_id: tabId }),
    },
  }, models: {
    list: () => request('/api/ekko-studio/models/v1/models'),
    respond: input => request('/api/ekko-studio/models/v1/responses', { method: 'POST', body: { ...input, stream: false } }),
  },
    sessions: {
      connect,
      list: query => request('/api/studio/sessions', query ? { query } : undefined), get: value => request(session(value)),
      create: (input = {}) => post('/api/studio/sessions', { ...input }),
      run: (value, input, options = {}) => post('/api/studio/chat-run/runs', { wait: false, ...options, session_id: value, input }),
      stop: value => post(`${session(value)}/stop`), remove: value => remove(session(value)),
      rename: (value, title) => post(`${session(value)}/rename`, { title }),
      archive: (value, archived = true) => post(`${session(value)}/${archived ? 'archive' : 'unarchive'}`),
      setModel: (value, model) => post(`${session(value)}/model`, model),
      setWorkspace: (value, workspace) => post(`${session(value)}/workspace`, { workspace }),
      messages: (value, query) => request(`/api/studio/sessions/conversations/${id(value)}/messages/paginated`, { query }),
    },
    groupChats: {
      list: () => request('/api/studio/group-chat/rooms'), get: value => request(room(value)),
      create: input => post('/api/studio/group-chat/rooms', input),
      update: (value, input) => request(`${room(value)}/config`, { method: 'PUT', body: input }), remove: value => remove(room(value)),
      send: (value, content, mentions) => post(`${room(value)}/messages`, { content, ...(mentions ? { mentions } : {}) }),
      stop: (value, agentName) => post(`${room(value)}/stop`, { agentName }),
      messages: (value, query) => request(`${room(value)}/messages`, { query }),
      agents: {
        list: value => request(`${room(value)}/agents`), add: (value, input) => post(`${room(value)}/agents`, input),
        update: (value, agentId, input) => request(`${room(value)}/agents/${id(agentId)}`, { method: 'PUT', body: input }),
        remove: (value, agentId) => remove(`${room(value)}/agents/${id(agentId)}`),
      },
    },
    workflows: {
      list: () => request('/api/studio/workflows'), get: value => request(workflow(value)),
      create: input => post('/api/studio/workflows', input), update: (value, input) => request(workflow(value), { method: 'PATCH', body: input }),
      remove: value => remove(workflow(value)), run: (value, input) => post(`${workflow(value)}/run`, { ...(input ? { input } : {}) }),
      stop: (value, runId) => post(`${workflow(value)}/runs/${id(runId)}/stop`),
      runs: value => request(`${workflow(value)}/runs`), getRun: (value, runId) => request(`${workflow(value)}/runs/${id(runId)}`),
      schedules: {
        list: value => request(`${workflow(value)}/schedules`), create: (value, input) => post(`${workflow(value)}/schedules`, input),
        update: (value, scheduleId, input) => request(`${workflow(value)}/schedules/${id(scheduleId)}`, { method: 'PATCH', body: input }),
        remove: (value, scheduleId) => remove(`${workflow(value)}/schedules/${id(scheduleId)}`),
      },
    },
    files: { list: (path = '') => request('/api/studio/files/list', { query: { path } }), read: path => request('/api/studio/files/read', { query: { path } }) },
  }
}
