import { existsSync, readFileSync } from 'fs'
import { resolve } from 'path'
import { parseSemver } from './version-compare'

export interface PackageInfo {
  name: string
  version: string
  repositoryUrl: string
  nodeVersionRange: string
}

export function readPackageInfo(): PackageInfo | null {
  const candidatePaths = [
    resolve(__dirname, '../../package.json'),
    resolve(__dirname, '../../../../../../../package.json'),
    resolve(process.cwd(), 'package.json'),
  ]

  for (const packagePath of candidatePaths) {
    if (!existsSync(packagePath)) continue
    try {
      const pkg = JSON.parse(readFileSync(packagePath, 'utf-8'))
      if (pkg?.name && pkg?.version) {
        return {
          name: String(pkg.name),
          version: String(pkg.version),
          repositoryUrl: readRepositoryUrl(pkg),
          nodeVersionRange: typeof pkg?.engines?.node === 'string' ? pkg.engines.node.trim() : '',
        }
      }
    } catch {}
  }
  return null
}

export function getLocalWebUiVersion(injectedVersion?: unknown): string {
  if (typeof injectedVersion === 'string') {
    const normalized = injectedVersion.trim()
    if (parseSemver(normalized)) return normalized
  }
  return readPackageInfo()?.version || '0.0.0'
}

function readRepositoryUrl(pkg: any): string {
  const repository = pkg?.repository
  if (typeof repository === 'string') return repository.trim()
  if (typeof repository?.url === 'string') return repository.url.trim()
  return ''
}
