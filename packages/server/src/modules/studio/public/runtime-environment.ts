import { existsSync, readFileSync } from 'fs'
import { dirname, join, resolve } from 'path'

export function isDockerContainer(): boolean {
  return existsSync('/.dockerenv') || process.env.container === 'docker'
}

const STUDIO_PACKAGE_NAMES = new Set(['ekko-studio', 'hermes-web-ui'])
const MAX_ANCESTOR_DEPTH = 8

function isStudioRepoRoot(dir: string): boolean {
  if (!existsSync(join(dir, '.git')) || !existsSync(join(dir, 'package.json'))) return false
  try {
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf-8'))
    return STUDIO_PACKAGE_NAMES.has(pkg?.name)
  } catch {
    return false
  }
}

function* walkAncestors(start: string): Generator<string> {
  let current = resolve(start)
  for (let depth = 0; depth <= MAX_ANCESTOR_DEPTH; depth += 1) {
    yield current
    const parent = dirname(current)
    if (parent === current) return
    current = parent
  }
}

/**
 * Resolve the source checkout that is currently running, or null for npm-global
 * and other non-source deployments.
 *
 * The bundled server runs from `<repo>/dist/server/index.js`, while in dev it runs
 * from `<repo>/packages/server/src/...`, so the repo root sits a different number of
 * levels up in each case. Walk ancestors instead of hardcoding a single depth.
 *
 * A directory only qualifies when it has both `.git` and a Studio `package.json`, so
 * an unrelated git repository in a parent directory cannot be mistaken for the install.
 */
export function getGitCloneRoot(): string | null {
  if (isDockerContainer()) return null

  const explicitRoot = process.env.HERMES_WEB_UI_REPO_ROOT?.trim()
  if (explicitRoot && isStudioRepoRoot(resolve(explicitRoot))) {
    return resolve(explicitRoot)
  }

  // `__dirname` exists in the bundled CJS server but is undefined under some ESM
  // test runners, so collect the candidate roots defensively.
  const starts: string[] = []
  if (process.cwd()) starts.push(process.cwd())
  if (typeof __dirname === 'string') starts.push(__dirname)

  for (const start of starts) {
    try {
      for (const candidate of walkAncestors(start)) {
        if (isStudioRepoRoot(candidate)) return candidate
      }
    } catch {
      // Unreadable parent directory — try the remaining candidate roots.
    }
  }
  return null
}

/**
 * True when the running server was launched from a git checkout rather than an
 * npm global install. Callers use this to route updates through git + rebuild +
 * service restart instead of `npm install -g`.
 */
export function isGitCloneDeployment(): boolean {
  return getGitCloneRoot() !== null
}
