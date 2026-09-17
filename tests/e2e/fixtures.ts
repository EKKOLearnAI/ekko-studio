import type { Page, Request, Route } from '@playwright/test'

export const TEST_ACCESS_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxIiwidXNlcm5hbWUiOiJwbGF5d3JpZ2h0Iiwicm9sZSI6InN1cGVyX2FkbWluIiwidHlwZSI6ImFjY2VzcyIsImF1ZCI6Imhlcm1lcy13ZWItdWkiLCJpYXQiOjE3NjAwMDAwMDAsImV4cCI6NDEwMjQ0NDgwMH0.playwright-signature'

export interface MockedRequest {
  method: string
  pathname: string
  search: string
  headers: Record<string, string>
  postData: string | null
}

interface MockJourneyPayload {
  graph: {
    nodes: unknown[]
    edges: unknown[]
    clusters: unknown[]
    memory?: unknown[]
    stats?: Record<string, unknown>
  }
}

interface MockSkillsPayload {
  categories: unknown[]
  archived: unknown[]
  paths?: unknown
}

interface MockSkillBundlePayload {
  name: string
  commandName: string
  description: string
  skills: string[]
}

interface MockThemePayload {
  fontSize: number
  textColor: string | null
  accentColor: string | null
  background: {
    name: string
    mime: string | null
    updatedAt: number
  } | null
  updatedAt: number
}

interface MockHermesApiOptions {
  tokenValidationStatus?: number
  initialProfileName?: 'default' | 'research'
  sessions?: unknown[]
  sessionCategories?: Array<{ id: number; name: string; created_at?: number; updated_at?: number }>
  journey?: MockJourneyPayload
  skills?: MockSkillsPayload
  bundles?: MockSkillBundlePayload[]
  workflows?: unknown[]
  workflowRuns?: unknown[]
  workflowSchedules?: unknown[]
  workflowScheduleError?: string
  workflowScheduleDelays?: Record<string, number>
  workflowScheduleGetSnapshotAtRequest?: boolean
  workflowScheduleMutationDelays?: Partial<Record<'POST' | 'PATCH' | 'DELETE', number>>
  workflowImportDocument?: unknown
  workflowImportPreviewError?: string
  channelCredentials?: boolean
  channelConfig?: Record<string, unknown>
  providerEditor?: Record<string, unknown>
  modelGroups?: Array<{
    provider: string
    label: string
    models: string[]
    [key: string]: unknown
  }>
  theme?: Partial<MockThemePayload>
  socialMessagePlatforms?: unknown[]
  socialMessageResult?: Record<string, unknown>
  socialMessageFeishuQrCode?: Record<string, unknown>
  socialMessageFeishuQrStatus?: Record<string, unknown>
  socialMessageFeishuRecipients?: Record<string, unknown>
  socialMessageTelegramRecipients?: Record<string, unknown>
  socialMessageWeixinRecipients?: Record<string, unknown>
  ttsActiveProviders?: Partial<Record<'default' | 'research', string>>
}

export const TEST_MODEL_GROUP = {
  provider: 'test-provider',
  label: 'Test Provider',
  base_url: 'https://example.invalid/v1',
  models: ['test-model'],
  available_models: ['test-model'],
  api_key: 'list-response-credential',
  builtin: true,
  provider_editable: true,
  editable_fields: ['label', 'base_url', 'api_key', 'preferred_model', 'context_lengths'],
}

const sampleJob = {
  job_id: 'job-smoke',
  id: 'job-smoke',
  name: 'Nightly Smoke',
  prompt: 'Run the smoke check',
  prompt_preview: 'Run the smoke check',
  skills: [],
  skill: null,
  model: 'test-model',
  provider: 'test-provider',
  base_url: null,
  script: null,
  schedule: '0 9 * * *',
  schedule_display: '0 9 * * *',
  repeat: { times: null, completed: 0 },
  enabled: true,
  state: 'scheduled',
  paused_at: null,
  paused_reason: null,
  created_at: '2026-01-01T00:00:00.000Z',
  next_run_at: '2026-01-02T09:00:00.000Z',
  last_run_at: null,
  last_status: null,
  last_error: null,
  deliver: 'origin',
  origin: null,
  last_delivery_error: null,
}

const sampleAuxiliaryModelTasks = [
  { key: 'vision', label: 'Vision', default_timeout: 120, default_download_timeout: 30 },
  { key: 'web_extract', label: 'Web extract', default_timeout: 360 },
  { key: 'compression', label: 'Compression', default_timeout: 120 },
  { key: 'skills_hub', label: 'Skills hub', default_timeout: 30 },
  { key: 'approval', label: 'Approval', default_timeout: 30 },
  { key: 'mcp', label: 'MCP', default_timeout: 30 },
  { key: 'title_generation', label: 'Title generation', default_timeout: 30 },
  { key: 'triage_specifier', label: 'Triage specifier', default_timeout: 120 },
  { key: 'kanban_decomposer', label: 'Kanban decomposer', default_timeout: 180 },
  { key: 'profile_describer', label: 'Profile describer', default_timeout: 60 },
  { key: 'curator', label: 'Curator', default_timeout: 600 },
  { key: 'session_search', label: 'Session search', default_timeout: 30 },
  { key: 'flush_memories', label: 'Flush memories', default_timeout: 30 },
]

function jsonResponse(body: unknown, status = 200) {
  return {
    status,
    contentType: 'application/json',
    body: JSON.stringify(body),
  }
}

function recordRequest(request: Request): MockedRequest {
  const url = new URL(request.url())
  return {
    method: request.method(),
    pathname: url.pathname,
    search: url.search,
    headers: request.headers(),
    postData: request.postData(),
  }
}

export async function mockHermesApi(page: Page, options: MockHermesApiOptions = {}) {
  const requests: MockedRequest[] = []
  const unexpectedRequests: MockedRequest[] = []
  const tokenValidationStatus = options.tokenValidationStatus ?? 200
  let activeProfileName = options.initialProfileName ?? 'research'
  const sessionCategories = [...(options.sessionCategories ?? [])]
  let workflowSchedules: any[] = [...(options.workflowSchedules ?? [])]
  const skillBundles = [...(options.bundles ?? [])]
  let channelCredentialsPresent = options.channelCredentials ?? false
  let delegationModel: Record<string, string> = {}
  let theme: MockThemePayload = {
    fontSize: 14,
    textColor: null,
    accentColor: null,
    background: null,
    updatedAt: 0,
    ...options.theme,
  }
  let providerEditor = {
    id: 'test-provider',
    label: 'Test Provider',
    builtin: true,
    source: 'builtin_env',
    base_url: 'https://example.invalid/v1',
    preferred_model: 'test-model',
    credential_configured: true,
    editable: true,
    editable_fields: ['label', 'base_url', 'api_key', 'preferred_model', 'context_lengths'],
    context_lengths: {},
    connection_test_supported: true,
    revision: 'provider-revision-1',
    ...options.providerEditor,
  }

  await page.route('**/*', async (route: Route) => {
    const request = route.request()
    const url = new URL(request.url())
    const { pathname } = url

    if (!(pathname === '/health' || pathname.startsWith('/api/') || pathname.startsWith('/v1/'))) {
      await route.continue()
      return
    }

    requests.push(recordRequest(request))

    if (pathname === '/api/studio/announcements') {
      await route.fulfill(jsonResponse({ ok: true, platform: 'desktop', list: [] }))
      return
    }

    if (pathname === '/health') {
      await route.fulfill(jsonResponse({ status: 'ok', webui_version: '0.5.23', node_version: '23.0.0' }))
      return
    }

    if (pathname === '/api/agents/status' && request.method() === 'GET') {
      await route.fulfill(jsonResponse({
        revision: 1,
        updatedAt: '2026-01-01T00:00:00.000Z',
        agents: [
          { id: 'hermes', name: 'Hermes', provider: 'Nous Research', kind: 'hermes', installed: true, version: '0.19.1', source: 'user-cli', path: '/usr/local/bin/hermes', error: '', installations: [] },
          { id: 'ekko-agent', name: 'Ekko', provider: 'Ekko Studio', kind: 'built-in', installed: true, version: '0.7.0', source: 'built-in', path: '', error: '', installations: [] },
          { id: 'claude-code', name: 'Claude', provider: 'Anthropic', kind: 'coding-agent', installed: true, version: '1.0.0', source: 'user-cli', path: '/usr/local/bin/claude', error: '', installations: [] },
          { id: 'codex', name: 'Codex', provider: 'OpenAI', kind: 'coding-agent', installed: true, version: '1.0.0', source: 'user-cli', path: '/usr/local/bin/codex', error: '', installations: [] },
          { id: 'pi', name: 'Pi', provider: 'Pi', kind: 'coding-agent', installed: true, version: '1.0.0', source: 'user-cli', path: '/usr/local/bin/pi', error: '', installations: [] },
          { id: 'grok', name: 'Grok', provider: 'xAI', kind: 'coding-agent', installed: true, version: '1.0.0', source: 'user-cli', path: '/usr/local/bin/grok', error: '', installations: [] },
          { id: 'dsh', name: 'DeepSeek Harness', provider: 'DeepSeek', kind: 'coding-agent', installed: true, version: '0.1.5-rc.1', source: 'user-cli', path: '/usr/local/bin/dsh', error: '', installations: [] },
        ],
      }))
      return
    }

    if (pathname === '/api/agents/availability' && request.method() === 'GET') {
      await route.fulfill(jsonResponse({
        revision: 1,
        updatedAt: '2026-01-01T00:00:00.000Z',
        agents: [
          { id: 'hermes', installed: true, source: 'user-cli' },
          { id: 'ekko-agent', installed: true, source: 'built-in' },
          { id: 'claude-code', installed: true, source: 'user-cli' },
          { id: 'codex', installed: true, source: 'user-cli' },
          { id: 'pi', installed: true, source: 'user-cli' },
          { id: 'grok', installed: true, source: 'user-cli' },
          { id: 'dsh', installed: true, source: 'user-cli' },
        ],
      }))
      return
    }

    if (pathname === '/api/hermes/runtime-versions' && request.method() === 'GET') {
      await route.fulfill(jsonResponse({
        active: null,
        platform: 'linux-x64',
        activeVersionPath: '',
        remoteManifestUrl: '',
        remoteError: '',
        hermes: {
          activeVersion: '',
          agentVersion: '0.19.1',
          activeDirectory: '',
          storageDirectory: '',
          defaultStorageDirectory: '',
          pendingStorageDirectory: '',
          migrationError: '',
          activationError: '',
          cliInstallations: [{
            path: '/usr/local/bin/hermes',
            version: '0.19.1',
            source: 'user-cli',
            selected: true,
          }],
          installed: [],
          remoteVersions: [],
        },
        webui: {
          currentVersion: '0.7.0',
          activeVersion: '0.7.0',
          activeDirectory: '',
          installed: [],
          remoteVersions: [],
        },
      }))
      return
    }

    if (pathname === '/api/hermes/runtime-versions/jobs' && request.method() === 'GET') {
      await route.fulfill(jsonResponse({ jobs: [] }))
      return
    }

    if (pathname === '/api/auth/status') {
      await route.fulfill(jsonResponse({ hasPasswordLogin: true, username: 'playwright' }))
      return
    }

    if (pathname === '/api/auth/login') {
      if (request.method() !== 'POST') {
        await route.fulfill(jsonResponse({ error: 'Method not allowed' }, 405))
        return
      }
      if (tokenValidationStatus !== 200) {
        await route.fulfill(jsonResponse({ error: 'Invalid username or password' }, tokenValidationStatus))
        return
      }
      await route.fulfill(jsonResponse({
        token: TEST_ACCESS_KEY,
        userId: 1,
        theme,
      }))
      return
    }

    if (pathname === '/api/theme/background') {
      if (request.method() === 'GET' && theme.background) {
        await route.fulfill({
          status: 200,
          contentType: theme.background.mime || 'image/png',
          body: Buffer.from(
            'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2V9sAAAAASUVORK5CYII=',
            'base64',
          ),
        })
        return
      }
      await route.fulfill(jsonResponse({ error: 'Theme background not found' }, 404))
      return
    }

    if (pathname === '/api/theme') {
      if (request.method() === 'GET') {
        await route.fulfill(jsonResponse(theme))
        return
      }
      if (request.method() === 'PUT') {
        const patch = JSON.parse(request.postData() || '{}') as Partial<MockThemePayload>
        theme = { ...theme, ...patch, updatedAt: Date.now() }
        await route.fulfill(jsonResponse(theme))
        return
      }
      await route.fulfill(jsonResponse({ error: 'Method not allowed' }, 405))
      return
    }

    if (pathname === '/api/auth/me') {
      await route.fulfill(jsonResponse({
        user: {
          id: 1,
          username: 'playwright',
          role: 'super_admin',
          status: 'active',
          created_at: 0,
          updated_at: 0,
          last_login_at: 0,
          avatar: '',
        },
      }))
      return
    }

    if (pathname === '/api/auth/avatar') {
      if (request.method() === 'GET') {
        await route.fulfill(jsonResponse({ avatar: '' }))
        return
      }
      if (request.method() === 'PUT') {
        await route.fulfill(jsonResponse({ success: true, avatar: '' }))
        return
      }
      await route.fulfill(jsonResponse({ error: 'Method not allowed' }, 405))
      return
    }

    if (pathname === '/api/studio/tts/settings' && request.method() === 'GET') {
      const profile = request.headers()['x-hermes-profile'] === 'research' ? 'research' : 'default'
      await route.fulfill(jsonResponse({
        settings: [],
        activeProvider: options.ttsActiveProviders?.[profile] || 'edge',
      }))
      return
    }

    if (pathname === '/api/studio/workflows/import/preview' && request.method() === 'POST') {
      if (options.workflowImportPreviewError) {
        await route.fulfill(jsonResponse({ error: options.workflowImportPreviewError }, 400))
        return
      }
      await route.fulfill(jsonResponse({ ok: true, preview: { token: 'preview-token', digest: 'digest', expiresAt: Date.now() + 60000, summary: { name: 'Imported flow', nodes: 1, edges: 0 } } }))
      return
    }

    if (pathname === '/api/studio/workflows/import/cancel' && request.method() === 'POST') {
      await route.fulfill(jsonResponse({ ok: true }))
      return
    }

    if (pathname === '/api/studio/workflows/import/confirm' && request.method() === 'POST') {
      const definition: any = options.workflowImportDocument || { name: 'Imported flow', nodes: [], edges: [], viewport: null }
      await route.fulfill(jsonResponse({ ok: true, workflow: { id: 'wf-imported', profile: 'research', workspace: null, created_at: 2, updated_at: 2, ...definition } }, 201))
      return
    }

    if (/^\/api\/studio\/workflows\/[^/]+\/export$/.test(pathname) && request.method() === 'GET') {
      const workflowId = pathname.split('/').at(-2)
      const workflow: any = (options.workflows || []).find((item: any) => item?.id === workflowId)
      await route.fulfill(workflow ? jsonResponse({ format: 'hermes-studio.workflow', version: 1, definition: { name: workflow.name, nodes: workflow.nodes, edges: workflow.edges, viewport: workflow.viewport } }) : jsonResponse({ error: 'workflow not found' }, 404))
      return
    }

    if (/^\/api\/studio\/workflows\/[^/]+\/schedules(?:\/[^/]+)?$/.test(pathname)) {
      if (options.workflowScheduleError) {
        await route.fulfill(jsonResponse({ error: options.workflowScheduleError }, 500))
        return
      }
      const parts = pathname.split('/')
      const workflowId = parts[4]
      const scheduleId = parts[6]
      if (request.method() === 'GET') {
        const schedules = options.workflowScheduleGetSnapshotAtRequest
          ? workflowSchedules.filter(item => item.workflow_id === workflowId)
          : null
        const delay = options.workflowScheduleDelays?.[workflowId] || 0
        if (delay > 0) await new Promise(resolve => setTimeout(resolve, delay))
        await route.fulfill(jsonResponse({ schedules: schedules ?? workflowSchedules.filter(item => item.workflow_id === workflowId) }))
        return
      }
      let body: Record<string, any> = {}
      try { body = JSON.parse(request.postData() || '{}') } catch {}
      if (request.method() === 'POST') {
        const schedule = { id: `schedule-${workflowSchedules.length + 1}`, workflow_id: workflowId, profile: 'research', concurrency_policy: 'skip', misfire_policy: 'skip', last_scheduled_at: null, next_run_at: Date.now() + 3_600_000, last_run_id: null, last_error: null, created_at: Date.now(), updated_at: Date.now(), ...body }
        workflowSchedules = [...workflowSchedules, schedule]
        const delay = options.workflowScheduleMutationDelays?.POST || 0
        if (delay > 0) await new Promise(resolve => setTimeout(resolve, delay))
        await route.fulfill(jsonResponse({ schedule }, 201))
        return
      }
      if (request.method() === 'PATCH') {
        const current = workflowSchedules.find(item => item.id === scheduleId && item.workflow_id === workflowId)
        const saved = current ? { ...current, ...body, updated_at: Date.now() } : null
        if (saved) workflowSchedules = workflowSchedules.map(item => item.id === scheduleId ? saved : item)
        const delay = options.workflowScheduleMutationDelays?.PATCH || 0
        if (delay > 0) await new Promise(resolve => setTimeout(resolve, delay))
        await route.fulfill(saved
          ? jsonResponse({ schedule: saved })
          : jsonResponse({ error: 'workflow schedule not found' }, 404))
        return
      }
      if (request.method() === 'DELETE') {
        workflowSchedules = workflowSchedules.filter(item => item.id !== scheduleId || item.workflow_id !== workflowId)
        const delay = options.workflowScheduleMutationDelays?.DELETE || 0
        if (delay > 0) await new Promise(resolve => setTimeout(resolve, delay))
        await route.fulfill(jsonResponse({ ok: true }))
        return
      }
    }

    if (/^\/api\/studio\/workflows\/[^/]+\/run$/.test(pathname) && request.method() === 'POST') {
      await route.fulfill(jsonResponse({ ok: true, status: 'accepted' }, 202))
      return
    }

    if (/^\/api\/studio\/workflows\/[^/]+\/runs$/.test(pathname)) {
      await route.fulfill(jsonResponse({ runs: options.workflowRuns ?? [] }))
      return
    }

    if (/^\/api\/studio\/workflows\/[^/]+\/runs\/[^/]+$/.test(pathname) && request.method() === 'GET') {
      const runId = pathname.split('/').at(-1)
      const run = (options.workflowRuns || []).find((item: any) => item?.id === runId)
      await route.fulfill(run ? jsonResponse({ run }) : jsonResponse({ error: 'workflow run not found' }, 404))
      return
    }

    if (/^\/api\/studio\/workflows\/[^/]+$/.test(pathname) && request.method() === 'PATCH') {
      const workflowId = pathname.split('/').at(-1)
      const workflow: any = (options.workflows || []).find((item: any) => item?.id === workflowId)
      let patch: Record<string, unknown> = {}
      try { patch = JSON.parse(request.postData() || '{}') } catch {}
      await route.fulfill(workflow
        ? jsonResponse({ workflow: { ...workflow, ...patch, updated_at: Date.now() } })
        : jsonResponse({ error: 'workflow not found' }, 404))
      return
    }

    if (pathname === '/api/studio/workflows') {
      await route.fulfill(jsonResponse({ workflows: options.workflows ?? [] }, tokenValidationStatus))
      return
    }

    if (pathname === '/api/studio/sessions') {
      await route.fulfill(jsonResponse({ sessions: options.sessions ?? [] }, tokenValidationStatus))
      return
    }

    if (pathname === '/api/studio/session-categories') {
      if (request.method() === 'GET') {
        await route.fulfill(jsonResponse({ categories: sessionCategories }))
        return
      }
      if (request.method() === 'POST') {
        const body = JSON.parse(request.postData() || '{}') as { name?: string }
        const now = Math.floor(Date.now() / 1000)
        const category = {
          id: Math.max(0, ...sessionCategories.map(item => item.id)) + 1,
          name: String(body.name || '').trim(),
          created_at: now,
          updated_at: now,
        }
        sessionCategories.push(category)
        await route.fulfill(jsonResponse({ category }))
        return
      }
    }

    if (/^\/api\/studio\/session-categories\/\d+$/.test(pathname)) {
      const categoryId = Number(pathname.split('/').at(-1))
      const categoryIndex = sessionCategories.findIndex(item => item.id === categoryId)
      if (categoryIndex < 0) {
        await route.fulfill(jsonResponse({ error: 'Category not found' }, 404))
        return
      }
      if (request.method() === 'PATCH') {
        const body = JSON.parse(request.postData() || '{}') as { name?: string }
        sessionCategories[categoryIndex] = {
          ...sessionCategories[categoryIndex],
          name: String(body.name || '').trim(),
          updated_at: Math.floor(Date.now() / 1000),
        }
        await route.fulfill(jsonResponse({ category: sessionCategories[categoryIndex] }))
        return
      }
      if (request.method() === 'DELETE') {
        sessionCategories.splice(categoryIndex, 1)
        await route.fulfill(jsonResponse({ ok: true }))
        return
      }
    }

    if (pathname === '/api/studio/sessions/hermes') {
      await route.fulfill(jsonResponse({ sessions: [] }))
      return
    }

    if (pathname === '/api/studio/sessions/context-length') {
      await route.fulfill(jsonResponse({ context_length: 256000 }))
      return
    }

    if (pathname === '/api/studio/workspace/folders' && request.method() === 'GET') {
      await route.fulfill(jsonResponse({ base: '/workspace', current: '', folders: [] }))
      return
    }

    if (/^\/api\/studio\/sessions\/[^/]+\/category$/.test(pathname) && request.method() === 'POST') {
      await route.fulfill(jsonResponse({ ok: true }))
      return
    }

    if (pathname === '/api/hermes/journey' && options.journey) {
      await route.fulfill(jsonResponse({
        profile: request.headers()['x-hermes-profile'] || activeProfileName,
        source: 'cli',
        graph: options.journey.graph,
      }))
      return
    }

    if (pathname === '/api/hermes/skills') {
      await route.fulfill(jsonResponse(options.skills ?? { categories: [], archived: [] }))
      return
    }

    if (pathname === '/api/hermes/bundles') {
      if (request.method() === 'GET') {
        await route.fulfill(jsonResponse({ bundles: skillBundles }))
        return
      }
      if (request.method() === 'POST') {
        const body = JSON.parse(request.postData() || '{}') as { name?: string; description?: string; skills?: string[] }
        const commandName = String(body.name || '')
          .trim()
          .toLowerCase()
          .replace(/ /g, '-')
          .replace(/_/g, '-')
          .replace(/[^a-z0-9-]/g, '')
          .replace(/-+/g, '-')
          .replace(/^-|-$/g, '')
        const bundle = {
          name: String(body.name || '').trim(),
          commandName,
          description: String(body.description || '').trim(),
          skills: Array.isArray(body.skills) ? body.skills : [],
        }
        skillBundles.push(bundle)
        await route.fulfill(jsonResponse({ bundle }, 201))
        return
      }
    }

    const bundleDeleteMatch = pathname.match(/^\/api\/hermes\/bundles\/([^/]+)$/)
    if (bundleDeleteMatch && request.method() === 'DELETE') {
      const commandName = decodeURIComponent(bundleDeleteMatch[1])
      const index = skillBundles.findIndex(bundle => bundle.commandName === commandName)
      if (index >= 0) skillBundles.splice(index, 1)
      await route.fulfill(jsonResponse({ success: true }))
      return
    }

    if (/^\/api\/studio\/sessions\/[^/]+\/workspace-run-changes$/.test(pathname)) {
      await route.fulfill(jsonResponse({ changes: [] }))
      return
    }

    if (/^\/api\/studio\/sessions\/[^/]+\/workspace-files\/list$/.test(pathname)) {
      await route.fulfill(jsonResponse({ entries: [], path: '', absolutePath: '' }))
      return
    }

    if (pathname === '/api/studio/files/list') {
      await route.fulfill(jsonResponse({ entries: [], path: '' }))
      return
    }

    if (pathname === '/api/hermes/auth/copilot/check-token') {
      await route.fulfill(jsonResponse({ has_token: false, source: null, enabled: false }))
      return
    }

    if (pathname === '/api/auth/locked-ips') {
      await route.fulfill(jsonResponse({ locks: [] }))
      return
    }

    if (/^\/api\/hermes\/config\/providers\/[^/]+\/editor\/test$/.test(pathname) && request.method() === 'POST') {
      await route.fulfill(jsonResponse({ success: true, models: ['test-model'], model_count: 1 }))
      return
    }

    if (/^\/api\/hermes\/config\/providers\/[^/]+\/editor\/contexts$/.test(pathname) && request.method() === 'PATCH') {
      let body: Record<string, any> = {}
      try { body = JSON.parse(request.postData() || '{}') } catch {}
      providerEditor = {
        ...providerEditor,
        context_lengths: { ...(providerEditor.context_lengths as Record<string, number>), ...(body.context_lengths || {}) },
        revision: 'provider-revision-3',
      }
      await route.fulfill(jsonResponse({ success: true, provider: providerEditor, changed: ['context_lengths'] }))
      return
    }

    if (/^\/api\/hermes\/config\/providers\/[^/]+\/editor$/.test(pathname)) {
      if (request.method() === 'GET') {
        await route.fulfill(jsonResponse({ provider: providerEditor }))
        return
      }
      if (request.method() === 'PATCH') {
        let body: Record<string, any> = {}
        try { body = JSON.parse(request.postData() || '{}') } catch {}
        providerEditor = {
          ...providerEditor,
          ...(body.label !== undefined ? { label: body.label } : {}),
          ...(body.base_url !== undefined ? { base_url: body.base_url } : {}),
          ...(body.api_mode !== undefined ? { api_mode: body.api_mode } : {}),
          ...(body.preferred_model !== undefined ? { preferred_model: body.preferred_model } : {}),
          ...(body.credential_action === 'clear' ? { credential_configured: false } : {}),
          ...(body.credential_action === 'replace' ? { credential_configured: true } : {}),
          revision: 'provider-revision-2',
        }
        await route.fulfill(jsonResponse({ success: true, provider: providerEditor, changed: Object.keys(body) }))
        return
      }
      await route.fulfill(jsonResponse({ error: 'Method not allowed' }, 405))
      return
    }

    if (pathname === '/api/hermes/available-models') {
      const groups = options.modelGroups ?? [TEST_MODEL_GROUP]
      const defaultGroup = groups.find(group => Array.isArray(group.models) && group.models.length > 0)
      await route.fulfill(jsonResponse({
        default: defaultGroup?.models?.[0] || '',
        default_provider: defaultGroup?.provider || '',
        groups,
        allProviders: groups,
        profiles: ['default', 'research'].map(profile => ({
          profile,
          default: defaultGroup?.models?.[0] || '',
          default_provider: defaultGroup?.provider || '',
          groups,
        })),
        model_aliases: {},
        model_visibility: {},
      }))
      return
    }

    if (pathname === '/api/hermes/provider-models') {
      await route.fulfill(jsonResponse({ models: ['proxy-model-a', 'proxy-model-b'] }))
      return
    }

    if (pathname === '/api/hermes/config/auxiliary-models') {
      await route.fulfill(jsonResponse({ tasks: sampleAuxiliaryModelTasks, auxiliary: {} }))
      return
    }

    if (pathname === '/api/hermes/config/delegation-model') {
      if (request.method() === 'PUT') {
        const body = JSON.parse(request.postData() || '{}') as { delegation?: Record<string, string> }
        delegationModel = { ...(body.delegation || {}) }
        await route.fulfill(jsonResponse({ success: true, delegation: delegationModel }))
        return
      }
      await route.fulfill(jsonResponse({ delegation: delegationModel }))
      return
    }

    if (pathname === '/api/studio/pets/active') {
      await route.fulfill(jsonResponse({ pet: null }))
      return
    }

    if (pathname === '/api/studio/petdex/manifest') {
      await route.fulfill(jsonResponse({
        generatedAt: '2026-07-28T00:00:00.000Z',
        total: 0,
        pets: [],
      }))
      return
    }

    if (pathname === '/api/hermes/profiles') {
      await route.fulfill(jsonResponse({
        profiles: [
          { name: 'default', active: activeProfileName === 'default', model: 'test-model', gateway: 'test', alias: 'Default' },
          { name: 'research', active: activeProfileName === 'research', model: 'test-model', gateway: 'test', alias: 'Research' },
        ],
      }))
      return
    }

    if (pathname === '/api/hermes/profiles/runtime-statuses') {
      await route.fulfill(jsonResponse({
        profiles: [
          {
            profile: 'default',
            bridge: { running: activeProfileName === 'default', profile: 'default', reachable: true },
            gateway: { running: true, profile: 'default' },
          },
          {
            profile: 'research',
            bridge: { running: activeProfileName === 'research', profile: 'research', reachable: true },
            gateway: { running: true, profile: 'research' },
          },
        ],
      }))
      return
    }

    if (pathname === '/api/hermes/profiles/active') {
      if (request.method() !== 'PUT') {
        await route.fulfill(jsonResponse({ error: 'Method not allowed' }, 405))
        return
      }

      let body: { name?: unknown }
      try {
        body = JSON.parse(request.postData() || '{}')
      } catch {
        await route.fulfill(jsonResponse({ error: 'Invalid JSON body' }, 400))
        return
      }

      if (body.name !== 'default' && body.name !== 'research') {
        await route.fulfill(jsonResponse({ error: 'Unknown profile' }, 400))
        return
      }

      activeProfileName = body.name
      await route.fulfill(jsonResponse({ success: true, active: activeProfileName }))
      return
    }

    if (/^\/api\/hermes\/config\/credentials\/[^/]+$/.test(pathname) && request.method() === 'DELETE') {
      const platform = pathname.split('/').at(-1)
      if (platform !== 'telegram') {
        await route.fulfill(jsonResponse({ error: 'Unsupported test platform' }, 400))
        return
      }
      channelCredentialsPresent = false
      await route.fulfill(jsonResponse({
        success: true,
        platform,
        clearedPaths: ['token', 'proxy'],
        gatewayRestarted: true,
      }))
      return
    }

    if (pathname === '/api/hermes/config') {
      await route.fulfill(jsonResponse({
        display: { streaming: true, show_reasoning: true, show_cost: true },
        agent: {},
        memory: {},
        session_reset: {},
        privacy: {},
        approvals: {},
        ...options.channelConfig,
        platformCredentialStatus: options.channelConfig?.platformCredentialStatus || {
          telegram: channelCredentialsPresent,
        },
      }))
      return
    }

    if (pathname === '/api/social-messages/platforms' && request.method() === 'GET') {
      await route.fulfill(jsonResponse({
        platforms: options.socialMessagePlatforms ?? [],
      }))
      return
    }

    if (pathname === '/api/social-messages/feishu/qrcode' && request.method() === 'GET') {
      await route.fulfill(jsonResponse(options.socialMessageFeishuQrCode ?? {
        session_id: 'feishu-session',
        qrcode_url: 'https://accounts.feishu.cn/device?code=playwright',
        poll_interval_ms: 1_000,
        expires_in_ms: 600_000,
      }))
      return
    }

    if (pathname === '/api/social-messages/feishu/qrcode/status' && request.method() === 'GET') {
      await route.fulfill(jsonResponse(options.socialMessageFeishuQrStatus ?? { status: 'pending' }))
      return
    }

    if (pathname === '/api/social-messages/feishu/recipients' && request.method() === 'GET') {
      await route.fulfill(jsonResponse(options.socialMessageFeishuRecipients ?? {
        recipients: [],
        runtimeStatus: 'running',
      }))
      return
    }

    if (pathname === '/api/social-messages/telegram/recipients' && request.method() === 'GET') {
      await route.fulfill(jsonResponse(options.socialMessageTelegramRecipients ?? {
        recipients: [],
        runtimeStatus: 'running',
      }))
      return
    }

    if (pathname === '/api/social-messages/weixin/recipients' && request.method() === 'GET') {
      await route.fulfill(jsonResponse(options.socialMessageWeixinRecipients ?? {
        recipients: [],
        runtimeStatus: 'running',
      }))
      return
    }

    if (pathname === '/api/app-connections' && request.method() === 'GET') {
      await route.fulfill(jsonResponse({ connections: [], access_failure: null }))
      return
    }

    if (pathname === '/api/app-relay/status' && request.method() === 'GET') {
      await route.fulfill(jsonResponse({
        relay: {
          connected: false,
          machineId: 'playwright-machine',
          pairingCode: '',
          pairingExpiresAt: 0,
          route: 'official',
          relayUrl: '',
        },
      }))
      return
    }

    if (pathname === '/api/studio/versions' && request.method() === 'GET') {
      await route.fulfill(jsonResponse({
        schema: 1,
        accessMode: 'public_beta',
        hermes: [],
        mobile: {
          version: '1.0.0',
          channels: {
            androidApk: { version: '1.0.0', githubUrl: '', cloudflareUrl: '', online: false },
            googlePlay: { version: '1.0.1', url: '', online: false },
            apple: { version: '1.1.0', testFlightUrl: '', appStoreUrl: '', online: false },
            harmony: { url: '', online: false },
          },
        },
      }))
      return
    }

    if (pathname === '/api/social-messages/send' && request.method() === 'POST') {
      await route.fulfill(jsonResponse({
        result: options.socialMessageResult ?? {
          platform: 'telegram',
          recipient: '1234',
          messageId: '42',
          sentAt: '2026-08-23T00:00:00.000Z',
        },
      }, 201))
      return
    }

    if (pathname === '/api/hermes/jobs') {
      await route.fulfill(jsonResponse({ jobs: [sampleJob] }))
      return
    }

    if (pathname === '/api/coding-agents/update-policies' && request.method() === 'GET') {
      await route.fulfill({ json: { agents: {} } })
      return
    }

    if (pathname === '/api/coding-agents/dsh/session-presets' && request.method() === 'GET') {
      await route.fulfill(jsonResponse({ presets: [
        { id: 'standard', name: 'Standard mode', description: 'File editing and delegation.', isDefault: true },
        { id: 'minimal', name: 'Minimal mode', description: 'A minimal set of tools.', isDefault: false },
      ] }))
      return
    }
    if (pathname === '/api/coding-agents' && request.method() === 'GET') {
      await route.fulfill(jsonResponse({ tools: [] }))
      return
    }

    if (
      request.method() === 'GET' &&
      /^\/api\/coding-agents\/(?:claude-code|codex|pi|grok)\/config-files\/[^/]+$/.test(pathname)
    ) {
      const key = pathname.split('/').at(-1) || 'config'
      await route.fulfill(jsonResponse({
        key,
        path: key,
        absolutePath: `/tmp/${key}`,
        language: 'text',
        content: '',
        exists: false,
        size: 0,
        profile: 'research',
        provider: '',
        rootDir: '/tmp',
      }))
      return
    }

    if (pathname === '/api/studio/group-chat/rooms' && request.method() === 'GET') {
      await route.fulfill(jsonResponse({ rooms: [] }))
      return
    }

    if (pathname === '/api/studio/group-chat-link/v1/connections' && request.method() === 'GET') {
      await route.fulfill(jsonResponse({ connections: [] }))
      return
    }

    if (pathname === '/api/cron-history') {
      await route.fulfill(jsonResponse({ runs: [] }))
      return
    }

    unexpectedRequests.push(recordRequest(request))
    await route.fulfill(jsonResponse({ error: `Unexpected mocked route: ${request.method()} ${pathname}` }, 404))
  })

  // Register this after the catch-all API route so Socket.IO's optimized
  // module is intercepted before Vite can proxy a connection to port 8648.
  await mockChatSocket(page)
  return { requests, unexpectedRequests }
}

export async function authenticate(page: Page, accessKey = TEST_ACCESS_KEY, profileName?: string) {
  await page.addInitScript((state: { storedToken: string; storedProfileName?: string }) => {
    const { storedToken, storedProfileName } = state
    window.localStorage.setItem('hermes_api_key', storedToken)
    if (storedProfileName && !window.localStorage.getItem('hermes_active_profile_name')) {
      window.localStorage.setItem('hermes_active_profile_name', storedProfileName)
    }
  }, { storedToken: accessKey, storedProfileName: profileName })
}

export async function mockChatSocket(page: Page) {
  await page.route('**/node_modules/.vite/**/socket__io-client.js*', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/javascript',
      body: `
const state = window.__PW_CHAT_SOCKET__ || (window.__PW_CHAT_SOCKET__ = { sockets: [], emitted: [] })
state.broadcast = (event, payload) => {
  for (const socket of [...state.sockets]) {
    if (socket.connected && socket.rooms.has(payload.session_id)) socket.__trigger(event, payload)
  }
}
function makeSocket(url, options) {
  const listeners = new Map()
  const onceListeners = new Map()
  const socketNumber = (state.socketCount = (state.socketCount || 0) + 1)
  const socket = {
    id: 'pw-socket-' + socketNumber,
    rooms: new Set(),
    connected: true,
    url,
    options,
    on(event, handler) {
      const handlers = listeners.get(event) || []
      handlers.push(handler)
      listeners.set(event, handlers)
      return this
    },
    once(event, handler) {
      const handlers = onceListeners.get(event) || []
      handlers.push(handler)
      onceListeners.set(event, handlers)
      return this
    },
    off(event, handler) {
      if (!event) return this
      if (!handler) {
        listeners.delete(event)
        onceListeners.delete(event)
        return this
      }
      listeners.set(event, (listeners.get(event) || []).filter(item => item !== handler))
      onceListeners.set(event, (onceListeners.get(event) || []).filter(item => item !== handler))
      return this
    },
    timeout() {
      return this
    },
    emit(event, payload, ack) {
      state.emitted.push({ event, payload })
      if ((event === 'run' || event === 'resume') && payload?.session_id) this.rooms.add(payload.session_id)
      if (typeof ack === 'function' && String(url).endsWith('/workflow')) {
        const data = event === 'workflow.status.subscribe'
          ? { statuses: [] }
          : event === 'workflows.list'
            ? { workflows: [] }
            : { ok: true }
        setTimeout(() => ack(null, { ok: true, data }), 0)
      } else if (typeof ack === 'function' && event === 'join') {
        setTimeout(() => ack({
          roomId: payload && payload.roomId,
          messages: [],
          members: [],
          pendingApprovals: [],
          pendingClarifies: [],
          executionQueue: [],
        }), 0)
      }
      if (event === 'resume') {
        const sessionId = payload && payload.session_id
        const resumes = window.__PW_CHAT_SOCKET_RESUMES__ || {}
        const response = sessionId ? resumes[sessionId] : null
        if (response) {
          setTimeout(() => this.__trigger('resumed', response), 0)
        }
      }
      return this
    },
    removeAllListeners() {
      listeners.clear()
      onceListeners.clear()
      return this
    },
    disconnect() {
      this.connected = false
      return this
    },
    __trigger(event, payload) {
      for (const handler of listeners.get(event) || []) handler(payload)
      const handlers = onceListeners.get(event) || []
      onceListeners.delete(event)
      for (const handler of handlers) handler(payload)
    },
  }
  state.allSockets = state.allSockets || []
  state.allSockets.push(socket)
  if (String(url).endsWith('/chat-run') || String(url).endsWith('/global-agent')) {
    state.sockets.push(socket)
    state.latest = socket
  }
  return socket
}
export function io(url, options) {
  return makeSocket(url, options)
}
export default { io }
`,
    })
  })
}

export async function mockTerminalWebSocket(page: Page) {
  await page.addInitScript(() => {
    const state = (window as any).__PW_TERMINAL_WS__ = {
      sockets: [] as any[],
      sent: [] as any[],
      createdCount: 0,
      latest: null as any,
    }
    const RealEvent = window.Event
    const RealMessageEvent = window.MessageEvent

    class MockTerminalWebSocket extends EventTarget {
      static CONNECTING = 0
      static OPEN = 1
      static CLOSING = 2
      static CLOSED = 3

      readonly CONNECTING = 0
      readonly OPEN = 1
      readonly CLOSING = 2
      readonly CLOSED = 3
      binaryType: BinaryType = 'blob'
      bufferedAmount = 0
      extensions = ''
      protocol = ''
      readyState = MockTerminalWebSocket.CONNECTING
      onopen: ((event: Event) => void) | null = null
      onmessage: ((event: MessageEvent) => void) | null = null
      onerror: ((event: Event) => void) | null = null
      onclose: ((event: CloseEvent) => void) | null = null

      constructor(readonly url: string | URL) {
        super()
        state.sockets.push(this)
        state.latest = this
        setTimeout(() => {
          this.readyState = MockTerminalWebSocket.OPEN
          const openEvent = new RealEvent('open')
          this.onopen?.(openEvent)
          this.dispatchEvent(openEvent)
          this.__createSession('term-1', 'zsh', 101)
        }, 0)
      }

      send(data: string | ArrayBufferLike | Blob | ArrayBufferView) {
        const normalized = typeof data === 'string' ? data : String(data)
        state.sent.push({ socket: this.url.toString(), data: normalized })
        if (normalized.charCodeAt(0) !== 0x7B) return
        try {
          const message = JSON.parse(normalized)
          if (message.type === 'create') {
            this.__createSession(`term-${state.createdCount + 1}`, 'bash', 200 + state.createdCount)
          }
          if (message.type === 'switch') {
            this.__emitMessage(JSON.stringify({ type: 'switched', id: message.sessionId }))
          }
        } catch {}
      }

      close() {
        this.readyState = MockTerminalWebSocket.CLOSED
      }

      __createSession(id: string, shell: string, pid: number) {
        state.createdCount += 1
        this.__emitMessage(JSON.stringify({ type: 'created', id, shell, pid }))
      }

      __emitMessage(data: string) {
        const event = new RealMessageEvent('message', { data })
        this.onmessage?.(event)
        this.dispatchEvent(event)
      }
    }

    ;(window as any).WebSocket = MockTerminalWebSocket
  })
}
