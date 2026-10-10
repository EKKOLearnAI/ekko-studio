import { existsSync, readFileSync, realpathSync, statSync } from 'fs'
import { basename, dirname, isAbsolute, join, resolve } from 'path'

export interface HermesInstallationEnvironment {
  python?: string
  agentRoot?: string
  environmentRoot?: string
}

function firstExisting(candidates: Array<string | undefined>): string | undefined {
  for (const candidate of candidates) {
    if (!candidate) continue
    try {
      if (existsSync(candidate)) return candidate
    } catch {}
  }
  return undefined
}

function isPythonExecutable(command: string): boolean {
  return /^(?:python|pypy)(?:\d+(?:\.\d+)*)?(?:\.exe)?$/i.test(basename(command))
}

// The Unix git-install layout chains launchers: ~/.local/bin/hermes is a
// two-line shell wrapper whose only job is `exec <repo>/.hermes/bin/hermes "$@"`,
// and the inner script carries the absolute Python path plus the repo root.
// Symlink resolution alone cannot see that inner script, so the chain must be
// followed through the shell text. Depth is capped and visited paths are
// canonicalized so a wrapper cycle cannot loop. The chain must never walk
// past a real interpreter binary: static python builds are >100MB ELF files
// and treating them as launcher text costs seconds per resolve, so only
// files below this size are eligible for chain-following or text scans.
const MAX_LAUNCHER_FOLLOW_DEPTH = 3
const MAX_LAUNCHER_TEXT_BYTES = 1024 * 1024

function isSmallExecutableFile(path: string): boolean {
  try {
    return statSync(path).size <= MAX_LAUNCHER_TEXT_BYTES
  } catch {
    return false
  }
}

function readSmallTextFile(path: string): string | undefined {
  if (!isSmallExecutableFile(path)) return undefined
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return undefined
  }
}

function execLaunchTarget(launcherPath: string): string | undefined {
  const contents = readSmallTextFile(launcherPath)
  if (!contents) return undefined
  for (const line of contents.split(/\r?\n/).slice(0, 10)) {
    const match = line.match(/^\s*exec\s+(")?([^"\s]+)\1(?:\s|$)/)
    if (!match) continue
    const target = match[2]
    if (!target || !isAbsolute(target) || !isSmallExecutableFile(target)) continue
    try {
      if (realpathSync(target) === realpathSync(launcherPath)) continue
    } catch {}
    return target
  }
  return undefined
}

function launcherContents(hermesBin: string): string[] {
  const candidates: string[] = []
  const seen = new Set<string>()
  let current: string | undefined = hermesBin
  for (let depth = 0; current && depth <= MAX_LAUNCHER_FOLLOW_DEPTH; depth += 1) {
    const path = current
    let canonical: string
    try {
      canonical = realpathSync(path)
    } catch {
      canonical = resolve(path)
    }
    if (seen.has(canonical)) break
    seen.add(canonical)
    candidates.push(path)
    try {
      const real = realpathSync(path)
      if (real !== path && !seen.has(real)) {
        seen.add(real)
        candidates.push(real)
      }
    } catch {}
    current = execLaunchTarget(path)
  }

  const contents: string[] = []
  for (const candidate of candidates) {
    const text = readSmallTextFile(candidate)
    if (text !== undefined) contents.push(text)
  }
  return contents
}

// Repo-root style wrappers embed absolute paths in their text (quoted
// `sys.path.insert` arguments, bare `exec` targets). Those paths are the only
// reliable agent-root hint for chained wrapper installs, where the executable
// itself lives outside any recognizable install directory.
function referencedAbsolutePaths(contents: string[]): string[] {
  const found: string[] = []
  for (const text of contents) {
    for (const match of text.matchAll(/["']([^"'\r\n]+)["']/g)) {
      const candidate = match[1]
      if (isAbsolute(candidate) && existsSync(candidate)) found.push(candidate)
    }
    for (const line of text.split(/\r?\n/)) {
      const bare = line.match(/^\s*exec\s+"?([^"\s]+)"?(?:\s|$)/)?.[1]
      if (bare && isAbsolute(bare) && existsSync(bare)) found.push(bare)
    }
  }
  return found
}

function resolveFromPath(command: string, env: NodeJS.ProcessEnv): string | undefined {
  if (isAbsolute(command)) return existsSync(command) ? command : undefined
  const pathValue = env.PATH || env.Path || ''
  const extensions = process.platform === 'win32' && !/\.[A-Za-z0-9]+$/.test(command)
    ? (env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';')
    : ['']
  for (const directory of pathValue.split(process.platform === 'win32' ? ';' : ':')) {
    if (!directory) continue
    for (const extension of extensions) {
      const candidate = join(directory, process.platform === 'win32' ? `${command}${extension}` : command)
      if (existsSync(candidate)) return candidate
    }
  }
  return undefined
}

function pythonFromLauncher(hermesBin: string, env: NodeJS.ProcessEnv): string | undefined {
  for (const contents of launcherContents(hermesBin)) {
    const firstLine = contents.split(/\r?\n/, 1)[0] || ''
    const shebang = firstLine.match(/^#!\s*(.+)$/)?.[1]?.trim() || ''
    const shebangParts = shebang.split(/\s+/).filter(Boolean)
    const interpreter = shebangParts[0] || ''
    if (isPythonExecutable(interpreter)) {
      const resolved = resolveFromPath(interpreter, env)
      if (resolved) return resolved
    }

    if (/^env(?:\.exe)?$/i.test(basename(interpreter))) {
      const envPython = shebangParts.slice(1).find(part => !part.startsWith('-'))
      if (envPython && isPythonExecutable(envPython)) {
        const resolved = resolveFromPath(envPython, env)
        if (resolved) return resolved
      }
    }

    // The standard Unix installer writes a shell wrapper whose exec target is
    // the selected Hermes virtualenv's absolute Python path. The path may be
    // quoted, or appear bare on an exec line (the repo launcher embeds it
    // unquoted in `python -I -c ...`), so scan both forms.
    for (const match of contents.matchAll(/["']([^"'\r\n]+)["']/g)) {
      const candidate = match[1]
      if (isAbsolute(candidate) && isPythonExecutable(candidate) && existsSync(candidate)) {
        return candidate
      }
    }
    for (const line of contents.split(/\r?\n/)) {
      const bare = line.match(/^\s*exec\s+"?([^"\s]+)"?(?:\s|$)/)?.[1]
      if (!bare) continue
      if (isAbsolute(bare) && isPythonExecutable(bare) && existsSync(bare)) {
        return bare
      }
    }
  }
  return undefined
}

function agentRootCandidates(hermesBin: string, hermesHome: string): string[] {
  const binCandidates = [hermesBin]
  try {
    const real = realpathSync(hermesBin)
    if (real !== hermesBin) binCandidates.push(real)
  } catch {}

  const candidates: string[] = []
  for (const candidate of binCandidates) {
    const binDir = dirname(candidate)
    candidates.push(
      resolve(binDir, '..'),
      resolve(binDir, '..', '..'),
      resolve(binDir, '..', 'hermes-agent'),
      resolve(binDir, '..', 'lib', 'hermes-agent'),
      resolve(binDir, '..', '..', 'hermes-agent'),
    )
  }
  // Chained shell wrappers (the Unix git install) hide the repo root behind
  // an exec target; the referenced absolute paths are the only structural
  // hint back to it.
  for (const referenced of referencedAbsolutePaths(launcherContents(hermesBin))) {
    let directory = dirname(referenced)
    for (let depth = 0; depth < 4; depth += 1) {
      candidates.push(directory)
      directory = dirname(directory)
    }
  }
  candidates.push(join(hermesHome, 'hermes-agent'))
  if (basename(dirname(hermesHome)) === 'profiles') {
    candidates.push(join(resolve(hermesHome, '..', '..'), 'hermes-agent'))
  }
  return [...new Set(candidates)]
}

function pythonCandidates(
  agentRoot: string | undefined,
  hermesBin: string,
  env: NodeJS.ProcessEnv,
): string[] {
  const binDir = dirname(hermesBin)
  const candidates: string[] = [
    pythonFromLauncher(hermesBin, env) || '',
    ...(process.platform === 'win32'
      ? [join(binDir, 'python.exe'), join(binDir, 'python3.exe'), join(binDir, '..', 'python.exe')]
      : [join(binDir, 'python3'), join(binDir, 'python')]),
  ]
  if (agentRoot) {
    candidates.push(...(process.platform === 'win32'
      ? [
          join(agentRoot, 'venv', 'Scripts', 'python.exe'),
          join(agentRoot, '.venv', 'Scripts', 'python.exe'),
          join(agentRoot, 'venv', 'python.exe'),
        ]
      : [
          join(agentRoot, 'venv', 'bin', 'python3'),
          join(agentRoot, 'venv', 'bin', 'python'),
          join(agentRoot, '.venv', 'bin', 'python3'),
          join(agentRoot, '.venv', 'bin', 'python'),
        ]))
  }

  return candidates
}

function environmentRootFromPython(python: string | undefined): string | undefined {
  if (!python) return undefined
  const scriptsRoot = dirname(python)
  return /^(?:bin|scripts)$/i.test(basename(scriptsRoot))
    ? dirname(scriptsRoot)
    : dirname(python)
}

/**
 * Resolve the Python side of one concrete Hermes CLI installation.
 *
 * This deliberately starts from the selected executable instead of ambient
 * runtime variables, so a user CLI cannot accidentally inherit Studio's
 * managed Python. It supports Unix shebang/wrapper installs and Windows
 * venv/Scripts launchers without assuming that the two layouts are identical.
 */
export function resolveHermesInstallationEnvironment(
  hermesBin: string,
  hermesHome: string,
  env: NodeJS.ProcessEnv = process.env,
): HermesInstallationEnvironment {
  const launcherPython = firstExisting(pythonCandidates(undefined, hermesBin, env))
  const pythonEnvironmentRoot = environmentRootFromPython(launcherPython)
  const pythonRoot = pythonEnvironmentRoot && /^(?:venv|\.venv)$/i.test(basename(pythonEnvironmentRoot))
    ? dirname(pythonEnvironmentRoot)
    : undefined
  const agentRoot = [
    ...(pythonRoot ? [pythonRoot] : []),
    ...agentRootCandidates(hermesBin, hermesHome),
  ]
    .find(candidate => existsSync(join(candidate, 'run_agent.py')))
  const python = launcherPython || firstExisting(pythonCandidates(agentRoot, hermesBin, env))
  return {
    ...(python ? { python, environmentRoot: environmentRootFromPython(python) } : {}),
    ...(agentRoot ? { agentRoot } : {}),
  }
}
