import { execFile } from 'child_process'
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'fs'
import { dirname, join, resolve } from 'path'
import { promisify } from 'util'
import { getDeployDir, getWebUiHome } from '../../../public/config'
import { getHermesUpdateHome } from '../runtime-dependencies'
import { UpdateError } from '../errors'
import type { UpdateConfig } from '../types'

export function getNpmPackageExecutionMessage(): string {
  return 'Update source is not fully configured. Set WEBUI_UPDATE_PACKAGE, WEBUI_UPDATE_REGISTRY, and WEBUI_UPDATE_CLI_BIN.'
}

export function assertNpmPackageExecution(update: UpdateConfig): void {
  if (!update.packageName || !update.registry || !update.cliBin) {
    throw new UpdateError('update_execution_misconfigured', getNpmPackageExecutionMessage())
  }
}

export function buildNpmPackageInstallArgs(update: UpdateConfig, versionOrTag: string): string[] {
  return [
    'install',
    '-g',
    `${update.packageName}@${versionOrTag}`,
    '--registry',
    update.registry,
    '--ignore-scripts',
    '--no-audit',
    '--no-fund',
  ]
}

/**
 * npm 全局安装（npm install -g）替换旧包时会把现有包目录改名为
 * `.{名字}-{随机}` 备份再装新版；若上次失败留下非空的备份目录，下一次
 * rename 会因目标非空而报 ENOTEMPTY（npm 10 已知问题）。这里收集需要
 * 清理的备份前缀：包名（去 scope）、CLI 名，以及已装包 package.json 里
 * 声明的 bin 名（如 hermes-web-ui、hermes-web-ui-mcp、hermes-studio-mcp）。
 */
export function collectNpmPackageBackupPrefixes(globalRoot: string, packageName: string, cliBin: string): string[] {
  const prefixes = new Set<string>()
  const base = packageName.includes('/') ? packageName.split('/').pop() || '' : packageName
  if (base.trim()) prefixes.add(base.trim())
  const cliBase = cliBin.replace(/\.(mjs|js|cjs)$/, '').trim()
  if (cliBase) prefixes.add(cliBase)

  const segments = packageName.startsWith('@') ? packageName.split('/') : [packageName]
  const pkgJsonPath = join(globalRoot, ...segments, 'package.json')
  try {
    if (existsSync(pkgJsonPath)) {
      const pkg = JSON.parse(readFileSync(pkgJsonPath, 'utf-8')) as { bin?: string | Record<string, string> }
      if (pkg.bin) {
        const names = typeof pkg.bin === 'string' ? [segments[segments.length - 1]] : Object.keys(pkg.bin)
        for (const name of names) {
          const trimmed = String(name).trim()
          if (trimmed) prefixes.add(trimmed)
        }
      }
    }
  } catch {
    // best-effort: 读不到已装包的 bin 声明也不影响清理主包备份
  }
  return Array.from(prefixes)
}

/**
 * 删除 npm 全局目录里上次失败留下的 `.{名字}-{随机}` 备份目录，避免下一次
 * `npm install -g` 的 rename 因目标非空而报 ENOTEMPTY。清理范围：包所在
 * 的 scope 目录（lib/node_modules/@scope 或 lib/node_modules）与全局 bin
 * 目录（Linux lib/node_modules 的兄弟 bin/，Windows 为前缀根目录）。
 * best-effort：单个目录清理失败不影响其余清理。
 */
export function cleanupStaleNpmPackageBackupDirs(globalRoot: string, packageName: string, cliBin: string): number {
  const prefixes = collectNpmPackageBackupPrefixes(globalRoot, packageName, cliBin)
  if (prefixes.length === 0) return 0

  const scope = packageName.startsWith('@') ? packageName.split('/')[0] : ''
  const scopeDir = scope ? join(globalRoot, scope) : globalRoot
  const globalBinDir = process.platform === 'win32'
    ? dirname(globalRoot)
    : join(dirname(globalRoot), 'bin')

  let removed = 0
  for (const directory of new Set([scopeDir, globalBinDir].filter(dir => existsSync(dir)))) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (!prefixes.some(prefix => entry.name.startsWith(`.${prefix}-`))) continue
      try {
        rmSync(join(directory, entry.name), { recursive: true, force: true })
        removed += 1
      } catch {
        // best-effort: 单个残留清理失败不阻断更新
      }
    }
  }
  return removed
}

/**
 * npm-package 更新通过 `npm install -g` 整体替换包目录，运行时生成在包目录
 * certs/ 下的 TLS 证书会随之被删除，导致更新后 HTTPS 回退为 HTTP。
 * 更新完成后把稳定位置的证书（部署目录或 Web UI 状态目录）恢复到新包目录，
 * 与 bootstrap 阶段的证书检测路径（resolve(__dirname, '../../certs')）保持一致，
 * 让升级后 HTTPS 无缝续用。
 */
export function restoreTlsCertificatesAfterNpmUpdate(targetCertsDir = resolve(__dirname, '../../certs')): void {
  const targetCerts = targetCertsDir
  if (existsSync(join(targetCerts, 'server.crt')) && existsSync(join(targetCerts, 'server.key'))) {
    return
  }
  const candidates = [
    join(getDeployDir(), 'certs'),
    join(getWebUiHome(), 'certs'),
  ]
  for (const source of candidates) {
    const crt = join(source, 'server.crt')
    const key = join(source, 'server.key')
    if (!existsSync(crt) || !existsSync(key)) continue
    try {
      mkdirSync(targetCerts, { recursive: true })
      cpSync(crt, join(targetCerts, 'server.crt'))
      cpSync(key, join(targetCerts, 'server.key'))
      console.log(`[update] restored TLS certificates from ${source} to ${targetCerts}`)
      return
    } catch (err) {
      console.warn(`[update] failed to restore TLS certificates from ${source}:`, err)
    }
  }
  console.warn('[update] no stable TLS certificates found; HTTPS may fall back to HTTP after update')
}

const execFileAsync = promisify(execFile)

/** Locate the Python interpreter of the Hermes Agent venv for the current install. */
export function resolveHermesAgentVenvPython(hermesHome = getHermesUpdateHome()): string | undefined {
  const candidates = process.platform === 'win32'
    ? [
        join(hermesHome, 'hermes-agent-venv', 'Scripts', 'python.exe'),
        join(hermesHome, 'hermes-agent-venv', 'Scripts', 'python3.exe'),
      ]
    : [
        join(hermesHome, 'hermes-agent-venv', 'bin', 'python3'),
        join(hermesHome, 'hermes-agent-venv', 'bin', 'python'),
      ]
  return candidates.find(candidate => existsSync(candidate))
}

/**
 * npm-package 更新只替换 Web UI 本体，Hermes Agent 是一个独立 Python 包。
 * 为了让 npm 用户也能在升级 Web UI 时顺带升级 Hermes Agent（修复上游 wheel
 * 缺陷等），这里把 Hermes Agent venv 的 pip 升级到最新 stable 版本。
 *
 * 这是 best-effort 行为：失败只记告警日志，绝不阻断 Web UI 更新本身。
 * 设备端如有 source-deploy 部署脚本，则由其 agent-only 模式承担更完整的
 * 权限与依赖处理；npm 用户大多没有该脚本，直接用 venv pip 是最稳妥的等价操作。
 */
export async function upgradeHermesAgentAfterNpmUpdate(): Promise<void> {
  const hermesHome = getHermesUpdateHome()
  const venvPython = resolveHermesAgentVenvPython(hermesHome)
  if (!venvPython) {
    console.warn('[update] Hermes Agent venv not found under %s; skipping agent upgrade', hermesHome)
    return
  }
  const startedAt = Date.now()
  try {
    const { stdout, stderr } = await execFileAsync(
      venvPython,
      ['-m', 'pip', 'install', '--upgrade', 'hermes-agent'],
      { timeout: 10 * 60 * 1000, maxBuffer: 8 * 1024 * 1024 },
    )
    console.log('[update] Hermes Agent upgraded via %s in %dms', venvPython, Date.now() - startedAt)
    if (stderr?.trim()) {
      console.warn('[update] hermes-agent pip stderr (upgrade continued):\n%s', stderr.trim().slice(0, 2000))
    }
    if (stdout?.trim()) {
      console.log('[update] hermes-agent pip stdout:\n%s', stdout.trim().slice(0, 1000))
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.warn('[update] failed to upgrade Hermes Agent (web UI update continues): %s', message)
  }
}
