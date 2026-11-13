import fs from 'fs/promises'
import path from 'path'

/**
 * DashScope API key 的持久化恢复（拆分自 meeting-asr/index.ts，行为保持一致）。
 *
 * Recover the DashScope API key from persistent storage when the caller
 * didn't pass one inline. The Python backend stores secrets in two files
 * under dataDir, and we must check both:
 *
 *   - config.json: written by the Node controller's /api/config proxy and
 *     by updateLLMConfig(). Key lives at `llm.api_key` or `asr.dashscope_api_key`.
 *   - config.env: written by Python `storage.update_config()` as shell-style
 *     `DASHSCOPE_API_KEY=sk-...` lines, consumed by `config.py` at import
 *     time via python-dotenv.
 *
 * Before this fix, the fallback only read config.json, so auto-restart or
 * first-start-after-deploy failed with "DASHSCOPE_API_KEY is not configured"
 * whenever the key had been persisted exclusively via the Python path
 * (config.env) — which is the common case after the user saves ASR config
 * from the UI.
 */
/** 读「设置 → 模型 → Realtime 模型」里保存的 Qwen key（DB 未就绪时返回 null）。 */
export async function readRealtimePanelApiKey(profile = 'default'): Promise<string | null> {
  try {
    // 动态 import: 保持本模块在纯文件系统场景（单测 / 无 DB 的启动早期）
    // 不依赖 db/index 的加载顺序。
    const { getRealtimeModelSetting } = await import('../../repositories/realtime-settings-store')
    const key = getRealtimeModelSetting(profile || 'default', { includeSecrets: true })?.secrets?.apiKey?.trim()
    return key || null
  } catch {
    return null
  }
}

/**
 * 统一解析 DashScope key（会议 ASR / Realtime 的单一入口）。
 *
 * 顺序：
 *   1. `dataDir/config.json` + `config.env` —— 会议 ASR 向导显式保存的 key（设备上的专用覆盖）
 *   2. 「设置 → 模型 → Realtime 模型」(SQLite `realtime_profile_settings.secrets.apiKey`)
 *      —— 界面承诺的「共用默认值」
 *   3. 进程环境变量 `DASHSCOPE_API_KEY`
 *
 * 为什么要接第 2 处（2026-10-11, 设备 192.168.1.54 事故）：浏览器侧在 start 时会把
 * Realtime 面板的 key 显式下发给后端，所以一直正常；而**设备端 Qt 客户端只会开
 * `/ws/omni-realtime`**，服务端只能用持久化回落。旧实现只看 config.json / config.env，
 * 用户只在 Realtime 面板填过 key（产品推荐的单点入口）时两者都不存在 →
 * 后端拿到空 key → 实时对话报 "DASHSCOPE_API_KEY is not configured"。
 *
 * 文件优先是刻意保留旧行为：会议 ASR 向导里填的 key 属于对该设备的专用覆盖，
 * Realtime 面板只是回落默认值（与 i18n 文案「未单独填写时回落使用」一致）。
 */
export async function resolveDashScopeKey(dataDir: string, profile = 'default'): Promise<string | null> {
  const fromFiles = await readStoredDashScopeKey(dataDir).catch(() => null)
  if (fromFiles) return fromFiles
  const fromPanel = await readRealtimePanelApiKey(profile)
  if (fromPanel) return fromPanel
  const env = process.env.DASHSCOPE_API_KEY
  return env && env.trim() ? env.trim() : null
}

export async function readStoredDashScopeKey(dataDir: string): Promise<string | null> {
  // 1. config.json (JSON)
  try {
    const configPath = path.join(dataDir, 'config.json')
    const raw = await fs.readFile(configPath, 'utf-8')
    const stored = JSON.parse(raw)
    const key = stored?.asr?.dashscope_api_key || stored?.llm?.api_key
    if (key) return key
  } catch { /* file missing or invalid JSON */ }

  // 2. config.env (shell-style KEY=VALUE lines)
  try {
    const envPath = path.join(dataDir, 'config.env')
    const raw = await fs.readFile(envPath, 'utf-8')
    for (const line of raw.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith('#')) continue
      const eq = trimmed.indexOf('=')
      if (eq === -1) continue
      if (trimmed.slice(0, eq).trim() === 'DASHSCOPE_API_KEY') {
        let val = trimmed.slice(eq + 1).trim()
        // Strip surrounding quotes if present
        if ((val.startsWith('"') && val.endsWith('"')) ||
            (val.startsWith("'") && val.endsWith("'"))) {
          val = val.slice(1, -1)
        }
        if (val) return val
      }
    }
  } catch { /* file missing */ }

  return null
}
