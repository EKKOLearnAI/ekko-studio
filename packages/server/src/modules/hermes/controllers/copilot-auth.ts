import { randomUUID } from 'crypto'
import { startDeviceFlow, pollDeviceFlow } from '../services/providers/copilot-device-flow'
import { saveEnvValue, updateConfigYaml } from '../../studio/public/profile-config'
import {
  invalidateAllCaches,
  resolveCopilotOAuthTokenWithSource,
  type CopilotTokenSource,
} from '../services/providers/copilot-models'
import { getActiveEnvPath } from '../services/profiles/profile'
import { readAppConfig, writeAppConfig } from '../../studio/public/app-config'
import { readFile } from 'fs/promises'
import { logger } from '../../studio/public/logging'
import { preservedModelKeys } from '../services/models/model-section'

const POLL_MAX_DURATION_MS = 15 * 60 * 1000 // 15 minutes hard ceiling
const SESSION_GC_GRACE_MS = 60 * 1000

interface CopilotLoginSession {
  id: string
  deviceCode: string
  userCode: string
  verificationUrl: string
  expiresIn: number
  interval: number
  status: 'pending' | 'approved' | 'denied' | 'expired' | 'error'
  error?: string
  createdAt: number
}

const sessions = new Map<string, CopilotLoginSession>()

function cleanupSessions(): void {
  const now = Date.now()
  sessions.forEach((s, id) => {
    if (now - s.createdAt > POLL_MAX_DURATION_MS + SESSION_GC_GRACE_MS) {
      sessions.delete(id)
    }
  })
}

async function persistToken(token: string): Promise<void> {
  // 与 disable 对称：只动 ~/.hermes/.env，apps.json 是 VS Code 的文件不要碰。
  // 同时把 enabled 置 true —— device flow 完成后用户已显式同意启用 Copilot。
  // NOTE: 故意不写 process.env.COPILOT_GITHUB_TOKEN —— 否则该值会跨 profile 持续覆盖
  // resolveCopilotOAuthTokenWithSource 的 .env 读取，导致切到别的 profile 仍解析到当前
  // profile 的 token。invalidateAllCaches() + .env 文件本身已能保证下次解析读到新 token。
  await saveEnvValue('COPILOT_GITHUB_TOKEN', token)
  await writeAppConfig({ copilotEnabled: true })
  invalidateAllCaches()
}

async function readEnvContent(): Promise<string> {
  try { return await readFile(getActiveEnvPath(), 'utf-8') } catch { return '' }
}

async function loginWorker(session: CopilotLoginSession): Promise<void> {
  const startTime = Date.now()
  let interval = Math.max(1, session.interval) * 1000

  while (Date.now() - startTime < POLL_MAX_DURATION_MS) {
    await new Promise((resolve) => setTimeout(resolve, interval))
    if (session.status !== 'pending') return

    const result = await pollDeviceFlow(session.deviceCode)

    if (result.kind === 'success') {
      try {
        await persistToken(result.access_token)
        session.status = 'approved'
        logger.info('Copilot OAuth login successful')
      } catch (err: any) {
        logger.error(err, 'Copilot OAuth: failed to persist token')
        session.status = 'error'
        session.error = err?.message ?? 'failed to persist token'
      }
      return
    }

    if (result.kind === 'pending') continue
    if (result.kind === 'slow_down') {
      interval += 5000
      continue
    }
    if (result.kind === 'denied') {
      session.status = 'denied'
      return
    }
    if (result.kind === 'expired') {
      session.status = 'expired'
      return
    }
    logger.error('Copilot OAuth poll error: %s %s', result.error, result.description ?? '')
    session.status = 'error'
    session.error = result.description ?? result.error
    return
  }

  session.status = 'expired'
}

export async function start(ctx: any): Promise<void> {
  cleanupSessions()
  try {
    const data = await startDeviceFlow()
    const sessionId = randomUUID()
    const session: CopilotLoginSession = {
      id: sessionId,
      deviceCode: data.device_code,
      userCode: data.user_code,
      verificationUrl: data.verification_uri,
      expiresIn: data.expires_in,
      interval: data.interval,
      status: 'pending',
      createdAt: Date.now(),
    }
    sessions.set(sessionId, session)

    loginWorker(session).catch((err) => {
      logger.error(err, 'Copilot login worker error')
      session.status = 'error'
      session.error = err?.message ?? String(err)
    })

    ctx.body = {
      session_id: sessionId,
      user_code: data.user_code,
      verification_url: data.verification_uri,
      expires_in: data.expires_in,
      interval: data.interval,
    }
  } catch (err: any) {
    logger.error(err, 'Copilot OAuth start failed')
    if (err?.name === 'TimeoutError' || err?.name === 'AbortError') {
      ctx.status = 504
      ctx.body = { error: 'GitHub timeout' }
      return
    }
    ctx.status = 502
    ctx.body = { error: err?.message ?? 'GitHub OAuth start failed' }
  }
}

export async function poll(ctx: any): Promise<void> {
  const session = sessions.get(ctx.params.sessionId)
  if (!session) {
    ctx.status = 404
    ctx.body = { error: 'Session not found' }
    return
  }
  ctx.body = { status: session.status, error: session.error || null }
}

/**
 * Reports current token resolution and whether Copilot is opt-in enabled.
 * Frontend Add Provider flow uses this to decide whether to show the
 * "token detected, click Add" confirmation or kick off device flow.
 *
 * Side effect: invalidates the model list cache so a subsequent listing
 * picks up gh-cli logout / VS Code sign-out without server restart.
 */
export async function checkToken(ctx: any): Promise<void> {
  invalidateAllCaches()
  const env = await readEnvContent()
  const { token, source } = await resolveCopilotOAuthTokenWithSource(env)
  const cfg = await readAppConfig()
  ctx.body = {
    has_token: Boolean(token),
    source: source as CopilotTokenSource,
    enabled: cfg.copilotEnabled === true,
  }
}

export async function enable(ctx: any): Promise<void> {
  await writeAppConfig({ copilotEnabled: true })
  invalidateAllCaches()
  ctx.body = { ok: true }
}

/**
 * "Soft delete" Copilot from the web-ui provider list.
 *   - Always: copilotEnabled = false (hides provider regardless of token source).
 *   - source='env'        → also clear ~/.hermes/.env COPILOT_GITHUB_TOKEN
 *                           (this token belongs to the hermes ecosystem).
 *   - source='gh-cli'     → leave gh CLI alone (user's terminal sessions).
 *   - source='apps-json'  → leave VS Code Copilot plugin alone.
 * The user can re-add Copilot any time via "Add Provider".
 */
export async function disable(ctx: any): Promise<void> {
  const env = await readEnvContent()
  const { source } = await resolveCopilotOAuthTokenWithSource(env)

  // 步骤 1：先清掉默认模型（最容易失败的一步：写 yaml 可能失败）。
  // 不能 swallow —— 否则会出现 "list 已隐藏 copilot 但 default 仍是 copilot" 的中间态。
  let clearedDefault = false
  try {
    clearedDefault = await updateConfigYaml((cfg) => {
      const modelSection = cfg.model
      if (typeof modelSection === 'object' && modelSection !== null) {
        const provider = String(modelSection.provider || '').trim().toLowerCase()
        if (provider === 'copilot') {
          cfg.model = preservedModelKeys(modelSection)
          return { data: cfg, result: true }
        }
      }
      return { data: cfg, result: false, write: false }
    }) || false
  } catch (err: any) {
    logger.error(err, 'Copilot disable failed: cannot clear default model')
    ctx.status = 500
    ctx.body = { error: `failed to clear default model: ${err?.message ?? 'unknown error'}` }
    return
  }

  // 步骤 2：清 .env（仅当 source='env'）。失败也不能让 enabled flag 偷偷置 false。
  try {
    if (source === 'env') {
      await saveEnvValue('COPILOT_GITHUB_TOKEN', '')
      delete process.env.COPILOT_GITHUB_TOKEN
    }
  } catch (err: any) {
    logger.error(err, 'Copilot disable failed: cannot clear .env')
    ctx.status = 500
    ctx.body = { error: `failed to clear .env: ${err?.message ?? 'unknown error'}` }
    return
  }

  // 步骤 3：最后翻 enabled flag。前两步成功才执行。
  try {
    await writeAppConfig({ copilotEnabled: false })
    invalidateAllCaches()
  } catch (err: any) {
    logger.error(err, 'Copilot disable failed: cannot persist enabled flag')
    ctx.status = 500
    ctx.body = { error: `failed to persist enabled flag: ${err?.message ?? 'unknown error'}` }
    return
  }

  ctx.body = { ok: true, cleared_env: source === 'env', cleared_default: clearedDefault }
}
