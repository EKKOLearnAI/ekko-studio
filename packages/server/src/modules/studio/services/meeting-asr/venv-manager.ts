import { spawn, type ChildProcess } from 'child_process'
import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import { logger } from '../../public/logging'

/**
 * Python venv 生命周期（拆分自 meeting-asr/index.ts，行为保持一致）。
 *
 * 职责：venv 路径解析、venv 创建/迁移/复用（marker 快路径）、依赖安装。
 * 服务层（index.ts）保留同名委托方法作为稳定 API，并注入 phase 回调。
 *
 * 红线（meeting-asr-safety-audit.md）：venv 创建命令序列与 marker 语义
 * 不得改变；venv 永远落在 dataDir/.venv，绝不写进 python-backend/。
 */

/** venv 安装阶段回调（'venv' = 创建中，'pip_install' = 装依赖中）。 */
export type VenvPhase = 'venv' | 'pip_install'

export interface EnsureVirtualEnvOptions {
  /** python-backend 目录（部署树内，venv 绝不落在这里） */
  backendPath: string
  /** 持久化数据目录（venv 的宿主） */
  dataDir: string
  /** requirements.txt 的绝对路径 */
  requirementsPath: string
  /** 启动阶段回调，服务层转发给 UI */
  onPhase?: (phase: VenvPhase) => void
}

/**
 * Resolve where the Python virtual environment should live.
 *
 * The venv must NOT sit under `python-backend/` because that directory is
 * part of the deployed bundle (`dist/server/services/meeting-asr/python-backend/`)
 * and is owned by the deploy user. If the runtime service runs as a
 * different (non-root) user it cannot write into the venv directory and
 * the first `start` call fails with EACCES — see incident at
 * `docs/planning/meeting-mode-rk3528-audit.md` #1 and #5.
 *
 * We co-locate the venv with the rest of the meeting-asr persistent state
 * under `dataDir/.venv/`. The data directory is owned by the runtime user
 * (`WorkingDirectory={{DEPLOY_DIR}}` in systemd + mkdir at bootstrap) and
 * survives device-package upgrades because it's outside the dist tree.
 *
 * `pythonBackendPath` is kept as an argument so the same helper is callable
 * from tests with arbitrary tmp paths and so future overrides (env var,
 * per-profile data dirs) can be added without churning call sites.
 */
export function resolveVenvPath(dataDir: string, _pythonBackendPath: string): string {
  return path.join(dataDir, '.venv')
}

export function resolveVenvMarkerPath(venvPath: string): string {
  return path.join(venvPath, '.hermes-ready')
}

export function getVenvPythonPath(venvPath: string): string {
  return os.platform() === 'win32'
    ? path.join(venvPath, 'Scripts', 'python.exe')
    : path.join(venvPath, 'bin', 'python')
}

export async function findPython(): Promise<string> {
  const candidates = os.platform() === 'win32'
    ? ['python', 'python3', 'py -3', 'py']
    : ['python3', 'python']

  for (const cmd of candidates) {
    try {
      await new Promise<void>((resolve, reject) => {
        const proc = spawn(cmd, ['--version'], { stdio: 'pipe' })
        proc.on('close', (code) => {
          if (code === 0) resolve()
          else reject(new Error(`exit code ${code}`))
        })
        proc.on('error', reject)
      })
      return cmd
    } catch {
      continue
    }
  }
  throw new Error('Python not found. Please install Python 3.')
}

/**
 * Run a child process to completion, capturing stderr so we can surface
 * actionable errors instead of opaque exit codes.
 */
export function runCaptured(
  cmd: string,
  args: string[],
  cwd: string,
  timeoutMs = 15 * 60 * 1000,
): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolve, reject) => {
    let stderr = ''
    let proc: ChildProcess
    try {
      proc = spawn(cmd, args, { cwd, stdio: 'pipe' })
    } catch (err) {
      reject(err)
      return
    }
    proc.stderr?.on('data', (d) => {
      stderr += d.toString()
      // Cap memory: only keep the last 64KB of stderr
      if (stderr.length > 64 * 1024) {
        stderr = stderr.slice(-64 * 1024)
      }
    })
    const timer = setTimeout(() => {
      proc.kill('SIGKILL')
      reject(new Error(`Process ${cmd} ${args.join(' ')} timed out after ${timeoutMs}ms`))
    }, timeoutMs)
    proc.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code, stderr })
    })
    proc.on('error', (err) => {
      clearTimeout(timer)
      reject(err)
    })
  })
}

/**
 * 确保 dataDir/.venv 存在且依赖装好，返回 venv python 的绝对路径。
 * 顺序：快路径（marker + probe）→ 旧位置迁移（v0.7.16+）→ 全新创建 + pip install。
 */
export async function ensureVirtualEnv(opts: EnsureVirtualEnvOptions): Promise<string> {
  const { backendPath } = opts
  const venvPath = resolveVenvPath(opts.dataDir, backendPath)
  const pythonPath = getVenvPythonPath(venvPath)
  // Marker file written after a successful pip install — lets us skip the
  // ~3-10 minute install on ARM64 after the first successful run. Treated
  // as a hint, not a hard guarantee: the probe below still verifies that
  // the binary actually executes.
  const markerPath = resolveVenvMarkerPath(venvPath)
  const onPhase = opts.onPhase ?? (() => {})

  const probePython = async (): Promise<void> => {
    await new Promise<void>((resolve, reject) => {
      const probe = spawn(pythonPath, ['-c', 'import sys; sys.exit(0)'], { stdio: 'pipe' })
      probe.on('close', (code) => {
        if (code === 0) resolve()
        else reject(new Error(`venv python exited ${code}`))
      })
      probe.on('error', reject)
    })
  }

  // Fast path: marker present + python executable + probe passes → reuse.
  try {
    await fs.access(pythonPath)
    await fs.access(markerPath)
    onPhase('venv')
    await probePython()
    logger.info('[meeting-asr] Reusing existing Python virtual environment at %s', venvPath)
    return pythonPath
  } catch {
    // fall through to slow path
  }

  // Migration path (v0.7.16+): if the legacy venv at
  // `<pythonBackend>/.venv` exists and is probe-healthy, move it to the
  // new data-dir location atomically. This preserves the multi-minute
  // `pip install` work already done on the device and keeps the
  // "start → ready in seconds" UX contract. Without this, every upgrade
  // would trigger a fresh 5-10 min pip install on ARM64.
  const legacyVenvPath = path.join(backendPath, '.venv')
  const legacyPythonPath = getVenvPythonPath(legacyVenvPath)
  try {
    await fs.access(legacyPythonPath)
    // Legacy venv exists — verify it actually works before moving it,
    // so we don't relocate a broken venv and then trust it.
    await new Promise<void>((resolve, reject) => {
      const probe = spawn(legacyPythonPath, ['-c', 'import sys; sys.exit(0)'], { stdio: 'pipe' })
      probe.on('close', (code) => {
        if (code === 0) resolve()
        else reject(new Error(`legacy venv python exited ${code}`))
      })
      probe.on('error', reject)
    })
    // Legacy venv is healthy. Move it. fs.rename is atomic on the same
    // filesystem; if cross-device (unlikely for /opt → /var/lib on the
    // same root partition) it falls back to copy + remove below.
    await fs.mkdir(path.dirname(venvPath), { recursive: true })
    try {
      await fs.rename(legacyVenvPath, venvPath)
    } catch (renameErr) {
      // Cross-device rename: fall back to recursive copy then remove.
      // Node fs.cp is available on Node 16.7+; we use it explicitly so
      // the failure mode is observable instead of silent.
      logger.warn(
        '[meeting-asr] fs.rename failed (%s); falling back to recursive copy',
        renameErr instanceof Error ? renameErr.message : String(renameErr),
      )
      await fs.cp(legacyVenvPath, venvPath, { recursive: true, force: true })
      await fs.rm(legacyVenvPath, { recursive: true, force: true })
    }
    // Re-link the venv's absolute python path if the venv was created
    // with absolute symlinks. Most venvs use relative symlinks so a move
    // is safe; if the probe below fails, the slow path recreates.
    try {
      await probePython()
      // Move succeeded and the relocated venv probes clean — write the
      // marker so the next start hits the fast path.
      try {
        await fs.writeFile(markerPath, new Date().toISOString(), 'utf-8')
      } catch (err) {
        logger.warn('[meeting-asr] Could not write venv marker %s: %s', markerPath, err)
      }
      logger.info(
        '[meeting-asr] Migrated legacy venv %s -> %s (fast path preserved)',
        legacyVenvPath,
        venvPath,
      )
      return pythonPath
    } catch (probeErr) {
      logger.warn(
        '[meeting-asr] Migrated venv failed probe (%s); proceeding to recreate',
        probeErr instanceof Error ? probeErr.message : String(probeErr),
      )
      // Remove the broken relocated venv so createVenv starts clean.
      await fs.rm(venvPath, { recursive: true, force: true })
    }
  } catch {
    // Legacy venv absent or broken — proceed to fresh creation below.
  }

  // Slow path: venv missing, broken, or marker absent — recreate + install.
  const createVenv = async (): Promise<void> => {
    onPhase('venv')
    logger.info('[meeting-asr] Creating Python virtual environment at %s', venvPath)
    const pythonCmd = await findPython()
    const createStderr = await runCaptured(pythonCmd, ['-m', 'venv', venvPath], backendPath)
    if (createStderr.code !== 0) {
      const hint = createStderr.stderr.includes('ensurepip')
        ? ' On Debian/Ubuntu/Armbian, ensure python3-venv is installed: apt-get install -y python3-venv python3-dev'
        : ''
      throw new Error(
        `Failed to create Python venv (exit ${createStderr.code}): ${createStderr.stderr.trim() || 'no stderr'}.${hint}`,
      )
    }
  }

  try {
    await fs.access(pythonPath)
  } catch {
    await createVenv()
  }

  // Guard against a partial venv left behind by an interrupted creation:
  // the venv python exists but pip is missing (e.g. the service was
  // restarted mid-`python -m venv`). Proceeding straight to `pip install`
  // would loop on "No module named pip" forever, so wipe and recreate.
  const pipProbe = await runCaptured(pythonPath, ['-m', 'pip', '--version'], backendPath, 60_000)
  if (pipProbe.code !== 0) {
    logger.warn(
      '[meeting-asr] venv python exists but pip is missing (%s); recreating venv',
      pipProbe.stderr.trim().slice(-200) || `exit ${pipProbe.code}`,
    )
    await fs.rm(venvPath, { recursive: true, force: true })
    await createVenv()
  }

  // Install requirements. May take 5-10 minutes on ARM64 — surface phase so
  // the UI can show "installing dependencies (~3 min)…" instead of "connecting".
  onPhase('pip_install')
  logger.info('[meeting-asr] Installing Python dependencies (this may take several minutes on ARM64)...')
  const installStderr = await runCaptured(
    pythonPath,
    ['-m', 'pip', 'install', '--disable-pip-version-check', '-r', opts.requirementsPath],
    backendPath,
  )
  if (installStderr.code !== 0) {
    throw new Error(
      `Failed to install Python dependencies (exit ${installStderr.code}): ` +
        `${installStderr.stderr.trim().slice(-500) || 'no stderr'}. ` +
        `Verify the device has network access to PyPI.`,
    )
  }

  // Write the marker so subsequent starts can take the fast path.
  try {
    await fs.writeFile(markerPath, new Date().toISOString(), 'utf-8')
  } catch (err) {
    logger.warn('[meeting-asr] Could not write venv marker %s: %s', markerPath, err)
  }

  return pythonPath
}
