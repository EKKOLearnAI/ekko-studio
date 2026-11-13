#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

export const SERVER_SOURCE_ROOT = 'packages/server/src'
export const TARGET_MODULES = Object.freeze([
  'studio',
  'hermes',
  'ekko',
  'coding-agents',
])

const TARGET_MODULE_SET = new Set(TARGET_MODULES)
const AGENT_MODULE_SET = new Set(['hermes', 'ekko', 'coding-agents'])
const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.mts', '.cts'])
const RESOLUTION_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs']
const STUDIO_AGENT_ENTRY_POINTS = new Set(['contracts', 'public'])
const STUDIO_ROUTE_ENTRY_POINTS = new Set(['contracts', 'public', 'middleware', 'http'])
const LEGACY_APP_COMPATIBILITY_FILE = 'modules/studio/middleware/legacy-app-api.ts'
const LEGACY_STUDIO_API_PREFIXES = [
  '/api/hermes/session-categories',
  '/api/hermes/search/sessions',
  '/api/hermes/group-chat-link',
  '/api/hermes/group-chat',
  '/api/hermes/app-uploads',
  '/api/hermes/performance',
  '/api/hermes/workflows',
  '/api/hermes/sessions',
  '/api/hermes/workspace',
  '/api/hermes/download',
  '/api/hermes/files',
  '/api/hermes/usage',
  '/api/hermes/logs',
  '/api/hermes/mcu',
  '/api/hermes/stt',
  '/api/hermes/tts',
]
const HERMES_STUDIO_FILE_PATTERNS = [
  /^modules\/hermes\/routes\/(?:app-upload|download|files)(?:\/|\.ts$)/,
  /^modules\/hermes\/controllers\/(?:app-upload|download|file-preview|files)(?:\/|\.ts$)/,
  /^modules\/hermes\/services\/files(?:\/|\.ts$)/,
]

function normalizePath(value) {
  return value.replaceAll('\\', '/').replace(/^\.\//, '')
}

function isSourceFile(file) {
  return SOURCE_EXTENSIONS.has(path.posix.extname(file)) && !file.endsWith('.d.ts')
}

function targetModuleInfo(file) {
  const normalized = normalizePath(file)
  const parts = normalized.split('/')
  if (parts[0] !== 'modules') return null

  const moduleName = parts[1] || null
  return {
    architecture: 'target',
    domain: moduleName,
    layer: parts[2] || null,
    moduleName,
    validModule: TARGET_MODULE_SET.has(moduleName),
  }
}

export function classifyServerFile(file) {
  const normalized = normalizePath(file)
  const target = targetModuleInfo(normalized)
  if (target) return target

  if (normalized === 'index.ts' || normalized.startsWith('bootstrap/')) {
    return {
      architecture: 'target',
      domain: 'bootstrap',
      layer: 'bootstrap',
      moduleName: null,
      validModule: true,
    }
  }

  return {
    architecture: 'legacy',
    domain: 'unassigned',
    layer: null,
    moduleName: null,
    validModule: true,
  }
}

export function studioOwnershipFailure(file) {
  const normalized = normalizePath(file)
  if (!HERMES_STUDIO_FILE_PATTERNS.some(pattern => pattern.test(normalized))) return null
  return `${normalized} places Studio-owned file capability under Hermes`
}

export function legacyAppAliasFailure(file, source) {
  const normalized = normalizePath(file)
  if (normalized === LEGACY_APP_COMPATIBILITY_FILE) return null
  const legacyPrefix = LEGACY_STUDIO_API_PREFIXES.find(prefix => source.includes(prefix))
  if (!legacyPrefix) return null
  return `${normalized} declares legacy Studio API ${legacyPrefix}; keep released-client aliases in ${LEGACY_APP_COMPATIBILITY_FILE}`
}

export function collectModuleSpecifiers(source, fileName = 'source.ts') {
  const sourceFile = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    true,
    fileName.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  )
  const specifiers = new Set()

  function addStringLiteral(node) {
    if (node && ts.isStringLiteralLike(node)) specifiers.add(node.text)
  }

  function visit(node) {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      addStringLiteral(node.moduleSpecifier)
    } else if (ts.isImportEqualsDeclaration(node)
      && ts.isExternalModuleReference(node.moduleReference)) {
      addStringLiteral(node.moduleReference.expression)
    } else if (ts.isCallExpression(node) && node.arguments.length >= 1) {
      const isDynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword
      const isRequire = ts.isIdentifier(node.expression) && node.expression.text === 'require'
      if (isDynamicImport || isRequire) addStringLiteral(node.arguments[0])
    }
    ts.forEachChild(node, visit)
  }

  visit(sourceFile)
  return [...specifiers].sort()
}

export function resolveServerImport(fromFile, specifier, allFiles) {
  if (!specifier.startsWith('.')) return null

  const base = path.posix.normalize(path.posix.join(path.posix.dirname(fromFile), specifier))
  const candidates = [base]
  const extension = path.posix.extname(base)

  if (extension) {
    const withoutExtension = base.slice(0, -extension.length)
    for (const candidateExtension of RESOLUTION_EXTENSIONS) {
      candidates.push(`${withoutExtension}${candidateExtension}`)
    }
  } else {
    for (const candidateExtension of RESOLUTION_EXTENSIONS) {
      candidates.push(`${base}${candidateExtension}`)
    }
    for (const candidateExtension of RESOLUTION_EXTENSIONS) {
      candidates.push(`${base}/index${candidateExtension}`)
    }
  }

  for (const candidate of candidates) {
    if (allFiles.has(candidate)) return candidate
  }
  return null
}

export function forbiddenDomainDependency(fromDomain, toDomain) {
  if (fromDomain === 'bootstrap' || fromDomain === toDomain) return false
  if (fromDomain === 'studio') return AGENT_MODULE_SET.has(toDomain)
  return AGENT_MODULE_SET.has(fromDomain) && AGENT_MODULE_SET.has(toDomain)
}

function targetDependencyFailures(fromFile, toFile) {
  const from = classifyServerFile(fromFile)
  const to = classifyServerFile(toFile)
  if (from.architecture !== 'target' || from.domain === 'bootstrap') return []

  const failures = []
  if (to.architecture === 'legacy' && to.domain !== 'bootstrap') {
    failures.push(`${fromFile} must not import legacy server source ${toFile}`)
    return failures
  }

  if (to.architecture !== 'target') return failures
  if (!to.validModule) {
    failures.push(`${fromFile} imports unknown server module ${to.moduleName || '(missing name)'} via ${toFile}`)
    return failures
  }

  if (forbiddenDomainDependency(from.domain, to.domain)) {
    failures.push(`${fromFile} (${from.domain}) must not depend on ${toFile} (${to.domain})`)
    return failures
  }

  if (AGENT_MODULE_SET.has(from.domain) && to.domain === 'studio') {
    const allowedEntryPoints = from.layer === 'routes'
      ? STUDIO_ROUTE_ENTRY_POINTS
      : STUDIO_AGENT_ENTRY_POINTS
    if (!allowedEntryPoints.has(to.layer)) {
      failures.push(
        `${fromFile} must use Studio contracts/public APIs, not Studio internal path ${toFile}`,
      )
    }
  }

  if (from.domain !== to.domain) return failures

  if (from.layer === 'routes'
    && !['routes', 'controllers', 'contracts', 'public', 'middleware', 'http'].includes(to.layer)) {
    failures.push(`${fromFile} is a route and must delegate through controllers instead of ${toFile}`)
  }
  if (from.layer === 'controllers'
    && !['controllers', 'services', 'contracts', 'public', 'http'].includes(to.layer)) {
    failures.push(`${fromFile} is a controller and must delegate through services instead of ${toFile}`)
  }
  if (from.layer === 'services' && ['routes', 'controllers', 'sockets'].includes(to.layer)) {
    failures.push(`${fromFile} is a service and must not depend on transport layer ${toFile}`)
  }

  return failures
}

export function validateTargetDependency(fromFile, toFile) {
  return targetDependencyFailures(normalizePath(fromFile), normalizePath(toFile))
}

function gitOutput(root, args) {
  return execFileSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}

function repositoryServerFiles(root) {
  const output = gitOutput(root, [
    'ls-files',
    '--cached',
    '--others',
    '--exclude-standard',
    '--',
    SERVER_SOURCE_ROOT,
  ])
  return output
    .split(/\r?\n/)
    .map(file => file.trim())
    .filter(Boolean)
    .map(file => normalizePath(path.posix.relative(SERVER_SOURCE_ROOT, file)))
    .filter(file => existsSync(path.join(root, SERVER_SOURCE_ROOT, file)))
    .sort()
}

async function collectDependencyEdges(sourceRoot, sourceFiles) {
  const allFiles = new Set(sourceFiles)
  const dependencies = []
  for (const from of sourceFiles.filter(isSourceFile)) {
    const source = await readFile(path.join(sourceRoot, from), 'utf8')
    for (const specifier of collectModuleSpecifiers(source, from)) {
      const to = resolveServerImport(from, specifier, allFiles)
      if (to) dependencies.push({ from, to })
    }
  }
  return dependencies
}

export async function inspectServerModuleBoundaries(root = process.cwd()) {
  const sourceRoot = path.join(root, SERVER_SOURCE_ROOT)
  const sourceFiles = repositoryServerFiles(root)
  const dependencies = await collectDependencyEdges(sourceRoot, sourceFiles)
  const failures = []

  for (const file of sourceFiles) {
    const info = classifyServerFile(file)
    if (info.architecture === 'target' && info.domain !== 'bootstrap' && !info.validModule) {
      failures.push(
        `${SERVER_SOURCE_ROOT}/${file} uses unknown module ${info.moduleName || '(missing name)'}; `
        + `expected one of: ${TARGET_MODULES.join(', ')}`,
      )
    }
    if (isSourceFile(file) && info.architecture === 'legacy') {
      failures.push(
        `${SERVER_SOURCE_ROOT}/${file} is outside modules/ and bootstrap/; legacy server source is not allowed`,
      )
    }
    const ownershipFailure = studioOwnershipFailure(file)
    if (ownershipFailure) failures.push(`${SERVER_SOURCE_ROOT}/${ownershipFailure}`)
    if (isSourceFile(file)) {
      const source = await readFile(path.join(sourceRoot, file), 'utf8')
      const aliasFailure = legacyAppAliasFailure(file, source)
      if (aliasFailure) failures.push(`${SERVER_SOURCE_ROOT}/${aliasFailure}`)
    }
  }

  for (const dependency of dependencies) {
    for (const failure of targetDependencyFailures(dependency.from, dependency.to)) {
      failures.push(`${SERVER_SOURCE_ROOT}/${failure}`)
    }
  }

  return { dependencies, failures, sourceFiles }
}

export async function checkServerModuleBoundaries(root = process.cwd()) {
  const inspection = await inspectServerModuleBoundaries(root)
  return [...inspection.failures]
}

async function runCli() {
  const root = process.cwd()
  const failures = await checkServerModuleBoundaries(root)
  if (failures.length > 0) {
    console.error('Server module boundary check failed:')
    for (const failure of failures) console.error(`- ${failure}`)
    process.exitCode = 1
    return
  }
  console.log('Server module boundary check passed')
}

const isDirectRun = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isDirectRun) await runCli()
