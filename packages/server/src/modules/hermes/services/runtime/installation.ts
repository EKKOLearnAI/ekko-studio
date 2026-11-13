import { existsSync, readFileSync, realpathSync } from 'fs'
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

function launcherContents(hermesBin: string): string[] {
  const candidates = [hermesBin]
  try {
    const real = realpathSync(hermesBin)
    if (real !== hermesBin) candidates.push(real)
  } catch {}

  const contents: string[] = []
  for (const candidate of candidates) {
    try {
      contents.push(readFileSync(candidate, 'utf8'))
    } catch {
      // Native launchers are expected to be unreadable as text.
    }
  }
  return contents
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
    // the selected Hermes virtualenv's absolute Python path.
    for (const match of contents.matchAll(/["']([^"'\r\n]+)["']/g)) {
      const candidate = match[1]
      if (isAbsolute(candidate) && isPythonExecutable(candidate) && existsSync(candidate)) {
        return candidate
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
