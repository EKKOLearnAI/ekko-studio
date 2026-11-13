import { existsSync } from 'node:fs'
import { copyFile, cp, lstat, mkdir, readdir, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { safeReadFile } from '../../../studio/public/profile-config'
import { writeManagedPromptFile } from '../prompt-file'
import { OPENCODE_CONFIG_FILE, OPENCODE_DATABASE_FILE, OPENCODE_SHARED_CONFIG_DIRS, openCodeRuntimeEnv, type createOpenCodeConfig } from './config'

async function pathEntryExists(path: string): Promise<boolean> {
  try {
    await lstat(path)
    return true
  } catch (err: any) {
    if (err?.code === 'ENOENT') return false
    throw err
  }
}

function shouldShareOpenCodeGlobalFile(name: string): boolean {
  if (name === 'AGENTS.md' || name === 'opencode.json' || name === 'opencode.jsonc') return false
  if (name === '.gitignore' || name === 'package.json' || name === 'package-lock.json' || name === 'bun.lock') return false
  if (name.endsWith('.lock') || name.endsWith('.pid') || name.endsWith('.sock')) return false
  if (name.endsWith('.db') || name.endsWith('.db-shm') || name.endsWith('.db-wal')) return false
  if (name.endsWith('.sqlite') || name.endsWith('.sqlite-shm') || name.endsWith('.sqlite-wal')) return false
  return !name.endsWith('.log')
}

async function shareOpenCodeGlobalEntry(source: string, target: string, type: 'file' | 'dir'): Promise<void> {
  if (await pathEntryExists(target)) return
  try {
    await symlink(source, target, process.platform === 'win32' && type === 'dir' ? 'junction' : type)
    return
  } catch (err: any) {
    if (err?.code !== 'EEXIST' && err?.code !== 'EPERM' && err?.code !== 'ENOTSUP' && err?.code !== 'EINVAL') {
      throw err
    }
    if (err?.code === 'EEXIST') return
  }
  if (type === 'dir') {
    await cp(source, target, {
      recursive: true,
      dereference: true,
      errorOnExist: false,
      force: false,
      preserveTimestamps: true,
    })
  } else {
    await copyFile(source, target)
  }
}

export async function prepareOpenCodeBaseConfig(input: {
  rootDir: string
  sourceHome: string
  profile: string
  systemPrompt: string
  workspaceDir: string
  opencodeRuntimeConfig: ReturnType<typeof createOpenCodeConfig>['opencodeRuntimeConfig']
  writeLauncherScript(input: { rootDir: string; workspaceDir: string; env: Record<string, string>; command: string; args: string[] }): Promise<string>
}) {
  const { rootDir, sourceHome, profile, systemPrompt, workspaceDir, writeLauncherScript, opencodeRuntimeConfig } = input
  await mkdir(rootDir, { recursive: true, mode: 0o700 })
  await mkdir(sourceHome, { recursive: true })

  for (const directory of OPENCODE_SHARED_CONFIG_DIRS) {
    const source = join(sourceHome, directory)
    const target = join(rootDir, directory)
    if (directory === 'skills') await mkdir(source, { recursive: true })
    if (!existsSync(source)) continue
    await shareOpenCodeGlobalEntry(source, target, 'dir')
  }

  if (sourceHome !== rootDir && existsSync(sourceHome)) {
    for (const entry of await readdir(sourceHome, { withFileTypes: true })) {
      if (!entry.isFile() || !shouldShareOpenCodeGlobalFile(entry.name)) continue
      await shareOpenCodeGlobalEntry(join(sourceHome, entry.name), join(rootDir, entry.name), 'file')
    }
  }

  const memoryFile = join(rootDir, 'AGENTS.md')
  const promptFile = join(rootDir, 'hermes-rules.md')
  const configFile = join(rootDir, OPENCODE_CONFIG_FILE)
  const globalInstructions = await safeReadFile(join(sourceHome, 'AGENTS.md')) || ''
  const globalConfig = await safeReadFile(join(sourceHome, OPENCODE_CONFIG_FILE))
    || await safeReadFile(join(sourceHome, 'opencode.jsonc'))
    || ''
  await writeFile(memoryFile, globalInstructions, 'utf-8')
  await writeManagedPromptFile(promptFile, systemPrompt, '')
  await writeFile(
    configFile,
    opencodeRuntimeConfig(profile, {}, globalConfig),
    'utf-8',
  )
  const launcherRuntimeConfig = opencodeRuntimeConfig(profile, { systemPrompt: promptFile })
  const env = openCodeRuntimeEnv({
    configDir: rootDir,
    databasePath: join(rootDir, OPENCODE_DATABASE_FILE),
    runtimeConfig: launcherRuntimeConfig,
  })
  const launcherFile = await writeLauncherScript({
    rootDir,
    workspaceDir,
    env,
    command: 'opencode',
    args: [],
  })
  return { rootDir, memoryFile, promptFile, configFile, launcherFile, launcherRuntimeConfig }
}
