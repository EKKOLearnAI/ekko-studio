import { readStudioPackageInfo, type StudioPackageName } from '../package-info'
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { delimiter, dirname, extname, join } from 'node:path'

export interface UpdateRuntimeDependencies { getWebUiHome: () => string; isDockerContainer: () => boolean }
let runtimeDependencies: UpdateRuntimeDependencies | null = null
let updateInProgress = false
const NODE_ENVIRONMENT_MISSING_CODE = 'node_environment_missing'
const DOCKER_ENVIRONMENT_CODE = 'docker_environment'

export function configureUpdateRuntime(dependencies: UpdateRuntimeDependencies): void {
  runtimeDependencies = dependencies
}

function getWebUiHome(): string {
  if (!runtimeDependencies) throw new Error('Studio update runtime has not been configured')
  return runtimeDependencies.getWebUiHome()
}

function isDockerContainer(): boolean {
  if (!runtimeDependencies) throw new Error('Studio update runtime has not been configured')
  return runtimeDependencies.isDockerContainer()
}

function getNodeBinDir() {
  return dirname(process.execPath)
}

function getNodePrefix() {
  return process.platform === 'win32' ? getNodeBinDir() : dirname(getNodeBinDir())
}

function getHomebrewPrefix() {
  const match = process.execPath.match(/^(.*)\/Cellar\/[^/]+\/[^/]+\/bin\/node$/)
  return match?.[1] || null
}

function getNpmCliCandidates() {
  const prefix = getNodePrefix()
  const homebrewPrefix = getHomebrewPrefix()

  return process.platform === 'win32'
    ? [
        join(prefix, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
        join(getNodeBinDir(), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
      ]
    : [
        join(prefix, 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
        ...(homebrewPrefix ? [join(homebrewPrefix, 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js')] : []),
      ]
}

function getNpmCliPath() {
  const candidates = getNpmCliCandidates()
  const npmCli = candidates.find(existsSync)

  return npmCli || null
}

function getNpmBin() {
  return process.platform === 'win32' ? 'npm.cmd' : 'npm'
}

function windowsCommandNeedsShell(command: string): boolean {
  const extension = extname(command).toLowerCase()
  return extension === '.cmd' || extension === '.bat'
}

function commandExecution(command: string, args: string[]): { command: string; args: string[] } {
  if (process.platform === 'win32' && windowsCommandNeedsShell(command)) {
    const commandArg = / /.test(command) ? `"${command}"` : command
    const argsString = args.map(arg => / /.test(arg) ? `"${arg}"` : arg).join(' ')
    return {
      command: 'cmd.exe',
      args: ['/d', '/s', '/c', `${commandArg} ${argsString}`],
    }
  }
  return { command, args }
}

function nodeEnvironmentMissingError(): Error {
  const err = new Error('Node/npm environment was not detected. Please install Node.js and try again.')
  ;(err as any).code = NODE_ENVIRONMENT_MISSING_CODE
  return err
}

function findCommandPath(command: string, env: NodeJS.ProcessEnv): string | null {
  try {
    const lookupCommand = process.platform === 'win32' ? 'where' : 'which'
    const stdout = execFileSync(lookupCommand, [command], {
      encoding: 'utf-8',
      timeout: 3000,
      stdio: ['pipe', 'pipe', 'pipe'],
      env,
      windowsHide: true,
    })
    return stdout.split(/\r?\n/).map((line: string) => line.trim()).find(Boolean) || null
  } catch {
    return null
  }
}

function npmCliFromNpmBin(npmBin: string): { node: string; npmCli: string } | null {
  const binDir = dirname(npmBin)
  if (process.platform === 'win32') {
    const node = join(binDir, 'node.exe')
    const npmCli = join(binDir, 'node_modules', 'npm', 'bin', 'npm-cli.js')
    return existsSync(node) && existsSync(npmCli) ? { node, npmCli } : null
  }

  const node = join(binDir, 'node')
  const npmCli = join(dirname(binDir), 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js')
  return existsSync(node) && existsSync(npmCli) ? { node, npmCli } : null
}

function npmExecution(args: string[], env: NodeJS.ProcessEnv): { command: string; args: string[] } {
  const bundledNpmCli = getNpmCliPath()
  if (bundledNpmCli) return { command: process.execPath, args: [bundledNpmCli, ...args] }

  const npmBin = findCommandPath(getNpmBin(), env) || findCommandPath('npm', env)
  if (!npmBin) throw nodeEnvironmentMissingError()

  const npmCli = npmCliFromNpmBin(npmBin)
  if (npmCli) return { command: npmCli.node, args: [npmCli.npmCli, ...args] }

  const nodeBin = findCommandPath(process.platform === 'win32' ? 'node.exe' : 'node', env) || findCommandPath('node', env)
  if (!nodeBin) throw nodeEnvironmentMissingError()

  return commandExecution(npmBin, args)
}

function getGlobalPackageBin(root: string, packageName: StudioPackageName) {
  return join(root, packageName, 'bin', 'hermes-web-ui.mjs')
}

function getCurrentNodeEnv() {
  return {
    ...process.env,
    PATH: [getNodeBinDir(), process.env.PATH].filter(Boolean).join(delimiter),
    npm_node_execpath: process.execPath,
  }
}

function getUpdateCommandCwd() {
  const cwd = getWebUiHome()
  mkdirSync(cwd, { recursive: true })
  return cwd
}

function runNpmSync(args: string[], options: { timeout?: number; env?: NodeJS.ProcessEnv } = {}) {
  const env = {
    ...getCurrentNodeEnv(),
    ...options.env,
  }
  const execution = npmExecution(args, env)
  return execFileSync(execution.command, execution.args, {
    cwd: getUpdateCommandCwd(),
    encoding: 'utf-8',
    timeout: options.timeout,
    stdio: ['pipe', 'pipe', 'pipe'],
    env,
    windowsHide: true,
  }).trim()
}

function getGlobalRoot() {
  return runNpmSync(['root', '-g'])
}

function getGlobalCliScript(packageName: StudioPackageName) {
  const cli = getGlobalPackageBin(getGlobalRoot(), packageName)
  if (!existsSync(cli)) {
    throw new Error(`Updated ${packageName} CLI not found: ${cli}`)
  }
  return cli
}

function runUpdateInstall(packageName: StudioPackageName) {
  try {
    runNpmSync(['cache', 'clean', '--force'], { timeout: 2 * 60 * 1000 })
  } catch (err) {
    console.warn('[update] failed to clean npm cache, continuing update:', err)
  }

  return runNpmSync(['install', '-g', `${packageName}@latest`], { timeout: 10 * 60 * 1000 })
}

function spawnRestart(port: string, packageName: StudioPackageName) {
  const cli = getGlobalCliScript(packageName)

  return spawn(process.execPath, [cli, 'restart', '--port', port], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    env: getCurrentNodeEnv(),
  })
}

export async function handleUpdate(ctx: any) {
  if (updateInProgress) {
    ctx.status = 409
    ctx.body = {
      success: false,
      message: 'Ekko Studio update is already in progress',
    }
    return
  }

  // Docker 环境中 npm 全局安装方式不可用，引导用户使用 docker pull 升级
  if (isDockerContainer()) {
    ctx.status = 400
    ctx.body = {
      success: false,
      code: DOCKER_ENVIRONMENT_CODE,
      message: 'Ekko Studio update is not available inside Docker. '
        + 'Please pull a new image and recreate the container:\n\n'
        + '  docker compose pull\n'
        + '  docker compose up -d --force-recreate',
    }
    return
  }

  updateInProgress = true
  let keepUpdateLockForRestart = false

  try {
    const packageName = readStudioPackageInfo()?.name
    if (!packageName) throw new Error('Cannot identify the installed Studio npm package')
    const output = runUpdateInstall(packageName)

    ctx.body = {
      success: true,
      message: output.trim() || `${packageName} updated successfully`,
    }

    keepUpdateLockForRestart = true
    setTimeout(() => {
      let restart
      try {
        restart = spawnRestart(process.env.PORT || '8648', packageName)
      } catch (err) {
        updateInProgress = false
        console.error('[update] failed to spawn restart:', err)
        return
      }

      restart.on('error', (err) => {
        updateInProgress = false
        console.error('[update] restart process failed:', err)
      })
      restart.on('exit', (code, signal) => {
        updateInProgress = false
        const failed = (typeof code === 'number' && code !== 0) || Boolean(signal)
        if (failed) {
          console.error(`[update] restart process exited before replacing server: code=${code} signal=${signal}`)
        }
      })
      restart.unref()
    }, 3000)
  } catch (err: any) {
    ctx.status = 500
    ctx.body = {
      success: false,
      message: err.stderr?.toString() || err.message || String(err),
    }
  } finally {
    if (!keepUpdateLockForRestart) {
      updateInProgress = false
    }
  }
}
