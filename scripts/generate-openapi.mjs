#!/usr/bin/env node
/**
 * Auto-generate OpenAPI specification from existing Koa routes and controllers
 *
 * This script scans both route files and controller files to generate comprehensive
 * OpenAPI documentation without requiring code changes or decorators.
 */

import { readFileSync, writeFileSync } from 'fs'
import { dirname, resolve, join } from 'path'
import { fileURLToPath } from 'url'

const __dirname = fileURLToPath(new URL('.', import.meta.url))
const rootDir = resolve(__dirname, '..')
const serverSourceDir = join(rootDir, 'packages/server/src')
const packageJson = JSON.parse(readFileSync(join(rootDir, 'package.json'), 'utf-8'))

// OpenAPI template
const openapi = {
  openapi: '3.0.3',
  info: {
    title: 'Ekko Studio API',
    description: 'Ekko Studio API — chat sessions, scheduled jobs, platform channels, model management, skills, memory, logs, file browser, group chat, and terminal.',
    version: packageJson.version,
  },
  servers: [
    { url: 'http://localhost:8648', description: 'Local development' },
  ],
  tags: [],
  paths: {},
  components: {
    securitySchemes: {
      BearerAuth: {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'API Token',
      },
    },
    schemas: {},
    responses: {},
  },
}

// Tag mappings based on route directories
const tagMappings = {
  'modules/studio/routes/desktop-browser.ts': { name: 'Desktop Browser', description: 'Authenticated remote Desktop browser relay with explicit Desktop consent' },
  'modules/hermes/routes/profiles.ts': { name: 'Profiles', description: 'Hermes profile management' },
  'modules/hermes/routes/models.ts': { name: 'Models', description: 'Model configuration' },
  'modules/hermes/routes/providers.ts': { name: 'Providers', description: 'Model provider management' },
  'modules/hermes/routes/skills.ts': { name: 'Skills', description: 'Skill browsing and management' },
  'modules/hermes/routes/skill-bundles.ts': { name: 'Skill Bundles', description: 'Skill bundle browsing and management' },
  'modules/hermes/routes/plugins.ts': { name: 'Plugins', description: 'Plugin browsing and management' },
  'modules/hermes/routes/memory.ts': { name: 'Memory', description: 'Agent memory files' },
  'modules/hermes/routes/jobs.ts': { name: 'Jobs', description: 'Scheduled job management' },
  'modules/hermes/routes/cron-history.ts': { name: 'Jobs', description: 'Cron job history' },
  'modules/hermes/routes/kanban.ts': { name: 'Kanban', description: 'Kanban board and task management' },
  'modules/hermes/routes/weixin.ts': { name: 'Weixin', description: 'Hermes WeChat QR code login' },
  'modules/hermes/routes/codex-auth.ts': { name: 'Codex Auth', description: 'OpenAI Codex OAuth' },
  'modules/hermes/routes/nous-auth.ts': { name: 'Nous Auth', description: 'Nous Research OAuth' },
  'modules/hermes/routes/copilot-auth.ts': { name: 'Copilot Auth', description: 'GitHub Copilot OAuth' },
  'modules/hermes/routes/xai-auth.ts': { name: 'xAI Auth', description: 'xAI OAuth' },
  'modules/hermes/routes/anthropic-auth.ts': { name: 'Anthropic Auth', description: 'Anthropic OAuth' },
  'modules/hermes/routes/minimax-auth.ts': { name: 'MiniMax Auth', description: 'MiniMax OAuth' },
  'modules/hermes/routes/config.ts': { name: 'Config', description: 'Configuration management' },
  'modules/studio/routes/files.ts': { name: 'Studio Files', description: 'Studio profile file browser and editor' },
  'modules/studio/routes/app-upload.ts': { name: 'Studio Files', description: 'Studio App chunked uploads' },
  'modules/studio/routes/download.ts': { name: 'Studio Files', description: 'Studio file download' },
  'modules/hermes/routes/mcp.ts': { name: 'MCP', description: 'MCP server and tool management' },
  'modules/hermes/routes/runtime-versions.ts': { name: 'Runtime Versions', description: 'Runtime and Web UI version management' },
  'modules/hermes/routes/legacy-data-migration.ts': { name: 'Data Migration', description: 'One-time legacy Hermes data migration' },
  'modules/hermes/routes/write-gate.ts': { name: 'Write Gate', description: 'Hermes Agent write approval review' },
  'modules/hermes/routes/journey.ts': { name: 'Journey', description: 'Hermes Agent learning journey graph' },
  'modules/ekko/routes/memory.ts': { name: 'Ekko Memory', description: 'Ekko durable memory management' },
  'modules/ekko/routes/skills.ts': { name: 'Ekko Skills', description: 'Ekko reusable skill management' },
  'modules/ekko/routes/mcp.ts': { name: 'Ekko MCP', description: 'Ekko MCP server management' },
  'modules/ekko/routes/config.ts': { name: 'Ekko Config', description: 'Ekko runtime configuration management' },
  'modules/studio/routes/workflows.ts': { name: 'Workflows', description: 'Cross-agent workflow orchestration' },
  'modules/studio/routes/sessions.ts': { name: 'Sessions', description: 'Cross-agent chat session management' },
  'modules/studio/routes/model-api.ts': { name: 'Model API', description: 'OpenAI Responses-compatible inference across configured providers; external usage accounting' },
  'modules/studio/routes/session-shares.ts': { name: 'Session Shares', description: 'App-bound single-session share tokens, first claim, permissions and revocation' },
  'modules/studio/routes/logs.ts': { name: 'Logs', description: 'Cross-agent log file access' },
  'modules/studio/routes/social-messages.ts': { name: 'Social Messages', description: 'Unified outbound messaging for configured social platforms' },
  'modules/studio/routes/group-chat.ts': { name: 'Group Chat', description: 'Cross-agent group chat management' },
  'modules/studio/routes/chat-run.ts': { name: 'Chat Run', description: 'Cross-agent chat run HTTP and Socket.IO bridge operations' },
  'modules/studio/routes/chat-webhooks.ts': { name: 'Chat Webhooks', description: 'Cross-agent Chat Run webhook endpoint management' },
  'modules/studio/routes/tts.ts': { name: 'TTS', description: 'Text-to-speech generation and settings' },
  'modules/studio/routes/stt.ts': { name: 'STT', description: 'Speech-to-text transcription and settings' },
  'modules/studio/routes/jev.ts': { name: 'JEV', description: 'Profile-scoped TypeSafe JEV configuration and shared Choice, Score, Noul evaluations' },
  'modules/studio/routes/media.ts': { name: 'Media', description: 'Media generation endpoints' },
  'modules/studio/routes/performance-monitor.ts': { name: 'Performance', description: 'Runtime performance monitoring' },
  'modules/studio/routes/petdex.ts': { name: 'Petdex', description: 'Desktop pet catalog and assets' },
  'modules/studio/routes/pets.ts': { name: 'Pets', description: 'Per-profile desktop pet settings' },
  'modules/studio/routes/health.ts': { name: 'Health', description: 'Health check' },
  'modules/studio/routes/update.ts': { name: 'Update', description: 'Studio self-update management' },
  'modules/studio/routes/upload.ts': { name: 'Studio Files', description: 'Studio runtime file upload' },
  'modules/studio/routes/auth.ts': { name: 'Auth', description: 'Authentication management' },
  'modules/studio/routes/app-connections.ts': { name: 'App Connections', description: 'Mobile App authorization and connection management' },
  'modules/studio/routes/app-relay.ts': { name: 'App Relay', description: 'Mobile App cloud relay route and connection management' },
  'modules/studio/routes/mcu-devices.ts': { name: 'MCU Devices', description: 'Microcontroller device management' },
  'modules/studio/routes/mcu-firmware.ts': { name: 'MCU Firmware', description: 'Microcontroller firmware distribution' },
  'modules/studio/routes/theme.ts': { name: 'Theme', description: 'Per-user appearance settings and background image' },
  'modules/studio/routes/announcements.ts': { name: 'Announcements', description: 'Published Studio desktop announcements, newest first' },
  'modules/studio/routes/api-docs.ts': { name: 'API Docs', description: 'OpenAPI route catalog' },
  'modules/studio/routes/agent-status.ts': { name: 'Agent Status', description: 'In-memory Agent installation, version, and source status' },
  'modules/coding-agents/routes/agents.ts': { name: 'Coding Agents', description: 'Coding agent installation, config, and runs' },
}

// Extract route definitions from route files
function scanRoutes() {
  const paths = {}

  for (const [routeFile, tagInfo] of Object.entries(tagMappings)) {
    const filePath = join(serverSourceDir, routeFile)
    try {
      scanRouteFile(filePath, tagInfo, paths)
    } catch (e) {
      // File might not exist, skip
    }
  }

  return paths
}

function scanRouteFile(filePath, tagInfo, paths) {
  const content = readFileSync(filePath, 'utf-8')
  const controllerContents = readControllerContents(filePath, content)
  const controllerAliases = [...controllerContents.keys()]

  // Pattern 1: controller functions - sessionRoutes.get('/path', middleware, ctrl.method)
  const ctrlRouteRegex = controllerAliases.length
    ? new RegExp(
        `\\w+Routes?\\.(get|post|put|delete|patch)\\(\\s*['"]([^'"]+)['"]\\s*,[^\\n]*?\\b(${controllerAliases.map(escapeRegExp).join('|')})\\.(\\w+)`,
        'g',
      )
    : null

  let match
  while (ctrlRouteRegex && (match = ctrlRouteRegex.exec(content)) !== null) {
    const [, method, path, controllerAlias, controllerMethod] = match
    const controller = controllerContents.get(controllerAlias)
    const controllerSource = controller
      ? extractHandlerSource(controller.filePath, controller.content, controllerMethod)
      : ''
    addEndpoint(paths, method, path, controllerMethod, tagInfo, content, match.index, controllerSource)
  }

  // Pattern 2: inline functions - groupChatRoutes.post('/path', async (ctx) => {...})
  const inlineRouteRegex = /\w+Routes?\.(get|post|put|delete|patch)\(\s*['"]([^'"]+)['"]\s*,[^\n]*?async\s*\(ctx\)/g

  while ((match = inlineRouteRegex.exec(content)) !== null) {
    const [, method, path] = match
    const controllerMethod = generateOperationIdFromPath(path, method)
    addEndpoint(paths, method, path, controllerMethod, tagInfo, content, match.index, extractInlineHandlerSource(content, match.index))
  }
}

function readControllerContents(routeFilePath, routeContent) {
  const contents = new Map()
  for (const match of routeContent.matchAll(/import\s+\*\s+as\s+(\w+)\s+from\s+['"]([^'"]+)['"]/g)) {
    const [, alias, importPath] = match
    const controllerPath = resolve(dirname(routeFilePath), `${importPath}.ts`)
    try {
      contents.set(alias, {
        content: readFileSync(controllerPath, 'utf-8'),
        filePath: controllerPath,
      })
    } catch {
      // Non-controller namespace imports are ignored by the route scanner.
    }
  }
  return contents
}

function extractHandlerSource(filePath, content, functionName) {
  const source = extractFunctionSource(content, functionName)
  if (!source) return ''

  // Module controllers may intentionally be thin HTTP boundaries that delegate
  // the implementation to a service. Include directly delegated handlers so
  // request parameters remain visible after moving business logic to services.
  const namedImports = readNamedImports(filePath, content)
  const delegatedSources = []
  const seen = new Set()

  for (const match of source.matchAll(/\b([A-Za-z_$][\w$]*)\s*\(\s*ctx\s*\)/g)) {
    const localName = match[1]
    const imported = namedImports.get(localName)
    if (!imported || seen.has(localName)) continue
    seen.add(localName)

    try {
      const importedContent = readFileSync(imported.filePath, 'utf-8')
      const delegatedSource = extractFunctionSource(importedContent, imported.importedName)
      if (delegatedSource) delegatedSources.push(delegatedSource)
    } catch {
      // An unresolved delegated import should not prevent the remaining API
      // catalog from being generated.
    }
  }

  return [source, ...delegatedSources].join('\n')
}

function readNamedImports(importerPath, content) {
  const imports = new Map()

  for (const match of content.matchAll(/import\s*\{([\s\S]*?)\}\s*from\s*['"]([^'"]+)['"]/g)) {
    const [, bindings, importPath] = match
    if (!importPath.startsWith('.')) continue

    const importedFilePath = resolveTypeScriptImport(importerPath, importPath)
    if (!importedFilePath) continue

    for (const binding of bindings.split(',')) {
      const parsed = binding.trim().match(/^(?:type\s+)?([A-Za-z_$][\w$]*)(?:\s+as\s+([A-Za-z_$][\w$]*))?$/)
      if (!parsed) continue
      const importedName = parsed[1]
      const localName = parsed[2] || importedName
      imports.set(localName, { filePath: importedFilePath, importedName })
    }
  }

  return imports
}

function resolveTypeScriptImport(importerPath, importPath) {
  const basePath = resolve(dirname(importerPath), importPath)
  for (const candidate of [`${basePath}.ts`, join(basePath, 'index.ts')]) {
    try {
      readFileSync(candidate, 'utf-8')
      return candidate
    } catch {
      // Try the next supported TypeScript module path.
    }
  }
  return null
}

function extractFunctionSource(content, functionName) {
  const functionRegex = new RegExp(`export\\s+(?:async\\s+)?function\\s+${functionName}\\b`)
  const match = functionRegex.exec(content)
  if (!match) return ''

  const openBrace = content.indexOf('{', match.index)
  if (openBrace < 0) return ''
  const closeBrace = findMatchingBrace(content, openBrace)
  if (closeBrace < 0) return ''
  return content.slice(match.index, closeBrace + 1)
}

function extractInlineHandlerSource(content, routeIndex) {
  const asyncIndex = content.indexOf('async', routeIndex)
  if (asyncIndex < 0) return ''
  const openBrace = content.indexOf('{', asyncIndex)
  if (openBrace < 0) return ''
  const closeBrace = findMatchingBrace(content, openBrace)
  if (closeBrace < 0) return ''
  return content.slice(asyncIndex, closeBrace + 1)
}

function findMatchingBrace(content, openBrace) {
  let depth = 0
  let quote = null
  let escaped = false

  for (let i = openBrace; i < content.length; i += 1) {
    const ch = content[i]
    const prev = content[i - 1]

    if (quote) {
      if (escaped) {
        escaped = false
      } else if (ch === '\\') {
        escaped = true
      } else if (ch === quote && (quote !== '`' || prev !== '\\')) {
        quote = null
      }
      continue
    }

    if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch
      continue
    }
    if (ch === '{') depth += 1
    if (ch === '}') {
      depth -= 1
      if (depth === 0) return i
    }
  }

  return -1
}

function addEndpoint(paths, method, path, controllerMethod, tagInfo, content, matchIndex, controllerSource = '') {
  if (isInternalProxyRoute(path)) return

  // Clean path parameters
  const openapiPath = path
    .replace(/:([^/]+)/g, '{$1}')
    .replace(/\{\*([^}]+)\}/g, '{$1}')
    .replace(/\*\*([^/]*)/g, '{$1}')

  if (!paths[openapiPath]) {
    paths[openapiPath] = {}
  }

  // Generate operation ID
  const operationId = `${controllerMethod}`

  // Generate description from JSDoc comments above the route
  const precedingContent = content.substring(Math.max(0, matchIndex - 500), matchIndex)
  const description = extractJsDocDescription(precedingContent) || `${method.toUpperCase()} ${path}`

  const operation = {
    tags: [tagInfo.name],
    summary: generateSummary(path, method, controllerMethod),
    description,
    operationId,
    security: [{ BearerAuth: [] }],
    responses: generateResponses(path, method),
  }

  const parameters = generateParameters(openapiPath, controllerSource)
  if (openapiPath === '/api/studio/sessions' && method === 'get') {
    operation.responses['200'] = {
      description: 'Session list. Supplying offset also returns pagination metadata and the total matching the same visibility, category, and include/exclude filters before pagination.',
      content: {
        'application/json': {
          schema: {
            type: 'object', required: ['sessions'],
            properties: {
              sessions: { type: 'array', items: { type: 'object', additionalProperties: true } },
              total: { type: 'integer', minimum: 0, description: 'Total matching sessions, independent of offset and limit. Present when offset is supplied.' },
              hasMore: { type: 'boolean' },
              offset: { type: 'integer', minimum: 0 },
              limit: { type: 'integer', minimum: 1 },
            },
          },
        },
      },
    }
    for (const parameter of parameters) {
      if (parameter.name === 'category') {
        parameter.schema = { oneOf: [{ type: 'integer', minimum: 1 }, { type: 'string', enum: ['none', 'pinned'] }] }
        parameter.description = 'Filter by category ID; none selects uncategorized sessions, pinned selects database-pinned sessions.'
      } else if (parameter.name === 'pinned') {
        parameter.schema = { type: 'boolean' }
        parameter.description = 'Filter by database pin state before pagination and counting. The pinned category takes precedence.'
      } else if (parameter.name === 'include' || parameter.name === 'exclude') {
        parameter.schema = { type: 'array', items: { type: 'string' } }
        parameter.style = 'form'
        parameter.explode = true
        parameter.description = 'Repeat this parameter for each session ID.'
      }
    }
  }
  if (method === 'get' && ['/api/studio/sessions/hermes', '/api/studio/sessions/hermes/groups'].includes(openapiPath)) {
    for (const parameter of parameters) {
      if (parameter.name === 'agent_groups') {
        parameter.schema = { type: 'string', enum: ['0', '1'], default: '0' }
        parameter.description = 'Set to 1 to include legacy native Ekko identities in the builtin_agent history group. Native direct chats are stored as builtin_agent.'
      } else if (parameter.name === 'source') {
        parameter.schema = { type: 'string' }
        parameter.description = 'History source to page. With agent_groups=1, builtin_agent selects native Ekko and coding_agent excludes it. Other sources retain their names.'
      } else if (parameter.name === 'include') {
        parameter.schema = { type: 'array', items: { type: 'string' } }
        parameter.style = 'form'
        parameter.explode = true
        parameter.description = 'Repeat for each deep-linked session ID. Included and pinned sessions do not advance group pagination cursors.'
      }
    }
  }
  if (parameters.length) operation.parameters = parameters

  const requestBody = generateRequestBody(method, controllerSource)
  if (requestBody) operation.requestBody = requestBody

  paths[openapiPath][method] = operation
}

function isInternalProxyRoute(path) {
  return path.startsWith('/api/codex-proxy/') || path.startsWith('/api/claude-code-proxy/')
}

function generateParameters(openapiPath, source) {
  const params = []
  const seen = new Set()

  for (const name of extractPathParamNames(openapiPath)) {
    seen.add(`path:${name}`)
    params.push({
      name,
      in: 'path',
      required: true,
      schema: { type: inferParamType(name, source) },
    })
  }

  for (const name of extractQueryParamNames(source)) {
    const key = `query:${name}`
    if (seen.has(key)) continue
    seen.add(key)
    params.push({
      name,
      in: 'query',
      required: isRequiredQueryParam(name, source),
      schema: queryParamSchema(name, source),
    })
  }

  return params
}

function extractPathParamNames(openapiPath) {
  return Array.from(openapiPath.matchAll(/\{([^}]+)\}/g))
    .map(match => match[1])
    .filter(name => name && !name.startsWith('*'))
}

function extractQueryParamNames(source) {
  const names = new Set()
  if (!source) return []

  collectMatches(source, /ctx\.query\??\.(\w+)/g, names)
  collectMatches(source, /ctx\.query\[['"]([^'"]+)['"]\]/g, names)

  for (const match of source.matchAll(/const\s+\{([^}]+)\}\s*=\s*ctx\.query/g)) {
    for (const name of parseDestructuredNames(match[1])) names.add(name)
  }

  for (const match of source.matchAll(/ctx\.query\s+as\s*\{([\s\S]*?)\}/g)) {
    for (const field of parseTypeLiteralFields(match[1])) names.add(field.name)
  }

  if (/\brequestBoard\(ctx\)/.test(source)) names.add('board')

  return Array.from(names).filter(Boolean).sort()
}

function collectMatches(source, regex, names) {
  for (const match of source.matchAll(regex)) names.add(match[1])
}

function parseDestructuredNames(text) {
  return parseDestructuredEntries(text).map(entry => entry.name)
}

function parseDestructuredEntries(text) {
  return text
    .split(',')
    .map(part => {
      const [rawName, rawLocal] = part.trim().split(':')
      const name = rawName?.trim()
      const local = (rawLocal || rawName)?.trim().replace(/\s*=.*$/, '')
      return { name, local }
    })
    .filter(entry => /^[A-Za-z_$][\w$]*$/.test(entry.name) && /^[A-Za-z_$][\w$]*$/.test(entry.local))
}

function queryParamSchema(name, source) {
  const type = inferParamType(name, source)
  const schema = { type }

  const enumValues = inferEnumValues(name, source)
  if (enumValues.length) schema.enum = enumValues

  return schema
}

function inferParamType(name, source) {
  const escaped = escapeRegExp(name)
  if (new RegExp(`parseInt\\([^)]*\\b${escaped}\\b`).test(source) || new RegExp(`Number\\([^)]*\\b${escaped}\\b`).test(source)) {
    return 'integer'
  }
  if (new RegExp(`\\b${escaped}\\b[^\\n]*(?:===|!==)\\s*['"](?:true|false|0|1)['"]`).test(source)) {
    return 'boolean'
  }
  if (new RegExp(`boolQuery\\([^)]*\\b${escaped}\\b`).test(source)) {
    return 'boolean'
  }
  return 'string'
}

function isRequiredQueryParam(name, source) {
  return extractRequiredNamesFromMessages(source).has(name)
}

function inferEnumValues(name, source) {
  const escaped = escapeRegExp(name)
  const values = new Set()
  const comparisonRegex = new RegExp(`\\b${escaped}\\b\\s*(?:===|!==)\\s*['"]([^'"]+)['"]`, 'g')
  collectMatches(source, comparisonRegex, values)
  const allowedRegex = new RegExp(`${escaped}\\s+must be\\s+([^'"\`\\n]+)`, 'i')
  const allowedMatch = source.match(allowedRegex)
  if (allowedMatch) {
    allowedMatch[1]
      .split(/,|\bor\b/)
      .map(value => value.trim())
      .filter(value => /^[A-Za-z0-9_.-]+$/.test(value))
      .forEach(value => values.add(value))
  }
  return Array.from(values)
}

function generateRequestBody(method, source) {
  if (!['post', 'put', 'patch'].includes(method)) return null
  if (!source || !/(ctx\.request\??\.body|requestBody\(ctx\))/.test(source)) return null

  const fields = extractBodyFields(source)
  const schema = {
    type: 'object',
    properties: {},
  }

  for (const field of fields) {
    schema.properties[field.name] = field.schema
  }

  const required = fields.filter(field => field.required).map(field => field.name)
  if (required.length) schema.required = required
  if (!fields.length) schema.additionalProperties = true

  return {
    required: true,
    content: {
      'application/json': {
        schema,
      },
    },
  }
}

function extractBodyFields(source) {
  const fields = new Map()
  const requiredNames = inferRequiredBodyNames(source)

  for (const typeLiteral of extractRequestBodyTypeLiterals(source)) {
    for (const field of parseTypeLiteralFields(typeLiteral)) {
      addBodyField(fields, {
        name: field.name,
        schema: schemaFromType(field.type),
        required: requiredNames.has(field.name) || !field.optional,
      })
    }
  }

  for (const name of extractDestructuredBodyNames(source)) {
    addBodyField(fields, {
      name,
      schema: schemaFromName(name, source),
      required: requiredNames.has(name),
    })
  }

  for (const name of extractBodyPropertyNames(source)) {
    addBodyField(fields, {
      name,
      schema: schemaFromName(name, source),
      required: requiredNames.has(name),
    })
  }

  return Array.from(fields.values()).sort((a, b) => a.name.localeCompare(b.name))
}

function addBodyField(fields, next) {
  if (!next.name || !/^[A-Za-z_$][\w$]*$/.test(next.name)) return
  const existing = fields.get(next.name)
  if (!existing) {
    fields.set(next.name, next)
    return
  }
  existing.required = existing.required || next.required
  existing.schema = mergeSchema(existing.schema, next.schema)
}

function mergeSchema(current, next) {
  if (current.type === 'object' && Object.keys(current).length === 1) return next
  if (next.type === 'object' && Object.keys(next).length === 1) return current
  return current
}

function extractRequestBodyTypeLiterals(source) {
  const literals = []
  const markers = ['ctx.request.body as {', '(ctx.request.body || {}) as {', '(ctx.request?.body || {}) as {']

  for (const marker of markers) {
    let index = source.indexOf(marker)
    while (index >= 0) {
      const openBrace = source.indexOf('{', index)
      const closeBrace = findMatchingBrace(source, openBrace)
      if (openBrace >= 0 && closeBrace > openBrace) {
        literals.push(source.slice(openBrace + 1, closeBrace))
      }
      index = source.indexOf(marker, index + marker.length)
    }
  }

  return literals
}

function parseTypeLiteralFields(typeLiteral) {
  const fields = []
  for (const entry of splitTopLevel(typeLiteral)) {
    const match = entry.trim().match(/^([A-Za-z_$][\w$]*)(\?)?\s*:\s*([\s\S]+)$/)
    if (!match) continue
    fields.push({
      name: match[1],
      optional: Boolean(match[2]),
      type: match[3].trim().replace(/[,;]$/, ''),
    })
  }
  return fields
}

function splitTopLevel(text) {
  const parts = []
  let start = 0
  let angleDepth = 0
  let braceDepth = 0
  let bracketDepth = 0
  let parenDepth = 0
  let quote = null

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]
    if (quote) {
      if (ch === quote && text[i - 1] !== '\\') quote = null
      continue
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch
      continue
    }
    if (ch === '<') angleDepth += 1
    if (ch === '>') angleDepth = Math.max(0, angleDepth - 1)
    if (ch === '{') braceDepth += 1
    if (ch === '}') braceDepth = Math.max(0, braceDepth - 1)
    if (ch === '[') bracketDepth += 1
    if (ch === ']') bracketDepth = Math.max(0, bracketDepth - 1)
    if (ch === '(') parenDepth += 1
    if (ch === ')') parenDepth = Math.max(0, parenDepth - 1)

    if ((ch === '\n' || ch === ';' || ch === ',') && angleDepth === 0 && braceDepth === 0 && bracketDepth === 0 && parenDepth === 0) {
      parts.push(text.slice(start, i))
      start = i + 1
    }
  }
  parts.push(text.slice(start))
  return parts.filter(part => part.trim())
}

function extractDestructuredBodyNames(source) {
  return extractDestructuredBodyEntries(source).map(entry => entry.name)
}

function extractDestructuredBodyEntries(source) {
  const entries = []
  for (const match of source.matchAll(/const\s+\{([^}]+)\}\s*=\s*(?:\([^)]*\)\s*)?ctx\.request\??\.body/g)) {
    entries.push(...parseDestructuredEntries(match[1]))
  }
  const byName = new Map()
  for (const entry of entries) byName.set(entry.name, entry)
  return Array.from(byName.values())
}

function extractBodyPropertyNames(source) {
  const names = new Set()
  const bodyVariableNames = extractBodyVariableNames(source)
  bodyVariableNames.push('bodyResult.body')

  for (const variableName of bodyVariableNames) {
    const escaped = escapeRegExp(variableName)
    collectMatches(source, new RegExp(`\\b${escaped}\\.([A-Za-z_$][\\w$]*)`, 'g'), names)
  }

  collectMatches(source, /ctx\.request\??\.body\??\.([A-Za-z_$][\w$]*)/g, names)
  collectMatches(source, /\(ctx\.request\.body as any\)\??\.([A-Za-z_$][\w$]*)/g, names)
  return Array.from(names)
}

function extractBodyVariableNames(source) {
  const names = []
  for (const match of source.matchAll(/const\s+([A-Za-z_$][\w$]*)\s*=\s*(?:\([^)]*\)\s*)?ctx\.request\??\.body/g)) {
    names.push(match[1])
  }
  for (const match of source.matchAll(/const\s+([A-Za-z_$][\w$]*)\s*=\s*(?:bodyResult\.body|requestBody\(ctx\)\.body)/g)) {
    names.push(match[1])
  }
  return Array.from(new Set(names))
}

function inferRequiredBodyNames(source) {
  const names = extractRequiredNamesFromMessages(source)
  collectMatches(source, /required\w*\([^,]+,\s*['"]([^'"]+)['"]/g, names)
  for (const entry of extractDestructuredBodyEntries(source)) {
    const escaped = escapeRegExp(entry.local)
    if (new RegExp(`if\\s*\\([^)]*!\\s*${escaped}\\b`).test(source)
      || new RegExp(`\\|\\|\\s*!\\s*${escaped}\\b`).test(source)
      || new RegExp(`&&\\s*!\\s*${escaped}\\b`).test(source)) {
      names.add(entry.name)
    }
  }
  return names
}

function extractRequiredNamesFromMessages(source) {
  const names = new Set()
  for (const match of source.matchAll(/['"`]([^'"`]*\brequired\b[^'"`]*)['"`]/gi)) {
    const message = match[1]
    const beforeRequired = message.split(/\brequired\b/i)[0] || ''
    beforeRequired
      .replace(/\bis\b|\bare\b|\bmust\b|\bbe\b/gi, ' ')
      .split(/,|\band\b|\/|\s+/)
      .map(part => part.trim())
      .filter(part => /^[A-Za-z_$][\w$]*$/.test(part))
      .forEach(part => {
        names.add(part)
        names.add(part.charAt(0).toLowerCase() + part.slice(1))
      })
  }
  return names
}

function schemaFromName(name, source) {
  const escaped = escapeRegExp(name)
  if (new RegExp(`optionalBoolean\\([^,]+,\\s*['"]${escaped}['"]`).test(source)) return { type: 'boolean' }
  if (new RegExp(`optional(?:Positive)?Integer\\([^,]+,\\s*['"]${escaped}['"]`).test(source)) return { type: 'integer' }
  if (new RegExp(`(?:optional|required)\\w*StringArray\\([^,]+,\\s*['"]${escaped}['"]`).test(source)) return { type: 'array', items: { type: 'string' } }
  if (new RegExp(`(?:StringArray|task_ids|ids)`, 'i').test(name)) return { type: 'array', items: { type: 'string' } }
  return { type: 'string' }
}

function schemaFromType(type) {
  const normalized = type.replace(/\s+/g, ' ')
  const schema = {}

  if (/\bnull\b/.test(normalized)) schema.nullable = true
  if (/SessionProviderApiMode|CodingAgentApiMode/.test(normalized)) {
    return { ...schema, type: 'string', enum: ['chat_completions', 'codex_responses', 'anthropic_messages'] }
  }
  if (/\bProviderApiMode\b/.test(normalized)) {
    return {
      ...schema, type: 'string',
      enum: ['chat_completions', 'codex_responses', 'anthropic_messages', 'bedrock_converse', 'codex_app_server', ...(schema.nullable ? [null] : [])],
      ...(schema.nullable ? { description: 'Null clears the custom connection protocol override for automatic matching; no api_mode is written to configuration.' } : {}),
    }
  }
  if (/string\[\]|Array<string>/.test(normalized)) {
    return { ...schema, type: 'array', items: { type: 'string' } }
  }
  if (/number/.test(normalized)) return { ...schema, type: 'number' }
  if (/boolean/.test(normalized)) return { ...schema, type: 'boolean' }
  if (/Record<|unknown|any|object|\{/.test(normalized)) return { ...schema, type: 'object', additionalProperties: true }
  if (/string/.test(normalized)) return { ...schema, type: 'string' }
  return { ...schema, type: 'object' }
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function generateOperationIdFromPath(path, method) {
  const parts = path.split('/').filter(Boolean)
  const lastPart = parts[parts.length - 1]

  if (lastPart && !lastPart.includes(':') && !lastPart.includes('*')) {
    const actionMap = {
      get: 'get',
      post: 'create',
      put: 'update',
      patch: 'patch',
      delete: 'delete',
    }
    return `${actionMap[method]}${lastPart.charAt(0).toUpperCase() + lastPart.slice(1)}`
  }

  const parentPart = parts[parts.length - 2]
  if (parentPart) {
    return `${method}${parentPart.charAt(0).toUpperCase() + parentPart.slice(1)}`
  }

  return method
}

function extractJsDocDescription(content) {
  const jsDocRegex = /\/\*\*[\s\S]*?\*\//g
  const matches = Array.from(content.matchAll(jsDocRegex))
  const match = matches.at(-1)
  if (match) {
    const trailingContent = content.slice((match.index || 0) + match[0].length)
    if (trailingContent.trim()) return null
    const jsDoc = match[0]
    // Extract description text
    const description = jsDoc
      .replace(/\/\*\*|\*\//g, '')
      .split('\n')
      .map(line => line.replace(/^\s*\*\s?/, '').trim())
      .filter(line => line && !line.startsWith('@'))
      .join('\n')
    return description || null
  }
  return null
}

function generateSummary(path, method, controllerMethod) {
  const parts = path.split('/').filter(Boolean)
  const resource = parts[parts.length - 1] || 'root'

  // Use controller method name to generate better summary
  const methodMap = {
    list: 'List',
    get: 'Get',
    create: 'Create',
    update: 'Update',
    remove: 'Delete',
    delete: 'Delete',
    rename: 'Rename',
    pause: 'Pause',
    resume: 'Resume',
    run: 'Run',
    search: 'Search',
    add: 'Add',
  }

  const action = methodMap[controllerMethod] || {
    get: 'Get',
    post: 'Create',
    put: 'Update',
    patch: 'Update',
    delete: 'Delete',
  }[method]

  if (resource.includes('{')) {
    const paramName = resource.match(/\{([^}]+)\}/)?.[1] || 'id'
    const parentResource = parts[parts.length - 2] || 'resource'
    return `${action} ${parentResource} by ${paramName}`
  }

  return `${action} ${resource}`
}

function generateResponses(path, method) {
  const responses = {
    '200': {
      description: 'Success',
    },
    '401': {
      $ref: '#/components/responses/Unauthorized',
    },
  }

  if (method === 'get' && path.includes('/')) {
    responses['404'] = { description: 'Not found' }
  }

  if (method === 'post' || method === 'put' || method === 'patch') {
    responses['400'] = { $ref: '#/components/responses/BadRequest' }
  }

  if (path === '/api/studio/group-chat/rooms/:roomId/workspace') {
    responses['403'] = { description: 'Forbidden - Workspace folder is not allowed' }
    responses['404'] = { $ref: '#/components/responses/NotFound' }
  }

  return responses
}

// Add standard responses
openapi.components.responses = {
  Unauthorized: {
    description: 'Unauthorized - Invalid or missing authentication token',
    content: {
      'application/json': {
        schema: {
          type: 'object',
          properties: {
            error: { type: 'string', example: 'Unauthorized' },
          },
        },
      },
    },
  },
  BadRequest: {
    description: 'Bad Request - Invalid parameters',
    content: {
      'application/json': {
        schema: {
          type: 'object',
          properties: {
            error: { type: 'string', example: 'Invalid request' },
          },
        },
      },
    },
  },
  NotFound: {
    description: 'Resource not found',
    content: {
      'application/json': {
        schema: {
          type: 'object',
          properties: {
            error: { type: 'string', example: 'Not found' },
          },
        },
      },
    },
  },
}

// Run scanner
console.log('Scanning routes...')
openapi.paths = scanRoutes()

// Collect all tags
const tagSet = new Set()
Object.values(openapi.paths).forEach(pathItem => {
  Object.values(pathItem).forEach(operation => {
    operation.tags?.forEach(tag => tagSet.add(tag))
  })
})

openapi.tags = Array.from(tagSet).map(tag => {
  const tagInfo = Object.values(tagMappings).find(t => t.name === tag)
  return {
    name: tag,
    description: tagInfo?.description || '',
  }
})

// Sort paths
const sortedPaths = {}
Object.keys(openapi.paths).sort().forEach(key => {
  sortedPaths[key] = openapi.paths[key]
})
openapi.paths = sortedPaths

// Add special endpoints after sorting
openapi.paths['/api/studio/sessions/{id}/pin'].post.requestBody = {
  required: true,
  content: { 'application/json': { schema: {
    type: 'object', required: ['is_pinned'], properties: { is_pinned: { type: 'boolean' } },
  } } },
}

// Group chat deletion is manager-only and protects the rolling room summary.
const groupSelectionPath = '/api/studio/group-chat/rooms/{roomId}/message-selection'
const groupDeletePath = '/api/studio/group-chat/rooms/{roomId}/messages/delete'
openapi.paths[groupSelectionPath].get.description = 'List complete persisted message/run groups for a managed group room. Summarized prefixes, runs crossing the summary anchor, and unknown summary boundaries are locked. Requires an idle room. Returns an opaque historyRevision to detect concurrent transcript or summary changes.'
openapi.paths[groupSelectionPath].get.responses['200'] = {
  description: 'Selection groups and opaque history revision',
  content: { 'application/json': { schema: { type: 'object', required: ['groups', 'historyRevision'], properties: {
    historyRevision: { type: 'string' },
    groups: { type: 'array', items: { type: 'object', required: ['id', 'kind', 'messageIds'], properties: {
      id: { type: 'string' }, kind: { type: 'string', enum: ['message', 'run'] },
      messageIds: { type: 'array', items: { type: 'string' } },
      deleteBlockedReason: { type: 'string', enum: ['summarized', 'summary_boundary_unknown'] },
    } } },
  } } } },
}
const groupDeleteOperation = openapi.paths[groupDeletePath].post
groupDeleteOperation.description = 'Permanently delete selected unsummarized group messages. Requires room management permission and the historyRevision from message-selection. Each selected agent message expands to the entire run across pages. Rechecks summary boundaries, revision, active runs, queues and summary work atomically. Preserves the summary and unselected history, updates context token totals and messageDeletionRevision, and broadcasts messages_deleted to room clients. Returns 409 for stale, protected or busy selections.'
groupDeleteOperation.requestBody = { required: true, content: { 'application/json': { schema: {
  type: 'object', required: ['messageIds', 'historyRevision'], properties: {
    messageIds: { type: 'array', minItems: 1, maxItems: 10000, items: { type: 'string', minLength: 1, maxLength: 500 } },
    historyRevision: { type: 'string', pattern: '^[a-f0-9]{64}$' },
  },
} } } }
groupDeleteOperation.responses['200'] = { description: 'Deletion result; also emitted as messages_deleted', content: { 'application/json': { schema: {
  type: 'object', required: ['roomId', 'messageIds', 'deletedGroups', 'messageCount', 'totalTokens', 'messageDeletionRevision'], properties: {
    roomId: { type: 'string' }, messageIds: { type: 'array', items: { type: 'string' } },
    deletedGroups: { type: 'integer' }, messageCount: { type: 'integer' }, totalTokens: { type: 'integer' }, messageDeletionRevision: { type: 'integer' },
  },
} } } }

// Message selection uses persisted identities and a revision checked on deletion.
const messageSelectionPath = '/api/studio/sessions/{id}/message-selection'
openapi.paths[messageSelectionPath].get.description = 'List selection groups and historyRevision for a local Hermes or Ekko chat. User messages are individual items; agent replies, reasoning and tools are grouped by complete run across pages. Groups touching the compressed prefix are locked. Missing or invalid compression cursors lock all groups. Shared sessions are excluded.'
openapi.paths[messageSelectionPath].get.responses['200'] = {
  description: 'Message identities for selection (no message bodies)',
  content: { 'application/json': { schema: {
    type: 'object', required: ['groups', 'historyRevision'], properties: {
      historyRevision: { type: 'integer', minimum: 0 },
      groups: { type: 'array', items: { type: 'object', required: ['id', 'kind', 'messageIds'], properties: {
        id: { type: 'integer' }, kind: { type: 'string', enum: ['message', 'run'] },
        messageIds: { type: 'array', items: { type: 'integer' } }, runMarker: { type: 'string' },
        deleteBlockedReason: { type: 'string', enum: ['compressed', 'compression_boundary_unknown'], description: 'Present when this group cannot be deleted. A run is locked if any of its messages is protected.' },
      } } },
    },
  } } },
}
const deleteMessagesOperation = openapi.paths['/api/studio/sessions/{id}/messages/batch-delete'].post
for (const operation of [openapi.paths[messageSelectionPath].get, deleteMessagesOperation]) {
  operation.parameters.push({ name: 'profile', in: 'query', required: false, schema: { type: 'string' }, description: 'Profile owning the local session.' })
}
deleteMessagesOperation.description = 'Permanently delete selected uncompressed messages. Selecting any agent message removes its entire run. Requires an idle local Hermes/Ekko chat and the historyRevision from message-selection. Rechecks the current compression cursor inside the transaction; groups touching the compressed prefix are rejected. Preserves the summary, cursor and compression timestamp while advancing snapshot validity with the history revision. Cached transcript and context estimates are refreshed; billing usage is retained. Returns 409 for compressed or stale selections, unknown compression boundaries, or pending runs/tasks; shared sessions are forbidden.'
deleteMessagesOperation.requestBody = {
  required: true,
  content: { 'application/json': { schema: {
    type: 'object', required: ['messageIds', 'historyRevision'], properties: {
      messageIds: { type: 'array', minItems: 1, maxItems: 10000, items: { type: 'integer', minimum: 1 } },
      historyRevision: { type: 'integer', minimum: 0 },
    },
  } } },
}
deleteMessagesOperation.responses['200'] = {
  description: 'Deleted message identities and new history revision',
  content: { 'application/json': { schema: {
    type: 'object', required: ['deleted', 'deletedGroups', 'messageIds', 'historyRevision'], properties: {
      deleted: { type: 'integer' }, deletedGroups: { type: 'integer' }, historyRevision: { type: 'integer' },
      contextTokens: { type: 'integer', nullable: true, minimum: 0, description: 'Estimated current context after deletion, including the retained summary; null if unavailable. Independent of billed usage.' },
      messageIds: { type: 'array', items: { type: 'integer' } },
    },
  } } },
}

// Shared task planning is bound to an authenticated, active turn capability.
openapi.paths['/api/studio/task-plans/update'] = {
  post: {
    tags: ['Chat Run'], summary: 'Update the current turn task plan', operationId: 'updateTaskPlan',
    description: 'Update the full ordered plan using the context_id injected into the current run instructions. Expired contexts and other profiles are rejected. Updates are persisted and emitted as plan.updated.',
    security: [{ BearerAuth: [] }],
    requestBody: { required: true, content: { 'application/json': { schema: {
      type: 'object', required: ['context_id', 'plan'],
      properties: {
        context_id: { type: 'string' }, explanation: { type: 'string', maxLength: 1000 },
        plan: { type: 'array', minItems: 1, maxItems: 30, items: {
          type: 'object', required: ['id', 'step', 'status'], additionalProperties: false,
          properties: {
            id: { type: 'string', minLength: 1, maxLength: 100 },
            step: { type: 'string', minLength: 1, maxLength: 200 },
            status: { type: 'string', enum: ['pending', 'in_progress', 'completed'] },
          },
        } },
      },
    } } } },
    responses: {
      200: { description: 'Persisted task plan snapshot with session_id, run_id, plan_id, revision, execution_state, explanation, plan, created_at and updated_at (milliseconds).' },
      400: { description: 'Invalid plan; at most one step can be in_progress and step ids must be unique.' },
      409: { description: 'Context expired, belongs to another profile, or has no active turn.' },
      503: { description: 'Chat run service unavailable.' },
    },
  },
}

// MCP user questions wait for a reply on the existing clarify.respond transport.
openapi.paths['/api/studio/clarifications/request'] = {
  post: {
    tags: ['Chat Run'], summary: 'Ask a user clarification in the current coding-agent turn', operationId: 'requestClarification',
    description: 'Requires the current interaction context_id and matching authenticated profile. Emits clarify.requested in Studio/App, waits up to five minutes, and returns the answer or an explicit timeout/dismissed/cancelled reason. Expired contexts cannot prompt a later turn. Caller-supplied session/run ids are ignored.',
    security: [{ BearerAuth: [] }],
    requestBody: { required: true, content: { 'application/json': { schema: {
      type: 'object', required: ['context_id', 'question'],
      properties: {
        context_id: { type: 'string' },
        question: { type: 'string', minLength: 1, maxLength: 4000 },
        choices: { type: 'array', maxItems: 20, items: { type: 'string', minLength: 1, maxLength: 500 } },
      },
    } } } },
    responses: {
      200: { description: 'Clarification settled.', content: { 'application/json': { schema: {
        type: 'object', required: ['ok', 'clarify_id', 'response', 'reason'], properties: {
          ok: { type: 'boolean' }, clarify_id: { type: 'string' }, response: { type: 'string' },
          reason: { type: 'string', enum: ['response', 'dismissed', 'timeout', 'cancelled'] },
        },
      } } } },
      400: { description: 'Missing context or invalid question/choices.' },
      409: { description: 'Expired or inactive context, wrong profile, or another question is pending.' },
      503: { description: 'Chat run service unavailable.' },
    },
  },
}

// Add non-streaming Chat Run HTTP wrapper endpoint
openapi.paths['/api/studio/chat-run/runs'] = {
  post: {
    tags: ['Chat Run'],
    summary: 'Run chat and wait for completion',
    description: 'Starts a Ekko Studio chat run through the chat-run transport and waits for a terminal result. Use this from HTTP/MCP callers that cannot consume Socket.IO streams.',
    operationId: 'runChatOnce',
    security: [{ BearerAuth: [] }],
    requestBody: {
      required: true,
      content: {
        'application/json': {
          schema: {
            type: 'object',
            required: ['input'],
            properties: {
              input: {
                oneOf: [
                  { type: 'string' },
                  {
                    type: 'array',
                    items: {
                      type: 'object',
                      additionalProperties: true,
                    },
                  },
                ],
                description: 'User message text or content blocks.',
              },
              session_id: {
                type: 'string',
                description: 'Optional session id. Omit this to create a new session automatically. Provide an existing session id to continue that session.',
              },
              profile: {
                type: 'string',
                description: 'Ekko Studio profile name. Defaults to the authenticated request profile or default.',
              },
              provider: {
                type: 'string',
                description: 'Model provider key to use for this run, for example openai, anthropic, deepseek, or a configured custom provider key.',
              },
              model: {
                type: 'string',
                description: 'Model id to use for this run, for example gpt-5.1 or deepseek-v4-pro.',
              },
              model_groups: {
                type: 'array',
                description: 'Optional provider/model fallback groups.',
                items: {
                  type: 'object',
                  required: ['provider', 'models'],
                  properties: {
                    provider: { type: 'string' },
                    models: { type: 'array', items: { type: 'string' } },
                  },
                },
              },
              source: {
                type: 'string',
                enum: ['cli', 'builtin_agent', 'coding_agent', 'global_agent', 'workflow', 'group_chat'],
                description: 'Session source. Use cli for Hermes bridge runs, builtin_agent for native Ekko direct chats, coding_agent for external CLIs, or the matching group_chat/workflow/global_agent surface. Omit source for normal Hermes chat runs; do not use the legacy api_server source.',
              },
              session_source: {
                type: 'string',
                enum: ['global_agent', 'workflow', 'group_chat'],
                description: 'Marks a coding-agent or bridge session as launched from the global agent.',
              },
              instructions: {
                type: 'string',
                description: 'Optional extra run instructions appended after the system prompt.',
              },
              workspace: {
                type: 'string',
                nullable: true,
                description: 'Optional current working directory for the run.',
              },
              reasoning_effort: {
                type: 'string',
                description: 'Optional per-run reasoning effort override.',
              },
              coding_agent_id: {
                type: 'string',
                enum: ['claude-code', 'codex', 'pi', 'grok', 'opencode', 'ekko-agent'],
                description: 'External coding-agent runtime id. ekko-agent is accepted for legacy clients; new native Ekko requests use agent_id.',
              },
              agent_id: {
                type: 'string',
                enum: ['claude-code', 'codex', 'pi', 'grok', 'opencode', 'ekko-agent'],
                description: 'Runtime id. Use ekko-agent for native Ekko with source=builtin_agent; external CLI ids remain accepted.',
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
                type: 'integer',
                minimum: 1,
                maximum: 1800000,
                default: 300000,
                description: 'Maximum time to wait for run.completed or run.failed.',
              },
              include_events: {
                type: 'boolean',
                default: false,
                description: 'Include recorded run events in the HTTP response.',
              },
            },
            additionalProperties: true,
          },
        },
      },
    },
    responses: {
      '200': {
        description: 'Run completed',
        content: {
          'application/json': {
            schema: {
              type: 'object',
              properties: {
                ok: { type: 'boolean', example: true },
                status: { type: 'string', example: 'completed' },
                session_id: { type: 'string' },
                run_id: { type: 'string' },
                output: { type: 'string' },
                reasoning: { type: 'string' },
                events: { type: 'array', items: { type: 'object', additionalProperties: true } },
              },
            },
          },
        },
      },
      '400': { $ref: '#/components/responses/BadRequest' },
      '401': { $ref: '#/components/responses/Unauthorized' },
      '409': { description: 'Run requires approval or clarification' },
      '500': { description: 'Run failed' },
      '504': { description: 'Run timed out' },
    },
  },
}

openapi.paths['/api/studio/mobile-calendar/request'] = {
  post: {
    tags: ['Chat Run'],
    summary: 'Request one-time mobile calendar or reminder access',
    description: 'Requests a user-confirmed calendar/reminder operation from the App for the exact authenticated direct-chat session. Single-item delete requires exact id, title and occurrence time with fresh App confirmation. Background, workflow, group-chat, and delegated use are not supported.',
    operationId: 'requestMobileCalendar',
    security: [{ BearerAuth: [] }],
    requestBody: {
      required: true,
      content: {
        'application/json': {
          schema: {
            type: 'object',
            required: ['session_id', 'capability', 'action', 'purpose'],
            properties: {
              session_id: { type: 'string' },
              capability: { type: 'string', enum: ['calendar', 'reminder'] },
              action: { type: 'string', enum: ['list', 'create', 'update', 'complete', 'delete'] },
              purpose: { type: 'string', maxLength: 240 },
              start_ms: { type: 'number' },
              end_ms: { type: 'number' },
              include_completed: { type: 'boolean' },
              limit: { type: 'integer', minimum: 1, maximum: 100 },
              item: { type: 'object', additionalProperties: true },
              timeout_ms: { type: 'integer', minimum: 3000, maximum: 300000, default: 300000 },
            },
          },
        },
      },
    },
    responses: {
      '200': { description: 'Confirmed App result, denial, or sanitized device error' },
      '400': { $ref: '#/components/responses/BadRequest' },
      '401': { $ref: '#/components/responses/Unauthorized' },
      '404': { $ref: '#/components/responses/NotFound' },
      '503': { description: 'Chat run service unavailable' },
    },
  },
}

// Add WebSocket terminal endpoint
openapi.paths['/api/hermes/terminal'] = {
  'get': {
    tags: ['Terminal'],
    summary: 'WebSocket terminal connection',
    description: 'Establish a WebSocket connection for interactive terminal access. Uses the `ws` or `wss` protocol with `?token=` for authentication.',
    operationId: 'terminalWebSocket',
    responses: {
      '101': { description: 'Switching Protocols - WebSocket connection established' },
      '401': { $ref: '#/components/responses/Unauthorized' },
    },
  },
}

// Add Terminal tag
if (!openapi.tags.find(t => t.name === 'Terminal')) {
  openapi.tags.push({ name: 'Terminal', description: 'WebSocket terminal access' })
}

// DSH Web profile plugins and native schema-based settings.
const pluginResponse = schema => ({ description: 'Plugin state', content: { 'application/json': { schema } } })
const pluginError = description => ({ description, content: { 'application/json': { schema: {
  type: 'object', properties: { code: { type: 'string' }, error: { type: 'string' }, retryable: { type: 'boolean' } },
} } } })
const pluginAuth = { security: [{ BearerAuth: [] }], tags: ['Coding Agents'] }
openapi.paths['/api/coding-agents/dsh/plugin-inventory'] = { get: {
  ...pluginAuth, operationId: 'getNativeDshPluginInventory', summary: 'Discover native DSH preset plugin entries',
  description: 'Super admin only. Reads the installed CLI dependency graph and native shipped/user preset compositions, recursively flattening groups. Includes disabled entries. Does not execute YAML expressions or connect to the Web runtime. Custom deployment roots and overlays are not resolved. Counts are per preset, not npm package counts. Includes separately counted packages installed in the native Web profile. Runtime phases remain unknown for this static inventory.',
  responses: { '200': pluginResponse({ type: 'object', properties: {
    source: { type: 'string', enum: ['native-presets'] }, discovery: { type: 'string', enum: ['shipped-and-user-roots'] },
    sourceHome: { type: 'string' }, packageVersion: { type: 'string' }, defaultPreset: { type: 'string' }, runtimeConnected: { type: 'boolean', enum: [false] },
    web: { type: 'object', properties: { profile: { type: 'string', enum: ['web'] }, sourcePath: { type: 'string' }, revision: { type: 'string' }, packages: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, title: { type: 'string' }, description: { type: 'string' }, requested: { type: 'string' }, version: { type: 'string' }, bundle: { type: 'boolean' }, containsBrowserPart: { type: 'boolean' }, sourcePath: { type: 'string' }, error: { type: 'string' } } } } } },
    presets: { type: 'array', items: { type: 'object', properties: {
      id: { type: 'string' }, name: { type: 'string' }, description: { type: 'string' }, trust: { type: 'string', enum: ['system', 'user'] },
      sourcePath: { type: 'string' }, isDefault: { type: 'boolean' }, error: { type: 'string' },
      entries: { type: 'array', items: { type: 'object', properties: {
        entryId: { type: 'string' }, title: { type: 'string' }, description: { type: 'string' }, moduleName: { type: 'string' }, configuredEnabled: { oneOf: [{ type: 'boolean' }, { type: 'string', enum: ['conditional'] }] },
        runtimePhase: { nullable: true, enum: [null] }, groupPath: { type: 'array', items: { type: 'string' } },
      } } },
    } } },
  } }), '401': pluginError('Authentication required'), '403': pluginError('Super admin required'), '422': pluginError('Native inventory unavailable in this installation'), '500': pluginError('Source unavailable') },
} }
const packageResponses = { '200': pluginResponse({ type: 'object', additionalProperties: true }), '400': pluginError('Invalid package selection'), '403': pluginError('Super admin required'), '409': pluginError('Another package operation is running'), '412': pluginError('Web profile changed; reload before continuing'), '422': pluginError('Native package command failed'), '503': pluginError('DSH or package manager unavailable') }
openapi.paths['/api/coding-agents/dsh/web-plugins'] = { post: {
  ...pluginAuth, operationId: 'changeDshWebPlugins', summary: 'Install or remove packages in the native Web profile',
  parameters: [{ in: 'header', name: 'If-Match', required: true, schema: { type: 'string' }, description: 'Quoted Web manifest revision from plugin-inventory' }],
  requestBody: { required: true, content: { 'application/json': { schema: { oneOf: [
    { type: 'object', required: ['action', 'packageSpec'], properties: { action: { type: 'string', enum: ['install'] }, packageSpec: { type: 'string', description: 'package@exact-version or github:owner/repo#commit' } } },
    { type: 'object', required: ['action', 'packageName'], properties: { action: { type: 'string', enum: ['remove'] }, packageName: { type: 'string' } } },
  ] } } } }, responses: packageResponses,
} }
openapi.paths['/api/coding-agents/dsh/ui-session'] = { post: {
  ...pluginAuth, operationId: 'openDshPluginUi', summary: 'Open an authenticated native DSH configuration slot',
  description: 'Super admin only. Starts the native Web runtime and returns a short-lived scoped frame path. Plugin forms and business APIs are owned by DSH and installed plugins.',
  responses: { '200': pluginResponse({ type: 'object', properties: { id: { type: 'string' }, path: { type: 'string' } } }), '403': pluginError('Super admin required'), '503': pluginError('Native DSH Web runtime unavailable') },
} }
openapi.paths['/api/coding-agents/dsh/ui-session/{id}'] = { delete: {
  ...pluginAuth, operationId: 'closeDshPluginUi', summary: 'Revoke a native plugin frame session',
  parameters: [{ in: 'path', name: 'id', required: true, schema: { type: 'string' } }], responses: { '204': { description: 'Frame session revoked' }, '403': pluginError('Super admin required') },
} }

// Studio-owned Agent preset presentation over the existing native DSH host.
const presetRowSchema = { type: 'object', required: ['id', 'trust', 'isDefault'], properties: {
  id: { type: 'string' }, name: { type: 'string' }, description: { type: 'string' }, trust: { type: 'string', enum: ['system', 'user'] }, isDefault: { type: 'boolean' }, broken: { type: 'string' },
} }
const presetRosterSchema = { type: 'object', required: ['presets', 'authorable'], properties: { presets: { type: 'array', items: presetRowSchema }, authorable: { type: 'boolean' } } }
const presetErrors = { '400': pluginError('Invalid preset request'), '403': pluginError('Super admin required or shipped preset is read-only'), '404': pluginError('Preset not found'), '422': pluginError('Unavailable preset or invalid operation'), '502': pluginError('Native preset service unavailable'), '503': pluginError('DSH installation unavailable') }
const presetParameters = [{ in: 'path', name: 'presetId', required: true, schema: { type: 'string', pattern: '^[a-z0-9][a-z0-9-]*$', maxLength: 200 } }]
openapi.paths['/api/coding-agents/dsh/session-presets'] = { get: {
  ...pluginAuth, operationId: 'listDshSessionPresets', summary: 'List DSH modes available when creating a chat',
  description: 'Available to authenticated chat users. Returns only preset identifiers, names, descriptions, default and availability; does not expose configuration files or authoring operations.',
  responses: { '200': pluginResponse({ type: 'object', required: ['presets'], properties: { presets: { type: 'array', items: { type: 'object', required: ['id', 'isDefault'], properties: { id: { type: 'string' }, name: { type: 'string' }, description: { type: 'string' }, isDefault: { type: 'boolean' }, unavailable: { type: 'boolean' } } } } } }), '502': pluginError('Native preset service unavailable'), '503': pluginError('DSH installation unavailable') },
} }
openapi.paths['/api/coding-agents/dsh/agent-presets'] = {
  get: { ...pluginAuth, operationId: 'listDshAgentPresets', summary: 'List the live native Agent preset roster', description: 'Reuses the existing owned DSH management host, including configured preset roots. Returns names, descriptions, default, authoring availability and broken states.', responses: { '200': pluginResponse(presetRosterSchema), ...presetErrors } },
  post: { ...pluginAuth, operationId: 'copyDshAgentPreset', summary: 'Duplicate a native Agent preset into its writable source root', requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['from', 'id'], properties: { from: { type: 'string' }, id: { type: 'string', pattern: '^[a-z0-9][a-z0-9-]*$', maxLength: 200 }, name: { type: 'string', maxLength: 200 } } } } } }, responses: { '200': pluginResponse(presetRosterSchema), ...presetErrors } },
}
openapi.paths['/api/coding-agents/dsh/agent-presets/{presetId}'] = {
  get: { ...pluginAuth, operationId: 'readDshAgentPreset', summary: 'Read a native preset composition', parameters: presetParameters, responses: { '200': pluginResponse({ type: 'object', properties: { agentPreset: { type: 'string' }, content: { type: 'string' }, name: { type: 'string' }, trust: { type: 'string', enum: ['system', 'user'] } } }), ...presetErrors } },
  delete: { ...pluginAuth, operationId: 'deleteDshAgentPreset', summary: 'Delete a custom preset directory through DSH', description: 'Native DSH rejects shipped presets and clears a deleted user default. Existing sessions retain their mounted composition.', parameters: presetParameters, responses: { '200': pluginResponse(presetRosterSchema), ...presetErrors } },
}
openapi.paths['/api/coding-agents/dsh/agent-presets/{presetId}/default'] = { put: { ...pluginAuth, operationId: 'defaultDshAgentPreset', summary: 'Set the native preset default for new sessions', parameters: presetParameters, responses: { '200': pluginResponse(presetRosterSchema), ...presetErrors } } }
openapi.paths['/api/coding-agents/dsh/agent-presets/{presetId}/location'] = { post: { ...pluginAuth, operationId: 'locateDshAgentPreset', summary: 'Open a custom preset directory on the DSH host or return its path', parameters: presetParameters, responses: { '200': pluginResponse({ oneOf: [{ type: 'object', required: ['opened'], properties: { opened: { type: 'boolean', enum: [true] } } }, { type: 'object', required: ['opened', 'path'], properties: { opened: { type: 'boolean', enum: [false] }, path: { type: 'string' } } }] }), ...presetErrors } } }

// Share identities use separate headers so App relays cannot replace the cloud
// account credential with a local Studio JWT.
openapi.components.securitySchemes.AppAccessToken = { type: 'apiKey', in: 'header', name: 'X-App-Access-Token', description: 'Cloud App access token, verified against /api/app/auth/me.' }
openapi.components.securitySchemes.SessionShareToken = { type: 'apiKey', in: 'header', name: 'X-Session-Share-Token', description: 'sst1_ invitation secret; never accepted as a Studio login JWT.' }
// These existing routes accept a second, session-scoped authentication mechanism.
const shareReadPaths = ['/api/studio/sessions/{id}', '/api/studio/sessions/{id}/context', '/api/studio/sessions/{id}/usage',
  '/api/studio/sessions/conversations/{id}/messages', '/api/studio/sessions/conversations/{id}/messages/paginated']
for (const [path, methods] of Object.entries(openapi.paths)) {
  for (const [method, operation] of Object.entries(methods)) {
    let permission = ''
    if (method === 'get' && shareReadPaths.includes(path)) permission = 'read'
    if (method === 'post' && path === '/api/studio/chat-run/runs') permission = 'input'
    if (method === 'get' && ['/api/studio/files/download', '/api/studio/sessions/{id}/export'].includes(path)) permission = 'download'
    if (method === 'get' && /^\/api\/studio\/sessions\/\{id\}\/(workspace-files\/list|workspace-file\/(read|diff|content)|workspace-run-changes(?:\/\{changeId\}\/files\/\{fileId\})?)$/.test(path)) permission = 'workspaceRead'
    if (['put workspace-file/write', 'post workspace-file/mkdir', 'delete workspace-file/delete', 'post workspace-file/rename', 'post workspace-file/copy'].includes(`${method} ${path.replace('/api/studio/sessions/{id}/', '')}`)) permission = 'workspaceWrite'
    if ((method === 'post' && path === '/api/studio/uploads') || /^\/api\/studio\/app-uploads(?:\/\{id\}(?:\/chunks|\/complete)?)?$/.test(path)) permission = 'upload'
    if (method === 'get' && path === '/api/studio/sessions/{id}/share-models') permission = 'switchModel'
    if (method === 'get' && path === '/api/studio/sessions/{id}/share-workspaces') permission = 'switchWorkspace'
    if (method === 'post' && path === '/api/studio/sessions/{id}/model') permission = 'switchModel'
    if (method === 'post' && path === '/api/studio/sessions/{id}/reasoning-effort') permission = 'reasoningEffort'
    if (method === 'post' && path === '/api/studio/sessions/{id}/workspace') permission = 'switchWorkspace'
    if (!permission) continue
    operation.security = [...(operation.security || [{ BearerAuth: [] }]), { AppAccessToken: [], SessionShareToken: [] }]
    operation['x-session-share-permission'] = permission
    operation.description = `${operation.description || ''}\nApp session sharing: requires the claimed recipient identity and ${permission} permission; scope is fixed to the shared session. workspace-file/content with download=1 requires download instead. Agent and terminal execution retain existing host permissions.`.trim()
  }
}
const sharePermissionSchema = { type: 'object', additionalProperties: false, properties: Object.fromEntries(
  ['input', 'voice', 'upload', 'download', 'workspaceRead', 'workspaceWrite', 'outsideWorkspace', 'terminal', 'switchModel', 'reasoningEffort', 'switchWorkspace'].map(key => [key, { type: 'boolean', default: false }]),
) }
sharePermissionSchema.properties.voice.description = 'Use session-scoped speech transcription and synthesis with the sharer Profile voice settings. Sending transcribed messages still requires input. Defaults to false for existing shares.'
sharePermissionSchema.properties.switchModel.description = 'Change the shared session model using the scoped share-models catalog, and edit the current Hermes/Ekko model context limit. Does not grant reasoning-effort changes.'
sharePermissionSchema.properties.reasoningEffort.description = 'Change the shared session reasoning effort independently of model selection.'
sharePermissionSchema.properties.switchWorkspace.description = 'Select an existing directory within the original workspace, or an explicit extraPaths grant when outsideWorkspace is enabled. Does not grant filesystem read/write or expand the share scope.'
for (const [suffix, description] of [
  ['share-models', 'Selectable models for this session. Returns provider/model labels and IDs without provider secrets or endpoints.'],
  ['share-workspaces', 'Browse only directories that this share may select as workspace. Empty path returns authorized roots; an absolute path returns child directories.'],
]) {
  const operation = openapi.paths[`/api/studio/sessions/{id}/${suffix}`]?.get
  if (!operation) continue
  operation.security = [{ AppAccessToken: [], SessionShareToken: [] }]
  operation.description = `${description} ${operation.description || ''}`
  if (suffix === 'share-workspaces') operation.parameters = [
    ...(operation.parameters || []).filter(parameter => parameter.name !== 'path'),
    { name: 'path', in: 'query', required: false, schema: { type: 'string' }, description: 'Existing absolute directory in the share scope. Omit to list authorized roots.' },
  ]
}
const shareChangeSchema = { type: 'object', additionalProperties: false, properties: {
  permissions: sharePermissionSchema,
  extraPaths: { type: 'array', maxItems: 16, items: { type: 'object', additionalProperties: false, required: ['path', 'writable'], properties: {
    path: { type: 'string', description: 'Existing absolute directory explicitly allowed outside the session workspace. Super administrator only.' }, writable: { type: 'boolean' },
  } } },
} }
const shareBody = schema => ({ required: true, content: { 'application/json': { schema } } })
for (const kind of ['synthesize', 'transcribe']) {
  const operation = openapi.paths[`/api/studio/sessions/{id}/share-voice/${kind}`].post
  operation.operationId = kind === 'synthesize' ? 'synthesizeSessionShareSpeech' : 'transcribeSessionShareSpeech'
  operation.security = [{ AppAccessToken: [], SessionShareToken: [] }]
  operation['x-session-share-permission'] = 'voice'
  operation.description = 'Requires voice permission on the claimed shared session. Uses the share-bound Profile active speech provider and stored settings; provider, credential and option overrides are rejected. No upload permission is required. Sending recognized text additionally requires input.'
  operation.requestBody = kind === 'synthesize'
    ? shareBody({ type: 'object', additionalProperties: false, required: ['text'], properties: { text: { type: 'string', minLength: 1, maxLength: 5000 } } })
    : { required: true, content: { 'multipart/form-data': { schema: { type: 'object', additionalProperties: false, required: ['audio'], properties: { audio: { type: 'string', format: 'binary' } } } } } }
  operation.responses['200'] = kind === 'synthesize'
    ? { description: 'MP3 speech audio', content: { 'audio/mpeg': { schema: { type: 'string', format: 'binary' } } } }
    : { description: 'Recognized speech; text is empty when no speech is detected', content: { 'application/json': { schema: { type: 'object', properties: { text: { type: 'string' }, provider: { type: 'string' }, model: { type: 'string' }, durationMs: { type: 'number' } } } } } }
  operation.responses['400'] = { description: 'Invalid text/audio, unsupported provider or missing host configuration' }
  operation.responses['403'] = { description: 'Voice permission denied or session/profile mismatch' }
  operation.responses['410'] = { description: 'Share expired or revoked' }
}
const shareContextPath = openapi.paths['/api/studio/sessions/{id}/share-context-length']
for (const method of ['get', 'put']) {
  const operation = shareContextPath[method]
  operation.operationId = method === 'get' ? 'getSessionShareContextLength' : 'setSessionShareContextLength'
  operation.security = [{ AppAccessToken: [], SessionShareToken: [] }]
  operation['x-session-share-permission'] = method === 'get' ? 'read' : 'switchModel'
  operation.description = 'Read or edit the current shared Hermes/Ekko model context limit. Profile and session are server-bound. Writes require switchModel and matching current provider/model; the value is model-level within the shared Profile. Coding Agents do not support this operation.'
  operation.responses['200'] = { description: 'Current context limit', content: { 'application/json': { schema: {
    type: 'object', required: ['context_length'], properties: { context_length: { type: 'integer', minimum: 1 } },
  } } } }
  operation.responses['403'] = { description: 'Permission denied or session/profile mismatch' }
  operation.responses['410'] = { description: 'Share expired or revoked' }
}
shareContextPath.put.requestBody = shareBody({ type: 'object', additionalProperties: false,
  required: ['provider', 'model', 'context_limit'], properties: {
    provider: { type: 'string', minLength: 1 }, model: { type: 'string', minLength: 1 },
    context_limit: { type: 'integer', minimum: 1000, maximum: 10000000 },
  },
})
openapi.components.schemas.SessionShare = {
  type: 'object', additionalProperties: false,
  properties: {
    id: { type: 'string' }, session_id: { type: 'string' },
    sharer_app_user_id: { type: 'integer' }, sharer_name_snapshot: { type: 'string' },
    recipient_app_user_id: { type: 'integer', nullable: true }, recipient_name_snapshot: { type: 'string', nullable: true },
    permissions: sharePermissionSchema, policy_version: { type: 'integer' },
    ...Object.fromEntries(['created_at', 'updated_at', 'expires_at', 'claimed_at', 'revoked_at'].map(key => [key, {
      type: 'integer', format: 'int64', description: 'Unix epoch milliseconds', ...(['claimed_at', 'revoked_at'].includes(key) ? { nullable: true } : {}),
    }])),
  },
}
for (const [path, methods] of Object.entries(openapi.paths)) {
  const management = /^\/api\/studio\/sessions\/\{sessionId\}\/shares/.test(path)
  if (!management && !path.startsWith('/api/studio/session-shares/')) continue
  for (const [method, operation] of Object.entries(methods)) {
    operation.operationId = management
      ? ({ post: 'createSessionShare', get: 'listSessionShares', patch: 'updateSessionShare', delete: 'revokeSessionShare' })[method]
      : ({ claim: 'claimSessionShare', access: 'getSessionShareAccess', check: 'checkSessionSharePermission' })[path.split('/').pop()]
    operation.parameters = [...path.matchAll(/\{([^}]+)\}/g)].map(match => ({ name: match[1], in: 'path', required: true, schema: { type: 'string' } }))
    operation.security = management ? [{ BearerAuth: [] }] : [{ AppAccessToken: [], SessionShareToken: [] }]
    if (management && ['post', 'patch'].includes(method)) operation.requestBody = shareBody(method === 'post'
      ? { ...shareChangeSchema, required: ['sharer'], properties: { ...shareChangeSchema.properties,
        sharer: { type: 'object', additionalProperties: false, required: ['id', 'name'], description: 'App-provided attribution only. Management authority comes from the authenticated local Studio owner, not this metadata.',
          properties: { id: { type: 'integer', minimum: 1 }, name: { type: 'string', maxLength: 200 } } },
      } } : shareChangeSchema)
    if (path.endsWith('/claim')) operation.requestBody = shareBody({ type: 'object', additionalProperties: false, required: ['confirm'], properties: { confirm: { type: 'boolean', enum: [true] } } })
    if (path.endsWith('/check')) operation.requestBody = shareBody({ type: 'object', additionalProperties: false, required: ['action', 'sessionId'], properties: {
      action: { type: 'string', enum: ['read', ...Object.keys(sharePermissionSchema.properties)] }, sessionId: { type: 'string' },
    } })
    operation.responses = { ...operation.responses, '401': { description: 'Missing or invalid App identity / Studio App device credential' },
      '403': { description: 'Recipient, session, resource, owner or permission mismatch' }, '404': { description: 'Share not found' },
      '409': { description: 'Already claimed by another App user, or concurrent policy change' }, '410': { description: 'Share expired or revoked' },
      '503': { description: 'Identity verification or transactional storage unavailable' } }
    if (management && method === 'post') {
      delete operation.responses['200']
      operation.responses['201'] = { description: 'New independent invitation; secret is returned only at creation', content: { 'application/json': { schema: {
        type: 'object', required: ['share', 'token'], properties: { share: { $ref: '#/components/schemas/SessionShare' }, token: { type: 'string', pattern: '^sst1_[A-Za-z0-9_-]{43}$' } },
      } } } }
    }
  }
}

// JEV accepts named heterogeneous questions and never returns its stored API key.
const jevSettingsProperties = {
  ekkoComputerUseMatchEnabled: { type: 'boolean', default: false },
  ekkoComputerUseMatchCandidateLimit: { type: 'integer', default: 20, minimum: 1, maximum: 50 },
  ekkoComputerUseMatchMinConfidence: { type: 'number', default: 0.8, minimum: 0.5, maximum: 1 },
  ekkoComputerUseMatchTimeoutMs: { type: 'integer', default: 3000, minimum: 100, maximum: 30000 },
  ekkoComputerUseVerifyEnabled: { type: 'boolean', default: false },
  ekkoComputerUseVerifyMinConfidence: { type: 'number', default: 0.8, minimum: 0.5, maximum: 1 },
  ekkoComputerUseVerifyTimeoutMs: { type: 'integer', default: 3000, minimum: 100, maximum: 30000 },
  browserMatchEnabled: { type: 'boolean', default: false },
  browserVerifyEnabled: { type: 'boolean', default: false },
  browserMatchCandidateLimit: { type: 'integer', default: 20, minimum: 1, maximum: 50 },
  browserMatchMinConfidence: { type: 'number', default: 0.8, minimum: 0.5, maximum: 1 },
  browserVerifyMinConfidence: { type: 'number', default: 0.8, minimum: 0.5, maximum: 1 },
  browserMatchTimeoutMs: { type: 'integer', default: 3000, minimum: 100, maximum: 30000 },
  browserVerifyTimeoutMs: { type: 'integer', default: 3000, minimum: 100, maximum: 30000 },
  baseUrl: { type: 'string', format: 'uri', default: 'https://api.typesafe.ai' },
  model: { type: 'string', default: 'jev-latest', maxLength: 200 },
  timeoutMs: { type: 'integer', minimum: 1000, maximum: 120000, default: 10000 },
}
const jevSettingsSchema = { type: 'object', properties: { ...jevSettingsProperties, hasApiKey: { type: 'boolean' } }, required: ['baseUrl', 'model', 'timeoutMs', 'hasApiKey'] }
openapi.components.schemas.JevError = {
  type: 'object', required: ['error'], properties: {
    error: { type: 'string', description: 'Sanitized diagnostic message.' },
    code: { type: 'string', pattern: '^jev_', description: 'Stable JEV error code used for client-side translation; middleware errors may omit it.' },
  },
}
for (const [path, methods] of Object.entries(openapi.paths)) {
  if (!path.startsWith('/api/studio/jev/')) continue
  for (const [method, operation] of Object.entries(methods)) {
    operation.parameters = [{ name: 'X-Hermes-Profile', in: 'header', required: true, schema: { type: 'string' }, description: 'Authorized Profile; never changes the global active Profile.' }]
    if (path.endsWith('/settings')) {
      operation.responses['200'] = { description: 'Non-secret JEV settings', content: { 'application/json': { schema: jevSettingsSchema } } }
      if (method === 'put') operation.requestBody = { required: true, content: { 'application/json': { schema: {
        type: 'object', additionalProperties: false, properties: { ...jevSettingsProperties,
          apiKey: { type: 'string', writeOnly: true, description: 'Omit or leave blank to preserve the saved key. DELETE clears it.' },
        },
      } } } }
    }
    if (path.includes('/browser/')) {
      const intent = path.endsWith('/match') ? 'target' : 'expectation'
      operation.requestBody = { required: true, content: { 'application/json': { schema: {
        type: 'object', required: [intent, 'snapshot'], properties: {
          [intent]: { type: 'string', minLength: 1, maxLength: 2000 },
          snapshot: { type: 'object', required: ['tabId', 'snapshotId', 'nodes'], properties: {
            tabId: { type: 'string', minLength: 1, maxLength: 128 }, snapshotId: { type: 'string', minLength: 1, maxLength: 128 },
            title: { type: 'string', maxLength: 1000 },
            nodes: { type: 'array', maxItems: 500, items: { type: 'object', required: ['ref', 'role', 'name'], properties: {
              ref: { type: 'string', pattern: '^@e[1-9][0-9]*$', maxLength: 32 }, role: { type: 'string', minLength: 1, maxLength: 80 },
              name: { type: 'string', maxLength: 1000 }, disabled: { type: 'boolean' },
            } } },
          } },
        },
      } } } }
      operation.responses['200'] = { description: 'Advisory, Profile-gated assessment of supplied snapshot evidence. Never executes actions or changes their completion status.', content: { 'application/json': { schema: {
        type: 'object', required: ['tabId', 'snapshotId', 'status'], properties: {
          tabId: { type: 'string' }, snapshotId: { type: 'string' },
          status: { type: 'string', enum: intent === 'target' ? ['matched', 'no_match', 'skipped', 'unavailable'] : ['met', 'not_met', 'unknown', 'skipped', 'unavailable'] },
          reason: { type: 'string' }, ref: { type: 'string' }, confidence: { type: 'number', minimum: 0, maximum: 1 }, considered: { type: 'integer' },
        },
      } } } }
    }
    if (path.endsWith('/evaluate')) operation.requestBody = { required: true, content: { 'application/json': { schema: {
      type: 'object', required: ['state', 'questions'], properties: {
        state: { nullable: true, oneOf: [{ type: 'string' }, { type: 'object', additionalProperties: true }, { type: 'array', items: {} }] },
        questions: { type: 'object', minProperties: 1, additionalProperties: {
          type: 'object', required: ['type'], properties: {
            type: { type: 'string', enum: ['choice', 'score', 'noul'] }, instructions: {}, criteria: {},
          }, description: 'Choice: at least two named criteria. Score: at least two ordered criteria. Noul: optional true/false criteria.',
        } }, model: { type: 'string' },
      },
    } } } }
    for (const [status, description] of Object.entries({ 400: 'Invalid input or missing Profile', 403: 'Profile access denied', 409: 'API key not configured', 499: 'Request cancelled', 500: 'Settings operation failed', 502: 'Provider request failed', 504: 'Provider request timed out' })) {
      operation.responses[status] = { description, content: { 'application/json': { schema: { $ref: '#/components/schemas/JevError' } } } }
    }
  }
}

// Usage rates are Profile-scoped and are snapshots for future usage only.
const usageRateSchema = { type: 'object', required: ['provider', 'model', 'input', 'output'], properties: {
  provider: { type: 'string', minLength: 1, maxLength: 200 }, model: { type: 'string', minLength: 1, maxLength: 300 },
  ...Object.fromEntries(['input', 'output', 'cacheRead', 'cacheWrite'].map(key => [key, { type: 'number', minimum: 0, maximum: 1000000, description: 'USD per million tokens', ...(['cacheRead', 'cacheWrite'].includes(key) ? { nullable: true } : {}) }])),
} }
const usageRatesSchema = { type: 'object', required: ['rates'], properties: { rates: { type: 'array', maxItems: 200, items: usageRateSchema } } }
const usagePricingPath = openapi.paths['/api/studio/usage/pricing']
usagePricingPath.put.requestBody = { required: true, content: { 'application/json': { schema: usageRatesSchema } } }
for (const operation of [usagePricingPath.get, usagePricingPath.put]) {
  operation.description = 'Profile-scoped model pricing in USD per million tokens. Exact provider/model match. Applies only to future calls without reported cost; never reprices historical usage.'
  operation.responses['200'] = { description: 'Saved pricing', content: { 'application/json': { schema: usageRatesSchema } } }
}
usagePricingPath.put.responses['400'] = { description: 'Invalid or duplicate provider/model pricing' }

// Account-owned workspace shortcuts. No local-storage import or profile dimension.
const workspaceDirectorySchema = { type: 'object', required: ['path', 'isFavorite', 'lastUsed', 'useCount', 'createdAt', 'updatedAt'], properties: {
  path: { type: 'string' }, isFavorite: { type: 'boolean' },
  ...Object.fromEntries(['lastUsed', 'useCount', 'createdAt', 'updatedAt'].map(key => [key, { type: 'integer', minimum: 0 }])),
} }
const workspaceDirectoryResponse = { type: 'object', required: ['directories'], properties: {
  directories: { type: 'array', items: workspaceDirectorySchema },
} }
const workspaceDirectoriesPath = openapi.paths['/api/studio/workspace/directories']
for (const [method, operation] of Object.entries(workspaceDirectoriesPath)) {
  operation.operationId = { get: 'listWorkspaceDirectories', post: 'recordWorkspaceDirectory', patch: 'setWorkspaceDirectoryFavorite' }[method]
  operation.description = 'Directory history and favorites for the authenticated Studio account, shared by Studio and App across Profiles. System-generated workspaces are excluded. Timestamps are Unix milliseconds.'
  operation.responses['200'] = { description: 'Account directory shortcuts', content: { 'application/json': { schema: workspaceDirectoryResponse } } }
  operation.responses['401'] = { description: 'Authenticated account required' }
  if (method === 'get') continue
  operation.requestBody = { required: true, content: { 'application/json': { schema: {
    type: 'object', required: method === 'patch' ? ['path', 'favorite'] : ['path'], properties: {
      path: { type: 'string', minLength: 1, maxLength: 4096 },
      ...(method === 'patch' ? { favorite: { type: 'boolean' } } : {}),
    },
  } } } }
  operation.responses['400'] = { description: 'Invalid directory path or favorite value' }
}

// One native model discovery endpoint for every Coding Agent.
const codingAgentIds = ['claude-code', 'codex', 'pi', 'grok', 'opencode', 'dsh', 'cursor', 'antigravity', 'qwen', 'kimi', 'codebuddy', 'qoder', 'copilot', 'zcode']
const nativeModelSchema = {
  type: 'object', required: ['id', 'name'], properties: {
    id: { type: 'string', description: 'Native model ID or alias; preserve provider prefixes.' },
    name: { type: 'string' }, provider: { type: 'string' },
    resolvedModel: { type: 'string', description: 'Concrete identity from native discovery; execution preserves id.' },
    isDefault: { type: 'boolean' }, hidden: { type: 'boolean' },
    contextWindow: { type: 'number' }, maxOutputTokens: { type: 'number' },
    reasoningEfforts: { type: 'array', items: { type: 'string' } },
    modelFamily: { type: 'string', description: 'Grouping key for native effort variants; never send it as a model ID.' },
    modelFamilyName: { type: 'string' },
    reasoningEffort: { type: 'string', description: 'Fixed effort encoded by this literal native model ID.' },
    inputModalities: { type: 'array', items: { type: 'string' } },
  },
}
const reasoningOperation = openapi.paths['/api/studio/sessions/{id}/reasoning-effort']?.post
if (reasoningOperation) {
  reasoningOperation.requestBody = { required: true, content: { 'application/json': { schema: {
    type: 'object', required: ['reasoningEffort'], properties: {
      reasoningEffort: { type: 'string', enum: ['', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] },
      model: { type: 'string', description: 'Optional literal effort-variant ID for global Cursor/Antigravity sessions. Validated against the native catalog and current family; persisted atomically with effort.' },
    },
  } } } }
  reasoningOperation.responses['400'] = { description: 'Invalid effort, mode or native variant/family' }
  reasoningOperation.responses['503'] = { description: 'Native catalog unavailable for validating the paired model change' }
}
openapi.paths['/api/hermes/available-models'].get.description = 'Visible models for one Profile or all accessible Profiles. Full catalogs and hidden-model aliases are omitted. Each group has model_count; allProviders contains preset descriptors with empty models. Load a full directory on demand with GET /api/hermes/provider-models.'
openapi.paths['/api/hermes/provider-models'].get = {
  tags: ['Models'], operationId: 'getProviderModelCatalog', summary: 'Read the full model directory for one Provider',
  description: 'Settings-only on-demand catalog, including hidden models and their aliases. Reads configured/cached models for the authorized Profile, with preset fallback. Does not probe upstream endpoints or scan capability metadata. Credentials are never returned.',
  security: [{ BearerAuth: [] }],
  parameters: [
    { name: 'provider', in: 'query', required: true, schema: { type: 'string' } },
    { name: 'profile', in: 'query', required: false, schema: { type: 'string' }, description: 'Authorized Profile; required here or in x-hermes-profile.' },
  ],
  responses: {
    '200': { description: 'Complete Provider directory and current visible models', content: { 'application/json': { schema: {
      type: 'object', required: ['provider', 'models', 'visible_models', 'model_aliases'], properties: {
        provider: { type: 'string' }, models: { type: 'array', items: { type: 'string' } },
        visible_models: { type: 'array', items: { type: 'string' } },
        model_aliases: { type: 'object', additionalProperties: { type: 'string' } },
      },
    } } } },
    '400': { description: 'Missing Provider or Profile' }, '403': { description: 'Profile access denied' },
    '404': { description: 'Provider not found' },
  },
}
openapi.paths['/api/coding-agents/models'] = { get: {
  tags: ['Coding Agents'], operationId: 'getCodingAgentModels', summary: 'Discover native models for one or all Coding Agents',
  description: 'Reads native CLI/account/config model directories on this Studio server, independently of Hermes Profiles. No chat prompts are sent. Each agent has its own discovery status; an individual failure does not fail the aggregate request. Successful results cache for 60 seconds and failures for 5 seconds. Refresh bypasses the cache while sharing in-flight requests. Builtin/configured entries do not prove account access. Raw native errors and credentials are never returned.',
  security: [{ BearerAuth: [] }],
  parameters: [
    { name: 'agent', in: 'query', required: false, schema: { type: 'string', enum: codingAgentIds }, description: 'Omit to discover all fourteen agents.' },
    { name: 'refresh', in: 'query', required: false, schema: { type: 'boolean', default: false } },
  ],
  responses: {
    '200': { description: 'Native directories and individual discovery statuses', content: { 'application/json': { schema: {
      type: 'object', required: ['agents'], properties: { agents: { type: 'array', items: {
        type: 'object', required: ['agentId', 'name', 'status', 'source', 'scope', 'models', 'checkedAt', 'cached'], properties: {
          agentId: { type: 'string', enum: codingAgentIds }, name: { type: 'string' },
          status: { type: 'string', enum: ['ready', 'empty', 'not_installed', 'auth_required', 'unsupported', 'timeout', 'error'] },
          source: { type: 'string', enum: ['cli', 'app-server', 'control-protocol', 'sdk', 'acp', 'config'] },
          scope: { type: 'string', enum: ['available', 'configured', 'builtin'] },
          models: { type: 'array', items: nativeModelSchema }, checkedAt: { type: 'string', format: 'date-time' }, cached: { type: 'boolean' },
        },
      } } },
    } } } },
    '400': { description: 'Unknown agent or invalid query parameters' },
    '401': { $ref: '#/components/responses/Unauthorized' },
    '500': { description: 'Unable to initialize native model discovery' },
  },
} }

const usageStatsOperation = openapi.paths['/api/studio/usage/stats']?.get
if (usageStatsOperation) {
  usageStatsOperation.description = 'Aggregates one usage origin across accessible Profiles. Defaults to internal (existing sessions, workflows and coding agents). External includes every Model API request, even when Studio calls its own endpoint. The categories can represent the same physical upstream call and must not be summed as a deduplicated total. Account means the session owner for internal usage and the authenticated API caller for external usage; unknown historical ownership remains unassigned.'
  usageStatsOperation.parameters = usageStatsOperation.parameters.filter(parameter => parameter.name !== 'origin')
  usageStatsOperation.parameters.push({ name: 'origin', in: 'query', required: false, schema: { type: 'string', enum: ['internal', 'external'], default: 'internal' } })
  const accountParameter = usageStatsOperation.parameters.find(parameter => parameter.name === 'account')
  accountParameter.schema = { type: 'string', pattern: '^(?:[1-9][0-9]*|unassigned)$' }
  accountParameter.description = 'Studio user ID, or unassigned. Omit to include all accounts.'
  usageStatsOperation.responses['400'] = { description: 'Invalid origin, account ID or timezone' }
  usageStatsOperation.responses['403'] = { description: 'Selected Profile is not accessible to this user' }
}

// Model keys are account-wide; management still requires Studio login.
const modelApiParameters = []
const modelApiErrors = Object.fromEntries([
  ['400', 'Invalid input or unsupported Responses feature'], ['401', 'Missing, invalid or revoked Model API key, or expired Studio user JWT'],
  ['403', 'User or Profile access denied'], ['404', 'Profile or configured model not found'],
  ['429', 'Model API key budget exhausted (insufficient_quota), or request costs are unknown (quota_cost_unknown)'],
  ['501', 'Provider requires an unsupported direct-request runtime'], ['502', 'Upstream model request failed'],
].map(([status, description]) => [status, { description }]))
const keyBudgetSchema = { type: 'number', nullable: true, minimum: 0, maximum: 1000000, description: 'Lifetime USD budget. Null or omitted means unlimited; 0 blocks inference. Editing never resets spending.' }
const keyMetadata = { type: 'object', properties: {
  budgetUsd: keyBudgetSchema, spentUsd: { type: 'number', minimum: 0, description: 'Settled lifetime USD costs for this key' },
  unpricedRequests: { type: 'integer', minimum: 0, description: 'Unpriced or pending requests. Limited keys pause when costs remain unresolved after completion or interruption; known in-flight calls can continue.' },
  id: { type: 'string' }, name: { type: 'string' }, preview: { type: 'string' },
  models: { type: 'array', items: { type: 'string' }, description: 'Explicit provider-qualified model IDs allowed by this key' },
  createdAt: { type: 'integer', description: 'Unix milliseconds' }, lastUsedAt: { type: 'integer', nullable: true, description: 'Unix milliseconds' },
} }
const cloudLinkPath = openapi.paths['/api/studio/models/cloud-link']
const cloudLinkSchema = { type: 'object', properties: {
  available: { type: 'boolean' }, reason: { type: 'string' },
  urls: { type: 'object', nullable: true, properties: { official: { type: 'string', format: 'uri' }, cloudflare: { type: 'string', format: 'uri' } } },
  limits: { type: 'object', properties: Object.fromEntries(['uploadMaxMegabytes', 'downloadMaxMegabytes', 'uploadMegabytesPerSecond', 'downloadMegabytesPerSecond', 'requestsPerMinute'].map(key => [key, { type: 'integer', minimum: 1 }])) },
} }
for (const [method, suffix] of [['get', 'Get'], ['post', 'Create'], ['delete', 'Revoke']]) {
  const operation = cloudLinkPath[method]
  operation.operationId = `modelApiCloudLink${suffix}`
  operation.summary = `${suffix} my dual-route cloud Model API link`
  operation.parameters = modelApiParameters
  operation.description = 'Requires Studio user authentication and a valid formal cloud connection for this machine/account. Independent of Profile. Returns available:false when cloud access, enabled server feature or relay v3 support is unavailable. The optional cloud feature is disabled by default; Agent run credentials cannot manage links. Addresses are routing IDs; model API keys are still required. Authorized cloud response calls record account/machine/model/token/USD metadata without request or response content. Reset/revoke invalidates both routes.'
  operation.responses = { '200': { description: 'Cloud link status and independent limits', content: { 'application/json': { schema: cloudLinkSchema } } }, '401': { description: 'Studio login required' }, '503': { description: 'Cloud relay unavailable' } }
}
cloudLinkPath.post.requestBody = { required: false, content: { 'application/json': { schema: { type: 'object', properties: { rotate: { type: 'boolean', default: false, description: 'True replaces both URLs; otherwise creates a link if absent.' } } } } } }

const keyManagementPath = openapi.paths['/api/studio/models/api-keys']
keyManagementPath.get.summary = 'List my account-wide Model API keys'
keyManagementPath.get.parameters = modelApiParameters
keyManagementPath.get.description = 'Requires Studio user authentication. Lists only the caller’s keys, independent of Profile selection. Never returns plaintext keys or hashes.'
keyManagementPath.get.responses = { '200': { description: 'Key metadata', content: { 'application/json': { schema: { type: 'object', properties: { keys: { type: 'array', items: keyMetadata } } } } } }, '401': { description: 'Studio login required' }, '403': { description: 'Profile access denied' } }
keyManagementPath.post.summary = 'Create an account-wide Model API key'
keyManagementPath.post.parameters = modelApiParameters
keyManagementPath.post.description = 'Requires Studio user authentication. Key allows model listing and Responses inference only for the explicitly selected models; valid until revoked. Only the hash is persisted. Limit: 50 keys per account. Cache-Control: no-store.'
const modelApiKeySettings = { type: 'object', required: ['name', 'models'], additionalProperties: false, properties: {
  budgetUsd: keyBudgetSchema,
  name: { type: 'string', minLength: 1, maxLength: 80 }, models: { type: 'array', minItems: 1, uniqueItems: true, items: { type: 'string' }, description: 'Currently accessible, callable provider-qualified model IDs. New models are not granted automatically.' },
} }
keyManagementPath.post.requestBody = { required: true, content: { 'application/json': { schema: modelApiKeySettings } } }
keyManagementPath.post.responses = { '201': { description: 'Save the plaintext API key now; it is returned only once', content: { 'application/json': { schema: { type: 'object', properties: { key: keyMetadata, apiKey: { type: 'string' } } } } } }, '400': { description: 'Invalid key name or key limit reached' }, '401': { description: 'Studio login required' }, '403': { description: 'Profile access denied' } }
const revokeKeyOperation = openapi.paths['/api/studio/models/api-keys/{id}'].delete
revokeKeyOperation.summary = 'Revoke my Model API key'
revokeKeyOperation.description = 'Requires Studio user authentication. Revokes only the caller’s key. Profile selection does not affect key ownership. New requests are rejected; already-running requests are not cancelled.'
revokeKeyOperation.parameters = [...modelApiParameters, { name: 'id', in: 'path', required: true, schema: { type: 'string' } }]
revokeKeyOperation.responses = { '200': { description: 'Key revoked' }, '401': { description: 'Studio login required' }, '403': { description: 'Profile access denied' }, '404': { description: 'No matching key owned by caller' } }
const editKeyOperation = openapi.paths['/api/studio/models/api-keys/{id}'].patch
editKeyOperation.summary = 'Edit my Model API key name, allowed models and USD budget'
editKeyOperation.description = 'Requires Studio user authentication. Updates only the caller’s key. The secret, token hash and lifetime spending remain unchanged. budgetUsd sets a cumulative USD cap, null removes it and 0 pauses inference. Subsequent model listing and inference requests immediately use the saved model scope. Already-running requests are not cancelled.'
editKeyOperation.parameters = revokeKeyOperation.parameters
editKeyOperation.requestBody = { required: true, content: { 'application/json': { schema: modelApiKeySettings } } }
editKeyOperation.responses = { '200': { description: 'Updated key metadata without plaintext or hash', content: { 'application/json': { schema: { type: 'object', properties: { key: keyMetadata } } } } }, '400': { description: 'Invalid name or model selection' }, '401': { description: 'Studio login required' }, '404': { description: 'No matching key owned by caller' } }
const modelListOperation = openapi.paths['/api/ekko-studio/models/v1/models'].get
modelListOperation.summary = 'List configured models with provider-qualified IDs'
modelListOperation.parameters = modelApiParameters
modelListOperation.description = 'Model API keys see only their explicitly allowed model IDs; Studio user JWTs see the full account catalog. Aggregates all accessible Profiles as provider/model and deduplicates IDs, preserving slashes inside native model IDs. Callable configurations win over disabled/unsupported duplicates, then default Profile, then Profile names in lexical order. Caller Profile selectors are ignored. Never returns credentials. MoA presets and self-referencing Model API providers using a locally issued Model API key are excluded from this catalog. responses_supported=false marks disabled models and providers requiring Bedrock or Codex app-server runtimes.'
modelListOperation.responses = { ...modelApiErrors, '200': { description: 'OpenAI-compatible model list', content: { 'application/json': { schema: { type: 'object', properties: {
  object: { type: 'string', enum: ['list'] }, data: { type: 'array', items: { type: 'object', properties: {
    id: { type: 'string', example: 'glm/glm-5.3' }, object: { type: 'string', enum: ['model'] }, created: { type: 'integer' },
    owned_by: { type: 'string' }, api_mode: { type: 'string', nullable: true }, responses_supported: { type: 'boolean' },
  } } },
} } } } } }
const modelResponseOperation = openapi.paths['/api/ekko-studio/models/v1/responses'].post
modelResponseOperation.summary = 'Request a configured model using OpenAI Responses format'
modelResponseOperation.parameters = modelApiParameters
modelResponseOperation.description = 'Model API keys enforce their saved lifetime USD budget against settled request costs. Exhausted keys and limited keys with unpriced requests return 429 before inference; already-running calls can exceed the cap. Costs follow the usage ledger pricing rules. Studio user JWTs are outside key budgets. Model API key requests must name an allowed model; ungranted IDs return 404 before any provider request. Stateless JSON or SSE inference through existing provider adapters. Supports text, base64 images on vision models, reasoning and function-tool continuations. Send full input history, including returned reasoning encrypted_content, unchanged. Protocol and credentials resolve server-side from the same unified catalog as GET /models. No Profile selector is required. Every attempted upstream request records external usage under the authenticated user. Does not execute tools or create chat sessions. See docs/model-api.md for supported features and limitations.'
modelResponseOperation.requestBody = { required: true, content: { 'application/json': { schema: {
  type: 'object', required: ['model', 'input'], properties: {
    model: { type: 'string', example: 'glm/glm-5.3' },
    input: { oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'object', description: 'Responses message, reasoning, function_call or function_call_output item.' } }] },
    instructions: { type: 'string' }, stream: { type: 'boolean', default: false }, store: { type: 'boolean', enum: [false], default: false },
    max_output_tokens: { type: 'integer', minimum: 1 }, temperature: { type: 'number', minimum: 0, maximum: 2 },
    reasoning: { type: 'object', properties: { effort: { type: 'string', enum: ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] }, summary: { type: 'string', enum: ['auto', 'concise', 'detailed'] } } },
    tools: { type: 'array', items: { type: 'object', required: ['type', 'name'], properties: { type: { type: 'string', enum: ['function'] }, name: { type: 'string' }, description: { type: 'string' }, parameters: { type: 'object' }, strict: { type: 'boolean', enum: [false] } } } },
    tool_choice: { type: 'string', enum: ['auto', 'none', 'required'] }, metadata: { type: 'object', maxProperties: 16, additionalProperties: { type: 'string', maxLength: 512 } },
  },
} } } }
modelResponseOperation.responses = { ...modelApiErrors, '200': { description: 'Response object, or named Responses SSE events ending in response.completed, response.incomplete or response.failed. Usage may be null if the upstream did not report it.', headers: { 'x-request-id': { schema: { type: 'string' } } }, content: {
  'application/json': { schema: { type: 'object', properties: { id: { type: 'string' }, object: { type: 'string', enum: ['response'] }, model: { type: 'string' }, status: { type: 'string', enum: ['completed', 'incomplete', 'failed'] }, output: { type: 'array', items: { type: 'object' } }, usage: { type: 'object', nullable: true }, error: { type: 'object', nullable: true } } } },
  'text/event-stream': { schema: { type: 'string' } },
} } }

// Named user themes use the same customization payload as /api/theme.
const themeNameSchema = { type: 'string', minLength: 1, maxLength: 80 }
openapi.paths['/api/theme/presets'].get.description = 'Lists themes owned by the authenticated Studio user. Preserves existing customization as the first theme on initial access.'
openapi.paths['/api/theme/presets'].post.requestBody = { required: true, content: { 'application/json': { schema: {
  type: 'object', required: ['name'], properties: {
    name: themeNameSchema,
    sourceId: { type: 'string', description: 'Owned theme to duplicate. Omit to create default customization without a wallpaper.' },
    brightness: { type: 'string', enum: ['system', 'light', 'dark'], default: 'system' },
    style: { type: 'string', enum: ['ink', 'comic'], default: 'ink' },
  },
} } } }
openapi.paths['/api/theme/presets/{id}'].patch.requestBody = { required: true, content: { 'application/json': { schema: {
  type: 'object', required: ['name'], properties: { name: themeNameSchema },
} } } }
openapi.paths['/api/theme/presets/{id}'].delete.description = 'Deletes an owned theme. Deleting the active theme activates the oldest remaining theme; deleting the last theme is rejected.'
openapi.paths['/api/theme/presets/{id}/activate'].post.description = 'Activates an owned theme and restores brightness, style, appearance and wallpaper together.'
for (const path of ['/api/theme/presets', '/api/theme/presets/{id}', '/api/theme/presets/{id}/activate']) {
  for (const operation of Object.values(openapi.paths[path])) {
    operation.responses['400'] = { description: 'Invalid theme settings, name, or deletion of the last theme' }
    operation.responses['404'] = { description: 'Theme not found for the authenticated user' }
  }
}
for (const operation of [openapi.paths['/api/theme'].put, openapi.paths['/api/theme/background'].post, openapi.paths['/api/theme/background'].delete]) {
  operation.responses['409'] = { description: 'The supplied presetId is no longer the active theme. Reload before editing.' }
}

const themeArchivePreferences = [
  { name: 'brightness', in: 'query', required: false, schema: { type: 'string', enum: ['system', 'light', 'dark'] }, description: 'Legacy device brightness. Used only when the stored theme has no mode.' },
  { name: 'style', in: 'query', required: false, schema: { type: 'string', enum: ['ink', 'comic'] }, description: 'Legacy device style. Used only when the stored theme has no style.' },
]
const themeZipExport = openapi.paths['/api/theme/presets/{id}/export'].get
themeZipExport.summary = 'Export an owned theme as a ZIP file'
themeZipExport.description = 'Downloads an ekko-studio-theme version 1 ZIP containing theme.json and the optional background image. Includes the theme name, modes and all global/regional settings; excludes user IDs, server file paths and preset IDs. Legacy device mode/style query values are fallback values only.'
themeZipExport.parameters = [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }, ...themeArchivePreferences]
themeZipExport.responses = {
  '200': { description: 'Theme ZIP download', content: { 'application/zip': { schema: { type: 'string', format: 'binary' } } } },
  '400': { description: 'Invalid fallback mode or style' }, '401': { $ref: '#/components/responses/Unauthorized' },
  '404': { description: 'Theme is not owned by the authenticated user' }, '409': { description: 'The saved background file is missing' },
}
const themeZipImport = openapi.paths['/api/theme/presets/import'].post
themeZipImport.summary = 'Import and activate a theme ZIP as a new theme'
themeZipImport.description = 'Accepts the ZIP bytes directly, up to 12 MiB. Validates a version 1 manifest (up to 64 KiB) and optional PNG/JPEG/WebP/GIF background (up to 10 MiB). Rejects unsupported entries, paths, links, encryption, invalid settings and corrupt/oversized expanded data. Creates a new owned theme and activates it atomically; same-name themes remain separate and existing themes are preserved. On initial migration, query preferences preserve the previous device-only mode/style.'
themeZipImport.parameters = themeArchivePreferences
themeZipImport.requestBody = { required: true, content: { 'application/zip': { schema: { type: 'string', format: 'binary' } } } }
themeZipImport.responses = {
  '200': { description: 'Updated library and active theme', content: { 'application/json': { schema: {
    type: 'object', required: ['activeId', 'themes', 'theme'], properties: {
      activeId: { type: 'string' }, themes: { type: 'array', items: { type: 'object' } }, theme: { type: 'object' },
    },
  } } } },
  '400': { description: 'Invalid or unsupported archive, manifest, settings or entries' },
  '401': { $ref: '#/components/responses/Unauthorized' },
  '413': { description: 'ZIP or background exceeds the allowed size' }, '415': { description: 'Expected ZIP bytes or a supported background image' },
}

const browserRelayOperation = openapi.paths['/api/studio/desktop-browser/request']?.post
if (browserRelayOperation) {
  browserRelayOperation.summary = 'Operate the explicitly authorized remote Desktop browser'
  browserRelayOperation.description = 'Requires an identified Studio user and matching Profile with an explicitly authorized active Desktop. Ownership transfers only on real user input after 10 minutes of owner inactivity and no in-flight operation. No browser credentials or debug ports are exposed. Run bindings never silently switch desktops; disconnected or replaced targets fail closed.'
  browserRelayOperation.requestBody = { required: true, content: { 'application/json': { schema: {
    type: 'object', required: ['method', 'client_id'], additionalProperties: false,
    properties: {
      client_id: { type: 'string', minLength: 1, maxLength: 200, description: 'Stable browser MCP process identity bound with authenticated token/context to the original Desktop.' },
      method: { type: 'string', enum: ['state', 'tabs.list', 'tabs.create', 'tabs.activate', 'tabs.close', 'lease.release', 'navigate', 'navigation.action', 'snapshot', 'text.read', 'interact', 'interact.batch', 'screenshot', 'console.read', 'console.clear'] },
      params: { type: 'object', additionalProperties: true },
    },
  } } } }
  browserRelayOperation.responses['403'] = { description: 'Identified Studio account required' }
  browserRelayOperation.responses['409'] = { description: 'Unavailable, ambiguous, disconnected, revoked or invalid browser operation' }
}

// Durable session goals are maintained by the current conversation model, separate from run plans.
openapi.components.schemas.SessionTask = {
  type: 'object', required: ['id', 'title', 'summary', 'status', 'source_message_id', 'created_at', 'updated_at'],
  properties: {
    id: { type: 'string' }, title: { type: 'string', maxLength: 200 }, summary: { type: 'string', maxLength: 1000 },
    status: { type: 'string', enum: ['open', 'completed', 'closed'] },
    source_message_id: { type: 'integer' }, evidence_message_id: { type: 'integer', nullable: true },
    completion_evidence: { type: 'string', description: 'Concise verification from the conversation agent, or an explicit manual-completion marker for a user action.' },
    created_at: { type: 'integer', description: 'Unix time in milliseconds.' }, updated_at: { type: 'integer' },
    completed_at: { type: 'integer', nullable: true },
  },
}
const sessionTasksOperation = openapi.paths['/api/studio/sessions/{id}/tasks'].get
sessionTasksOperation.operationId = 'getSessionTasks'
sessionTasksOperation.summary = 'Read durable session goals'
sessionTasksOperation.description = 'Returns persisted goals for an accessible Studio session. The current conversation agent reviews them at turn start and records only independent deliverables, ongoing follow-up or explicitly requested tracking. Simple questions, one-off lookups and trivial edits without lasting tracking value are skipped; refinements and corrections reuse the same goal. Eligible goals are created before execution; changed results are saved before the final response. Summaries contain one or two short sentences about results and remaining blockers. Goals span turns and are separate from run plans. Reading goals does not require a write or create a per-turn task-plan card.'
sessionTasksOperation.parameters = [
  { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
  { name: 'profile', in: 'query', required: false, schema: { type: 'string' }, description: 'Optional exact session profile filter.' },
]
sessionTasksOperation.responses = {
  '200': { description: 'Current goal ledger; tasks is empty before the first goal is recorded.', content: { 'application/json': { schema: {
    type: 'object', required: ['session_id', 'revision', 'updated_at', 'tasks'], properties: {
      session_id: { type: 'string' }, revision: { type: 'integer', minimum: 0 }, updated_at: { type: 'integer' },
      tasks: { type: 'array', items: { $ref: '#/components/schemas/SessionTask' } },
    },
  } } } },
  '401': { $ref: '#/components/responses/Unauthorized' },
  '403': { description: 'The authenticated user cannot access this session profile.' },
  '404': { description: 'Session not found, or the explicit profile filter does not match.' },
}


openapi.components.schemas.SessionTaskListItem = {
  allOf: [{ $ref: '#/components/schemas/SessionTask' }, {
    type: 'object', required: ['session_id', 'session_title', 'profile', 'source', 'agent', 'message_id'], properties: {
      session_id: { type: 'string' }, session_title: { type: 'string', nullable: true, description: 'Conversation display name, using the same first-user-message fallback as the session list when no title is set.' }, profile: { type: 'string' },
      source: { type: 'string' }, agent: { type: 'string' }, message_id: { type: 'integer', nullable: true,
        description: 'Visible user message beginning the request turn for open tasks or the completion turn for completed tasks. Use with the session/profile to navigate chat.' },
    },
  }],
}
const taskListOperation = openapi.paths['/api/studio/session-tasks'].get
taskListOperation.operationId = 'listSessionTaskItems'
taskListOperation.summary = 'List conversation tasks across accessible profiles'
taskListOperation.description = 'Lists persisted single-chat tasks, including archived sessions, with stable pagination. Profile access and pending deletions are applied before counting. Group, workflow and global-agent tasks are excluded. Open tasks precede completed then closed tasks; update time and id determine stable order within each status. Does not invoke a model or modify task status.'
taskListOperation.parameters = [
  { name: 'profile', in: 'query', schema: { type: 'string' }, description: 'Optional exact profile filter. Empty selects all accessible, existing profiles; run credentials remain bound to their profile.' },
  { name: 'search', in: 'query', schema: { type: 'string', maxLength: 200 }, description: 'Literal substring in task title, summary or session name, including its first-message fallback.' },
  { name: 'status', in: 'query', schema: { type: 'string', enum: ['open', 'completed', 'closed'] } },
  { name: 'order', in: 'query', schema: { type: 'string', enum: ['newest', 'oldest'], default: 'newest' } },
  { name: 'offset', in: 'query', schema: { type: 'integer', minimum: 0, default: 0 } },
  { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 100, default: 50 } },
]
taskListOperation.responses = {
  '200': { description: 'Authorized task page.', content: { 'application/json': { schema: {
    type: 'object', required: ['tasks', 'total', 'has_more'], properties: {
      tasks: { type: 'array', items: { $ref: '#/components/schemas/SessionTaskListItem' } },
      total: { type: 'integer' }, has_more: { type: 'boolean' },
    },
  } } } },
  '400': { description: 'Invalid filters or pagination.' },
  '401': { $ref: '#/components/responses/Unauthorized' },
  '403': { description: 'Profile access denied.' },
}

const sessionTaskChangeSchema = {
  type: 'object', additionalProperties: false, required: ['title', 'summary', 'status'], properties: {
    id: { type: 'string', minLength: 1, maxLength: 100 },
    title: { type: 'string', minLength: 1, maxLength: 200, description: 'Concise user outcome; reuse the existing goal for refinements and corrections.' },
    summary: { type: 'string', minLength: 1, maxLength: 1000, description: 'One or two short sentences about results and remaining blockers. Keep implementation and test logs in the conversation.' },
    status: { type: 'string', enum: ['open', 'completed'] },
    completion_evidence: { type: 'string', maxLength: 1000, description: 'Required for newly completed goals: evidence of verified delivery.' },
  },
}
const manualTaskStatusOperation = openapi.paths['/api/studio/sessions/{id}/tasks/{taskId}/status'].patch
manualTaskStatusOperation.operationId = 'setSessionTaskStatus'
manualTaskStatusOperation.summary = 'Manually change a task status'
manualTaskStatusOperation.description = 'User action from the task list. Changes one existing task to open, completed or closed, with account/profile access checks. Requires its latest updated_at as expected_updated_at; stale rows return 409. Closed tasks remain readable and only this manual endpoint can reopen them. Manual completion records the user action as evidence and links to the original request. Does not invoke a model or create a run plan. Run credentials cannot use this endpoint.'
manualTaskStatusOperation.parameters = [
  ...sessionTasksOperation.parameters,
  { name: 'taskId', in: 'path', required: true, schema: { type: 'string' } },
]
manualTaskStatusOperation.requestBody = { required: true, content: { 'application/json': { schema: {
  type: 'object', additionalProperties: false, required: ['status', 'expected_updated_at'], properties: {
    status: { type: 'string', enum: ['open', 'completed', 'closed'] },
    expected_updated_at: { type: 'integer', minimum: 0 },
  },
} } } }
manualTaskStatusOperation.responses = {
  ...sessionTasksOperation.responses,
  '400': { description: 'Invalid status or expected_updated_at.' },
  '409': { description: 'Task changed or session is unavailable. Refresh the task list.' },
}
for (const action of ['list', 'update']) {
  const operation = openapi.paths[`/api/studio/session-tasks/${action}`].post
  operation.summary = `${action === 'list' ? 'Read' : 'Update'} the active turn session goals`
  operation.description = 'The current turn context binds the session and profile. Expired contexts, other profiles, group chats, workflows and background/delegated runs are rejected. No per-turn task plan is created or modified. Writes upsert only changed/new goals and preserve omitted goals; revision conflicts require rereading. New completions require completion_evidence. Closed goals remain readable but model writes cannot change them; only a user can reopen them from the task list.'
  operation.requestBody = { required: true, content: { 'application/json': { schema: {
    type: 'object', additionalProperties: false,
    required: action === 'list' ? ['context_id'] : ['context_id', 'revision', 'changes'],
    properties: { context_id: { type: 'string', minLength: 1 }, ...(action === 'update' ? {
      revision: { type: 'integer', minimum: 0 },
      changes: { type: 'array', minItems: 1, maxItems: 30, items: sessionTaskChangeSchema },
    } : {}) },
  } } } }
  operation.responses = {
    ...sessionTasksOperation.responses,
    '400': { description: 'Invalid input, foreign task id, duplicate goal or missing completion evidence.' },
    '409': { description: 'Context expired, session scope unavailable, or revision changed; reread before retrying.' },
    '503': { description: 'Chat run service unavailable.' },
  }
  delete operation.responses['404']
}

// Write output
const outputPath = join(rootDir, 'docs/openapi.json')
writeFileSync(outputPath, JSON.stringify(openapi, null, 2))

console.log(`✓ Generated OpenAPI spec: ${outputPath}`)
console.log(`  ${Object.keys(openapi.paths).length} endpoints`)
console.log(`  ${openapi.tags.length} tags`)
