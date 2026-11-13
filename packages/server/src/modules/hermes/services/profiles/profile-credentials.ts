/**
 * 智能克隆 Profile 凭据管理
 *
 * 背景：`hermes profile create --clone` 会完整复制源 profile 的 .env + config.yaml，
 * 包括各平台的独占凭据（Weixin / Telegram / Slack / ...）。
 * 这导致多个 profile 同时持有同一个 bot token，hermes-agent 内部的 token 互斥机制
 * 会让后启动的 gateway 在健康检查阶段被 kill，表现为"profile 加载错误"。
 *
 * 解决方案：clone 完成后，对新 profile 自动执行：
 *   1. 从 .env 中删除所有匹配独占平台前缀的 KEY
 *   2. 把 config.yaml 中独占平台的 `enabled: true` 改为 false
 * 操作前会备份原文件为 `.bak.<timestamp>`。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import yaml from 'js-yaml'
import { detectHermesRootHome } from '../runtime/path'

function hermesBase(): string {
  return detectHermesRootHome()
}

function profileDir(profileName: string): string {
  const base = hermesBase()
  return profileName === 'default'
    ? base
    : join(base, 'profiles', profileName)
}

function activeProfileName(): string {
  try {
    return readFileSync(join(hermesBase(), 'active_profile'), 'utf-8').trim() || 'default'
  } catch {
    return 'default'
  }
}

/**
 * 已知"独占型"平台的环境变量前缀正则
 *
 * 这些平台的凭据本质上是"一对一身份绑定"：一个 token / app_id 对应唯一一个机器人或账号。
 * 多个 profile 共享同一凭据会触发 hermes-agent 的 token 互斥机制 → 启动失败。
 *
 * 不在此列表的（模型 provider API key、工具调试开关等）视为可安全共享。
 *
 * **来源（不要凭主观推测扩展）**：与 hermes-agent `gateway/platforms/` 中实际调用
 * `_acquire_platform_lock` / `acquire_scoped_lock` 的 adapter 1:1 对齐。
 * 验证方法：`grep -l _acquire_platform_lock gateway/platforms/*.py`。
 * 当前匹配上游的 7 个：discord, feishu, signal, slack, telegram, weixin, whatsapp。
 */
export const EXCLUSIVE_PLATFORM_ENV_PATTERNS: RegExp[] = [
  /^TELEGRAM_/,  // Telegram bot
  /^DISCORD_/,   // Discord bot
  /^SLACK_/,     // Slack app
  /^WHATSAPP_/,  // WhatsApp Business
  /^SIGNAL_/,    // Signal
  /^WEIXIN_/,    // 个人微信 bot
  /^FEISHU_/,    // 飞书
]

/**
 * 已知"独占型"平台在 config.yaml 中 `platforms.<name>` 节点的名称集合
 * 与 EXCLUSIVE_PLATFORM_ENV_PATTERNS 一一对应，用于禁用 `enabled` 字段。
 */
export const EXCLUSIVE_PLATFORMS = [
  'telegram', 'discord', 'slack', 'whatsapp', 'signal', 'weixin', 'feishu',
]

/**
 * config.yaml 中独占平台节点下的"敏感凭据字段"黑名单
 *
 * 仅在 EXCLUSIVE_PLATFORMS 节点（含其 `extra` 子节点）下作用，避免误伤模型 provider key
 * 等其他配置。clone 时这些字段会被一并删除，防止用户后续 re-enable 平台时复用源 profile
 * 的身份。
 */
export const EXCLUSIVE_PLATFORM_CREDENTIAL_KEYS = [
  'token', 'bot_token', 'app_token',
  'signing_secret', 'app_secret', 'client_secret',
  'access_token', 'webhook_secret',
  'account_id', 'phone_number_id', 'app_id',
  'encrypt_key', 'verification_token',
]

/** 判断 .env 中的 KEY 是否属于独占平台凭据 */
export function isExclusivePlatformKey(key: string): boolean {
  return EXCLUSIVE_PLATFORM_ENV_PATTERNS.some(re => re.test(key))
}

/**
 * 清理 .env 文件中的独占平台凭据
 * @param envPath .env 文件绝对路径
 * @returns 被删除的 KEY 名列表（按 .env 中出现顺序）；文件不存在或无需删除时返回 []
 *
 * 副作用：实际删除前会备份为 `.env.bak.<timestamp>`，便于用户恢复。
 */
export function stripExclusivePlatformCredentials(envPath: string): string[] {
  if (!existsSync(envPath)) return []
  const original = readFileSync(envPath, 'utf-8')
  const lines = original.split('\n')
  const removedKeys: string[] = []
  const kept: string[] = []
  for (const line of lines) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)\s*=/)
    if (m && isExclusivePlatformKey(m[1])) {
      removedKeys.push(m[1])
    } else {
      kept.push(line)
    }
  }
  if (removedKeys.length === 0) return []
  writeFileSync(`${envPath}.bak.${Date.now()}`, original, 'utf-8')
  writeFileSync(envPath, kept.join('\n'), 'utf-8')
  return removedKeys
}

/**
 * 禁用 config.yaml 中已知独占平台的 enabled 字段，并清理节点下的敏感凭据
 * @param configPath config.yaml 绝对路径
 * @returns
 *   - disabled: 被禁用的平台名列表
 *   - strippedConfigCredentials: 被清理的凭据字段路径（如 'weixin.extra.token'）
 *   无任何修改时两个字段均为空数组。
 *
 * 副作用：实际改写前会备份为 `config.yaml.bak.<timestamp>`。
 */
export function disableExclusivePlatformsInConfig(configPath: string): {
  disabled: string[]
  strippedConfigCredentials: string[]
} {
  if (!existsSync(configPath)) return { disabled: [], strippedConfigCredentials: [] }
  const original = readFileSync(configPath, 'utf-8')
  let cfg: any
  try {
    cfg = yaml.load(original, { json: true })
  } catch {
    return { disabled: [], strippedConfigCredentials: [] }
  }
  if (!cfg || typeof cfg !== 'object') return { disabled: [], strippedConfigCredentials: [] }
  const platforms = cfg.platforms
  if (!platforms || typeof platforms !== 'object') return { disabled: [], strippedConfigCredentials: [] }

  const disabled: string[] = []
  const strippedConfigCredentials: string[] = []

  for (const platName of EXCLUSIVE_PLATFORMS) {
    const node = platforms[platName]
    if (!node || typeof node !== 'object') continue

    if (node.enabled === true) {
      node.enabled = false
      disabled.push(platName)
    }

    // 清理节点直挂的凭据字段
    for (const k of EXCLUSIVE_PLATFORM_CREDENTIAL_KEYS) {
      if (k in node) {
        delete node[k]
        strippedConfigCredentials.push(`${platName}.${k}`)
      }
    }
    // 清理 extra 子节点中的凭据字段
    if (node.extra && typeof node.extra === 'object') {
      for (const k of EXCLUSIVE_PLATFORM_CREDENTIAL_KEYS) {
        if (k in node.extra) {
          delete node.extra[k]
          strippedConfigCredentials.push(`${platName}.extra.${k}`)
        }
      }
    }
  }

  if (disabled.length === 0 && strippedConfigCredentials.length === 0) {
    return { disabled: [], strippedConfigCredentials: [] }
  }
  writeFileSync(`${configPath}.bak.${Date.now()}`, original, 'utf-8')
  writeFileSync(configPath, yaml.dump(cfg, { lineWidth: -1 }), 'utf-8')
  return { disabled, strippedConfigCredentials }
}

export interface SmartCloneCleanup {
  /** 从 .env 中删除的 KEY 名列表 */
  strippedCredentials: string[]
  /** 在 config.yaml 中被禁用的平台名列表 */
  disabledPlatforms: string[]
  /** 在 config.yaml 中被清理的内嵌凭据字段路径（如 'weixin.extra.token'） */
  strippedConfigCredentials: string[]
}

function configuredModelProvider(configPath: string): string {
  if (!existsSync(configPath)) return ''
  let cfg: any
  try {
    cfg = yaml.load(readFileSync(configPath, 'utf-8'), { json: true })
  } catch {
    return ''
  }
  const provider = cfg?.model && typeof cfg.model === 'object'
    ? String(cfg.model.provider || '').trim()
    : ''
  if (!provider || provider === 'custom') return ''
  return provider
}

function readAuthJson(path: string): any {
  if (!existsSync(path)) return {}
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8'))
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

function authProviderKeysForModelProvider(provider: string): string[] {
  return provider === 'claude-oauth' ? ['claude-oauth', 'anthropic'] : [provider]
}

const MODEL_AUTH_PROVIDERS = new Set([
  'openai-codex',
  'claude-oauth',
  'xai-oauth',
  'qwen-oauth',
  'nous',
  'minimax-oauth',
])

/**
 * Copy the source profile's OAuth auth for the cloned profile's configured model
 * provider only.
 *
 * Hermes CLI `profile create --clone` copies config/.env/SOUL/skills, but not
 * `auth.json`. OAuth-only model providers such as `openai-codex` then look
 * configured in the cloned profile while `/available-models?profile=<clone>`
 * returns no groups because the profile-local auth file is missing. Copying only
 * the provider keys required by the cloned `model.provider` preserves model
 * access without copying unrelated provider or platform credentials across
 * profiles. Claude OAuth also copies its `anthropic` runtime alias because chat
 * execution rewrites `claude-oauth` to `anthropic`.
 */
export function copyModelProviderAuthForClone(profileName: string): string[] {
  if (!profileName || profileName === 'default') return []
  const targetDir = profileDir(profileName)
  const provider = configuredModelProvider(join(targetDir, 'config.yaml'))
  if (!MODEL_AUTH_PROVIDERS.has(provider)) return []

  const sourceDir = profileDir(activeProfileName())
  const sourceAuth = readAuthJson(join(sourceDir, 'auth.json'))
  const targetAuthPath = join(targetDir, 'auth.json')
  const targetAuth = readAuthJson(targetAuthPath)
  const copied = new Set<string>()

  for (const authProvider of authProviderKeysForModelProvider(provider)) {
    if (sourceAuth.providers?.[authProvider] && !targetAuth.providers?.[authProvider]) {
      targetAuth.providers = { ...(targetAuth.providers || {}), [authProvider]: sourceAuth.providers[authProvider] }
      copied.add(authProvider)
    }
    if (sourceAuth.credential_pool?.[authProvider] && !targetAuth.credential_pool?.[authProvider]) {
      targetAuth.credential_pool = { ...(targetAuth.credential_pool || {}), [authProvider]: sourceAuth.credential_pool[authProvider] }
      copied.add(authProvider)
    }
  }
  if (copied.size === 0) return []

  mkdirSync(targetDir, { recursive: true })
  if (existsSync(targetAuthPath)) {
    writeFileSync(`${targetAuthPath}.bak.${Date.now()}`, JSON.stringify(readAuthJson(targetAuthPath), null, 2) + '\n', 'utf-8')
  }
  writeFileSync(targetAuthPath, JSON.stringify(targetAuth, null, 2) + '\n', { encoding: 'utf-8', mode: 0o600 })
  return [...copied]
}

/**
 * 一站式：清理新 profile 的独占凭据 + 禁用 config.yaml 中的独占平台
 *
 * @param profileName profile 名称（'default' → ~/.hermes/，其他 → ~/.hermes/profiles/<name>/）
 */
export function smartCloneCleanup(profileName: string): SmartCloneCleanup {
  const targetDir = profileDir(profileName)
  const configResult = disableExclusivePlatformsInConfig(join(targetDir, 'config.yaml'))
  return {
    strippedCredentials: stripExclusivePlatformCredentials(join(targetDir, '.env')),
    disabledPlatforms: configResult.disabled,
    strippedConfigCredentials: configResult.strippedConfigCredentials,
  }
}
