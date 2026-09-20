import { existsSync } from 'fs'
import { copyFile, cp, lstat, mkdir, readFile, readdir, writeFile } from 'fs/promises'
import { join } from 'path'
import { writeManagedPromptFile } from '../prompt-file'
import { GROK_API_KEY_ENV, GROK_PROVIDER_ID } from './definition'

const MANAGED_MCP_NAMES = new Set([
  'hermes-studio-api',
  'hermes-studio-browser',
  'hermes-studio-devices',
  'hermes-studio-use',
  'ekko-studio-api',
  'ekko-studio-browser',
  'ekko-studio-devices',
  'ekko-studio-use',
  'ekko-studio-plan',
  'ekko-studio-interaction',
  'hermes-studio',
  'hermes-studio-mcp',
  'ekko-studio-mcp',
  'hermes-web-ui-mcp',
])
const COPIED_GLOBAL_DIRS = new Set([
  'agents',
  'hooks',
  'personas',
  'plugins',
  'roles',
  'rules',
  'skills',
  'workflows',
])
const MANAGED_MCP_MARKER = 'HERMES_WEB_UI_MANAGED_MCP'
const SCOPED_IDENTITY_BEGIN = '<!-- BEGIN EKKO STUDIO GROK SCOPED IDENTITY -->'
const SCOPED_IDENTITY_END = '<!-- END EKKO STUDIO GROK SCOPED IDENTITY -->'

export interface GrokRuntimeFiles {
  promptFile: string
  files: Array<{ key: string; path: string; absolutePath: string }>
}

async function readText(path: string): Promise<string> {
  try {
    return await readFile(path, 'utf-8')
  } catch {
    return ''
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path)
    return true
  } catch (err: any) {
    if (err?.code === 'ENOENT') return false
    throw err
  }
}

function mcpServerName(header: string): string {
  const match = header.match(/^\s*\[mcp_servers\.(?:"([^"]+)"|([^\].]+))(?:\.[^\]]+)?\]\s*$/)
  return String(match?.[1] || match?.[2] || '').trim()
}

function grokConfigBlocks(content: string): string[][] {
  const blocks: string[][] = []
  let current: string[] = []
  for (const line of String(content || '').split(/\r?\n/)) {
    if (/^\s*\[/.test(line) && current.length > 0) {
      blocks.push(current)
      current = []
    }
    current.push(line)
  }
  if (current.length > 0) blocks.push(current)
  return blocks
}

function joinGrokConfigBlocks(blocks: string[][]): string {
  return blocks
    .map(block => block.join('\n').trimEnd())
    .filter(block => block.trim())
    .join('\n\n')
    .trim()
}

function isManagedMcpBlock(block: string[]): boolean {
  const name = mcpServerName(block[0] || '')
  return Boolean(name) && (
    MANAGED_MCP_NAMES.has(name) ||
    block.join('\n').includes(MANAGED_MCP_MARKER)
  )
}

export function grokSettingsConfig(content: string): string {
  const value = joinGrokConfigBlocks(
    grokConfigBlocks(content).filter(block => !mcpServerName(block[0] || '')),
  )
  return value ? `${value}\n` : ''
}

interface TomlArrayScanState {
  quote: '"' | "'" | null
  multiline: boolean
}

function scanTomlArrayBrackets(line: string, state: TomlArrayScanState): number {
  let delta = 0
  let escaped = false
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index]
    if (state.quote) {
      if (state.multiline) {
        if (state.quote === '"' && char === '\\') {
          escaped = !escaped
          continue
        }
        if (char === state.quote && !escaped) {
          let quoteCount = 1
          while (line[index + quoteCount] === state.quote) quoteCount += 1
          if (quoteCount >= 3) {
            state.quote = null
            state.multiline = false
            index += quoteCount - 1
          }
        }
        escaped = false
        continue
      }
      if (state.quote === '"' && char === '\\' && !escaped) {
        escaped = true
        continue
      }
      if (char === state.quote && !escaped) {
        state.quote = null
      }
      escaped = false
      continue
    }
    if (char === '#') break
    if (char === '"' || char === "'") {
      state.quote = char
      state.multiline = line.slice(index, index + 3) === char.repeat(3)
      if (state.multiline) index += 2
      continue
    }
    if (char === '[') delta += 1
    else if (char === ']') delta -= 1
  }
  return delta
}

function isManagedGrokSection(section: string): boolean {
  return section === 'models'
    || section.startsWith('model.')
    || section.startsWith('mcp_servers.')
    || section === 'auth'
    || section.startsWith('auth.')
    || section === 'account'
    || section.startsWith('account.')
}

export function grokRuntimeSettingsConfig(...contents: Array<string | null | undefined>): string {
  const topLevel = new Map<string, string>()
  const sections = new Map<string, { header: string; lines: string[] }>()
  const runtimeKeys = new Set([
    'model',
    'default',
    'default_reasoning_effort',
    'context_window',
    'max_completion_tokens',
    'api_key',
    'access_token',
    'refresh_token',
    'auth_token',
  ])

  let arraySectionIndex = 0
  for (const content of contents) {
    let section = ''
    let sectionKey = ''
    const sectionScanState: TomlArrayScanState = { quote: null, multiline: false }
    const lines = String(content || '').split(/\r?\n/)
    for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
      const line = lines[lineIndex]
      if (sectionScanState.multiline) {
        const sectionBlock = sections.get(sectionKey)
        if (sectionBlock && !isManagedGrokSection(section)) sectionBlock.lines.push(line)
        scanTomlArrayBrackets(line, sectionScanState)
        continue
      }
      const arrayHeader = line.match(/^\s*\[\[([^\]]+)\]\]\s*$/)
      if (arrayHeader) {
        section = arrayHeader[1].trim()
        if (isManagedGrokSection(section)) {
          sectionKey = ''
          continue
        }
        sectionKey = `array:${arraySectionIndex++}`
        sections.set(sectionKey, { header: line.trim(), lines: [] })
        continue
      }
      const tableHeader = line.match(/^\s*\[([^\]]+)\]\s*$/)
      if (tableHeader) {
        section = tableHeader[1].trim()
        sectionKey = `table:${section}`
        if (!sections.has(sectionKey)) sections.set(sectionKey, { header: line.trim(), lines: [] })
        continue
      }
      const assignment = line.match(/^\s*([A-Za-z0-9_.-]+)\s*=/)
      if (!section) {
        if (assignment && !runtimeKeys.has(assignment[1])) {
          let mergedLine = line
          const scanState: TomlArrayScanState = { quote: null, multiline: false }
          let bracketDepth = scanTomlArrayBrackets(line.slice(line.indexOf('=') + 1), scanState)
          while ((bracketDepth > 0 || scanState.multiline) && lineIndex + 1 < lines.length) {
            lineIndex += 1
            const nextLine = lines[lineIndex]
            mergedLine += `\n${nextLine}`
            bracketDepth += scanTomlArrayBrackets(nextLine, scanState)
          }
          topLevel.set(assignment[1], mergedLine)
        }
        continue
      }
      if (isManagedGrokSection(section)) {
        scanTomlArrayBrackets(line, sectionScanState)
        continue
      }
      const sectionBlock = sections.get(sectionKey)
      if (sectionBlock && line.trim()) sectionBlock.lines.push(line)
      scanTomlArrayBrackets(line, sectionScanState)
    }
  }

  const blocks = [...topLevel.values()]
  for (const [key, { header, lines }] of sections) {
    if (lines.length || key.startsWith('array:')) {
      blocks.push(lines.length ? `${header}\n${lines.join('\n')}` : header)
    }
  }
  return blocks.join('\n\n')
}

export function grokUserMcpConfig(content: string): string {
  const value = joinGrokConfigBlocks(
    grokConfigBlocks(content).filter(block => (
      Boolean(mcpServerName(block[0] || '')) && !isManagedMcpBlock(block)
    )),
  )
  return value ? `${value}\n` : ''
}

export function stripManagedGrokMcp(content: string): string {
  return joinGrokConfigBlocks(grokConfigBlocks(content)
    .filter((block) => {
      const name = mcpServerName(block[0] || '')
      if (!name) return true
      return !isManagedMcpBlock(block)
    }))
}

export function mergeGrokSettingsConfig(existingContent: string, settingsContent: string): string {
  return [grokSettingsConfig(settingsContent).trim(), grokUserMcpConfig(existingContent).trim()]
    .filter(Boolean).join('\n\n').concat('\n')
}

export function mergeGrokUserMcpConfig(existingContent: string, mcpContent: string): string {
  return [grokSettingsConfig(existingContent).trim(), grokUserMcpConfig(mcpContent).trim()]
    .filter(Boolean).join('\n\n').concat('\n')
}

export function mergeGrokConfigWithManagedMcp(content: string, managedMcpToml: string): string {
  return [stripManagedGrokMcp(content), managedMcpToml.trim()]
    .filter(Boolean)
    .join('\n\n')
    .concat('\n')
}

async function copyGlobalDirectory(source: string, target: string): Promise<void> {
  if (await pathExists(target)) return
  await cp(source, target, {
    recursive: true,
    dereference: true,
    errorOnExist: false,
    force: false,
    preserveTimestamps: true,
  })
}

async function syncSkillsDirectory(source: string, target: string): Promise<void> {
  if (!existsSync(source)) return
  await cp(source, target, {
    recursive: true, dereference: true, errorOnExist: false, force: true, preserveTimestamps: true,
  })
}

async function syncGlobalSkillsDirectories(sourceHome: string, rootDir: string): Promise<void> {
  await syncSkillsDirectory(join(sourceHome, 'skills'), join(rootDir, 'skills'))
  await syncSkillsDirectory(join(sourceHome, '..', '.agents', 'skills'), join(rootDir, 'skills'))
}

function shouldCopyGlobalFile(name: string): boolean {
  if (name === 'AGENTS.md' || name === 'config.toml') return false
  if (name.endsWith('.lock') || name.endsWith('.pid') || name.endsWith('.sock')) return false
  if (name.endsWith('.db') || name.endsWith('.db-shm') || name.endsWith('.db-wal')) return false
  if (name.endsWith('.sqlite') || name.endsWith('.sqlite-shm') || name.endsWith('.sqlite-wal')) return false
  return !name.endsWith('.log')
}

export async function prepareGlobalGrokRuntime(input: {
  sourceHome: string
  rootDir: string
  systemPrompt: string
  managedMcpToml: string
}): Promise<GrokRuntimeFiles> {
  await mkdir(input.rootDir, { recursive: true, mode: 0o700 })
  if (input.sourceHome !== input.rootDir && existsSync(input.sourceHome)) {
    for (const entry of await readdir(input.sourceHome, { withFileTypes: true })) {
      const source = join(input.sourceHome, entry.name)
      const target = join(input.rootDir, entry.name)
      if (entry.isFile() && shouldCopyGlobalFile(entry.name)) {
        if (!await pathExists(target)) await copyFile(source, target)
      } else if (entry.isDirectory() && COPIED_GLOBAL_DIRS.has(entry.name)) {
        await copyGlobalDirectory(source, target)
      }
    }
  }
  await syncGlobalSkillsDirectories(input.sourceHome, input.rootDir)

  const configPath = join(input.rootDir, 'config.toml')
  const promptFile = join(input.rootDir, 'AGENTS.md')
  await writeFile(
    configPath,
    mergeGrokConfigWithManagedMcp(await readText(join(input.sourceHome, 'config.toml')), input.managedMcpToml),
    'utf-8',
  )
  await writeManagedPromptFile(
    promptFile,
    input.systemPrompt,
    await readText(join(input.sourceHome, 'AGENTS.md')),
  )
  return {
    promptFile,
    files: [
      { key: 'config', path: 'config.toml', absolutePath: configPath },
      { key: 'agents', path: 'AGENTS.md', absolutePath: promptFile },
    ],
  }
}

function tomlString(value: string): string {
  return JSON.stringify(value)
}

function promptIdentityValue(value: string): string {
  return String(value || '').replace(/[\r\n]+/g, ' ').trim()
}

export function scopedGrokIdentityPrompt(provider: string, model: string): string {
  const providerId = promptIdentityValue(provider)
  const modelId = promptIdentityValue(model)
  return [
    SCOPED_IDENTITY_BEGIN,
    '## Runtime model identity',
    '',
    'You are running inside Grok Build as the coding-agent harness. Grok Build is the shell, not necessarily the upstream language model.',
    `The selected upstream provider is \`${providerId}\` and the exact model ID is \`${modelId}\`.`,
    `When asked which model you are, answer with \`${modelId}\` and, when useful, provider \`${providerId}\`. Do not answer only "Grok" unless that is the selected model ID.`,
    SCOPED_IDENTITY_END,
  ].join('\n')
}

export async function prepareScopedGrokRuntime(input: {
  sourceHome?: string
  rootDir: string
  provider: string
  model: string
  displayName: string
  proxyBaseUrl: string
  contextWindow: number
  outputLimit: number
  autoCompactThresholdPercent?: number
  reasoningEffort: string
  systemPrompt: string
  userInstructions: string
  settingsContent?: string
  managedMcpToml: string
}): Promise<GrokRuntimeFiles> {
  await mkdir(input.rootDir, { recursive: true, mode: 0o700 })
  if (input.sourceHome) await syncGlobalSkillsDirectories(input.sourceHome, input.rootDir)
  const configPath = join(input.rootDir, 'config.toml')
  const promptFile = join(input.rootDir, 'AGENTS.md')
  const config = [
    grokRuntimeSettingsConfig(input.settingsContent),
    '[models]',
    `default = ${tomlString(GROK_PROVIDER_ID)}`,
    ...(input.reasoningEffort ? [`default_reasoning_effort = ${tomlString(input.reasoningEffort)}`] : []),
    '',
    `[model.${GROK_PROVIDER_ID}]`,
    `model = ${tomlString(input.model)}`,
    `name = ${tomlString(input.displayName)}`,
    `base_url = ${tomlString(input.proxyBaseUrl)}`,
    `env_key = ${tomlString(GROK_API_KEY_ENV)}`,
    'api_backend = "responses"',
    `context_window = ${Math.max(1, Math.floor(input.contextWindow))}`,
    `auto_compact_threshold_percent = ${Math.max(0, Math.min(100, Math.round(input.autoCompactThresholdPercent ?? 85)))}`,
    `max_completion_tokens = ${Math.max(1, Math.floor(input.outputLimit))}`,
    '',
    input.managedMcpToml.trim(),
    '',
  ].join('\n')
  await writeFile(configPath, config, 'utf-8')
  await writeManagedPromptFile(
    promptFile,
    input.systemPrompt,
    [scopedGrokIdentityPrompt(input.provider, input.model), input.userInstructions.trim()]
      .filter(Boolean)
      .join('\n\n'),
  )
  return {
    promptFile,
    files: [
      { key: 'config', path: 'config.toml', absolutePath: configPath },
      { key: 'agents', path: 'AGENTS.md', absolutePath: promptFile },
    ],
  }
}
