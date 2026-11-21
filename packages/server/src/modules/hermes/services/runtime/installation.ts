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

function shellExecTarget(contents: string): string | undefined {
  if (!/^#![^\r\n]*\b(?:sh|bash|dash|ksh|zsh)(?:\s|$)/.test(contents)) return undefined
  // Read the executable token without evaluating shell or bootstrap code.
  for (const line of contents.split(/\r?\n/)) {
    const command = line.match(/^\s*exec\s+(.+)$/)?.[1]
    if (!command) continue
    let target = ''
    let quote = ''
    for (let index = 0; index < command.length; index += 1) {
      const char = command[index]
      if (quote === "'") {
        if (char === "'") quote = ''
        else target += char
      } else if (char === quote) {
        quote = ''
      } else if (char === '\\' && (!quote || /["\\$\x60]/.test(command[index + 1] || ''))) {
        target += command[++index] || ''
      } else if (!quote && (char === '"' || char === "'")) {
        quote = char
      } else if (!quote && /\s/.test(char)) {
        break
      } else {
        target += char
      }
    }
    if (!quote && isAbsolute(target)) return target
  }
  return undefined
}

interface LauncherScript {
  path: string
  contents: string
  execTarget?: string
}

function launcherScripts(hermesBin: string): LauncherScript[] {
  const scripts: LauncherScript[] = []
  const seen = new Set<string>()
  const followShellWrappers = process.platform !== 'win32'
  let next: string | undefined = hermesBin
  // A user-bin wrapper may forward to a launcher inside the checkout.
  for (let depth = 0; next && depth < 4; depth += 1) {
    let path: string = next
    try {
      path = realpathSync(path)
    } catch {}
    if (seen.has(path)) break
    seen.add(path)
    try {
      if (followShellWrappers) {
        const stat = statSync(path)
        if (!stat.isFile() || stat.size > 1024 * 1024) break
      }
      const contents = readFileSync(path, 'utf8')
      const execTarget = followShellWrappers ? shellExecTarget(contents) : undefined
      scripts.push({ path, contents, execTarget })
      next = execTarget && !isPythonExecutable(execTarget) ? execTarget : undefined
    } catch {
      break
    }
  }
  return scripts
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

function pythonFromLauncher(scripts: LauncherScript[], env: NodeJS.ProcessEnv): string | undefined {
  for (const { contents, execTarget } of scripts) {
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

    if (execTarget && isPythonExecutable(execTarget) && existsSync(execTarget)) return execTarget

    for (const match of contents.matchAll(/["']([^"'\r\n]+)["']/g)) {
      const candidate = match[1]
      if (isAbsolute(candidate) && isPythonExecutable(candidate) && existsSync(candidate)) {
        return candidate
      }
    }
  }
  return undefined
}

function agentRootCandidates(hermesBin: string, hermesHome: string, scripts: LauncherScript[]): string[] {
  const binCandidates = [hermesBin]
  try {
    const real = realpathSync(hermesBin)
    if (real !== hermesBin) binCandidates.push(real)
  } catch {}
  binCandidates.push(...scripts.map(script => script.path))

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

function pythonCandidates(agentRoot: string | undefined, hermesBin: string): string[] {
  const binDir = dirname(hermesBin)
  const candidates: string[] = [
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
  const scripts = launcherScripts(hermesBin)
  const launcherPython = pythonFromLauncher(scripts, env) || firstExisting(pythonCandidates(undefined, hermesBin))
  const pythonEnvironmentRoot = environmentRootFromPython(launcherPython)
  const pythonRoot = pythonEnvironmentRoot && /^(?:venv|\.venv)$/i.test(basename(pythonEnvironmentRoot))
    ? dirname(pythonEnvironmentRoot)
    : undefined
  const agentRoot = [
    ...(pythonRoot ? [pythonRoot] : []),
    ...agentRootCandidates(hermesBin, hermesHome, scripts),
  ]
    .find(candidate => existsSync(join(candidate, 'run_agent.py')))
  const python = launcherPython || firstExisting(pythonCandidates(agentRoot, hermesBin))
  return {
    ...(python ? { python, environmentRoot: environmentRootFromPython(python) } : {}),
    ...(agentRoot ? { agentRoot } : {}),
  }
}
