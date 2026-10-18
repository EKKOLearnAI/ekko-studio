import { existsSync, readFileSync } from 'fs'
import { resolve } from 'path'

export type StudioPackageName = 'ekko-studio' | 'hermes-web-ui'

export function isStudioPackageName(name: unknown): name is StudioPackageName {
  return name === 'ekko-studio' || name === 'hermes-web-ui'
}

export function readStudioPackageInfo(): {
  name: StudioPackageName
  version: string
  repositoryUrl: string
} | null {
  // Read the running installation before considering the caller's working directory.
  const candidatePaths = [
    resolve(__dirname, '../../../../../../package.json'),
    resolve(__dirname, '../../package.json'),
    resolve(process.cwd(), 'package.json'),
  ]
  for (const packagePath of candidatePaths) {
    if (!existsSync(packagePath)) continue
    try {
      const pkg = JSON.parse(readFileSync(packagePath, 'utf-8'))
      if (!isStudioPackageName(pkg?.name) || typeof pkg.version !== 'string' || !pkg.version) continue
      const repositoryUrl = typeof pkg.repository === 'string'
        ? pkg.repository
        : typeof pkg.repository?.url === 'string' ? pkg.repository.url : ''
      return { name: pkg.name, version: pkg.version, repositoryUrl }
    } catch {
      // Try the next installation layout.
    }
  }
  return null
}
