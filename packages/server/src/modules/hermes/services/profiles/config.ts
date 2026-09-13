import { openCodeSessionHeaders } from '../../../studio/public/opencode-session'
import { readFile, chmod } from 'fs/promises'
import { readdir, stat } from 'fs/promises'
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { getCompatibleCustomProviders } from '../../../studio/contracts/provider-compat'
import { logger } from '../../../studio/public/logging'
import { safeFileStore } from '../../../studio/public/safe-file-store'
import { getActiveProfileDir, getActiveConfigPath, getActiveEnvPath, getProfileDir } from './profile'

// --- Provider env var mapping (from hermes providers.py HERMES_OVERLAYS + config.py) ---
export const PROVIDER_ENV_MAP: Record<string, { api_key_env: string; base_url_env: string }> = {
  'fun-codex': { api_key_env: '', base_url_env: '' },
  'fun-claude': { api_key_env: '', base_url_env: '' },
  lmstudio: { api_key_env: 'LM_API_KEY', base_url_env: 'LM_BASE_URL' },
  openrouter: { api_key_env: 'OPENROUTER_API_KEY', base_url_env: 'OPENROUTER_BASE_URL' },
  glm: { api_key_env: 'GLM_API_KEY', base_url_env: '' },
  zai: { api_key_env: 'ZAI_API_KEY', base_url_env: 'ZAI_BASE_URL' },
  'kimi-coding': { api_key_env: 'KIMI_API_KEY', base_url_env: 'KIMI_BASE_URL' },
  'kimi-coding-cn': { api_key_env: 'KIMI_CN_API_KEY', base_url_env: '' },
  minimax: { api_key_env: 'MINIMAX_API_KEY', base_url_env: 'MINIMAX_BASE_URL' },
  'minimax-oauth': { api_key_env: '', base_url_env: '' },
  'minimax-cn': { api_key_env: 'MINIMAX_CN_API_KEY', base_url_env: 'MINIMAX_CN_BASE_URL' },
  deepseek: { api_key_env: 'DEEPSEEK_API_KEY', base_url_env: 'DEEPSEEK_BASE_URL' },
  alibaba: { api_key_env: 'DASHSCOPE_API_KEY', base_url_env: 'DASHSCOPE_BASE_URL' },
  'alibaba-coding-plan': { api_key_env: 'ALIBABA_CODING_PLAN_API_KEY', base_url_env: 'ALIBABA_CODING_PLAN_BASE_URL' },
  anthropic: { api_key_env: 'ANTHROPIC_API_KEY', base_url_env: 'ANTHROPIC_BASE_URL' },
  'claude-oauth': { api_key_env: '', base_url_env: '' },
  xai: { api_key_env: 'XAI_API_KEY', base_url_env: 'XAI_BASE_URL' },
  'xai-oauth': { api_key_env: '', base_url_env: '' },
  'qwen-oauth': { api_key_env: '', base_url_env: 'HERMES_QWEN_BASE_URL' },
  xiaomi: { api_key_env: 'XIAOMI_API_KEY', base_url_env: 'XIAOMI_BASE_URL' },
  'xiaomi-token-plan': { api_key_env: 'XIAOMI_TOKEN_PLAN_API_KEY', base_url_env: 'XIAOMI_TOKEN_PLAN_BASE_URL' },
  gemini: { api_key_env: 'GEMINI_API_KEY', base_url_env: 'GEMINI_BASE_URL' },
  kilocode: { api_key_env: 'KILO_API_KEY', base_url_env: 'KILOCODE_BASE_URL' },
  'ai-gateway': { api_key_env: 'AI_GATEWAY_API_KEY', base_url_env: 'AI_GATEWAY_BASE_URL' },
  cliproxyapi: { api_key_env: '', base_url_env: '' },
  'opencode-zen': { api_key_env: 'OPENCODE_ZEN_API_KEY', base_url_env: 'OPENCODE_ZEN_BASE_URL' },
  'opencode-free': { api_key_env: '', base_url_env: '' },
  'opencode-go': { api_key_env: 'OPENCODE_GO_API_KEY', base_url_env: 'OPENCODE_GO_BASE_URL' },
  huggingface: { api_key_env: 'HF_TOKEN', base_url_env: 'HF_BASE_URL' },
  nvidia: { api_key_env: 'NVIDIA_API_KEY', base_url_env: 'NVIDIA_BASE_URL' },
  novita: { api_key_env: 'NOVITA_API_KEY', base_url_env: 'NOVITA_BASE_URL' },
  gmi: { api_key_env: 'GMI_API_KEY', base_url_env: 'GMI_BASE_URL' },
  arcee: { api_key_env: 'ARCEE_API_KEY', base_url_env: 'ARCEE_BASE_URL' },
  stepfun: { api_key_env: 'STEPFUN_API_KEY', base_url_env: 'STEPFUN_BASE_URL' },
  'ollama-cloud': { api_key_env: 'OLLAMA_API_KEY', base_url_env: 'OLLAMA_BASE_URL' },
  nous: { api_key_env: '', base_url_env: '' },
  'openai-codex': { api_key_env: '', base_url_env: '' },
  'openai-api': { api_key_env: 'OPENAI_API_KEY', base_url_env: 'OPENAI_BASE_URL' },
  copilot: { api_key_env: 'GITHUB_TOKEN', base_url_env: '' },
  longcat: { api_key_env: '', base_url_env: '' },
  'tencent-tokenhub': { api_key_env: 'TENCENT_TOKENHUB_API_KEY', base_url_env: 'TOKENHUB_BASE_URL' },
}

// --- Types ---

export type SkillSource = 'builtin' | 'hub' | 'local' | 'external'

export interface SkillInfo {
  name: string
  description: string
  enabled: boolean
  source?: SkillSource
}

export interface SkillCategory {
  name: string
  description: string
  skills: SkillInfo[]
}

export interface ModelInfo {
  id: string
  label: string
}

export interface ModelGroup {
  provider: string
  models: ModelInfo[]
}

// --- Config YAML helpers ---

const configPath = () => getActiveConfigPath()
const configPathForProfile = (profile: string) => join(getProfileDir(profile), 'config.yaml')
const envPathForProfile = (profile: string) => join(getProfileDir(profile), '.env')

export async function readConfigYaml(): Promise<Record<string, any>> {
  return safeFileStore.readYaml(configPath())
}

export async function readConfigYamlForProfile(profile: string): Promise<Record<string, any>> {
  return safeFileStore.readYaml(configPathForProfile(profile))
}

export async function writeConfigYaml(config: Record<string, any>): Promise<void> {
  await safeFileStore.writeYaml(configPath(), config, { backup: true })
}

export async function updateConfigYaml<T = void>(
  updater: (config: Record<string, any>) => Record<string, any> | { data: Record<string, any>; result: T; write?: boolean } | Promise<Record<string, any> | { data: Record<string, any>; result: T; write?: boolean }>,
): Promise<T | undefined> {
  return safeFileStore.updateYaml(configPath(), updater, { backup: true })
}

export async function updateConfigYamlForProfile<T = void>(
  profile: string,
  updater: (config: Record<string, any>) => Record<string, any> | { data: Record<string, any>; result: T; write?: boolean } | Promise<Record<string, any> | { data: Record<string, any>; result: T; write?: boolean }>,
): Promise<T | undefined> {
  return safeFileStore.updateYaml(configPathForProfile(profile), updater, { backup: true })
}

// --- .env helpers ---

function assertValidEnvKey(key: string): void {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
    throw new Error(`Invalid .env key: ${JSON.stringify(key)}`)
  }
}

async function saveEnvValueAtPath(envPath: string, key: string, value: string): Promise<void> {
  assertValidEnvKey(key)
  await safeFileStore.updateText(envPath, (raw) => {
    const remove = !value
    const lines = raw.split('\n')
    let found = false
    const result: string[] = []
    for (const line of lines) {
      const trimmed = line.trim()
      if (trimmed.startsWith('#') && trimmed.startsWith(`# ${key}=`)) {
        if (!remove) result.push(`${key}=${value}`)
        found = true
      } else {
        const eqIdx = trimmed.indexOf('=')
        if (eqIdx !== -1 && trimmed.slice(0, eqIdx).trim() === key) {
          if (!remove) result.push(`${key}=${value}`)
          found = true
        } else {
          result.push(line)
        }
      }
    }
    if (!found && !remove) {
      result.push(`${key}=${value}`)
    }
    return result.join('\n').replace(/\n{3,}/g, '\n\n').replace(/\n+$/, '') + '\n'
  })
  try { await chmod(envPath, 0o600) } catch { /* ignore */ }
}

export async function saveEnvValue(key: string, value: string): Promise<void> {
  await saveEnvValueAtPath(getActiveEnvPath(), key, value)
}

export async function saveEnvValueForProfile(profile: string, key: string, value: string): Promise<void> {
  await saveEnvValueAtPath(envPathForProfile(profile), key, value)
}

// --- File helpers ---

export async function safeReadFile(filePath: string): Promise<string | null> {
  try {
    return await readFile(filePath, 'utf-8')
  } catch {
    return null
  }
}

export async function safeStat(filePath: string): Promise<{ mtime: number } | null> {
  try {
    const s = await stat(filePath)
    return { mtime: Math.round(s.mtimeMs) }
  } catch {
    return null
  }
}

// --- Skill helpers ---

export function extractDescription(content: string): string {
  const lines = content.split('\n')
  let inFrontmatter = false
  let bodyStarted = false

  for (const line of lines) {
    if (!bodyStarted && line.trim() === '---') {
      if (!inFrontmatter) {
        inFrontmatter = true
        continue
      } else {
        inFrontmatter = false
        bodyStarted = true
        continue
      }
    }
    if (inFrontmatter) continue
    if (line.trim() === '') continue
    if (line.startsWith('#')) continue
    return line.trim().slice(0, 80)
  }
  return ''
}

export async function listFilesRecursive(dir: string, prefix: string): Promise<{ path: string; name: string }[]> {
  const result: { path: string; name: string }[] = []
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return result
  }
  for (const entry of entries) {
    const relPath = prefix ? `${prefix}/${entry.name}` : entry.name
    if (entry.isDirectory()) {
      result.push(...await listFilesRecursive(join(dir, entry.name), relPath))
    } else {
      result.push({ path: relPath, name: entry.name })
    }
  }
  return result
}

// --- Provider model helpers ---

export async function fetchProviderModels(baseUrl: string, apiKey: string, freeOnly = false): Promise<string[]> {
  const base = baseUrl.replace(/\/+$/, '')
  const modelsUrl = /\/v\d+\/?$/.test(base) ? `${base}/models` : `${base}/v1/models`
  try {
    const res = await fetch(modelsUrl, {
      headers: { ...openCodeSessionHeaders(modelsUrl), Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(8000),
    })
    if (!res.ok) {
      logger.warn('available-models %s returned %d', modelsUrl, res.status)
      return []
    }
    const data = await res.json() as { data?: Array<{ id: string }> }
    if (!Array.isArray(data.data)) {
      logger.warn('available-models %s returned unexpected format', modelsUrl)
      return []
    }
    let models = data.data.map(m => m.id)
    // Gemini returns model IDs with "models/" prefix. Strip to avoid double
    // prefix when Hermes native adapter constructs .../models/{model}:generateContent
    if (base.includes('generativelanguage.googleapis.com')) {
      models = models.map(m => m.startsWith('models/') ? m.slice('models/'.length) : m)
    }
    if (freeOnly) models = models.filter(m => m.endsWith(':free'))
    return models.sort()
  } catch (err: any) {
    logger.error(err, 'available-models %s failed', modelsUrl)
    return []
  }
}

export function buildModelGroups(config: Record<string, any>): { default: string; groups: ModelGroup[] } {
  let defaultModel = ''
  const groups: ModelGroup[] = []

  // 1. Extract current model
  const modelSection = config.model
  if (typeof modelSection === 'object' && modelSection !== null) {
    defaultModel = String(modelSection.default || '').trim()
  } else if (typeof modelSection === 'string') {
    defaultModel = modelSection.trim()
  }

  // 2. Aggregate custom providers from both schemas (legacy list + v12+ dict).
  const customProviders = getCompatibleCustomProviders(config)
  const customModels: ModelInfo[] = []
  for (const entry of customProviders) {
    const cName = entry.name.trim()
    if (!cName) continue
    const seen = new Set<string>()
    const pushModel = (modelId: string) => {
      const id = modelId.trim()
      if (!id || seen.has(id)) return
      seen.add(id)
      customModels.push({ id, label: `${cName}: ${id}` })
    }
    if (entry.model) pushModel(entry.model)
    if (entry.models && typeof entry.models === 'object') {
      for (const id of Object.keys(entry.models)) pushModel(id)
    }
  }
  if (customModels.length > 0) {
    groups.push({ provider: 'Custom', models: customModels })
  }

  return { default: defaultModel, groups }
}

// --- Profile directory helper ---

export const getHermesDir = () => getActiveProfileDir()
