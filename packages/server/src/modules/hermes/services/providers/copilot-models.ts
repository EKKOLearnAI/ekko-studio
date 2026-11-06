import { execFile } from 'child_process'
import { promisify } from 'util'
import { readFile } from 'fs/promises'
import { homedir } from 'os'
import { join } from 'path'

const execFileAsync = promisify(execFile)

const COPILOT_API_TOKEN_URL = 'https://api.github.com/copilot_internal/v2/token'
const COPILOT_MODELS_URL = 'https://api.githubcopilot.com/models'
const EDITOR_VERSION = 'vscode/1.104.1'
const PLUGIN_VERSION = 'copilot-chat/0.20.0'
const USER_AGENT = 'GithubCopilot/1.155.0'
const FETCH_TIMEOUT_MS = 8000
const POSITIVE_TTL_MS = 60 * 60 * 1000
const NEGATIVE_TTL_MS = 60 * 1000

export interface CopilotModelMeta {
  id: string
  preview: boolean
  disabled: boolean
}

const FALLBACK_MODELS: CopilotModelMeta[] = [
  { id: 'gpt-5.5', preview: false, disabled: false },
  { id: 'gpt-5.4', preview: false, disabled: false },
  { id: 'gpt-5.4-mini', preview: false, disabled: false },
  { id: 'gpt-5.4-nano', preview: false, disabled: false },
  { id: 'gpt-5-mini', preview: false, disabled: false },
  { id: 'gpt-5.3-codex', preview: false, disabled: false },
  { id: 'claude-opus-4.8', preview: false, disabled: false },
  { id: 'claude-opus-4.7', preview: false, disabled: false },
  { id: 'claude-opus-4.6', preview: false, disabled: false },
  { id: 'claude-opus-4.6-fast', preview: true, disabled: false },
  { id: 'claude-opus-4.5', preview: false, disabled: false },
  { id: 'claude-haiku-4.5', preview: false, disabled: false },
  { id: 'claude-sonnet-4.6', preview: false, disabled: false },
  { id: 'claude-sonnet-4.5', preview: false, disabled: false },
  { id: 'gemini-2.5-pro', preview: false, disabled: false },
  { id: 'gemini-3-flash', preview: true, disabled: false },
  { id: 'gemini-3.1-pro', preview: true, disabled: false },
  { id: 'gemini-3.5-flash', preview: false, disabled: false },
  { id: 'raptor-mini', preview: true, disabled: false },
]

interface CacheEntry {
  value: CopilotModelMeta[]
  expiresAt: number
  isFallback: boolean
}

// 缓存按 oauth token 隔离：避免切换 hermes profile（不同 .env / 不同 Copilot 账号）
// 时仍命中上一个账号的模型列表 + preview/disabled 状态。key 为 token 的非密码学哈希
// （不直接用明文 token 作 key，减少日志/调试时泄漏风险）。无 token 场景使用 "__none__"。
const cacheByToken: Map<string, CacheEntry> = new Map()
const inflightByToken: Map<string, Promise<CopilotModelMeta[]>> = new Map()

function tokenCacheKey(oauthToken: string): string {
  if (!oauthToken) return '__none__'
  // FNV-1a 32-bit；够用作 cache key
  let h = 0x811c9dc5
  for (let i = 0; i < oauthToken.length; i++) {
    h ^= oauthToken.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(16)
}

function unquote(raw: string): string {
  const v = raw.trim()
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
    return v.slice(1, -1)
  }
  return v
}

function readEnvVar(envContent: string, key: string, inheritProcessEnv = true): string {
  const m = envContent.match(new RegExp(`^${key}\\s*=[ \\t]*(.+)`, 'm'))
  if (m && m[1].trim() && !m[1].trim().startsWith('#')) return unquote(m[1])
  if (inheritProcessEnv && process.env[key]) return unquote(process.env[key]!)
  return ''
}

// classic PATs (ghp_) cannot be used as Copilot OAuth tokens — mirror upstream
// hermes-agent copilot_auth.py and skip them so callers fall through.
function isUsableOAuthToken(token: string): boolean {
  if (!token) return false
  if (token.startsWith('ghp_')) return false
  return true
}

async function readGhAppsToken(): Promise<string> {
  const candidates = [
    join(homedir(), '.config', 'github-copilot', 'apps.json'),
    join(homedir(), '.config', 'github-copilot', 'hosts.json'),
  ]
  for (const path of candidates) {
    try {
      const text = await readFile(path, 'utf-8')
      const data = JSON.parse(text)
      for (const v of Object.values(data) as any[]) {
        const tok = v?.oauth_token
        if (typeof tok === 'string' && isUsableOAuthToken(tok.trim())) return tok.trim()
      }
    } catch { /* skip */ }
  }
  return ''
}

/**
 * 解析 Copilot OAuth token，按 web-ui 的优先级顺序：
 *   1. COPILOT_GITHUB_TOKEN  2. GH_TOKEN  3. GITHUB_TOKEN
 *   4. ~/.config/github-copilot/apps.json (VS Code Copilot 插件存储)
 *   5. `gh auth token` CLI fallback
 * 跳过 classic PAT (ghp_)，与上游 hermes-agent copilot_auth.py 行为对齐。
 * 这是单一事实来源 —— 授权检测和模型拉取都应使用此函数。
 */
export type CopilotTokenSource = 'env' | 'gh-cli' | 'apps-json' | null

export async function resolveCopilotOAuthTokenWithSource(
  envContent: string,
  options: { inheritProcessEnv?: boolean; allowExternal?: boolean } = {},
): Promise<{ token: string; source: CopilotTokenSource }> {
  for (const key of ['COPILOT_GITHUB_TOKEN', 'GH_TOKEN', 'GITHUB_TOKEN']) {
    const v = readEnvVar(envContent, key, options.inheritProcessEnv !== false)
    if (isUsableOAuthToken(v)) return { token: v, source: 'env' }
  }
  if (options.allowExternal === false) return { token: '', source: null }
  const appsToken = await readGhAppsToken()
  if (appsToken) return { token: appsToken, source: 'apps-json' }
  try {
    const { stdout } = await execFileAsync('gh', ['auth', 'token'], { timeout: 3000, windowsHide: true })
    const v = stdout.trim()
    if (isUsableOAuthToken(v)) return { token: v, source: 'gh-cli' }
  } catch { /* ignore */ }
  return { token: '', source: null }
}

export async function resolveCopilotOAuthToken(envContent: string, inheritProcessEnv = true): Promise<string> {
  // Catalogs describe credentials the Hermes runtime can actually use. The
  // explicit Add flow may detect external credentials and migrate them first.
  const { token } = await resolveCopilotOAuthTokenWithSource(envContent, { allowExternal: false, inheritProcessEnv })
  return token
}

async function exchangeForCopilotToken(oauthToken: string): Promise<string> {
  const res = await fetch(COPILOT_API_TOKEN_URL, {
    headers: {
      'Authorization': `token ${oauthToken}`,
      'Editor-Version': EDITOR_VERSION,
      'Editor-Plugin-Version': PLUGIN_VERSION,
      'User-Agent': USER_AGENT,
      'Accept': 'application/json',
    },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  })
  if (!res.ok) throw new Error(`token exchange ${res.status}`)
  const data = await res.json() as { token?: string }
  if (!data.token) throw new Error('no token in response')
  return data.token
}

// ID 噪音过滤：
// - text-embedding-* / *-embedding-* —— 嵌入模型（chat type 已过滤掉，但保留显式清单防御）
// - accounts/msft/routers/* —— Copilot 内部路由模型，UI 模型 ID（带斜杠）会破坏 selectbox，且不可读
// - rerank* —— rerank 模型
// 与 opencode/models.dev 的 curated 思路一致：剔除明显非聊天用途的噪音 ID。
const NOISE_ID_PREFIXES = ['accounts/', 'text-embedding', 'rerank']

function isNoiseModelId(id: string): boolean {
  const lower = id.toLowerCase()
  return NOISE_ID_PREFIXES.some((p) => lower.startsWith(p))
}

async function fetchModelsList(copilotToken: string): Promise<CopilotModelMeta[]> {
  const res = await fetch(COPILOT_MODELS_URL, {
    headers: {
      'Authorization': `Bearer ${copilotToken}`,
      'Editor-Version': EDITOR_VERSION,
      'Copilot-Integration-Id': 'vscode-chat',
      'User-Agent': USER_AGENT,
      'Accept': 'application/json',
    },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  })
  if (!res.ok) throw new Error(`models fetch ${res.status}`)
  const data = await res.json() as { data?: any[] }
  if (!Array.isArray(data.data)) return []
  // 与上游 hermes-agent hermes_cli/models.py 对齐：只过滤 chat type 且 supports
  // /chat/completions endpoint。不强制 model_picker_enabled —— 用户可能想用未在 IDE
  // picker 里的模型（用户决定全量展示，由用户自行判断订阅是否覆盖）。
  // 额外去掉噪音 ID（embedding/rerank/router）。
  const seen = new Set<string>()
  const out: CopilotModelMeta[] = []
  for (const m of data.data) {
    if (m?.capabilities?.type !== 'chat') continue
    const endpoints = m?.supported_endpoints
    if (Array.isArray(endpoints) && endpoints.length > 0) {
      if (!endpoints.includes('/chat/completions')) continue
    }
    const id = String(m?.id ?? '').trim()
    if (!id || seen.has(id)) continue
    if (isNoiseModelId(id)) continue
    seen.add(id)
    out.push({
      id,
      preview: m?.preview === true,
      disabled: m?.policy?.state === 'disabled',
    })
  }
  return out
}

async function loadModelsWithToken(oauth: string): Promise<CopilotModelMeta[]> {
  if (!oauth) throw new Error('no oauth token')
  const copilotToken = await exchangeForCopilotToken(oauth)
  const models = await fetchModelsList(copilotToken)
  if (models.length === 0) throw new Error('empty model list')
  return models
}

/** Fetch a fresh catalog with an already-resolved OAuth token. */
export async function fetchCopilotModelsWithOAuthToken(oauthToken: string): Promise<CopilotModelMeta[]> {
  return loadModelsWithToken(oauthToken)
}

/**
 * 获取 GitHub Copilot 当前账号可用的 chat 模型列表（含 preview/disabled meta）。
 * - 缓存按 oauth token 隔离（profile 切换不会串
 * - 正缓存 1 小时（成功结果）
 * - 负缓存 60 秒（失败时缓存 fallback，避免抖动重复打慢路径）
 * - 并发请求合并：同一 token 的同时多次调用复用 inflight Promise
 */
export async function getCopilotModelsDetailed(envContent: string, inheritProcessEnv = true): Promise<CopilotModelMeta[]> {
  // 先解析 oauth token —— 这一步本身有 fs 读取，但不会发网络请求；用作 cache key。
  const oauth = await resolveCopilotOAuthToken(envContent, inheritProcessEnv)
  const key = tokenCacheKey(oauth)
  const now = Date.now()
  const hit = cacheByToken.get(key)
  if (hit && hit.expiresAt > now) return hit.value
  const existing = inflightByToken.get(key)
  if (existing) return existing
  const promise = (async () => {
    try {
      const models = await loadModelsWithToken(oauth)
      cacheByToken.set(key, { value: models, expiresAt: Date.now() + POSITIVE_TTL_MS, isFallback: false })
      return models
    } catch {
      cacheByToken.set(key, { value: FALLBACK_MODELS, expiresAt: Date.now() + NEGATIVE_TTL_MS, isFallback: true })
      return FALLBACK_MODELS
    } finally {
      inflightByToken.delete(key)
    }
  })()
  inflightByToken.set(key, promise)
  return promise
}

/** 兼容旧调用：只返回 ID 列表。 */
export async function getCopilotModels(envContent: string): Promise<string[]> {
  const detailed = await getCopilotModelsDetailed(envContent)
  return detailed.map((m) => m.id)
}

/** 仅供测试使用：清空所有缓存与 inflight 状态。 */
export function __resetCopilotModelsCacheForTest(): void {
  cacheByToken.clear()
  inflightByToken.clear()
}

/**
 * 注销 / 切换账号后必须调用：清空所有 token 桶下的模型列表缓存与 inflight。
 * 否则下一次查询仍会命中旧账号的 cache（key 是 token 哈希；删除 token 后
 * key 变为 "__none__" 不会撞，但旧 key 的旧数据仍残留并继续返回过期模型）。
 */
export function invalidateAllCaches(): void {
  cacheByToken.clear()
  inflightByToken.clear()
}

export const COPILOT_FALLBACK_MODELS = FALLBACK_MODELS
