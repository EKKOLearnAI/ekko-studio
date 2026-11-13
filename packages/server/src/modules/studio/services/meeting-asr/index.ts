import { getServerCertDir, getWebUiHome } from '../../public/config'
import { ChildProcess, spawn } from 'child_process'
import { EventEmitter } from 'events'
import { createHash } from 'crypto'
import { readdirSync, readFileSync } from 'fs'
import http from 'node:http'
import https from 'node:https'
import { createServer as createNetServer } from 'node:net'
import path from 'path'
import fs from 'fs/promises'
import os from 'os'
import { logger } from '../../public/logging'
import * as venvManager from './venv-manager'
import * as dashscopeKeyStore from './dashscope-key-store'

export interface MeetingASRConfig {
  /**
   * ASR provider selection: `'dashscope'` (default — Paraformer/Fun-ASR
   * WebSocket flow) or `'minimax'` (MiniMax Speech-to-Text REST chunking
   * flow, https://platform.minimax.cn/docs/api-reference/speech-to-text).
   * Undefined is treated as `'dashscope'` for backward compatibility.
   */
  asrProvider?: 'dashscope' | 'minimax'
  dashscopeApiKey?: string
  asrModel?: string  // 'paraformer-v2' | 'fun-asr' | 'fun-asr-mtl'
  paraformerWsUrl?: string
  paraformerModel?: string
  paraformerSampleRate?: number
  paraformerFormat?: string
  paraformerLanguageHints?: string
  paraformerSemanticPunctuation?: boolean
  /** MiniMax Speech-to-Text API key (Bearer token). */
  minimaxApiKey?: string
  /** MiniMax ASR model id, e.g. 'asr-1.0'. */
  minimaxAsrModel?: string
  /** MiniMax ASR HTTP base URL. */
  minimaxBaseUrl?: string
  /** BCP-47 language hint for MiniMax (`zh`, `en`, ...). */
  minimaxLanguage?: string
  /** Container MiniMax accepts (MiniMax rejects raw PCM). */
  minimaxAudioFormat?: 'wav' | 'mp3' | 'opus' | 'aac' | 'ogg'
  /** PCM sample rate fed into the MiniMax encoder (Hz). */
  minimaxSampleRate?: number
  /** Maximum PCM chunk seconds per MiniMax request. */
  minimaxChunkSeconds?: number
  llmApiKey?: string
  llmBaseUrl?: string
  llmModel?: string
  dataDir?: string
  host?: string
  asrPort?: number
  diarizePort?: number
  ossBucket?: string
  ossAccessKeyId?: string
  ossAccessKeySecret?: string
  ossEndpoint?: string
  ossPathPrefix?: string
}

export interface MeetingASRStatus {
  isRunning: boolean
  asrPort: number | null
  diarizePort: number | null
  pid: number | null
  uptime: number | null
  error: string | null
  /**
   * Where the service is in its startup lifecycle. Used by the UI to render
   * phase-specific copy (e.g. "installing dependencies, ~3 min on ARM64")
   * instead of a generic "connecting". Also surfaced while waiting for
   * `isRunning=true` after the user clicks record.
   */
  startupPhase: StartupPhase
  /** True iff the Python venv probe passed at least once this run. */
  isVenvReady: boolean
  /**
   * Whether the spawned uvicorn processes serve HTTPS. The Node WS proxy in
   * bootstrap reads this so the upgrade handler picks `tls.connect` vs
   * `net.connect` automatically — no deploy-time env coordination needed.
   */
  useTls: boolean
  /**
   * Content hash of the python-backend sources currently on disk. The client
   * compares it with the hash the backend reports on `/healthz` to notice a
   * stale uvicorn child after a rebuild.
   */
  codeHash?: string | null
}

/**
 * Startup lifecycle phase. Exposed via MeetingASRStatus so the front-end can
 * show actionable progress without inventing its own state machine.
 */
export type StartupPhase =
  | 'idle'
  | 'venv'           // probing / creating the Python virtual environment
  | 'pip_install'    // installing requirements inside the venv (slow on ARM64)
  | 'starting'       // spawning uvicorn for asr / diarize
  | 'ready'          // both healthz endpoints respond OK
  | 'error'

export class MeetingASRService extends EventEmitter {
  private static instance: MeetingASRService | null = null
  private mainProcess: ChildProcess | null = null
  private diarizeProcess: ChildProcess | null = null
  private _isRunning = false
  private _startTime: number | null = null
  private _config: MeetingASRConfig = {}
  private _error: string | null = null
  private _asrPort: number | null = null
  private _diarizePort: number | null = null
  /** Content hash of the python-backend sources the running child loaded. */
  private _backendCodeHash: string | null = null
  /**
   * Tail of the main child's stdout/stderr. uvicorn writes tracebacks and the
   * kernel's OOM notice there, but the live stream is only logged at debug
   * level (too noisy for access logs). Keeping the tail lets an unexpected
   * exit report *why* it died, which is what the 503 `detail` field shows.
   */
  private _mainLogTail: string[] = []
  private static readonly LOG_TAIL_LINES = 25
  // Auto-restart: when true, an unexpected main-process exit triggers a
  // bounded backoff restart loop. Disabled by stop() to avoid fighting
  // deliberate shutdowns.
  private _autoRestart = false
  private _restartAttempts = 0
  private _restartTimer: NodeJS.Timeout | null = null
  private static readonly MAX_RESTART_ATTEMPTS = 5
  private static readonly RESTART_BACKOFF_MS = [1000, 2000, 5000, 10000, 30000]

  // Startup phase tracking + health monitor (added for v0.7.8 to surface
  // long-running start phases and recover from silent OOM kills).
  private _startupPhase: StartupPhase = 'idle'
  private _isVenvReady = false
  private _healthTimer: NodeJS.Timeout | null = null
  private _healthFailures = 0
  private static readonly HEALTH_PROBE_INTERVAL_MS = 30_000
  private static readonly HEALTH_PROBE_TIMEOUT_MS = 5_000
  private static readonly HEALTH_FAILURES_BEFORE_RESTART = 3

  // TLS mode is decided at construction from env so that:
  //   1. spawn() can pass --ssl-keyfile/--ssl-certfile to uvicorn, and
  //   2. the WS upgrade proxy in bootstrap/index.ts can pick the matching
  //      transport (tls.connect vs net.connect) without an extra env hop.
  // Default is plain HTTP (dev-friendly); device images set
  // HERMES_WEB_UI_MEETING_ASR_TLS=true to use the shared self-signed cert
  // under packages/server/certs/.
  private readonly _useTls: boolean =
    String(process.env.HERMES_WEB_UI_MEETING_ASR_TLS || '').toLowerCase() === 'true'

  private constructor() {
    super()
  }

  static getInstance(): MeetingASRService {
    if (!MeetingASRService.instance) {
      MeetingASRService.instance = new MeetingASRService()
    }
    return MeetingASRService.instance
  }

  get isRunning(): boolean {
    return this._isRunning
  }

  get status(): MeetingASRStatus {
    return {
      isRunning: this._isRunning,
      asrPort: this._asrPort,
      diarizePort: this._diarizePort,
      pid: this.mainProcess?.pid || null,
      uptime: this._startTime ? Date.now() - this._startTime : null,
      error: this._error,
      startupPhase: this._startupPhase,
      isVenvReady: this._isVenvReady,
      useTls: this._useTls,
      codeHash: this._backendCodeHash,
    }
  }

  /**
   * Content hash of the bundled python-backend sources.
   *
   * The uvicorn child imports its modules once at spawn; a rebuild that
   * replaces `python-backend/` on disk does not affect an already-running
   * process. Hashing the sources lets us (a) detect that mismatch on the next
   * start and respawn, and (b) expose the marker to the client via status so
   * it can compare against the hash the backend reports on /healthz.
   *
   * Best-effort: any IO error just yields null and the staleness check is
   * skipped rather than blocking startup.
   */
  private computeBackendCodeHash(): string | null {
    try {
      const root = this.getPythonBackendPath()
      const files: string[] = []
      const walk = (dir: string): void => {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
          if (entry.name === '__pycache__' || entry.name.startsWith('.')) continue
          const full = path.join(dir, entry.name)
          if (entry.isDirectory()) walk(full)
          else if (entry.name.endsWith('.py')) files.push(full)
        }
      }
      walk(root)
      files.sort()
      const hash = createHash('sha256')
      for (const file of files) {
        hash.update(path.relative(root, file))
        hash.update(readFileSync(file))
      }
      return hash.digest('hex').slice(0, 16)
    } catch (err) {
      logger.warn('[meeting-asr] failed to hash python-backend sources: %s', err)
      return null
    }
  }

  /**
   * True when the sources on disk no longer match the ones the running child
   * imported. False when nothing is running, when the hash is unknown, or
   * when hashing failed — the caller then falls back to a hot config push.
   */
  private isBackendCodeStale(): boolean {
    if (!this._backendCodeHash) return false
    const current = this.computeBackendCodeHash()
    return !!current && current !== this._backendCodeHash
  }

  /** Append a child output chunk to the bounded diagnostic tail. */
  private _recordMainLog(chunk: unknown): void {
    const text = String(chunk ?? '')
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim()
      if (trimmed) this._mainLogTail.push(trimmed)
    }
    const overflow = this._mainLogTail.length - MeetingASRService.LOG_TAIL_LINES
    if (overflow > 0) this._mainLogTail.splice(0, overflow)
  }

  /**
   * Public read-only view of the TLS decision so the WS upgrade proxy in
   * bootstrap/index.ts can pick tls.connect vs net.connect without reading
   * process.env on its own. Constant for the lifetime of the process — the
   * env is sampled once at construction.
   */
  get useTls(): boolean {
    return this._useTls
  }

  private getPythonBackendPath(): string {
    return path.join(__dirname, 'python-backend')
  }

  /**
   * Build the `--ssl-*` argv pair for uvicorn when running in TLS mode.
   *
   * Path resolution matches the Node HTTPS server in bootstrap/index.ts so
   * both sides use the same self-signed cert under packages/server/certs/.
   * Env overrides exist for non-standard deploy layouts.
   *
   * Returns [] when TLS is off — the caller spreads these into uvicorn argv.
   */
  private _uvicornTlsArgs(): string[] {
    if (!this._useTls) return []
    const certPath = process.env.HERMES_WEB_UI_SSL_CERTFILE
      || path.join(getServerCertDir(), 'server.crt')
    const keyPath = process.env.HERMES_WEB_UI_SSL_KEYFILE
      || path.join(getServerCertDir(), 'server.key')
    return ['--ssl-certfile', certPath, '--ssl-keyfile', keyPath]
  }

  private getDataDir(): string {
    // Resolution order (highest priority first):
    //   1. start({ dataDir }) constructor arg — used by tests and ad-hoc
    //      overrides from /api/studio/meeting-asr/start.
    //   2. MEETING_ASR_DATA_DIR env var — set by deploy-source-armbian.sh
    //      so the pre-warmed venv and the runtime venv share the same path
    //      (was a regression risk before v0.7.16; see audit #1).
    //   3. The canonical Web UI state home for installations without overrides.
    return (
      this._config.dataDir
      || process.env.MEETING_ASR_DATA_DIR
      || path.join(getWebUiHome(), 'meeting-asr')
    )
  }

  resolveVenvPath(dataDir: string, _pythonBackendPath: string): string {
    return venvManager.resolveVenvPath(dataDir, _pythonBackendPath)
  }

  resolveVenvMarkerPath(venvPath: string): string {
    return venvManager.resolveVenvMarkerPath(venvPath)
  }

  getVenvPythonPath(venvPath: string): string {
    return venvManager.getVenvPythonPath(venvPath)
  }

  async readStoredDashScopeKey(dataDir: string): Promise<string | null> {
    return dashscopeKeyStore.readStoredDashScopeKey(dataDir)
  }

  /**
   * 把持久化里解析到的 DashScope key 热推给「已在运行但没拿到 key」的后端进程。
   *
   * 场景（2026-10-11 设备 192.168.1.54）：用户先打开录音/会议页 → 后端以空 key 启动
   * → 之后才在「设置 → 模型 → Realtime 模型」填 key。浏览器随后会把 key 显式下发，
   * 但设备端 Qt 客户端只开 `/ws/omni-realtime`、不会下发，于是实时对话持续报
   * "DASHSCOPE_API_KEY is not configured"。这里在实时 WS 接入前补推一次，
   * 用户无需重启服务/应用。
   *
   * 只在后端当前 key 为空时推送 —— 已有 key（会议向导或浏览器下发的）不动。
   * 返回 true 表示确实推送了一次。
   */
  async ensureDashScopeKeyPushed(profile = 'default'): Promise<boolean> {
    if (!this._isRunning || !this._asrPort) return false

    let stored: string | null = null
    try {
      stored = await dashscopeKeyStore.resolveDashScopeKey(this.getDataDir(), profile)
    } catch {
      return false
    }
    if (!stored) return false

    let asr: Record<string, unknown> | null = null
    try {
      const res = await this.backendRequest(this._asrPort, '/api/config', 'GET', undefined, 5000)
      const parsed = JSON.parse(res.body)
      asr = (parsed && typeof parsed.asr === 'object' && parsed.asr) || null
    } catch (err) {
      logger.warn(
        '[meeting-asr] could not read backend config before key push: %s',
        err instanceof Error ? err.message : err,
      )
      return false
    }
    if (String(asr?.dashscope_api_key || '').trim()) return false

    const payload: Record<string, unknown> = { ...(asr || {}) }
    // get_config_safe() 会额外附带 *_masked 展示字段，不属于 ASRConfig。
    for (const key of Object.keys(payload)) {
      if (key.endsWith('_masked')) delete payload[key]
    }
    payload.dashscope_api_key = stored

    try {
      const res = await this.backendRequest(
        this._asrPort, '/api/config/asr', 'POST', JSON.stringify(payload), 8000,
      )
      if (res.status >= 200 && res.status < 300) {
        logger.info('[meeting-asr] pushed stored DashScope key (%d chars) to running backend', stored.length)
        return true
      }
      logger.warn('[meeting-asr] DashScope key push rejected: %d %s', res.status, res.body.slice(0, 200))
    } catch (err) {
      logger.warn('[meeting-asr] DashScope key push failed: %s', err instanceof Error ? err.message : err)
    }
    return false
  }

  private async ensureVirtualEnv(): Promise<string> {
    const backendPath = this.getPythonBackendPath()
    const dataDir = this.getDataDir()
    const pythonPath = await venvManager.ensureVirtualEnv({
      backendPath,
      dataDir,
      requirementsPath: path.join(__dirname, 'requirements.txt'),
      onPhase: (phase) => {
        this._startupPhase = phase
        this.emit('phase', phase)
      },
    })
    this._isVenvReady = true
    return pythonPath
  }

  async start(config: MeetingASRConfig = {}): Promise<void> {
    if (this._isRunning) {
      // Service is already up. Decide between restart and hot-config push:
      //   - OSS_* fields require a restart because Python config.py reads
      //     them from os.environ at import time (no runtime override).
      //   - All other fields (DashScope key, Paraformer, LLM) are pushed via
      //     updateConfig() → POST /api/config so we avoid interrupting the
      //     user's recording session.
      //   - Changed python-backend sources also require a restart: the child
      //     imported its modules at spawn and would otherwise keep running
      //     stale logic after a rebuild (this is how an already-fixed bug can
      //     keep reproducing until the service is manually restarted).
      const currentHash = this.computeBackendCodeHash()
      const codeChanged = this.isBackendCodeStale()
      if (config.ossBucket || config.ossAccessKeyId || config.ossAccessKeySecret) {
        logger.info('[meeting-asr] OSS config provided while running; restarting to pick up new credentials')
        await this.stop()
        // Fall through to the normal start path below.
      } else if (codeChanged) {
        logger.info(
          '[meeting-asr] python-backend sources changed (%s → %s); restarting to load the new code',
          this._backendCodeHash, currentHash,
        )
        await this.stop()
        // Fall through to the normal start path below.
      } else {
        try {
          await this.updateConfig(config)
          logger.info('[meeting-asr] Hot-pushed non-OSS config to running service')
          return
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          this._error = `config push failed: ${msg}`
          logger.error('[meeting-asr] %s', this._error)
          this.emit('error', err)
          // Surface the failure to the caller instead of silently dropping
          // the new config like v0.7.7 did — the user must know their
          // updated key did not take effect.
          throw err
        }
      }
    }

    this._config = config
    this._error = null
    this._startupPhase = 'venv'
    this.emit('phase', this._startupPhase)

    try {
      // Reset restart counter for a deliberate start.
      this._restartAttempts = 0
      this._autoRestart = true
      if (this._restartTimer) {
        clearTimeout(this._restartTimer)
        this._restartTimer = null
      }
      // Stop any leftover health monitor from a prior failed start.
      this._stopHealthMonitor()
      this._healthFailures = 0

      // Ensure data directory exists
      const dataDir = this.getDataDir()
      await fs.mkdir(dataDir, { recursive: true })

      // Get Python path
      const pythonPath = await this.ensureVirtualEnv()
      const backendPath = this.getPythonBackendPath()

      // Set ports. If the configured port is already taken — typically by an
      // orphaned uvicorn from a previous Node process (`detached:false`
      // children survive a parent exit) — walk forward to a free one. Without
      // this the new child fails to bind while `waitForReady` happily talks to
      // the orphan, which still runs the OLD code: that is how an
      // already-fixed bug keeps reproducing after a rebuild.
      const requestedAsrPort = config.asrPort || 8000
      const requestedDiarizePort = config.diarizePort || 8001
      this._asrPort = await pickFreePort(requestedAsrPort)
      this._diarizePort = await pickFreePort(requestedDiarizePort, new Set([this._asrPort]))
      if (this._asrPort !== requestedAsrPort) {
        logger.warn(
          '[meeting-asr] port %d is in use (orphaned backend?); serving ASR on %d instead',
          requestedAsrPort, this._asrPort,
        )
      }
      if (this._diarizePort !== requestedDiarizePort) {
        logger.warn(
          '[meeting-asr] port %d is in use (orphaned backend?); serving diarize on %d instead',
          requestedDiarizePort, this._diarizePort,
        )
      }

      // Build environment variables
      const env: Record<string, string> = {
        ...process.env,
        DATA_DIR: dataDir,
        BACKEND_HOST: config.host || '0.0.0.0',
        BACKEND_PORT: String(this._asrPort),
        DIARIZE_PORT: String(this._diarizePort),
        CORS_ORIGIN: `http://localhost:${process.env.PORT || 6060}`,
      }

      // Stamp the sources this child is about to load. /healthz echoes it and
      // the client compares it with `status.codeHash` to spot a stale process.
      const codeHash = this.computeBackendCodeHash()
      if (codeHash) {
        env.MEETING_ASR_CODE_HASH = codeHash
        this._backendCodeHash = codeHash
      }

      if (config.dashscopeApiKey) {
        env.DASHSCOPE_API_KEY = config.dashscopeApiKey
      } else {
        // Auto-restart fallback: the caller (UI or auto-restart) didn't
        // provide a key inline, so recover it from persistent storage:
        //   - config.json / config.env  (meeting ASR wizard writes these)
        //   - 「设置 → 模型 → Realtime 模型」的 key (SQLite realtime_profile_settings)
        //   - process env DASHSCOPE_API_KEY
        // The third source was added after the 2026-10-11 device incident: the
        // Qt client only opens /ws/omni-realtime (unlike the browser, which
        // pushes the key inline), so a device whose user had only filled the
        // Realtime panel started the backend with an empty key and realtime
        // failed with "DASHSCOPE_API_KEY is not configured".
        // See dashscope-key-store.resolveDashScopeKey() for the ordering rationale.
        try {
          const key = await dashscopeKeyStore.resolveDashScopeKey(dataDir)
          if (key) env.DASHSCOPE_API_KEY = key
        } catch { /* best effort */ }
      }
      // MiniMax provider config — passed through to Python via env so
      // `config.py` can read it at import time. Only honoured when
      // `asrProvider === 'minimax'`; for DashScope the Python ASR proxy
      // continues to use DASHSCOPE_API_KEY untouched.
      if (config.minimaxApiKey) env.MINIMAX_API_KEY = config.minimaxApiKey
      if (config.minimaxAsrModel) env.MINIMAX_ASR_MODEL = config.minimaxAsrModel
      if (config.minimaxBaseUrl) env.MINIMAX_BASE_URL = config.minimaxBaseUrl
      if (config.minimaxLanguage) env.MINIMAX_LANGUAGE = config.minimaxLanguage
      if (config.minimaxAudioFormat) env.MINIMAX_AUDIO_FORMAT = config.minimaxAudioFormat
      if (config.minimaxSampleRate) env.MINIMAX_SAMPLE_RATE = String(config.minimaxSampleRate)
      if (config.minimaxChunkSeconds) env.MINIMAX_CHUNK_SECONDS = String(config.minimaxChunkSeconds)
      // `asrProvider` defaults to 'dashscope' on the Python side, so we
      // only export it when explicitly non-default to keep env diffs
      // narrow for ops that grep the spawned process env.
      if (config.asrProvider === 'minimax') env.ASR_PROVIDER = 'minimax'
      if (config.asrModel) {
        env.ASR_MODEL = config.asrModel
      }
      if (config.paraformerWsUrl) {
        env.PARAFORMER_WS_URL = config.paraformerWsUrl
      }
      if (config.paraformerModel) {
        env.PARAFORMER_MODEL = config.paraformerModel
      }
      if (config.paraformerSampleRate) {
        env.PARAFORMER_SAMPLE_RATE = String(config.paraformerSampleRate)
      }
      if (config.paraformerFormat) {
        env.PARAFORMER_FORMAT = config.paraformerFormat
      }
      if (config.paraformerLanguageHints) {
        env.PARAFORMER_LANGUAGE_HINTS = config.paraformerLanguageHints
      }
      if (config.paraformerSemanticPunctuation !== undefined) {
        env.PARAFORMER_SEMANTIC_PUNCTUATION = String(config.paraformerSemanticPunctuation)
      }
      // OSS config for diarize OSS-based chunk flow (speaker diarization)
      if (config.ossBucket) {
        env.OSS_BUCKET = config.ossBucket
      }
      if (config.ossAccessKeyId) {
        env.OSS_ACCESS_KEY_ID = config.ossAccessKeyId
      }
      if (config.ossAccessKeySecret) {
        env.OSS_ACCESS_KEY_SECRET = config.ossAccessKeySecret
      }
      if (config.ossEndpoint) {
        env.OSS_ENDPOINT = config.ossEndpoint
      }
      if (config.ossPathPrefix) {
        env.OSS_PATH_PREFIX = config.ossPathPrefix
      }
      if (config.llmApiKey) {
        // LLM config is stored in the data dir config.json
        // We'll write it after starting
      }

      // Start main ASR process
      this._startupPhase = 'starting'
      this.emit('phase', this._startupPhase)
      logger.info('[meeting-asr] Starting main ASR service on port %d...', this._asrPort)
      const mainUvicornArgs = [
        '-m', 'uvicorn', 'app.main:app', '--host', '0.0.0.0', '--port', String(this._asrPort),
        ...this._uvicornTlsArgs(),
      ]
      this._mainLogTail = []
      this.mainProcess = spawn(pythonPath, mainUvicornArgs, {
        cwd: backendPath,
        env,
        stdio: 'pipe',
        detached: false,
      })

      this.mainProcess.stdout?.on('data', (data) => {
        this._recordMainLog(data)
        logger.debug('[meeting-asr:main] %s', data.toString().trim())
      })

      this.mainProcess.stderr?.on('data', (data) => {
        this._recordMainLog(data)
        logger.debug('[meeting-asr:main] %s', data.toString().trim())
      })

      this.mainProcess.on('error', (err) => {
        logger.error('[meeting-asr] Main process error: %s', err.message)
        this._error = err.message
        this.emit('error', err)
      })

      this.mainProcess.on('close', (code) => {
        logger.info('[meeting-asr] Main process exited with code %d', code ?? 0)
        this._isRunning = false
        this._stopHealthMonitor()
        this.emit('stopped', code ?? 0)
        // Auto-restart on unexpected crash, unless explicitly stopped.
        if (this._autoRestart && (code ?? 0) !== 0) {
          // The tail is the only place the reason survives (Python traceback /
          // OOM kill). It is surfaced through status.error → the 503 body the
          // UI logs, so "Service Unavailable" becomes diagnosable.
          const tail = this._mainLogTail.slice(-MeetingASRService.LOG_TAIL_LINES).join(' | ')
          const reason = `main process exited unexpectedly (code ${code})${tail ? `: ${tail.slice(-800)}` : ''}`
          this._error = reason
          logger.error('[meeting-asr] %s', reason)
          this._scheduleRestart(reason)
        }
      })

      // Start diarize process
      logger.info('[meeting-asr] Starting diarize service on port %d...', this._diarizePort)
      const diarizeUvicornArgs = [
        '-m', 'uvicorn', 'app.diarize_server:app', '--host', '0.0.0.0', '--port', String(this._diarizePort),
        ...this._uvicornTlsArgs(),
      ]
      this.diarizeProcess = spawn(pythonPath, diarizeUvicornArgs, {
        cwd: backendPath,
        env,
        stdio: 'pipe',
        detached: false,
      })

      this.diarizeProcess.stdout?.on('data', (data) => {
        logger.info('[meeting-asr:diarize:out] %s', data.toString().trim())
      })

      this.diarizeProcess.stderr?.on('data', (data) => {
        logger.info('[meeting-asr:diarize:err] %s', data.toString().trim())
      })

      this.diarizeProcess.on('error', (err) => {
        logger.error('[meeting-asr] Diarize process error: %s', err.message)
      })

      this.diarizeProcess.on('close', (code) => {
        logger.info('[meeting-asr] Diarize process exited with code %d', code ?? 0)
      })

      // Wait for services to be ready
      await this.waitForReady()

      this._isRunning = true
      this._startTime = Date.now()
      this._startupPhase = 'ready'
      this.emit('phase', this._startupPhase)

      // Write LLM config if provided
      if (config.llmApiKey || config.llmBaseUrl || config.llmModel) {
        await this.updateLLMConfig(config)
      }

      // Begin background health monitor — recovers from silent OOM kills
      // by recycling through the existing _scheduleRestart pipeline.
      this._startHealthMonitor()

      logger.info('[meeting-asr] Services started successfully')
      this.emit('started')

    } catch (err) {
      this._error = err instanceof Error ? err.message : String(err)
      this._startupPhase = 'error'
      this.emit('phase', this._startupPhase)
      logger.error('[meeting-asr] Failed to start services: %s', this._error)
      await this.stop()
      throw err
    }
  }

  private async waitForReady(timeout = 60000): Promise<void> {
    // Poll main (:8000) and diarize (:8001) healthz in parallel. Both must be
    // healthy before we declare the service ready — silence on diarize means
    // user-side speaker-diarization will silently hang without diagnostics.
    //
    // When the backend is HTTPS, Node's native fetch rejects the self-signed
    // cert, so we route through `node:https` with rejectUnauthorized:false.
    const startTime = Date.now()
    let mainOk = false
    let diarizeOk = false
    let mainLastErr = ''
    let diarizeLastErr = ''

    while (Date.now() - startTime < timeout) {
      if (!mainOk && this._asrPort) {
        const r = await this.probeHealthz(this._asrPort)
        if (r.ok) {
          mainOk = true
          logger.info('[meeting-asr] Main service is ready on :%d', this._asrPort)
        } else {
          mainLastErr = r.err || `main healthz status ${r.status}`
        }
      }

      if (!diarizeOk && this._diarizePort) {
        const r = await this.probeHealthz(this._diarizePort)
        if (r.ok) {
          diarizeOk = true
          logger.info('[meeting-asr] Diarize service is ready on :%d', this._diarizePort)
        } else {
          diarizeLastErr = r.err || `diarize healthz status ${r.status}`
        }
      }

      if (mainOk && diarizeOk) return

      // Bail early if either process died unexpectedly
      if (this.mainProcess?.exitCode !== null && this.mainProcess?.exitCode !== undefined) {
        throw new Error(
          `Main ASR process exited with code ${this.mainProcess.exitCode} during startup. ` +
            `Check journald logs for traceback.`,
        )
      }

      await new Promise((resolve) => setTimeout(resolve, 1000))
    }

    const missing = [
      mainOk ? null : `main(:${this._asrPort}): ${mainLastErr || 'no response'}`,
      diarizeOk ? null : `diarize(:${this._diarizePort}): ${diarizeLastErr || 'no response'}`,
    ]
      .filter(Boolean)
      .join('; ')
    throw new Error(
      `Timeout waiting for ASR services to be ready after ${timeout}ms. Not ready: ${missing}.`,
    )
  }

  /**
   * Single-port healthz probe. Matches the protocol chosen for uvicorn:
   *   - dev (useTls=false) → plain http://
   *   - device (useTls=true) → https:// with rejectUnauthorized:false because
   *     the cert is the shared self-signed one under packages/server/certs/
   *
   * Earlier this hard-coded `http://` and assumed Node terminates TLS
   * externally — true for the WS upgrade path, but not when uvicorn itself
   * was spawned with --ssl-certfile (which is what `_useTls=true` implies).
   */
  private async probeHealthz(
    port: number,
    timeoutMs = 2000,
  ): Promise<{ ok: boolean; status?: number; err?: string }> {
    try {
      const response = await this.backendRequest(port, '/healthz', 'GET', undefined, timeoutMs)
      return { ok: response.status >= 200 && response.status < 300, status: response.status }
    } catch (err) {
      return { ok: false, err: err instanceof Error ? err.message : String(err) }
    }
  }

  /**
   * Request against the local Python backend over the protocol it was spawned
   * with. `node:http(s)` — not `fetch` — because undici's `dispatcher` option
   * rejects a `node:https.Agent` with `agent.dispatch is not a function`, which
   * silently broke every backend call on TLS device images.
   */
  private backendRequest(
    port: number,
    path: string,
    method: 'GET' | 'POST' = 'GET',
    body?: string,
    timeoutMs = 30_000,
  ): Promise<{ status: number; body: string }> {
    return new Promise((resolve, reject) => {
      const transport = this._useTls ? https : http
      const req = transport.request(
        {
          host: '127.0.0.1',
          port,
          path,
          method,
          headers: body ? { 'Content-Type': 'application/json' } : {},
          timeout: timeoutMs,
          ...(this._useTls ? { rejectUnauthorized: false } : {}),
        },
        (res) => {
          const chunks: Buffer[] = []
          res.on('data', (chunk: Buffer) => chunks.push(chunk))
          res.on('end', () => resolve({
            status: res.statusCode || 502,
            body: Buffer.concat(chunks).toString('utf-8'),
          }))
        },
      )
      req.on('timeout', () => req.destroy(new Error(`backend request timed out after ${timeoutMs}ms`)))
      req.on('error', reject)
      if (body !== undefined) req.write(body)
      req.end()
    })
  }

  /**
   * Send SIGTERM to a process, wait up to `graceMs` for graceful exit,
   * then SIGKILL if still alive. Resolves to the eventual exit code.
   */
  private killGraceful(proc: ChildProcess | null, graceMs = 5000): Promise<number | null> {
    return new Promise((resolve) => {
      if (!proc || proc.exitCode !== null || proc.signalCode !== null) {
        resolve(proc?.exitCode ?? null)
        return
      }
      const onExit = (code: number | null) => {
        clearTimeout(timer)
        resolve(code)
      }
      const timer = setTimeout(() => {
        if (proc.exitCode === null && proc.signalCode === null) {
          logger.warn('[meeting-asr] Process did not exit within %dms; sending SIGKILL', graceMs)
          try {
            proc.kill('SIGKILL')
          } catch {
            /* already gone */
          }
        }
      }, graceMs)
      proc.once('exit', onExit)
      try {
        proc.kill('SIGTERM')
      } catch {
        clearTimeout(timer)
        resolve(proc.exitCode ?? null)
      }
    })
  }

  async stop(): Promise<void> {
    if (!this._isRunning && !this.mainProcess && !this.diarizeProcess) {
      return
    }

    logger.info('[meeting-asr] Stopping services...')

    // Disable auto-restart while we shut down deliberately.
    this._autoRestart = false
    this._stopHealthMonitor()

    // Stop diarize and main in parallel, each with SIGTERM → SIGKILL fallback.
    const stops = await Promise.all([
      this.diarizeProcess ? this.killGraceful(this.diarizeProcess) : Promise.resolve(null),
      this.mainProcess ? this.killGraceful(this.mainProcess) : Promise.resolve(null),
    ])

    this.diarizeProcess = null
    this.mainProcess = null
    this._isRunning = false
    this._startTime = null
    this._backendCodeHash = null
    this._asrPort = null
    this._diarizePort = null
    this._startupPhase = 'idle'
    this.emit('phase', this._startupPhase)

    logger.info('[meeting-asr] Services stopped (main=%s diarize=%s)', stops[1], stops[0])
    this.emit('stopped', 0)
  }

  /**
   * Begin polling both healthz endpoints at a fixed interval. After
   * HEALTH_FAILURES_BEFORE_RESTART consecutive failures we recycle through
   * the same _scheduleRestart path used for unexpected crashes, so recovery
   * is bounded and observable via status.error.
   */
  private _startHealthMonitor(): void {
    if (this._healthTimer) return
    this._healthTimer = setInterval(() => {
      this._probeHealthBoth()
        .then((ok) => {
          if (ok) {
            this._healthFailures = 0
            return
          }
          this._healthFailures += 1
          logger.warn(
            '[meeting-asr] health probe failed %d/%d',
            this._healthFailures,
            MeetingASRService.HEALTH_FAILURES_BEFORE_RESTART,
          )
          if (this._healthFailures >= MeetingASRService.HEALTH_FAILURES_BEFORE_RESTART) {
            this._healthFailures = 0
            this._scheduleRestart('health monitor: repeated healthz failures')
          }
        })
        .catch((err) => {
          logger.error('[meeting-asr] health probe threw: %s', err?.message || err)
        })
    }, MeetingASRService.HEALTH_PROBE_INTERVAL_MS)
  }

  private _stopHealthMonitor(): void {
    if (this._healthTimer) {
      clearInterval(this._healthTimer)
      this._healthTimer = null
    }
    this._healthFailures = 0
  }

  /**
   * Probe main + diarize healthz concurrently. Returns true iff both report
   * a healthy response within the per-probe timeout. Either child dying or
   * a non-2xx response counts as failure.
   */
  private async _probeHealthBoth(): Promise<boolean> {
    if (!this._asrPort || !this._diarizePort) return false
    const results = await Promise.all([
      this.probeHealthz(this._asrPort, MeetingASRService.HEALTH_PROBE_TIMEOUT_MS),
      this.probeHealthz(this._diarizePort, MeetingASRService.HEALTH_PROBE_TIMEOUT_MS),
    ])
    return results.every((r) => r.ok)
  }

  /**
   * Schedule an auto-restart with exponential backoff. Bounded by
   * MAX_RESTART_ATTEMPTS — after that we give up and surface the failure
   * to the user via the status endpoint.
   */
  private _scheduleRestart(reason: string): void {
    if (this._restartAttempts >= MeetingASRService.MAX_RESTART_ATTEMPTS) {
      logger.error(
        '[meeting-asr] Auto-restart exhausted after %d attempts (reason: %s). User must restart manually.',
        this._restartAttempts,
        reason,
      )
      this._error = `auto-restart exhausted: ${reason}`
      this._autoRestart = false
      this.emit('crashed', this._error)
      return
    }
    const delay =
      MeetingASRService.RESTART_BACKOFF_MS[
        Math.min(this._restartAttempts, MeetingASRService.RESTART_BACKOFF_MS.length - 1)
      ]
    this._restartAttempts += 1
    logger.warn(
      '[meeting-asr] Auto-restart %d/%d scheduled in %dms (reason: %s)',
      this._restartAttempts,
      MeetingASRService.MAX_RESTART_ATTEMPTS,
      delay,
      reason,
    )
    this._restartTimer = setTimeout(() => {
      this._restartTimer = null
      this.start(this._config).catch((err) => {
        logger.error('[meeting-asr] Auto-restart failed: %s', err?.message || err)
        this._scheduleRestart(`restart attempt ${this._restartAttempts} failed`)
      })
    }, delay)
  }

  private async updateLLMConfig(config: MeetingASRConfig): Promise<void> {
    // Route through the Python backend's /api/config/llm endpoint instead of
    // writing config.json directly. Direct file writes bypassed Storage's
    // in-memory config AND its runtime Settings sync, so llm_service (which
    // reads storage.get_config()) kept serving the old key after an update —
    // the same class of desync that caused the v0.7.17
    // "DASHSCOPE_API_KEY is not configured" incident for ASR.
    try {
      const response = await this.backendRequest(
        this._asrPort!,
        '/api/config/llm',
        'POST',
        JSON.stringify({
          api_key: config.llmApiKey || '',
          base_url: config.llmBaseUrl || '',
          model: config.llmModel || '',
        }),
      )
      if (response.status < 200 || response.status >= 300) {
        throw new Error(`Python backend rejected LLM config: ${response.status}`)
      }
      logger.info('[meeting-asr] LLM config persisted via Python backend')
    } catch (err) {
      // Best-effort: a failed LLM push must not fail the whole ASR start.
      logger.error('[meeting-asr] Failed to update LLM config via backend: %s', err)
    }
  }

  async updateConfig(config: Partial<MeetingASRConfig>): Promise<void> {
    if (!this._isRunning) {
      throw new Error('ASR service is not running')
    }

    const body = JSON.stringify({
      asr: {
        dashscope_api_key: config.dashscopeApiKey,
        paraformer_ws_url: config.paraformerWsUrl,
        paraformer_model: config.paraformerModel,
        paraformer_sample_rate: config.paraformerSampleRate,
        paraformer_format: config.paraformerFormat,
        paraformer_language_hints: config.paraformerLanguageHints,
        paraformer_semantic_punctuation: config.paraformerSemanticPunctuation,
        // MiniMax credentials are provider-independent: the whole-file
        // transcription dialog lets the user pick either engine regardless of
        // the session's provider, so any known key is pushed. The Python
        // `Settings.sync_from()` only overwrites these when truthy, so an
        // omitted field keeps the previous value.
        minimax_api_key: config.minimaxApiKey,
        minimax_asr_model: config.minimaxAsrModel,
        minimax_base_url: config.minimaxBaseUrl,
      },
      llm: {
        api_key: config.llmApiKey,
        base_url: config.llmBaseUrl,
        model: config.llmModel,
      },
    })

    try {
      const response = await this.backendRequest(this._asrPort!, '/api/config', 'POST', body)
      if (response.status < 200 || response.status >= 300) {
        throw new Error(`Failed to update config: HTTP ${response.status}`)
      }
    } catch (err) {
      logger.error('[meeting-asr] Failed to update config: %s', err)
      throw err
    }
  }

  getASRPort(): number | null {
    return this._asrPort
  }

  getDiarizePort(): number | null {
    return this._diarizePort
  }
}

export const meetingASRService = MeetingASRService.getInstance()

/**
 * True when nothing is listening on `port` (probed on 0.0.0.0 to match the
 * `--host 0.0.0.0` uvicorn bind). Exported for tests.
 */
export function checkPortAvailable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = createNetServer()
    let settled = false
    const finish = (ok: boolean) => {
      if (settled) return
      settled = true
      resolve(ok)
    }
    srv.once('error', () => finish(false))
    srv.once('listening', () => srv.close(() => finish(true)))
    srv.listen(port, '0.0.0.0')
  })
}

/**
 * First free port at or after `base` (skipping `avoid`), scanning a bounded
 * window. Exported for tests.
 */
export async function pickFreePort(base: number, avoid: Set<number> = new Set(), attempts = 50): Promise<number> {
  for (let port = base; port < base + attempts; port++) {
    if (avoid.has(port)) continue
    if (await checkPortAvailable(port)) return port
  }
  throw new Error(`no free TCP port found in [${base}, ${base + attempts})`)
}
