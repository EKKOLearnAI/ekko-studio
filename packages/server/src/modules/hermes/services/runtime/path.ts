/**
 * Hermes 路径检测工具 - 跨平台兼容
 *
 * Hermes 数据目录在所有平台上的默认位置：~/.hermes
 * - 用户自定义: HERMES_HOME 环境变量
 */

import { realpath } from 'fs/promises'
import { basename, dirname, isAbsolute, relative, resolve, join, win32 as pathWin32 } from 'path'
import { homedir } from 'os'

/**
 * 获取 Hermes 数据目录
 *
 * 解析优先级：
 * 1. HERMES_HOME 环境变量（用户自定义）
 * 2. 默认: ~/.hermes（Windows/Linux/macOS/WSL2）
 *
 * @returns Hermes 数据目录的绝对路径
 */
export function detectHermesHome(): string {
  // 1. 用户自定义的环境变量（最高优先级）
  if (process.env.HERMES_HOME) {
    return resolve(process.env.HERMES_HOME)
  }

  const userHome = process.platform === 'win32'
    ? process.env.USERPROFILE?.trim() || homedir()
    : homedir()
  return resolve(userHome, '.hermes')
}

/**
 * Detect the Hermes root data directory.
 *
 * `HERMES_HOME` may intentionally point at a profile directory when launching a
 * specific gateway (`<root>/profiles/<name>`). Web UI profile management needs
 * the root directory so it can read `active_profile` and enumerate profiles.
 */
export function detectHermesRootHome(): string {
  const home = detectHermesHome()
  const parent = dirname(home)
  if (basename(parent) === 'profiles') return dirname(parent)
  return home
}

/**
 * 获取 Hermes CLI 二进制文件路径
 * @param customBin 自定义的 hermes 二进制路径
 * @returns hermes 命令名称或路径
 */
export function getHermesBin(customBin?: string): string {
  if (customBin?.trim()) return customBin.trim()
  if (process.env.HERMES_BIN?.trim()) return process.env.HERMES_BIN.trim()
  return 'hermes'
}

function comparablePath(path: string): string {
  return process.platform === 'win32' ? path.toLowerCase() : path
}

function looksLikeWindowsPath(path: string): boolean {
  return /^[a-zA-Z]:[\\/]/.test(path)
}

function useWindowsPathOps(...paths: string[]): boolean {
  return process.platform === 'win32' || paths.some(looksLikeWindowsPath)
}

function resolveComparablePath(path: string, useWindows: boolean): string {
  return useWindows ? pathWin32.resolve(path) : resolve(path)
}

function relativeComparablePath(from: string, to: string, useWindows: boolean): string {
  return useWindows ? pathWin32.relative(from, to) : relative(from, to)
}

function isComparableAbsolute(path: string, useWindows: boolean): boolean {
  return useWindows ? pathWin32.isAbsolute(path) : isAbsolute(path)
}

/**
 * A relative path leaves its base only when its first segment is exactly `..`.
 * A first segment that merely begins with dots — `..hidden`, `...` — names a
 * child, and `relative()` can only produce it for a target inside the base.
 */
function startsWithParentSegment(relativePath: string): boolean {
  const [first] = relativePath.split(/[\\/]/)
  return first === '..'
}

function dirnameComparablePath(path: string, useWindows: boolean): string {
  return useWindows ? pathWin32.dirname(path) : dirname(path)
}

export function isPathWithin(targetPath: string, basePath: string): boolean {
  const useWindows = useWindowsPathOps(targetPath, basePath)
  const base = resolveComparablePath(basePath, useWindows)
  const target = resolveComparablePath(targetPath, useWindows)
  const rel = relativeComparablePath(comparablePath(base), comparablePath(target), useWindows)
  return rel === '' || (!!rel && !startsWithParentSegment(rel) && !isComparableAbsolute(rel, useWindows))
}

export function relativePathFromBase(targetPath: string, basePath: string): string | null {
  if (!isPathWithin(targetPath, basePath)) return null
  const useWindows = useWindowsPathOps(targetPath, basePath)
  const rel = relativeComparablePath(
    resolveComparablePath(basePath, useWindows),
    resolveComparablePath(targetPath, useWindows),
    useWindows,
  )
  return rel.replace(/\\/g, '/')
}

export async function realPathOrResolved(targetPath: string): Promise<string> {
  try {
    return await realpath(targetPath)
  } catch (err: any) {
    if (err?.code !== 'ENOENT' && err?.code !== 'ENOTDIR') throw err
    return resolveComparablePath(targetPath, useWindowsPathOps(targetPath))
  }
}

export async function nearestExistingRealPath(targetPath: string): Promise<string | null> {
  const useWindows = useWindowsPathOps(targetPath)
  let current = resolveComparablePath(targetPath, useWindows)
  while (true) {
    try {
      return await realpath(current)
    } catch (err: any) {
      if (err?.code !== 'ENOENT' && err?.code !== 'ENOTDIR') throw err
    }

    const parent = dirnameComparablePath(current, useWindows)
    if (parent === current) return null
    current = parent
  }
}

export async function isRealPathWithin(targetPath: string, basePath: string): Promise<boolean> {
  const [realTargetPath, realBasePath] = await Promise.all([
    realPathOrResolved(targetPath),
    realPathOrResolved(basePath),
  ])
  return isPathWithin(realTargetPath, realBasePath)
}

export async function isNearestExistingRealPathWithin(targetPath: string, basePath: string): Promise<boolean> {
  const [realAncestorPath, realBasePath] = await Promise.all([
    nearestExistingRealPath(targetPath),
    realPathOrResolved(basePath),
  ])
  return !!realAncestorPath && isPathWithin(realAncestorPath, realBasePath)
}
