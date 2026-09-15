#!/usr/bin/env node
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { createInterface } from 'node:readline'
import { randomUUID } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const DEFAULT_PORT = process.env.HERMES_WEB_UI_PORT || process.env.PORT || '8648'
const DEFAULT_BASE_URL = `http://127.0.0.1:${DEFAULT_PORT}`
const DISPLAY_COMMAND = 'ekko-studio-mcp'
const SERVER_NAME = process.env.HERMES_MCP_SERVER_NAME || DISPLAY_COMMAND
const TOOLSETS = new Set(['api', 'browser', 'devices', 'use'])
const ALLOWED_PUBLIC_REQUEST_HEADERS = new Set([
  'accept',
  'accept-language',
  'content-type',
  'x-request-id',
])

const __dirname = dirname(fileURLToPath(import.meta.url))

function readPackageVersion() {
  const candidates = [
    resolve(__dirname, '../package.json'),
    resolve(__dirname, '../../package.json'),
    resolve(process.cwd(), 'package.json'),
  ]
  for (const packagePath of candidates) {
    try {
      const pkg = JSON.parse(readFileSync(packagePath, 'utf8'))
      if (typeof pkg.version === 'string' && pkg.version.trim()) return pkg.version.trim()
    } catch {
      // Try the next candidate path.
    }
  }
  return '0.0.0'
}

const VERSION = readPackageVersion()

function printHelp() {
  process.stdout.write(`${DISPLAY_COMMAND} v${VERSION}

Ekko Studio MCP stdio server.

Usage:
  ${DISPLAY_COMMAND} [api|browser|devices|use]
  ${DISPLAY_COMMAND} --help
  ${DISPLAY_COMMAND} --version

Environment:
  HERMES_WEB_UI_URL       Web UI base URL. Default: ${DEFAULT_BASE_URL}
  HERMES_WEB_UI_HOME      Web UI state directory. Default: ~/.hermes-web-ui
  HERMES_WEBUI_STATE_DIR  Fallback Web UI state directory.
  HERMES_WEB_UI_PROFILE   Default Hermes profile when a tool call omits profile.
  HERMES_WEB_UI_TOKEN     Optional explicit API token.
  AUTH_TOKEN              Optional explicit API token fallback.
  HERMES_MCP_TOOLSET      Tool category to expose: api, browser, devices, or use. Default: api.

When run without options, this process waits for MCP JSON-RPC messages on stdin.
`)
}

const positionalArgs = process.argv.slice(2).filter(arg => !arg.startsWith('-'))
const requestedToolset = String(positionalArgs[0] || process.env.HERMES_MCP_TOOLSET || 'api').trim().toLowerCase()
const ACTIVE_TOOLSET = TOOLSETS.has(requestedToolset) ? requestedToolset : 'api'
const SHARED_TASK_PLAN_ENABLED = process.env.HERMES_MCP_NATIVE_TASK_PLAN !== '1'

if (process.argv.includes('-h') || process.argv.includes('--help')) {
  printHelp()
  process.exit(0)
}

if (process.argv.includes('-v') || process.argv.includes('--version')) {
  process.stdout.write(`${SERVER_NAME} v${VERSION}\n`)
  process.exit(0)
}

function appHome() {
  return process.env.HERMES_WEB_UI_HOME ||
    process.env.HERMES_WEBUI_STATE_DIR ||
    join(homedir(), '.hermes-web-ui')
}

function normalizeProfileSegment(profile) {
  const raw = String(profile || '').trim()
  if (!raw) return ''
  const sanitized = raw.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
  if (sanitized === '.' || sanitized === '..' || sanitized.length > 128) return ''
  return sanitized
}

function readProfileToken(profile) {
  const segment = normalizeProfileSegment(profile)
  if (!segment) return ''
  try {
    return readFileSync(join(appHome(), 'profiles', segment, '.model-run-token'), 'utf8').trim()
  } catch {
    return ''
  }
}

function readToken(tokenOverride, allowTokenFile = true, profile = '') {
  const explicit = tokenOverride || process.env.HERMES_WEB_UI_TOKEN || process.env.AUTH_TOKEN
  if (explicit) return explicit.trim()
  if (!allowTokenFile) return ''
  const profileToken = readProfileToken(profile)
  if (profileToken) return profileToken
  try {
    return readFileSync(join(appHome(), '.token'), 'utf8').trim()
  } catch {
    return ''
  }
}

function defaultProfile() {
  return String(
    process.env.HERMES_WEB_UI_PROFILE ||
    process.env.HERMES_PROFILE ||
    process.env.PROFILE ||
    '',
  ).trim()
}

function authHint() {
  return `Web UI token was not accepted. Pass the current Hermes profile argument so this MCP server can read its temporary token, pass an explicit token argument, or set HERMES_WEB_UI_TOKEN.`
}

function baseUrl() {
  return (process.env.HERMES_WEB_UI_URL || DEFAULT_BASE_URL).replace(/\/$/, '')
}

function jsonText(data) {
  return {
    content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
  }
}

function errorText(message) {
  return {
    isError: true,
    content: [{ type: 'text', text: message }],
  }
}

async function request(path, options = {}) {
  const envelope = await requestEnvelope(path, options)
  if (envelope.status < 200 || envelope.status >= 300) {
    if (envelope.status === 401) {
      throw new Error(`${envelope.body?.error || 'Unauthorized'}. ${authHint()}`)
    }
    throw new Error(envelope.body?.error || envelope.bodyText || `HTTP ${envelope.status}`)
  }
  return envelope.body
}

function appendQuery(path, query) {
  if (!query || typeof query !== 'object' || Array.isArray(query)) return path
  const parsed = new URL(path, 'http://hermes-web-ui.local')
  for (const [key, value] of Object.entries(query)) {
    if (value == null) continue
    if (Array.isArray(value)) {
      for (const item of value) {
        if (item != null) parsed.searchParams.append(key, String(item))
      }
      continue
    }
    parsed.searchParams.set(key, String(value))
  }
  return `${parsed.pathname}${parsed.search}`
}

function normalizePublicHeaders(headers) {
  const normalized = {}
  if (!headers || typeof headers !== 'object' || Array.isArray(headers)) return normalized
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase()
    if (!ALLOWED_PUBLIC_REQUEST_HEADERS.has(lower) || value == null) continue
    normalized[lower] = Array.isArray(value) ? String(value.find(Boolean) || '') : String(value)
  }
  return normalized
}

// Mobile consent can wait five minutes before producing response headers.
// Avoid fetch's 300-second headers deadline racing that business deadline.
async function fetchMobileConsent(url, options) {
  return new Promise((resolve, reject) => {
    const target = new URL(url)
    const transport = target.protocol === 'https:' ? httpsRequest : httpRequest
    let timer
    const req = transport(target, { method: options.method, headers: options.headers }, res => {
      const chunks = []
      res.on('data', chunk => chunks.push(chunk))
      res.on('error', error => { clearTimeout(timer); reject(error) })
      res.on('end', () => {
        clearTimeout(timer)
        const text = Buffer.concat(chunks).toString('utf8')
        const headers = new Headers()
        for (const [name, value] of Object.entries(res.headers)) {
          if (value != null) headers.set(name, Array.isArray(value) ? value.join(', ') : value)
        }
        resolve({ status: res.statusCode || 500, headers, text: async () => text })
      })
    })
    timer = setTimeout(() => req.destroy(new Error('Mobile consent transport timed out')), 330_000)
    req.on('error', error => { clearTimeout(timer); reject(error) })
    req.end(options.body)
  })
}

async function requestEnvelope(path, options = {}) {
  const profile = typeof options.profile === 'string' && options.profile.trim()
    ? options.profile.trim()
    : defaultProfile()
  const token = readToken(options.token, options.allowTokenFile !== false, profile)
  const method = options.method || 'GET'
  const body = method === 'GET' || method === 'HEAD' ? undefined : options.body
  const headers = {
    ...normalizePublicHeaders(options.headers),
    ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...(profile ? { 'X-Hermes-Profile': profile } : {}),
  }
  const fetchRequest = path === '/api/studio/mobile-calendar/request' || path === '/api/studio/mobile-health/request' ? fetchMobileConsent : fetch
  const response = await fetchRequest(`${baseUrl()}${appendQuery(path, options.query)}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  const responseHeaders = {}
  response.headers.forEach((value, key) => {
    responseHeaders[key] = value
  })
  if (method === 'HEAD' || response.status === 204) {
    return { status: response.status, headers: responseHeaders, body: null }
  }
  const contentType = response.headers.get('content-type') || ''
  const bodyText = await response.text()
  let parsedBody = bodyText
  if (contentType.toLowerCase().includes('application/json')) {
    try {
      parsedBody = bodyText ? JSON.parse(bodyText) : null
    } catch {
      parsedBody = bodyText
    }
  }
  return { status: response.status, headers: responseHeaders, body: parsedBody, bodyText }
}

function normalizeApiMethod(method) {
  const value = String(method || 'GET').trim().toUpperCase()
  return ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'].includes(value) ? value : null
}

function normalizeApiPath(path) {
  const raw = String(path || '').trim()
  if (!raw || !raw.startsWith('/') || raw.startsWith('//')) return null
  if (raw === '/v1' || raw.startsWith('/v1/')) return null
  const parsed = new URL(raw, 'http://hermes-web-ui.local')
  const normalized = `${parsed.pathname}${parsed.search}`
  if (parsed.pathname === '/api/openapi.json') return normalized
  if (parsed.pathname === '/health') return normalized
  if (parsed.pathname.startsWith('/api/')) return normalized
  return null
}

let cachedOpenApiDocument = null

function isRecord(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

async function openApiDocument(options = {}) {
  if (cachedOpenApiDocument) return cachedOpenApiDocument
  cachedOpenApiDocument = await request('/api/openapi.json', options)
  return cachedOpenApiDocument
}

function pathWithoutQuery(path) {
  return new URL(path, 'http://hermes-web-ui.local').pathname
}

function pathTemplateRegex(template) {
  const escaped = String(template).split('/').map(part => {
    if (/^\{[^/{}]+\}$/.test(part)) return '[^/]+'
    return part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  }).join('/')
  return new RegExp(`^${escaped}$`)
}

function findOpenApiOperation(openapi, method, path) {
  const paths = isRecord(openapi?.paths) ? openapi.paths : {}
  const pathname = pathWithoutQuery(path)
  const exact = paths[pathname]?.[method.toLowerCase()]
  if (exact) return { operation: exact, pathTemplate: pathname }
  for (const [template, methods] of Object.entries(paths)) {
    if (!pathTemplateRegex(template).test(pathname)) continue
    const operation = isRecord(methods) ? methods[method.toLowerCase()] : null
    if (operation) return { operation, pathTemplate: template }
  }
  return null
}

function queryObjectFromPath(path, query) {
  const parsed = new URL(path, 'http://hermes-web-ui.local')
  const values = {}
  for (const [key, value] of parsed.searchParams.entries()) {
    if (values[key] === undefined) values[key] = value
    else if (Array.isArray(values[key])) values[key].push(value)
    else values[key] = [values[key], value]
  }
  if (isRecord(query)) {
    for (const [key, value] of Object.entries(query)) {
      if (value != null) values[key] = value
    }
  }
  return values
}

function missingValue(value) {
  return value === undefined || value === null || value === ''
}

function validateRequiredObjectFields(schema, value, location) {
  if (!schema || !Array.isArray(schema.required) || schema.required.length === 0) return null
  if (!isRecord(value)) return `${location} must be an object with required fields: ${schema.required.join(', ')}`
  for (const field of schema.required) {
    if (missingValue(value[field])) return `missing required field ${location}.${field}`
  }
  return null
}

async function validateApiRequest(method, path, args) {
  if (pathWithoutQuery(path) === '/api/openapi.json') return null
  const openapi = await openApiDocument(withAuthArgs(args))
  const match = findOpenApiOperation(openapi, method, path)
  if (!match) return `Unknown endpoint in OpenAPI document: ${method} ${pathWithoutQuery(path)}`
  const { operation } = match
  const queryValues = queryObjectFromPath(path, args.query)
  for (const parameter of Array.isArray(operation.parameters) ? operation.parameters : []) {
    if (!parameter?.required) continue
    if (parameter.in === 'query' && missingValue(queryValues[parameter.name])) {
      return `missing required query parameter ${parameter.name}`
    }
    if (parameter.in === 'path') {
      // Path templates are already matched by the request path; no separate path arg exists.
      continue
    }
  }
  const requestBody = operation.requestBody
  if (!requestBody) return null
  const body = args.body
  if (requestBody.required && body === undefined) return `missing required request body for ${method} ${pathWithoutQuery(path)}`
  if (body === undefined) return null
  const schema = requestBody.content?.['application/json']?.schema
  return validateRequiredObjectFields(schema, body, 'body')
}

function schemaType(schema) {
  if (!isRecord(schema)) return undefined
  if (typeof schema.type === 'string') return schema.type
  if (Array.isArray(schema.oneOf)) return `oneOf(${schema.oneOf.map(schemaType).filter(Boolean).join('|')})`
  if (Array.isArray(schema.anyOf)) return `anyOf(${schema.anyOf.map(schemaType).filter(Boolean).join('|')})`
  if (schema.$ref) return String(schema.$ref).split('/').pop()
  return undefined
}

function compactParameters(parameters) {
  const path = []
  const query = []
  for (const parameter of Array.isArray(parameters) ? parameters : []) {
    if (!parameter?.name) continue
    const item = {
      name: parameter.name,
      required: parameter.required === true,
      type: schemaType(parameter.schema) || 'string',
      ...(Array.isArray(parameter.schema?.enum) ? { enum: parameter.schema.enum } : {}),
    }
    if (parameter.in === 'path') path.push(item)
    if (parameter.in === 'query') query.push(item)
  }
  return { path, query }
}

function compactBodyFields(requestBody) {
  const schema = requestBody?.content?.['application/json']?.schema
  if (!isRecord(schema?.properties)) return []
  const required = new Set(Array.isArray(schema.required) ? schema.required : [])
  return Object.entries(schema.properties).map(([name, property]) => {
    return {
      name,
      required: required.has(name),
      type: schemaType(property) || 'unknown',
      ...(Array.isArray(property?.enum) ? { enum: property.enum } : {}),
      ...(property?.description ? { description: String(property.description) } : {}),
    }
  })
}

const moduleHints = {
  'API Docs': {
    purpose: 'Discover the Web UI API catalog and generated OpenAPI metadata.',
    keywords: ['操作手册', '接口文档', 'API 文档', 'openapi', 'route catalog'],
  },
  Auth: {
    purpose: 'Manage Web UI authentication state and tokens.',
    keywords: ['auth', 'login', 'token', 'session'],
  },
  'Chat Run': {
    purpose: 'Start a chat or coding-agent run through the HTTP bridge and wait for the result.',
    keywords: ['chat', 'run', 'execute', 'agent', 'model'],
  },
  'Coding Agents': {
    purpose: 'Install, configure, and run coding agents such as Codex or Claude Code.',
    keywords: ['codex', 'claude', 'coding agent', 'install', 'run'],
  },
  Config: {
    purpose: 'Read and update Hermes Web UI configuration.',
    keywords: ['config', 'settings', 'preferences'],
  },
  Devices: {
    purpose: 'Discover, pair, and operate LAN peer devices, terminals, commands, and file transfer.',
    keywords: ['device', 'lan', 'peer', 'terminal', 'file transfer'],
  },
  Files: {
    purpose: 'Browse and operate files exposed through the Hermes file browser.',
    keywords: ['files', 'browser', 'read', 'list', 'download'],
  },
  'Group Chat': {
    purpose: 'Manage multi-participant group chat rooms and messages.',
    keywords: ['group chat', 'room', 'participants', 'messages'],
  },
  Jobs: {
    purpose: 'Create, inspect, update, and run scheduled or background jobs.',
    keywords: ['jobs', 'schedule', 'cron', 'tasks', 'automation'],
  },
  Kanban: {
    purpose: 'Manage boards, columns, cards, and task workflow state.',
    keywords: ['kanban', 'board', 'task', 'card', 'workflow'],
  },
  MCP: {
    purpose: 'Manage MCP servers, tools, and Web UI MCP integration.',
    keywords: ['mcp', 'tools', 'server', 'integration'],
  },
  Media: {
    purpose: 'Generate or manage media assets.',
    keywords: ['media', 'image', 'generation', 'asset'],
  },
  Memory: {
    purpose: 'Read and manage agent memory files.',
    keywords: ['memory', 'agent memory', 'notes'],
  },
  Models: {
    purpose: 'Inspect and configure model ids available to Hermes.',
    keywords: ['models', 'model id', 'llm'],
  },
  Profiles: {
    purpose: 'Manage Hermes profiles and profile-scoped runtime state.',
    keywords: ['profile', 'workspace', 'account'],
  },
  Providers: {
    purpose: 'Manage model provider configuration and credentials metadata.',
    keywords: ['provider', 'model provider', 'api key', 'base url'],
  },
  Sessions: {
    purpose: 'List, inspect, create, update, and delete user-requested chat sessions. Do not use session operations as an internal delegation mechanism.',
    keywords: ['sessions', 'conversation', 'chat history'],
  },
  Skills: {
    purpose: 'Browse and manage skills available to Hermes agents.',
    keywords: ['skills', 'agent skill', 'capability'],
  },
  Terminal: {
    purpose: 'Open interactive terminal sessions over WebSocket.',
    keywords: ['terminal', 'shell', 'websocket'],
  },
  'Write Gate': {
    purpose: 'Review and approve Hermes Agent write operations.',
    keywords: ['approval', 'write gate', 'review'],
  },
}

function compactOperation(path, method, operation) {
  const parameters = compactParameters(operation.parameters)
  const body = compactBodyFields(operation.requestBody)
  return {
    method: method.toUpperCase(),
    path,
    ...(operation.operationId ? { operationId: operation.operationId } : {}),
    ...(Array.isArray(operation.tags) && operation.tags.length ? { tags: operation.tags } : {}),
    ...(operation.summary ? { summary: operation.summary } : {}),
    ...(parameters.path.length ? { pathParams: parameters.path } : {}),
    ...(parameters.query.length ? { queryParams: parameters.query } : {}),
    ...(operation.requestBody ? {
      requestBody: {
        required: operation.requestBody.required === true,
        fields: body,
      },
    } : {}),
  }
}

function collectOpenApiModules(openapi) {
  const descriptions = new Map()
  for (const tag of Array.isArray(openapi?.tags) ? openapi.tags : []) {
    if (typeof tag?.name === 'string') descriptions.set(tag.name, String(tag.description || ''))
  }

  const counts = new Map()
  const paths = isRecord(openapi?.paths) ? openapi.paths : {}
  for (const methods of Object.values(paths)) {
    if (!isRecord(methods)) continue
    for (const [method, operation] of Object.entries(methods)) {
      if (!['get', 'post', 'put', 'patch', 'delete', 'head'].includes(method)) continue
      const tags = Array.isArray(operation?.tags) && operation.tags.length ? operation.tags : ['Untagged']
      for (const tag of tags) counts.set(tag, (counts.get(tag) || 0) + 1)
    }
  }

  return [...counts.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([tag, operationCount]) => ({
      tag,
      operationCount,
      ...(moduleHints[tag]?.purpose ? { purpose: moduleHints[tag].purpose } : {}),
      ...(moduleHints[tag]?.keywords ? { keywords: moduleHints[tag].keywords } : {}),
      ...(descriptions.get(tag) ? { description: descriptions.get(tag) } : {}),
    }))
}

function compactOpenApiDocument(openapi, args = {}) {
  if (args.full === true) return openapi
  const filterPath = typeof args.path === 'string' && args.path.trim() ? pathWithoutQuery(args.path.trim()) : ''
  const filterMethod = typeof args.method === 'string' && args.method.trim()
    ? normalizeApiMethod(args.method)
    : null
  const filterTag = typeof args.tag === 'string' && args.tag.trim() ? args.tag.trim() : ''
  const filters = {
    ...(filterPath ? { path: filterPath } : {}),
    ...(filterMethod ? { method: filterMethod } : {}),
    ...(filterTag ? { tag: filterTag } : {}),
  }
  const hasFilters = Object.keys(filters).length > 0
  const modules = collectOpenApiModules(openapi)
  const operations = []
  const paths = isRecord(openapi?.paths) ? openapi.paths : {}
  for (const [path, methods] of Object.entries(paths)) {
    if (filterPath && path !== filterPath) continue
    if (!isRecord(methods)) continue
    for (const [method, operation] of Object.entries(methods)) {
      if (!['get', 'post', 'put', 'patch', 'delete', 'head'].includes(method)) continue
      if (filterMethod && method !== filterMethod.toLowerCase()) continue
      if (filterTag && !(Array.isArray(operation?.tags) && operation.tags.includes(filterTag))) continue
      operations.push(compactOperation(path, method, operation))
    }
  }

  return {
    title: openapi?.info?.title || 'Ekko Studio API',
    version: openapi?.info?.version || '',
    usage: hasFilters
      ? 'Use the selected operation details to call ekko_studio_api_request with method, path, query, and body. Auth and profile are handled by the MCP server.'
      : 'This catalog is large. First read module purpose and keywords to choose the right module, then call ekko_studio_api_openapi_get again with tag, path, or method filters to fetch endpoint details on demand.',
    moduleCount: modules.length,
    modules,
    ...(Object.keys(filters).length ? { filters } : {}),
    operationCount: operations.length,
    ...(hasFilters ? { operations } : { operationsOmitted: true }),
  }
}

const authArgumentProperties = {
  token: {
    type: 'string',
    description: 'Optional Hermes Web UI bearer token. Usually omit this and pass profile so the MCP server can read the temporary profile token.',
  },
  profile: {
    type: 'string',
    description: 'Hermes profile name for profile-scoped Web UI requests and temporary profile token lookup.',
  },
}

function inputSchema(properties = {}, required = []) {
  return {
    type: 'object',
    properties: { ...authArgumentProperties, ...properties },
    ...(required.length ? { required } : {}),
    additionalProperties: false,
  }
}

function withAuthArgs(args, options = {}) {
  return {
    ...options,
    token: args.token,
    profile: args.profile,
  }
}

const BROWSER_CLIENT_ID = `${SERVER_NAME}:${process.pid}:${randomUUID()}`
let cachedBrowserSession = null

function browserInputSchema(properties = {}, required = []) {
  return {
    type: 'object',
    properties,
    ...(required.length ? { required } : {}),
    additionalProperties: false,
  }
}

function browserDescriptor() {
  let descriptor
  const descriptorPath = join(appHome(), 'desktop-browser', 'broker.json')
  try {
    const info = statSync(descriptorPath)
    if (process.platform !== 'win32' && (info.mode & 0o077) !== 0) throw new Error('unsafe descriptor permissions')
    const directoryInfo = statSync(join(appHome(), 'desktop-browser'))
    if (process.platform !== 'win32' && (directoryInfo.mode & 0o077) !== 0) throw new Error('unsafe descriptor directory permissions')
    descriptor = JSON.parse(readFileSync(descriptorPath, 'utf8'))
  } catch {
    throw new Error('Ekko Studio Desktop Browser is not running. Open the Desktop app and try again.')
  }
  const endpoint = String(descriptor?.endpoint || '')
  const token = String(descriptor?.token || '')
  const parsed = new URL(endpoint)
  if (descriptor?.schema !== 1 || parsed.protocol !== 'http:' || parsed.hostname !== '127.0.0.1' || parsed.pathname !== '/v1' || !token) {
    throw new Error('Desktop Browser Broker descriptor is invalid')
  }
  if (!Number.isInteger(descriptor.desktopPid) || descriptor.desktopPid <= 0) throw new Error('Desktop Browser Broker PID is invalid')
  try { process.kill(descriptor.desktopPid, 0) } catch { throw new Error('Ekko Studio Desktop Browser is no longer running') }
  return { endpoint, token, instanceId: String(descriptor.instanceId || '') }
}

async function browserSession(descriptor) {
  if (cachedBrowserSession?.instanceId === descriptor.instanceId) return cachedBrowserSession
  const sessionUrl = new URL(descriptor.endpoint)
  sessionUrl.pathname = '/v1/session'
  const response = await fetch(sessionUrl, {
    method: 'POST',
    headers: { Authorization: `Bearer ${descriptor.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ client: BROWSER_CLIENT_ID, client_pid: process.pid }),
    signal: AbortSignal.timeout(10_000),
  })
  const payload = await response.json().catch(() => null)
  if (!response.ok || !payload?.client_id || !payload?.session_token) throw new Error(payload?.error || 'Desktop Browser Broker session failed')
  cachedBrowserSession = { instanceId: descriptor.instanceId, clientId: payload.client_id, token: payload.session_token }
  return cachedBrowserSession
}

async function browserRequest(method, params = {}) {
  const descriptor = browserDescriptor()
  const session = await browserSession(descriptor)
  const operationId = randomUUID()
  const response = await fetch(descriptor.endpoint, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${session.token}`,
      'Content-Type': 'application/json',
      'X-Hermes-Browser-Client': session.clientId,
    },
    body: JSON.stringify({ method, params, operation_id: operationId }),
    signal: AbortSignal.timeout(45_000),
  })
  const payload = await response.json().catch(() => null)
  if (!response.ok) throw new Error(payload?.error || `Browser Broker HTTP ${response.status}`)
  return payload
}

function browserScreenshotContent(envelope) {
  const screenshot = envelope?.result
  if (!screenshot?.data || !screenshot?.mediaType) throw new Error('Browser Broker returned an invalid screenshot')
  const metadata = { ...screenshot }
  delete metadata.data
  return {
    content: [
      { type: 'text', text: JSON.stringify({ operation_id: envelope.operation_id, ...metadata }, null, 2) },
      { type: 'image', data: screenshot.data, mimeType: screenshot.mediaType },
    ],
  }
}

function pickDefined(source, keys) {
  const picked = {}
  for (const key of keys) {
    if (source[key] !== undefined) picked[key] = source[key]
  }
  return picked
}

function currentMobileSessionArgs(args) {
  const sessionId = String(process.env.HERMES_STUDIO_SESSION_ID || '').trim()
  return sessionId ? { ...args, session_id: sessionId } : args
}
function boundedInteger(value, fallback, min, max) {
  const parsed = Number.parseInt(String(value ?? ''), 10)
  if (!Number.isFinite(parsed)) return fallback
  return Math.max(min, Math.min(max, parsed))
}

function cleanSessionContextPayload(payload, args = {}) {
  const turns = boundedInteger(args.turns, 10, 1, 50)
  const messages = Array.isArray(payload?.messages) ? payload.messages : []
  const cleanMessages = messages
    .filter(message => message?.role === 'user' || message?.role === 'assistant')
    .filter(message => !Array.isArray(message?.tool_calls) || message.tool_calls.length === 0)
    .filter(message => !message?.tool_call_id && !message?.tool_name)
    .map(message => pickDefined(message, [
      'id',
      'session_id',
      'role',
      'content',
      'timestamp',
      'reasoning',
      'reasoning_content',
    ]))
    .filter(message => typeof message.content === 'string' ? message.content.trim() : message.content != null)
  const maxMessages = turns * 2
  const returnedMessages = cleanMessages.slice(-maxMessages)
  return {
    ...payload,
    messages: returnedMessages,
    message_count: returnedMessages.length,
    clean_message_count: cleanMessages.length,
    requested_turns: turns,
  }
}

function summarizeWorkerRuntime(payload) {
  const workers = Array.isArray(payload?.bridge?.workers) ? payload.bridge.workers : []
  const summarizedWorkers = workers.map(worker => {
    const sessionCount = Number(worker?.sessionCount || 0)
    const interactingSessionCount = Number(worker?.runningSessionCount || 0)
    return {
      profile: worker?.profile || '',
      pid: worker?.pid || 0,
      running: Boolean(worker?.running),
      session_count: sessionCount,
      interacting_session_count: interactingSessionCount,
      completed_interaction_count: Math.max(0, sessionCount - interactingSessionCount),
      last_used_at: worker?.lastUsedAt || null,
      endpoint: worker?.endpoint || '',
    }
  })
  const interactingWorkers = summarizedWorkers.filter(worker => worker.interacting_session_count > 0)
  const completedWorkers = summarizedWorkers.filter(worker => worker.session_count > 0 && worker.interacting_session_count === 0)
  return {
    timestamp: payload?.timestamp || Date.now(),
    bridge_reachable: Boolean(payload?.bridge?.reachable),
    worker_count: summarizedWorkers.length,
    running_worker_count: summarizedWorkers.filter(worker => worker.running).length,
    session_count: summarizedWorkers.reduce((sum, worker) => sum + worker.session_count, 0),
    interacting_session_count: summarizedWorkers.reduce((sum, worker) => sum + worker.interacting_session_count, 0),
    completed_interaction_count: summarizedWorkers.reduce((sum, worker) => sum + worker.completed_interaction_count, 0),
    interacting_workers: interactingWorkers,
    completed_workers: completedWorkers,
    workers: summarizedWorkers,
  }
}

function availableModelGroups(payload) {
  const groups = Array.isArray(payload?.groups)
    ? payload.groups
    : Array.isArray(payload?.providers)
      ? payload.providers
      : []
  return groups
    .map(group => ({
      provider: String(group?.provider || group?.id || '').trim(),
      label: String(group?.label || group?.name || group?.provider || group?.id || '').trim(),
      models: Array.isArray(group?.models) ? group.models.map(model => String(model || '').trim()).filter(Boolean) : [],
      model_meta: group?.model_meta && typeof group.model_meta === 'object' && !Array.isArray(group.model_meta)
        ? group.model_meta
        : {},
    }))
    .filter(group => group.provider && group.models.length > 0)
}

function findProvidersForModel(payload, model) {
  const target = String(model || '').trim()
  if (!target) return { model: target, found: false, provider: null, providers: [], ambiguous: false }
  const targetLower = target.toLowerCase()
  const matches = []
  for (const group of availableModelGroups(payload)) {
    for (const candidate of group.models) {
      const alias = typeof group.model_meta?.[candidate]?.alias === 'string'
        ? group.model_meta[candidate].alias.trim()
        : ''
      const matchType = candidate === target
        ? 'exact'
        : candidate.toLowerCase() === targetLower
          ? 'case_insensitive'
          : alias && alias === target
            ? 'alias'
            : alias && alias.toLowerCase() === targetLower
              ? 'alias_case_insensitive'
              : ''
      if (!matchType) continue
      matches.push({
        provider: group.provider,
        label: group.label || group.provider,
        model: candidate,
        match: matchType,
        ...(alias ? { alias } : {}),
      })
    }
  }
  const defaultProvider = String(payload?.default_provider || '').trim()
  const defaultModel = String(payload?.default || '').trim()
  const preferred = matches.find(match => match.provider === defaultProvider && match.model === defaultModel) ||
    matches.find(match => match.match === 'exact') ||
    matches[0]
  return {
    model: target,
    found: matches.length > 0,
    provider: preferred?.provider || null,
    providers: matches,
    ambiguous: matches.length > 1,
  }
}

function modelAlias(group, model) {
  const alias = group.model_meta?.[model]?.alias
  return typeof alias === 'string' ? alias.trim() : ''
}

function compactAvailableModelsPayload(payload, args = {}) {
  if (args.include_details === true) return payload

  const query = String(args.query || '').trim()
  const queryLower = query.toLowerCase()
  const limit = boundedInteger(args.limit_per_provider, 20, 1, 100)
  const groups = availableModelGroups(payload)
  const providers = []
  let returnedModelCount = 0
  let matchedModelCount = 0

  for (const group of groups) {
    const providerMatches = queryLower &&
      (`${group.provider} ${group.label}`).toLowerCase().includes(queryLower)
    const matchedModels = queryLower
      ? group.models.filter(model => {
          const alias = modelAlias(group, model)
          return providerMatches ||
            model.toLowerCase().includes(queryLower) ||
            Boolean(alias && alias.toLowerCase().includes(queryLower))
        })
      : group.models
    if (queryLower && matchedModels.length === 0) continue

    const returnedModels = matchedModels.slice(0, limit)
    const aliases = {}
    for (const model of returnedModels) {
      const alias = modelAlias(group, model)
      if (alias) aliases[model] = alias
    }
    matchedModelCount += matchedModels.length
    returnedModelCount += returnedModels.length
    providers.push({
      provider: group.provider,
      label: group.label || group.provider,
      model_count: group.models.length,
      matched_model_count: matchedModels.length,
      returned_model_count: returnedModels.length,
      omitted_model_count: Math.max(0, matchedModels.length - returnedModels.length),
      models: returnedModels,
      ...(Object.keys(aliases).length ? { aliases } : {}),
    })
  }

  const totalModelCount = groups.reduce((sum, group) => sum + group.models.length, 0)
  return {
    default: payload?.default || '',
    default_provider: payload?.default_provider || '',
    provider_count: groups.length,
    model_count: totalModelCount,
    returned_provider_count: providers.length,
    returned_model_count: returnedModelCount,
    matched_model_count: queryLower ? matchedModelCount : totalModelCount,
    limit_per_provider: limit,
    ...(query ? { query } : {}),
    providers,
    note: 'Compact MCP response. Use query to narrow models, limit_per_provider to adjust returned models, or include_details=true to return the raw available-models payload.',
  }
}

const tools = [
  {
    name: 'ekko_studio_browser_tabs',
    toolset: 'browser',
    description: 'List, create, activate, close, or release control of Ekko Studio Desktop browser tabs. Reuse explicit tab_id values across calls.',
    inputSchema: browserInputSchema({
      action: { type: 'string', enum: ['list', 'create', 'activate', 'close', 'release'] },
      tab_id: { type: 'string', description: 'Required for activate, close, and release.' },
      url: { type: 'string', description: 'Optional HTTP/HTTPS URL for a new tab.' },
      activate: { type: 'boolean', description: 'Whether a newly created tab becomes visible. Defaults to true.' },
    }, ['action']),
  },
  {
    name: 'ekko_studio_browser_navigate',
    toolset: 'browser',
    description: 'Open an HTTP/HTTPS URL or move back, forward, reload, or stop one Ekko Studio Desktop browser tab.',
    inputSchema: browserInputSchema({
      tab_id: { type: 'string' },
      action: { type: 'string', enum: ['open', 'back', 'forward', 'reload', 'stop'], description: 'Defaults to open when url is provided.' },
      url: { type: 'string', description: 'Required when action is open.' },
    }, ['tab_id']),
  },
  {
    name: 'ekko_studio_browser_snapshot',
    toolset: 'browser',
    description: 'Return a bounded accessibility snapshot with stable element refs. Pass its snapshot_id to read text, click, or type; stale snapshots are rejected.',
    inputSchema: browserInputSchema({ tab_id: { type: 'string' } }, ['tab_id']),
  },
  {
    name: 'ekko_studio_browser_read_text',
    toolset: 'browser',
    description: 'Read a bounded page of rendered text from one ref in the latest accessibility snapshot. Use nextOffset while hasMore is true to continue long text safely.',
    inputSchema: browserInputSchema({
      tab_id: { type: 'string' },
      snapshot_id: { type: 'string' },
      ref: { type: 'string' },
      mode: { type: 'string', enum: ['innerText', 'textContent'], description: 'Defaults to innerText. Text refs use their parent element for innerText.' },
      offset: { type: 'number', minimum: 0, description: 'Zero-based source character offset. Defaults to 0.' },
      limit: { type: 'number', minimum: 1, maximum: 20000, description: 'Maximum source characters to return. Defaults to 4000.' },
    }, ['tab_id', 'snapshot_id', 'ref']),
  },
  {
    name: 'ekko_studio_browser_interact',
    toolset: 'browser',
    description: 'Click, type, press a key, or scroll in one Desktop browser tab. Click/type require a ref and snapshot_id from the latest snapshot.',
    inputSchema: browserInputSchema({
      tab_id: { type: 'string' },
      action: { type: 'string', enum: ['click', 'type', 'press', 'scroll'] },
      ref: { type: 'string' }, snapshot_id: { type: 'string' }, text: { type: 'string' }, key: { type: 'string' },
      direction: { type: 'string', enum: ['up', 'down', 'left', 'right'] }, pixels: { type: 'number' },
    }, ['tab_id', 'action']),
  },
  {
    name: 'ekko_studio_browser_screenshot',
    toolset: 'browser',
    description: 'Capture the visible viewport or bounded full page as a real MCP image content block for visual reasoning.',
    inputSchema: browserInputSchema({ tab_id: { type: 'string' }, full_page: { type: 'boolean' } }, ['tab_id']),
  },
  {
    name: 'ekko_studio_browser_console',
    toolset: 'browser',
    description: 'Read or clear the bounded console log for one Desktop browser tab.',
    inputSchema: browserInputSchema({ tab_id: { type: 'string' }, action: { type: 'string', enum: ['read', 'clear'] } }, ['tab_id', 'action']),
  },
  {
    name: 'ekko_studio_api_openapi_get',
    toolset: 'api',
    description: 'Return Ekko Studio API documentation as compact JSON. When the user asks to read/check the operation manual, API docs, endpoint docs, 接口文档, 接口手册, or 操作手册, call this tool without filters first to get the outline/module index. Without filters, returns only module purpose, keywords, and operation counts because the full API catalog is large. For endpoint details, call again with tag, path, or method filters, then use ekko_studio_api_request.',
    inputSchema: inputSchema({
        path: {
          type: 'string',
          description: 'Optional exact endpoint path filter for on-demand details, for example /api/studio/chat-run/runs.',
        },
        method: {
          type: 'string',
          enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'],
          description: 'Optional HTTP method filter. Usually combine with path or tag.',
        },
        tag: {
          type: 'string',
          description: 'Optional module/tag filter. Recommended flow: call without filters to list modules, then call with one module tag for details.',
        },
        full: {
          type: 'boolean',
          description: 'Return the raw full OpenAPI JSON. Defaults to false; prefer compact JSON output for agent use.',
        },
      }),
  },
  {
    name: 'ekko_studio_api_request',
    toolset: 'api',
    description: 'Execute a Ekko Studio operation by calling an endpoint path. Use ekko_studio_api_openapi_get first as the operation manual to inspect method, parameters, requestBody, and responses. Do not use /api/studio/chat-run/* or /api/studio/sessions/* as an internal delegation mechanism.',
    inputSchema: inputSchema({
        method: {
          type: 'string',
          enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'],
          description: 'HTTP method. Defaults to GET.',
        },
        path: {
          type: 'string',
          description: 'Relative Ekko Studio endpoint path from the operation manual, for example /api/studio/sessions?limit=20. Full URLs and // paths are rejected.',
        },
        body: {
          type: ['object', 'array', 'string', 'number', 'boolean', 'null'],
          description: 'Optional JSON request body for POST/PUT/PATCH/DELETE. GET and HEAD ignore body.',
        },
        query: {
          type: 'object',
          description: 'Optional query parameters merged into path. Values are serialized as strings; arrays append repeated parameters.',
          additionalProperties: true,
        },
        headers: {
          type: 'object',
          description: 'Optional request headers. Allowed names: accept, accept-language, content-type, x-request-id. Authorization and X-Hermes-Profile are filled from token/profile.',
          additionalProperties: {
            type: ['string', 'number', 'boolean', 'array'],
          },
        },
      }, ['path']),
  },
  {
    name: 'ekko_studio_update_plan',
    toolset: 'use',
    description: 'Create or update the current turn task plan shown in Studio and App. For multi-step work, send the full ordered plan before starting and whenever progress changes. Keep step ids stable, use at most one in_progress step, and mark completion only after verification. Requires the context_id supplied in the current run instructions; cannot start a run or modify another turn.',
    inputSchema: inputSchema({
      context_id: { type: 'string', description: 'Current turn context supplied by Studio. Never reuse a previous turn context.' },
      explanation: { type: 'string', maxLength: 1000 },
      plan: {
        type: 'array', minItems: 1, maxItems: 30,
        items: {
          type: 'object', additionalProperties: false, required: ['id', 'step', 'status'],
          properties: {
            id: { type: 'string', minLength: 1, maxLength: 100 },
            step: { type: 'string', minLength: 1, maxLength: 200 },
            status: { type: 'string', enum: ['pending', 'in_progress', 'completed'] },
          },
        },
      },
    }, ['context_id', 'plan']),
  },
  {
    name: 'ekko_studio_use_chat_run',
    toolset: 'use',
    description: 'Start one user-requested Ekko Studio chat or coding-agent run through the HTTP bridge and wait for completion. Do not use this as an internal delegation or subtask mechanism.',
    inputSchema: inputSchema({
        input: {
          oneOf: [
            { type: 'string' },
            { type: 'array', items: { type: 'object', additionalProperties: true } },
          ],
          description: 'User message text or content blocks.',
        },
        session_id: {
          type: 'string',
          description: 'Optional existing session id. Omit to create a new session.',
        },
        provider: {
          type: 'string',
          description: 'Optional model provider key, for example openai, anthropic, or deepseek.',
        },
        model: {
          type: 'string',
          description: 'Optional model id for this run.',
        },
        model_groups: {
          type: 'array',
          description: 'Optional provider/model fallback groups.',
          items: { type: 'object', additionalProperties: true },
        },
        source: {
          type: 'string',
          enum: ['cli', 'coding_agent', 'global_agent'],
          description: 'Optional run backend source.',
        },
        session_source: {
          type: 'string',
          enum: ['global_agent'],
          description: 'Optional session source marker.',
        },
        instructions: {
          type: 'string',
          description: 'Optional extra run instructions.',
        },
        workspace: {
          type: ['string', 'null'],
          description: 'Optional working directory for the run.',
        },
        reasoning_effort: {
          type: 'string',
          description: 'Optional per-run reasoning effort override.',
        },
        coding_agent_id: {
          type: 'string',
          enum: ['claude-code', 'codex', 'pi', 'grok', 'opencode', 'ekko-agent'],
          description: 'Coding agent id when source is coding_agent.',
        },
        agent_id: {
          type: 'string',
          enum: ['claude-code', 'codex', 'pi', 'grok', 'opencode', 'ekko-agent'],
          description: 'Alias for coding_agent_id.',
        },
        mode: {
          type: 'string',
          enum: ['scoped', 'global'],
          description: 'Coding-agent launch mode.',
        },
        baseUrl: {
          type: 'string',
          description: 'Optional provider base URL for coding-agent runs.',
        },
        apiKey: {
          type: 'string',
          description: 'Optional provider API key for coding-agent runs.',
        },
        apiMode: {
          type: 'string',
          enum: ['chat_completions', 'codex_responses', 'anthropic_messages'],
          description: 'Optional provider wire API mode for coding-agent runs.',
        },
        timeout_ms: {
          type: 'number',
          description: 'Maximum time to wait for a terminal run event.',
        },
        include_events: {
          type: 'boolean',
          description: 'Include recorded run events in the response.',
        },
      }, ['input']),
  },
  {
    name: 'ekko_studio_use_sessions_list',
    toolset: 'use',
    description: 'List Ekko Studio chat sessions for an explicit user-requested session operation. Do not use this as an internal delegation mechanism.',
    inputSchema: inputSchema({
        limit: {
          type: 'number',
          description: 'Optional maximum number of sessions.',
        },
        source: {
          type: 'string',
          description: 'Optional session source filter.',
        },
      }),
  },
  {
    name: 'ekko_studio_use_sessions_count',
    toolset: 'use',
    description: 'Count Ekko Studio chat sessions without returning the session list. Do not use this as an internal delegation mechanism.',
    inputSchema: inputSchema({
        source: {
          type: 'string',
          description: 'Optional session source filter.',
        },
      }),
  },
  {
    name: 'ekko_studio_use_usage_stats',
    toolset: 'use',
    description: 'Query Ekko Studio usage totals, cost estimate, model breakdown, and daily trend for the selected profile.',
    inputSchema: inputSchema({
        days: {
          type: 'number',
          description: 'Number of days to include. Server clamps the range to 1-365. Defaults to 30.',
        },
      }),
  },
  {
    name: 'ekko_studio_use_session_get',
    toolset: 'use',
    description: 'Get one Ekko Studio session by id for an explicit user-requested session operation. Do not use this as an internal delegation mechanism.',
    inputSchema: inputSchema({
        session_id: {
          type: 'string',
          description: 'Session id.',
        },
      }, ['session_id']),
  },
  {
    name: 'ekko_studio_use_session_messages',
    toolset: 'use',
    description: 'Get messages for one Ekko Studio conversation. By default returns user and assistant messages only. Do not use this as an internal delegation mechanism.',
    inputSchema: inputSchema({
        session_id: {
          type: 'string',
          description: 'Conversation/session id.',
        },
        include_internal: {
          type: 'boolean',
          description: 'Set true to include internal/non-user-visible message roles.',
        },
      }, ['session_id']),
  },
  {
    name: 'ekko_studio_use_session_context',
    toolset: 'use',
    description: 'Get the latest clean user/assistant context for one session, defaulting to the last 10 conversation turns and excluding tool calls/tool results. Do not use this as an internal delegation mechanism.',
    inputSchema: inputSchema({
        session_id: {
          type: 'string',
          description: 'Session id.',
        },
        turns: {
          type: 'number',
          description: 'Number of recent conversation turns to return. Defaults to 10.',
        },
      }, ['session_id']),
  },
  {
    name: 'ekko_studio_use_session_delete',
    toolset: 'use',
    description: 'Delete one Ekko Studio session by id for an explicit user-requested session operation. Do not use this as an internal delegation mechanism.',
    inputSchema: inputSchema({
        session_id: {
          type: 'string',
          description: 'Session id to delete.',
        },
      }, ['session_id']),
  },
  {
    name: 'ekko_studio_use_session_rename',
    toolset: 'use',
    description: 'Rename one Ekko Studio session title for an explicit user-requested session operation. Do not use this as an internal delegation mechanism.',
    inputSchema: inputSchema({
        session_id: {
          type: 'string',
          description: 'Session id to rename.',
        },
        title: {
          type: 'string',
          description: 'New session title.',
        },
      }, ['session_id', 'title']),
  },
  {
    name: 'ekko_studio_use_profiles_list',
    toolset: 'use',
    description: 'List Ekko Studio profiles.',
    inputSchema: inputSchema(),
  },
  {
    name: 'ekko_studio_use_available_models',
    toolset: 'use',
    description: 'List available Ekko Studio models for the selected profile as a compact provider/model summary. Use query to narrow results or include_details=true only when raw provider metadata is required.',
    inputSchema: inputSchema({
        query: {
          type: 'string',
          description: 'Optional case-insensitive provider, model, or alias substring filter.',
        },
        limit_per_provider: {
          type: 'number',
          description: 'Maximum model ids to return for each provider. Defaults to 20, maximum 100.',
        },
        include_details: {
          type: 'boolean',
          description: 'Return the raw /api/hermes/available-models payload, including full provider metadata. Defaults to false.',
        },
      }),
  },
  {
    name: 'ekko_studio_use_model_provider_get',
    toolset: 'use',
    description: 'Find provider candidates for a model id from the selected profile available-models catalog.',
    inputSchema: inputSchema({
        model: {
          type: 'string',
          description: 'Model id or visible model alias to look up.',
        },
      }, ['model']),
  },
  {
    name: 'ekko_studio_use_provider_add',
    toolset: 'use',
    description: 'Add or update a Ekko Studio model provider for the selected profile, then make it the active default provider/model.',
    inputSchema: inputSchema({
        name: {
          type: 'string',
          description: 'Provider display/config name. For custom providers this becomes the custom provider name.',
        },
        base_url: {
          type: 'string',
          description: 'Provider API base URL. For built-in providers this can be omitted only when the preset supplies a default URL.',
        },
        api_key: {
          type: 'string',
          description: 'Provider API key. Some built-in providers do not require this.',
        },
        model: {
          type: 'string',
          description: 'Default model id to use with this provider.',
        },
        context_length: {
          type: 'number',
          description: 'Optional context length metadata for the model.',
        },
        providerKey: {
          type: ['string', 'null'],
          description: 'Optional built-in or custom provider key. Omit for a normal custom provider; use values like openai-codex or custom:my-provider when needed.',
        },
        api_mode: {
          type: 'string',
          enum: ['chat_completions', 'codex_responses', 'anthropic_messages', 'bedrock_converse', 'codex_app_server'],
          description: 'Optional provider wire API mode.',
        },
      }, ['name', 'base_url', 'model']),
  },
  {
    name: 'ekko_studio_use_provider_delete',
    toolset: 'use',
    description: 'Delete a Ekko Studio model provider or clear a built-in provider credential for the selected profile.',
    inputSchema: inputSchema({
        pool_key: {
          type: 'string',
          description: 'Provider pool key to delete, for example custom:my-provider, openai, openai-codex, or deepseek.',
        },
        source: {
          type: 'string',
          enum: ['custom_providers', 'providers'],
          description: 'Optional custom provider storage source when removing one duplicate location.',
        },
        providerKey: {
          type: 'string',
          description: 'Optional providers-dict key to disambiguate dict-backed custom providers.',
        },
      }, ['pool_key']),
  },
  {
    name: 'ekko_studio_use_worker_status',
    toolset: 'use',
    description: 'Summarize current Hermes worker state, including worker count, completed interactions, and sessions still interacting.',
    inputSchema: inputSchema(),
  },
  {
    name: 'ekko_studio_use_mobile_location',
    toolset: 'use',
    description: 'Request the user’s current mobile-device location once for the current direct chat. The App always asks the user to confirm before sharing WGS84 coordinates. Never use proactively, for background tracking, or from delegated/workflow tasks.',
    inputSchema: inputSchema({
        session_id: {
          type: 'string',
          description: 'Exact current Ekko Studio direct-chat session id supplied in the run context.',
        },
        purpose: {
          type: 'string',
          description: 'Short user-visible explanation of why the current location is needed.',
        },
        accuracy: {
          type: 'string',
          enum: ['coarse', 'precise'],
          description: 'Requested accuracy. Defaults to coarse; use precise only when necessary for the user’s request.',
        },
        timeout_ms: {
          type: 'number',
          description: 'Maximum time to wait for the user and device, from 3000 to 60000 milliseconds.',
        },
      }, ['session_id', 'purpose']),
  },
  {
    name: 'ekko_studio_use_mobile_calendar',
    toolset: 'use',
    description: 'With the user’s explicit request, ask their mobile App to list, create, update, or delete calendar events in the current direct chat. The App always requires one-time confirmation. Single-item delete requires exact listed id, title and start_ms (calendar) or due_ms when present (reminder), with fresh App confirmation. Background access is not supported.',
    inputSchema: inputSchema({
      session_id: { type: 'string', description: 'Exact current Ekko Studio direct-chat session id supplied in the run context.' },
      action: { type: 'string', enum: ['list', 'create', 'update', 'delete'], description: 'Calendar operation.' },
      purpose: { type: 'string', description: 'Short user-visible reason for the request.' },
      start_ms: { type: 'number', description: 'List range start as Unix milliseconds.' },
      end_ms: { type: 'number', description: 'List range end as Unix milliseconds; maximum range is 31 days.' },
      limit: { type: 'number', description: 'Maximum list result count, from 1 to 100.' },
      item: { type: 'object', additionalProperties: true, description: 'Event fields for create/update: id (update), title, start_ms, end_ms, all_day, location, notes, reminder_minutes.' },
      timeout_ms: { type: 'number', minimum: 3000, maximum: 300000, default: 300000, description: 'Wait time for user confirmation, from 3000 to 300000 milliseconds. Defaults to 5 minutes, matching the App consent card. Omit unless the user requests a shorter wait.' },
    }, ['session_id', 'action', 'purpose']),
  },
  {
    name: 'ekko_studio_use_mobile_reminders',
    toolset: 'use',
    description: 'With the user’s explicit request, ask their mobile App to list, create, update, complete, or delete reminders in the current direct chat. The App always requires one-time confirmation. Single-item delete requires exact listed id, title and start_ms (calendar) or due_ms when present (reminder), with fresh App confirmation. Background access is not supported.',
    inputSchema: inputSchema({
      session_id: { type: 'string', description: 'Exact current Ekko Studio direct-chat session id supplied in the run context.' },
      action: { type: 'string', enum: ['list', 'create', 'update', 'complete', 'delete'], description: 'Reminder operation.' },
      purpose: { type: 'string', description: 'Short user-visible reason for the request.' },
      start_ms: { type: 'number', description: 'List range start as Unix milliseconds.' },
      end_ms: { type: 'number', description: 'List range end as Unix milliseconds; maximum range is 31 days.' },
      include_completed: { type: 'boolean', description: 'Include completed reminders when listing.' },
      limit: { type: 'number', description: 'Maximum list result count, from 1 to 100.' },
      item: { type: 'object', additionalProperties: true, description: 'Reminder fields: id (update/complete), title, due_ms, notes, priority, completed.' },
      timeout_ms: { type: 'number', minimum: 3000, maximum: 300000, default: 300000, description: 'Wait time for user confirmation, from 3000 to 300000 milliseconds. Defaults to 5 minutes, matching the App consent card. Omit unless the user requests a shorter wait.' },
    }, ['session_id', 'action', 'purpose']),
  },
  {
    name: 'ekko_studio_use_mobile_health',
    toolset: 'use',
    description: 'With the user’s explicit request, ask their iPhone or iPad App to read selected Apple HealthKit data once in the current direct chat. iOS only; read-only; no background collection, diagnosis, advertising, delegated tasks, workflows, or group chats.',
    inputSchema: inputSchema({
      session_id: { type: 'string', description: 'Exact current Ekko Studio direct-chat session id supplied in the run context.' },
      purpose: { type: 'string', description: 'Short user-visible reason for reading the health data.' },
      metrics: { type: 'array', items: { type: 'string', enum: ['steps', 'sleep', 'heart_rate', 'resting_heart_rate', 'heart_rate_variability', 'oxygen_saturation', 'body_weight', 'active_energy', 'distance_walking_running', 'workouts'] }, minItems: 1, uniqueItems: true, description: 'Health metrics to read.' },
      start_ms: { type: 'number', description: 'Range start as Unix milliseconds.' },
      end_ms: { type: 'number', description: 'Range end as Unix milliseconds, not in the future; maximum range is 31 days.' },
      limit: { type: 'number', minimum: 1, maximum: 100, description: 'Maximum sleep or workout records returned.' },
      timeout_ms: { type: 'number', minimum: 3000, maximum: 300000, default: 300000, description: 'Wait time for one-time App confirmation.' },
    }, ['session_id', 'purpose', 'metrics', 'start_ms', 'end_ms']),
  },
  {
    name: 'ekko_studio_use_workflows_list',
    toolset: 'use',
    description: 'List Ekko Studio workflows for the selected or requested profile.',
    inputSchema: inputSchema({
        profile: {
          type: 'string',
          description: 'Optional profile filter. When omitted, the active MCP profile is used through X-Hermes-Profile.',
        },
      }),
  },
  {
    name: 'ekko_studio_use_workflow_get',
    toolset: 'use',
    description: 'Get one Ekko Studio workflow by id.',
    inputSchema: inputSchema({
        workflow_id: {
          type: 'string',
          description: 'Workflow id.',
        },
      }, ['workflow_id']),
  },
  {
    name: 'ekko_studio_use_workflow_create',
    toolset: 'use',
    description: 'Create a Ekko Studio workflow with optional nodes, edges, viewport, workspace, and profile.',
    inputSchema: inputSchema({
        name: {
          type: 'string',
          description: 'Workflow name.',
        },
        profile: {
          type: 'string',
          description: 'Optional workflow profile. Defaults to the active MCP profile or server default.',
        },
        workspace: {
          type: ['string', 'null'],
          description: 'Optional workflow workspace path.',
        },
        nodes: {
          type: 'array',
          description: 'Optional workflow node array.',
          items: { type: 'object', additionalProperties: true },
        },
        edges: {
          type: 'array',
          description: 'Optional workflow edge array.',
          items: { type: 'object', additionalProperties: true },
        },
        viewport: {
          type: ['object', 'null'],
          description: 'Optional workflow viewport state.',
          additionalProperties: true,
        },
      }, ['name']),
  },
  {
    name: 'ekko_studio_use_workflow_update',
    toolset: 'use',
    description: 'Update a Ekko Studio workflow name, workspace, nodes, edges, or viewport.',
    inputSchema: inputSchema({
        workflow_id: {
          type: 'string',
          description: 'Workflow id.',
        },
        name: {
          type: 'string',
          description: 'Optional new workflow name.',
        },
        workspace: {
          type: ['string', 'null'],
          description: 'Optional workspace path update.',
        },
        nodes: {
          type: 'array',
          description: 'Optional replacement workflow node array.',
          items: { type: 'object', additionalProperties: true },
        },
        edges: {
          type: 'array',
          description: 'Optional replacement workflow edge array.',
          items: { type: 'object', additionalProperties: true },
        },
        viewport: {
          type: ['object', 'null'],
          description: 'Optional replacement workflow viewport state.',
          additionalProperties: true,
        },
      }, ['workflow_id']),
  },
  {
    name: 'ekko_studio_use_workflow_delete',
    toolset: 'use',
    description: 'Delete one Ekko Studio workflow by id, including its workflow run records.',
    inputSchema: inputSchema({
        workflow_id: {
          type: 'string',
          description: 'Workflow id to delete.',
        },
      }, ['workflow_id']),
  },
  {
    name: 'ekko_studio_use_workflow_runs_list',
    toolset: 'use',
    description: 'List recent run records and node sessions for one workflow.',
    inputSchema: inputSchema({
        workflow_id: {
          type: 'string',
          description: 'Workflow id.',
        },
        limit: {
          type: 'number',
          description: 'Optional maximum number of workflow runs.',
        },
      }, ['workflow_id']),
  },
  {
    name: 'ekko_studio_use_workflow_run_start',
    toolset: 'use',
    description: 'Start a workflow run. Returns accepted status while the workflow continues asynchronously.',
    inputSchema: inputSchema({
        workflow_id: {
          type: 'string',
          description: 'Workflow id.',
        },
        start_node_ids: {
          type: 'array',
          description: 'Optional node ids to start from.',
          items: { type: 'string' },
        },
        input: {
          type: ['string', 'null'],
          description: 'Optional workflow input text.',
        },
        timeout_ms: {
          type: 'integer',
          minimum: 1000,
          maximum: 86400000,
          description: 'Optional total Workflow Run budget in milliseconds. Omit for no deadline.',
        },
      }, ['workflow_id']),
  },
  {
    name: 'ekko_studio_use_workflow_run_stop',
    toolset: 'use',
    description: 'Cancel a queued or running workflow run.',
    inputSchema: inputSchema({
        workflow_id: {
          type: 'string',
          description: 'Workflow id.',
        },
        run_id: {
          type: 'string',
          description: 'Workflow run id.',
        },
      }, ['workflow_id', 'run_id']),
  },
  {
    name: 'ekko_studio_use_workflow_rerun_node',
    toolset: 'use',
    description: 'Rerun an existing workflow run from a node. Use preserve_start_node=true to keep the selected node message and only rerun downstream nodes; false clears the selected node and downstream sessions.',
    inputSchema: inputSchema({
        workflow_id: {
          type: 'string',
          description: 'Workflow id.',
        },
        run_id: {
          type: 'string',
          description: 'Workflow run id.',
        },
        node_id: {
          type: 'string',
          description: 'Node id to rerun from.',
        },
        preserve_start_node: {
          type: 'boolean',
          description: 'When true, keep the selected node session and rerun downstream nodes only. Defaults to false on the server.',
        },
        timeout_ms: {
          type: 'integer',
          minimum: 1000,
          maximum: 86400000,
          description: 'Optional total Workflow Run budget in milliseconds. Omit for no deadline.',
        },
      }, ['workflow_id', 'run_id', 'node_id']),
  },
  {
    name: 'ekko_studio_use_workflow_run_delete',
    toolset: 'use',
    description: 'Delete one workflow run and its node session records.',
    inputSchema: inputSchema({
        workflow_id: {
          type: 'string',
          description: 'Workflow id.',
        },
        run_id: {
          type: 'string',
          description: 'Workflow run id.',
        },
      }, ['workflow_id', 'run_id']),
  },
  {
    name: 'ekko_studio_lan_devices_list',
    toolset: 'devices',
    description: 'List known LAN and remote devices from Hermes Web UI, including pairing and online status.',
    inputSchema: inputSchema(),
  },
  {
    name: 'ekko_studio_lan_devices_scan',
    toolset: 'devices',
    description: 'Refresh LAN device discovery cache and return known devices with pairing and online status.',
    inputSchema: inputSchema(),
  },
  {
    name: 'ekko_studio_lan_peer_connect',
    toolset: 'devices',
    description: 'Connect to a paired LAN device by device id.',
    inputSchema: inputSchema({ device_id: { type: 'string' } }, ['device_id']),
  },
  {
    name: 'ekko_studio_lan_peer_connections',
    toolset: 'devices',
    description: 'List active LAN peer socket connections.',
    inputSchema: inputSchema(),
  },
  {
    name: 'ekko_studio_lan_peer_disconnect',
    toolset: 'devices',
    description: 'Disconnect an active LAN peer socket connection.',
    inputSchema: inputSchema({ connection_id: { type: 'string' } }, ['connection_id']),
  },
  {
    name: 'ekko_studio_lan_terminal_create',
    toolset: 'devices',
    description: 'Create an interactive terminal on a connected LAN peer.',
    inputSchema: inputSchema({
        connection_id: { type: 'string' },
        shell: { type: 'string' },
        cols: { type: 'number' },
        rows: { type: 'number' },
      }, ['connection_id']),
  },
  {
    name: 'ekko_studio_lan_terminal_list',
    toolset: 'devices',
    description: 'List interactive terminals tracked for a connected LAN peer, including IDs that can be read or closed.',
    inputSchema: inputSchema({
        connection_id: { type: 'string' },
      }, ['connection_id']),
  },
  {
    name: 'ekko_studio_lan_terminal_input',
    toolset: 'devices',
    description: 'Write input to an interactive terminal on a connected LAN peer.',
    inputSchema: inputSchema({
        connection_id: { type: 'string' },
        terminal_id: { type: 'string' },
        data: { type: 'string' },
      }, ['connection_id', 'terminal_id', 'data']),
  },
  {
    name: 'ekko_studio_lan_terminal_read',
    toolset: 'devices',
    description: 'Read buffered terminal output from an interactive terminal.',
    inputSchema: inputSchema({
        connection_id: { type: 'string' },
        terminal_id: { type: 'string' },
      }, ['connection_id', 'terminal_id']),
  },
  {
    name: 'ekko_studio_lan_terminal_resize',
    toolset: 'devices',
    description: 'Resize an interactive terminal on a connected LAN peer.',
    inputSchema: inputSchema({
        connection_id: { type: 'string' },
        terminal_id: { type: 'string' },
        cols: { type: 'number' },
        rows: { type: 'number' },
      }, ['connection_id', 'terminal_id', 'cols', 'rows']),
  },
  {
    name: 'ekko_studio_lan_terminal_close',
    toolset: 'devices',
    description: 'Close an interactive terminal on a connected LAN peer.',
    inputSchema: inputSchema({
        connection_id: { type: 'string' },
        terminal_id: { type: 'string' },
      }, ['connection_id', 'terminal_id']),
  },
  {
    name: 'ekko_studio_lan_command_exec',
    toolset: 'devices',
    description: 'Run a command on a connected LAN peer using command plus args, without shell string execution.',
    inputSchema: inputSchema({
        connection_id: { type: 'string' },
        command: { type: 'string' },
        args: { type: 'array', items: { type: 'string' } },
        cwd: { type: 'string' },
        timeout_ms: { type: 'number' },
      }, ['connection_id', 'command']),
  },
  {
    name: 'ekko_studio_lan_file_download',
    toolset: 'devices',
    description: 'Download a file from a connected LAN peer remote path to a local path on this machine.',
    inputSchema: inputSchema({
        connection_id: { type: 'string' },
        remote_path: { type: 'string' },
        local_path: { type: 'string' },
        timeout_ms: { type: 'number' },
      }, ['connection_id', 'remote_path', 'local_path']),
  },
  {
    name: 'ekko_studio_lan_file_upload',
    toolset: 'devices',
    description: 'Upload a local file path from this machine to a connected LAN peer remote path.',
    inputSchema: inputSchema({
        connection_id: { type: 'string' },
        local_path: { type: 'string' },
        remote_path: { type: 'string' },
        timeout_ms: { type: 'number' },
      }, ['connection_id', 'local_path', 'remote_path']),
  },
]

const TOOL_ALIASES = new Map([
  ['hermes_api_openapi_get', 'ekko_studio_api_openapi_get'],
  ['hermes_api_request', 'ekko_studio_api_request'],
  ['ekko_studio_use_workflow_run_rerun_from_node', 'ekko_studio_use_workflow_rerun_node'],
  ['hermes_lan_devices_list', 'ekko_studio_lan_devices_list'],
  ['hermes_lan_devices_scan', 'ekko_studio_lan_devices_scan'],
  ['hermes_lan_peer_connect', 'ekko_studio_lan_peer_connect'],
  ['hermes_lan_peer_connections', 'ekko_studio_lan_peer_connections'],
  ['hermes_lan_peer_disconnect', 'ekko_studio_lan_peer_disconnect'],
  ['hermes_lan_terminal_create', 'ekko_studio_lan_terminal_create'],
  ['hermes_lan_terminal_list', 'ekko_studio_lan_terminal_list'],
  ['hermes_lan_terminal_input', 'ekko_studio_lan_terminal_input'],
  ['hermes_lan_terminal_read', 'ekko_studio_lan_terminal_read'],
  ['hermes_lan_terminal_resize', 'ekko_studio_lan_terminal_resize'],
  ['hermes_lan_terminal_close', 'ekko_studio_lan_terminal_close'],
  ['hermes_lan_command_exec', 'ekko_studio_lan_command_exec'],
  ['hermes_lan_file_download', 'ekko_studio_lan_file_download'],
  ['hermes_lan_file_upload', 'ekko_studio_lan_file_upload'],
])

const CATEGORY_TOOLSETS = {
  browser: {
    name: 'ekko_studio_browser_toolset',
    coverage: 'Ekko Studio Desktop browser tabs and leases; HTTP/HTTPS navigation; accessibility snapshots with stable refs; click, type, key press, and scroll interaction; viewport or full-page screenshots; bounded console log read and clear.',
    description: 'Discover and invoke Ekko Studio Desktop browser operations without loading every browser tool schema into the model context. Covers tab list/create/activate/close/release, navigation back/forward/reload/stop/open, accessibility snapshots, click/type/key/scroll interaction, screenshots, and console logs. Use action=list for the compact operation catalog, action=describe for one full input schema, then action=call with that exact tool name and arguments.',
  },
  devices: {
    name: 'ekko_studio_devices_toolset',
    coverage: 'LAN and remote device discovery and status; paired peer connect/disconnect; interactive terminal create/list/input/read/resize/close; structured remote command execution; file upload and download.',
    description: 'Discover and invoke Ekko Studio LAN/remote-device operations without loading every device tool schema into the model context. Covers device list/scan, paired peer connections, interactive terminal lifecycle and I/O, structured command execution using command plus argument arrays, and remote file upload/download. Use action=list for the compact operation catalog, action=describe for one full input schema, then action=call with that exact tool name and arguments.',
  },
  use: {
    name: 'ekko_studio_use_toolset',
    coverage: (SHARED_TASK_PLAN_ENABLED ? 'Current-turn task plans and progress; ' : '') + 'Explicit user-requested Studio chat/coding runs; one-time confirmed mobile location, calendar and reminder operations; session list/count/detail/messages/context/rename/delete; usage statistics; profiles and available models; provider add/delete; worker status; workflow CRUD and workflow run list/start/stop/rerun/delete.',
    description: 'Discover and invoke high-level Ekko Studio operations without loading every Studio-use tool schema into the model context. Covers ' + (SHARED_TASK_PLAN_ENABLED ? 'current-turn task planning, ' : '') + 'explicit user-requested chat or coding runs, one-time confirmed mobile location, calendar/reminder operations, session management and clean context, usage statistics, profiles/models/providers, worker status, workflow CRUD, and workflow run lifecycle. Never use chat/session or mobile-device operations as an internal delegation mechanism. Use action=list for the compact operation catalog, action=describe for one full input schema, then action=call with that exact tool name and arguments.',
  },
}

function categoryToolsetDefinition(toolset) {
  const category = CATEGORY_TOOLSETS[toolset]
  if (!category) return null
  return {
    name: category.name,
    description: category.description,
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['list', 'describe', 'call'],
          description: 'list returns the compact category catalog; describe returns one full tool schema; call invokes one catalog tool.',
        },
        query: {
          type: 'string',
          description: 'Optional case-insensitive filter for action=list, matched against tool names and descriptions.',
        },
        tool: {
          type: 'string',
          description: 'Exact tool name returned by list. Required for describe and call.',
        },
        arguments: {
          type: 'object',
          description: 'Arguments matching the described tool schema. Required for call; use an empty object when the target takes no arguments.',
          additionalProperties: true,
        },
      },
      required: ['action'],
      additionalProperties: false,
    },
  }
}

function resolveToolName(name) {
  const canonical = typeof name === 'string' ? name.replace(/^hermes_studio_/, 'ekko_studio_') : name
  return TOOL_ALIASES.get(canonical) || canonical
}

function activeToolsetTools() {
  return tools.filter(tool => tool.toolset === ACTIVE_TOOLSET
    && (SHARED_TASK_PLAN_ENABLED || tool.name !== 'ekko_studio_update_plan'))
}

function categoryToolCatalog(query = '') {
  const normalizedQuery = String(query || '').trim().toLowerCase()
  return activeToolsetTools()
    .filter(tool => !normalizedQuery || `${tool.name} ${tool.description}`.toLowerCase().includes(normalizedQuery))
    .map(tool => ({ name: tool.name, description: tool.description }))
}

function categoryToolByName(name) {
  const resolved = resolveToolName(String(name || '').trim())
  return activeToolsetTools().find(tool => tool.name === resolved) || null
}

function serverInstructions() {
  if (ACTIVE_TOOLSET === 'api') {
    return 'Ekko Studio API operations. Use ekko_studio_api_openapi_get without filters for the compact module index, call it again with tag/path/method filters for endpoint details, then call ekko_studio_api_request with the documented relative path and JSON fields.'
  }
  const category = CATEGORY_TOOLSETS[ACTIVE_TOOLSET]
  return category ? `${category.description} Coverage: ${category.coverage}` : ''
}

function visibleTools() {
  if (ACTIVE_TOOLSET === 'browser') {
    try {
      browserDescriptor()
    } catch {
      return []
    }
  }
  const categoryToolset = categoryToolsetDefinition(ACTIVE_TOOLSET)
  if (categoryToolset) return [categoryToolset]
  const visible = activeToolsetTools()
  return visible.map(({ toolset, ...tool }) => tool)
}

function isToolCallable(name) {
  const resolved = resolveToolName(name)
  const categoryToolset = categoryToolsetDefinition(ACTIVE_TOOLSET)
  if (categoryToolset?.name === resolved) return true
  return activeToolsetTools().some(tool => tool.name === resolved)
}

async function callCategoryToolset(args = {}) {
  const category = CATEGORY_TOOLSETS[ACTIVE_TOOLSET]
  if (!category) return errorText(`No compact category toolset is available for '${ACTIVE_TOOLSET}'.`)
  if (args.action === 'list') {
    const catalog = categoryToolCatalog(args.query)
    return jsonText({
      toolset: ACTIVE_TOOLSET,
      coverage: category.coverage,
      operation_count: catalog.length,
      operations: catalog,
      next: `Call ${category.name} with action=describe and an exact tool name before action=call when its parameters are not already known.`,
    })
  }
  const target = categoryToolByName(args.tool)
  if (!target) return errorText(`Unknown '${ACTIVE_TOOLSET}' tool: ${String(args.tool || '')}. Call ${category.name} with action=list first.`)
  if (args.action === 'describe') {
    return jsonText({
      toolset: ACTIVE_TOOLSET,
      name: target.name,
      description: target.description,
      inputSchema: target.inputSchema,
    })
  }
  if (args.action === 'call') {
    if (!isRecord(args.arguments)) return errorText('arguments must be an object when action=call.')
    return await callTool(target.name, args.arguments)
  }
  return errorText('Invalid category toolset action. Allowed: list, describe, call.')
}

async function callTool(name, args = {}) {
  if (!isToolCallable(name)) {
    return errorText(`Tool is not available in the active '${ACTIVE_TOOLSET}' MCP toolset: ${name}`)
  }
  const resolvedName = resolveToolName(name)
  const categoryToolset = categoryToolsetDefinition(ACTIVE_TOOLSET)
  if (resolvedName === categoryToolset?.name) return await callCategoryToolset(args)
  switch (resolvedName) {
    case 'ekko_studio_browser_tabs': {
      if (args.action === 'list') return jsonText(await browserRequest('tabs.list'))
      if (args.action === 'create') return jsonText(await browserRequest('tabs.create', { url: args.url, activate: args.activate }))
      if (args.action === 'activate') return jsonText(await browserRequest('tabs.activate', { tab_id: args.tab_id }))
      if (args.action === 'close') return jsonText(await browserRequest('tabs.close', { tab_id: args.tab_id }))
      if (args.action === 'release') return jsonText(await browserRequest('lease.release', { tab_id: args.tab_id }))
      return errorText('Invalid browser tab action')
    }
    case 'ekko_studio_browser_navigate': {
      const action = args.action || 'open'
      if (action === 'open') {
        if (!args.url) return errorText('url is required when browser navigation action is open')
        return jsonText(await browserRequest('navigate', { tab_id: args.tab_id, url: args.url }))
      }
      return jsonText(await browserRequest('navigation.action', { tab_id: args.tab_id, action }))
    }
    case 'ekko_studio_browser_snapshot':
      return jsonText(await browserRequest('snapshot', { tab_id: args.tab_id }))
    case 'ekko_studio_browser_read_text':
      return jsonText(await browserRequest('text.read', {
        tab_id: args.tab_id,
        snapshot_id: args.snapshot_id,
        ref: args.ref,
        mode: args.mode,
        offset: args.offset,
        limit: args.limit,
      }))
    case 'ekko_studio_browser_interact': {
      const action = { action: args.action }
      for (const key of ['ref', 'snapshot_id', 'text', 'key', 'direction', 'pixels']) {
        if (args[key] !== undefined) action[key] = args[key]
      }
      return jsonText(await browserRequest('interact', { tab_id: args.tab_id, action }))
    }
    case 'ekko_studio_browser_screenshot': {
      try {
        return browserScreenshotContent(await browserRequest('screenshot', { tab_id: args.tab_id, full_page: args.full_page === true }))
      } catch (error) {
        const snapshot = await browserRequest('snapshot', { tab_id: args.tab_id }).catch(() => null)
        if (!snapshot) throw error
        return jsonText({
          screenshot_error: error instanceof Error ? error.message : String(error),
          fallback: 'Accessibility snapshot',
          snapshot: snapshot.result,
        })
      }
    }
    case 'ekko_studio_browser_console':
      return jsonText(await browserRequest(args.action === 'clear' ? 'console.clear' : 'console.read', { tab_id: args.tab_id }))
    case 'ekko_studio_api_openapi_get':
      return jsonText(compactOpenApiDocument(await openApiDocument(withAuthArgs(args)), args))
    case 'ekko_studio_api_request': {
      const method = normalizeApiMethod(args.method)
      const path = normalizeApiPath(args.path)
      if (!method) return errorText('Invalid method. Allowed: GET, POST, PUT, PATCH, DELETE, HEAD.')
      if (!path) return errorText('Invalid path. Use a relative /api/... or /health path from ekko_studio_api_openapi_get; full URLs are not allowed.')
      const validationError = await validateApiRequest(method, path, args)
      if (validationError) return errorText(`Invalid API request for ${method} ${pathWithoutQuery(path)}: ${validationError}. Use ekko_studio_api_openapi_get to inspect required parameters and requestBody.`)
      const options = withAuthArgs(args, {
        method,
        query: args.query,
        headers: args.headers,
        ...(method === 'GET' || method === 'HEAD' ? {} : { body: args.body }),
      })
      return jsonText(await requestEnvelope(path, options))
    }
    case 'ekko_studio_update_plan':
      return jsonText(await request('/api/studio/task-plans/update', withAuthArgs(args, {
        method: 'POST', body: pickDefined(args, ['context_id', 'explanation', 'plan']),
      })))
    case 'ekko_studio_use_chat_run':
      return jsonText(await request('/api/studio/chat-run/runs', withAuthArgs(args, {
        method: 'POST',
        body: pickDefined(args, [
          'input',
          'session_id',
          'provider',
          'model',
          'model_groups',
          'source',
          'session_source',
          'instructions',
          'workspace',
          'reasoning_effort',
          'coding_agent_id',
          'agent_id',
          'mode',
          'baseUrl',
          'apiKey',
          'apiMode',
          'timeout_ms',
          'include_events',
        ]),
      })))
    case 'ekko_studio_use_sessions_list':
      return jsonText(await request('/api/studio/sessions', withAuthArgs(args, {
        query: pickDefined(args, ['limit', 'source']),
      })))
    case 'ekko_studio_use_sessions_count':
      return jsonText(await request('/api/studio/sessions/count', withAuthArgs(args, {
        query: pickDefined(args, ['source']),
      })))
    case 'ekko_studio_use_usage_stats':
      return jsonText(await request('/api/studio/usage/stats', withAuthArgs(args, {
        query: pickDefined(args, ['days']),
      })))
    case 'ekko_studio_use_session_get':
      return jsonText(await request(`/api/studio/sessions/${encodeURIComponent(args.session_id)}`, withAuthArgs(args)))
    case 'ekko_studio_use_session_messages':
      return jsonText(await request(`/api/studio/sessions/conversations/${encodeURIComponent(args.session_id)}/messages`, withAuthArgs(args, {
        query: args.include_internal ? { humanOnly: '0' } : undefined,
      })))
    case 'ekko_studio_use_session_context':
      return jsonText(cleanSessionContextPayload(
        await request(`/api/studio/sessions/${encodeURIComponent(args.session_id)}/context`, withAuthArgs(args)),
        args,
      ))
    case 'ekko_studio_use_session_delete':
      return jsonText(await request(`/api/studio/sessions/${encodeURIComponent(args.session_id)}`, withAuthArgs(args, {
        method: 'DELETE',
      })))
    case 'ekko_studio_use_session_rename':
      return jsonText(await request(`/api/studio/sessions/${encodeURIComponent(args.session_id)}/rename`, withAuthArgs(args, {
        method: 'POST',
        body: { title: args.title },
      })))
    case 'ekko_studio_use_profiles_list':
      return jsonText(await request('/api/hermes/profiles', withAuthArgs(args)))
    case 'ekko_studio_use_available_models':
      return jsonText(compactAvailableModelsPayload(
        await request('/api/hermes/available-models', withAuthArgs(args)),
        args,
      ))
    case 'ekko_studio_use_model_provider_get':
      return jsonText(findProvidersForModel(
        await request('/api/hermes/available-models', withAuthArgs(args)),
        args.model,
      ))
    case 'ekko_studio_use_provider_add':
      return jsonText(await request('/api/hermes/config/providers', withAuthArgs(args, {
        method: 'POST',
        body: pickDefined(args, [
          'name',
          'base_url',
          'api_key',
          'model',
          'context_length',
          'providerKey',
          'api_mode',
        ]),
      })))
    case 'ekko_studio_use_provider_delete':
      return jsonText(await request(`/api/hermes/config/providers/${encodeURIComponent(args.pool_key)}`, withAuthArgs(args, {
        method: 'DELETE',
        query: pickDefined(args, ['source', 'providerKey']),
      })))
    case 'ekko_studio_use_worker_status':
      return jsonText(summarizeWorkerRuntime(
        await request('/api/studio/performance/runtime', withAuthArgs(args)),
      ))
    case 'ekko_studio_use_mobile_location':
      return jsonText(await request('/api/studio/mobile-location/request', withAuthArgs(args, {
        method: 'POST',
        body: pickDefined(args, ['session_id', 'purpose', 'accuracy', 'timeout_ms']),
      })))
    case 'ekko_studio_use_mobile_calendar':
      return jsonText(await request('/api/studio/mobile-calendar/request', withAuthArgs(currentMobileSessionArgs(args), {
        method: 'POST',
        body: {
          capability: 'calendar',
          ...pickDefined(currentMobileSessionArgs(args), ['session_id', 'action', 'purpose', 'start_ms', 'end_ms', 'limit', 'item', 'timeout_ms']),
        },
      })))
    case 'ekko_studio_use_mobile_reminders':
      return jsonText(await request('/api/studio/mobile-calendar/request', withAuthArgs(currentMobileSessionArgs(args), {
        method: 'POST',
        body: {
          capability: 'reminder',
          ...pickDefined(currentMobileSessionArgs(args), ['session_id', 'action', 'purpose', 'start_ms', 'end_ms', 'include_completed', 'limit', 'item', 'timeout_ms']),
        },
      })))
    case 'ekko_studio_use_mobile_health':
      return jsonText(await request('/api/studio/mobile-health/request', withAuthArgs(currentMobileSessionArgs(args), {
        method: 'POST',
        body: pickDefined(currentMobileSessionArgs(args), ['session_id', 'purpose', 'metrics', 'start_ms', 'end_ms', 'limit', 'timeout_ms']),
      })))
    case 'ekko_studio_use_workflows_list':
      return jsonText(await request('/api/studio/workflows', withAuthArgs(args, {
        query: pickDefined(args, ['profile']),
      })))
    case 'ekko_studio_use_workflow_get':
      return jsonText(await request(`/api/studio/workflows/${encodeURIComponent(args.workflow_id)}`, withAuthArgs(args)))
    case 'ekko_studio_use_workflow_create':
      return jsonText(await request('/api/studio/workflows', withAuthArgs(args, {
        method: 'POST',
        body: pickDefined(args, [
          'name',
          'profile',
          'workspace',
          'nodes',
          'edges',
          'viewport',
        ]),
      })))
    case 'ekko_studio_use_workflow_update':
      return jsonText(await request(`/api/studio/workflows/${encodeURIComponent(args.workflow_id)}`, withAuthArgs(args, {
        method: 'PATCH',
        body: pickDefined(args, [
          'name',
          'workspace',
          'nodes',
          'edges',
          'viewport',
        ]),
      })))
    case 'ekko_studio_use_workflow_delete':
      return jsonText(await request(`/api/studio/workflows/${encodeURIComponent(args.workflow_id)}`, withAuthArgs(args, {
        method: 'DELETE',
      })))
    case 'ekko_studio_use_workflow_runs_list':
      return jsonText(await request(`/api/studio/workflows/${encodeURIComponent(args.workflow_id)}/runs`, withAuthArgs(args, {
        query: pickDefined(args, ['limit']),
      })))
    case 'ekko_studio_use_workflow_run_start':
      return jsonText(await request(`/api/studio/workflows/${encodeURIComponent(args.workflow_id)}/run`, withAuthArgs(args, {
        method: 'POST',
        body: pickDefined(args, [
          'start_node_ids',
          'input',
          'timeout_ms',
        ]),
      })))
    case 'ekko_studio_use_workflow_run_stop':
      return jsonText(await request(`/api/studio/workflows/${encodeURIComponent(args.workflow_id)}/runs/${encodeURIComponent(args.run_id)}/stop`, withAuthArgs(args, {
        method: 'POST',
      })))
    case 'ekko_studio_use_workflow_rerun_node':
      return jsonText(await request(`/api/studio/workflows/${encodeURIComponent(args.workflow_id)}/runs/${encodeURIComponent(args.run_id)}/rerun-from-node`, withAuthArgs(args, {
        method: 'POST',
        body: pickDefined(args, [
          'node_id',
          'preserve_start_node',
          'timeout_ms',
        ]),
      })))
    case 'ekko_studio_use_workflow_run_delete':
      return jsonText(await request(`/api/studio/workflows/${encodeURIComponent(args.workflow_id)}/runs/${encodeURIComponent(args.run_id)}`, withAuthArgs(args, {
        method: 'DELETE',
      })))
    case 'ekko_studio_lan_devices_list':
      return jsonText(await request('/api/devices', withAuthArgs(args)))
    case 'ekko_studio_lan_devices_scan':
      return jsonText(await request('/api/devices/scan', withAuthArgs(args, { method: 'POST' })))
    case 'ekko_studio_lan_peer_connect':
      return jsonText(await request(`/api/devices/${encodeURIComponent(args.device_id)}/connect`, withAuthArgs(args, { method: 'POST' })))
    case 'ekko_studio_lan_peer_connections':
      return jsonText(await request('/api/devices/peer-connections', withAuthArgs(args)))
    case 'ekko_studio_lan_peer_disconnect':
      return jsonText(await request(`/api/devices/peer-connections/${encodeURIComponent(args.connection_id)}/disconnect`, withAuthArgs(args, { method: 'POST' })))
    case 'ekko_studio_lan_terminal_create':
      return jsonText(await request(`/api/devices/peer-connections/${encodeURIComponent(args.connection_id)}/terminal`, withAuthArgs(args, {
        method: 'POST',
        body: { shell: args.shell, cols: args.cols, rows: args.rows },
      })))
    case 'ekko_studio_lan_terminal_list':
      return jsonText(await request(`/api/devices/peer-connections/${encodeURIComponent(args.connection_id)}/terminals`, withAuthArgs(args)))
    case 'ekko_studio_lan_terminal_input':
      return jsonText(await request(`/api/devices/peer-connections/${encodeURIComponent(args.connection_id)}/terminal/${encodeURIComponent(args.terminal_id)}/input`, withAuthArgs(args, {
        method: 'POST',
        body: { data: args.data },
      })))
    case 'ekko_studio_lan_terminal_read':
      return jsonText(await request(`/api/devices/peer-connections/${encodeURIComponent(args.connection_id)}/terminal/${encodeURIComponent(args.terminal_id)}/read`, withAuthArgs(args)))
    case 'ekko_studio_lan_terminal_resize':
      return jsonText(await request(`/api/devices/peer-connections/${encodeURIComponent(args.connection_id)}/terminal/${encodeURIComponent(args.terminal_id)}/resize`, withAuthArgs(args, {
        method: 'POST',
        body: { cols: args.cols, rows: args.rows },
      })))
    case 'ekko_studio_lan_terminal_close':
      return jsonText(await request(`/api/devices/peer-connections/${encodeURIComponent(args.connection_id)}/terminal/${encodeURIComponent(args.terminal_id)}/close`, withAuthArgs(args, { method: 'POST' })))
    case 'ekko_studio_lan_command_exec':
      return jsonText(await request(`/api/devices/peer-connections/${encodeURIComponent(args.connection_id)}/exec`, withAuthArgs(args, {
        method: 'POST',
        body: { command: args.command, args: args.args || [], cwd: args.cwd, timeout_ms: args.timeout_ms },
      })))
    case 'ekko_studio_lan_file_download':
      return jsonText(await request(`/api/devices/peer-connections/${encodeURIComponent(args.connection_id)}/download`, withAuthArgs(args, {
        method: 'POST',
        body: { remote_path: args.remote_path, local_path: args.local_path, timeout_ms: args.timeout_ms },
      })))
    case 'ekko_studio_lan_file_upload':
      return jsonText(await request(`/api/devices/peer-connections/${encodeURIComponent(args.connection_id)}/upload`, withAuthArgs(args, {
        method: 'POST',
        body: { local_path: args.local_path, remote_path: args.remote_path, timeout_ms: args.timeout_ms },
      })))
    default:
      return errorText(`Unknown tool: ${name}`)
  }
}

async function handle(message) {
  if (!message || message.id === undefined) return null

  try {
    switch (message.method) {
      case 'initialize':
        return {
          jsonrpc: '2.0',
          id: message.id,
          result: {
            protocolVersion: message.params?.protocolVersion || '2024-11-05',
            capabilities: { tools: {} },
            serverInfo: { name: SERVER_NAME, version: VERSION, toolset: ACTIVE_TOOLSET },
            instructions: serverInstructions(),
          },
        }
      case 'tools/list':
        return { jsonrpc: '2.0', id: message.id, result: { tools: visibleTools() } }
      case 'tools/call':
        return {
          jsonrpc: '2.0',
          id: message.id,
          result: await callTool(message.params?.name, message.params?.arguments || {}),
        }
      default:
        return {
          jsonrpc: '2.0',
          id: message.id,
          error: { code: -32601, message: `Method not found: ${message.method}` },
        }
    }
  } catch (err) {
    return { jsonrpc: '2.0', id: message.id, result: errorText(err?.message || String(err)) }
  }
}

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity })
rl.on('line', async line => {
  const text = line.trim()
  if (!text) return
  let message
  try {
    message = JSON.parse(text)
  } catch {
    return
  }
  const response = await handle(message)
  if (response) process.stdout.write(`${JSON.stringify(response)}\n`)
})
