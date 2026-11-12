import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { chmod, mkdir, readFile, writeFile, rename, rm } from 'node:fs/promises'
import { join, isAbsolute } from 'node:path'

const repository = 'https://github.com/can1357/oh-my-pi'
const exactVersion = /^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/

export function childEnvironment(agentDir) {
  const names = ['PATH', 'PATHEXT', 'SystemRoot', 'SYSTEMROOT', 'COMSPEC', 'TEMP', 'TMP', 'TMPDIR', 'LANG', 'LC_ALL', 'SHELL']
  return { ...Object.fromEntries(names.filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]])),
    PI_CODING_AGENT_DIR: agentDir, PI_NO_TITLE: '1', PI_NO_PTY: '1', NO_COLOR: '1', TERM: 'dumb' }
}
export function runCommand(command, args, { signal, cwd, env, timeout = 15000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { signal, cwd, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = '', stderr = '', settled = false
    const finish = (error, value) => { if (settled) return; settled = true; clearTimeout(timer); error ? reject(error) : resolve(value) }
    const timer = setTimeout(() => { child.kill(); finish(new Error('OMP command timed out')) }, timeout)
    child.stdout.on('data', data => { stdout = (stdout + data).slice(-200000) })
    child.stderr.on('data', data => { stderr = (stderr + data).slice(-4000) })
    child.once('error', error => finish(error))
    child.once('close', code => finish(code === 0 ? null : new Error(`OMP exited ${code}: ${stderr}`), stdout.trim()))
  })
}
export async function selectedExecutable(dataDir, configured) {
  if (configured) {
    if (!isAbsolute(configured)) throw new Error('OMP executable must be an absolute path')
    return configured
  }
  try {
    const selected = JSON.parse(await readFile(join(dataDir, 'engine.json'), 'utf8'))
    if (!exactVersion.test(selected.version) || !/^[\w.-]+$/.test(selected.asset)) throw new Error('Invalid OMP installation record')
    return join(dataDir, 'engines', selected.version, selected.asset)
  } catch (error) { if (error.code === 'ENOENT') return null; throw error }
}
export async function engineStatus(dataDir, configured, signal) {
  await mkdir(dataDir, { recursive: true, mode: 0o700 })
  const executable = await selectedExecutable(dataDir, configured)
  if (!executable) return { installed: false, version: '', source: 'not-installed' }
  try {
    const version = await runCommand(executable, ['--version'], { signal, env: childEnvironment(join(dataDir, 'probe')), cwd: dataDir })
    const matched = version.match(/\b(\d+\.\d+\.\d+(?:-[\w.-]+)?)\b/)
    if (!matched) throw new Error('OMP returned an invalid version')
    return { installed: true, version: matched[1], source: configured ? 'external' : 'managed', path: executable }
  } catch (error) {
    signal?.throwIfAborted()
    return { installed: false, version: '', source: 'not-installed', error: error.message }
  }
}
let latest
export async function latestVersion(signal) {
  if (latest && Date.now() - latest.at < 300000) return latest.version
  const response = await fetch('https://api.github.com/repos/can1357/oh-my-pi/releases/latest', {
    signal, headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'Ekko-Studio-OMP' },
  })
  if (!response.ok) throw new Error(`OMP release lookup returned ${response.status}`)
  const version = String((await response.json()).tag_name || '').replace(/^v/, '')
  if (!exactVersion.test(version)) throw new Error('OMP release has an invalid version')
  latest = { version, at: Date.now() }
  return version
}
export function binaryAsset(platform = process.platform, arch = process.arch) {
  if (!['darwin', 'linux', 'win32'].includes(platform) || !['arm64', 'x64'].includes(arch)) throw new Error('OMP supports macOS, Linux and Windows on x64 or arm64')
  const musl = platform === 'linux' && !process.report?.getReport()?.header?.glibcVersionRuntime
  return `omp-${platform === 'win32' ? 'windows' : platform}${musl ? '-musl' : ''}-${arch}${platform === 'win32' ? '.exe' : ''}`
}
export async function installEngine(dataDir, version, signal, progress = () => {}) {
  if (!exactVersion.test(version)) throw new Error('An exact OMP version is required')
  const asset = binaryAsset(), stage = join(dataDir, 'engines', `.install-${randomUUID()}`)
  await mkdir(stage, { recursive: true, mode: 0o700 })
  try {
    progress({ message: 'Downloading OMP', percent: 0 })
    const base = `${repository}/releases/download/v${version}`
    const checksumResponse = await fetch(`${base}/SHA256SUMS.txt`, { signal })
    if (!checksumResponse.ok) throw new Error(`OMP checksums returned ${checksumResponse.status}`)
    const line = (await checksumResponse.text()).split('\n').find(line => line.trim().split(/\s+/).at(-1)?.replace(/^\*/, '') === asset)
    const expected = line?.trim().split(/\s+/)[0]
    if (!/^[a-fA-F0-9]{64}$/.test(expected || '')) throw new Error('OMP release does not contain this platform checksum')
    const response = await fetch(`${base}/${asset}`, { signal })
    if (!response.ok || !response.body) throw new Error(`OMP download returned ${response.status}`)
    const { open } = await import('node:fs/promises')
    const file = await open(join(stage, asset), 'wx', 0o700), hash = createHash('sha256')
    let received = 0
    try {
      for await (const chunk of response.body) {
        signal.throwIfAborted(); received += chunk.length
        if (received > 600000000) throw new Error('OMP binary exceeds the download limit')
        hash.update(chunk); await file.writeFile(chunk)
      }
    } finally { await file.close() }
    if (hash.digest('hex').toLowerCase() !== expected.toLowerCase()) throw new Error('OMP binary checksum verification failed')
    await chmod(join(stage, asset), 0o700)
    const status = await engineStatus(stage, join(stage, asset), signal)
    if (!status.installed || status.version !== version) throw new Error('Downloaded OMP binary does not match the requested version')
    const license = await fetch(`${base}/LICENSE`, { signal })
    if (!license.ok) throw new Error(`OMP license download returned ${license.status}`)
    await writeFile(join(stage, 'LICENSE'), await license.text(), { mode: 0o600 })
    signal.throwIfAborted()
    const directory = join(dataDir, 'engines', version)
    await rm(directory, { recursive: true, force: true }); await rename(stage, directory)
    const pointer = join(dataDir, `engine-${randomUUID()}.json`)
    await writeFile(pointer, JSON.stringify({ version, asset }), { mode: 0o600 })
    await rename(pointer, join(dataDir, 'engine.json'))
    progress({ message: 'OMP installed', percent: 100 })
    return { installedVersion: version }
  } finally { await rm(stage, { recursive: true, force: true }) }
}
