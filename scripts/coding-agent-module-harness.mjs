import { existsSync } from 'node:fs'
import { readFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import ts from 'typescript'
import { collectModuleSpecifiers } from './server-module-boundaries.mjs'

const moduleRoot = 'packages/server/src/modules/coding-agents'
const ownedImplementations = new Map([
  ['prepareQwenScopedRuntime', 'services/qwen/'],
  ['prepareKimiScopedRuntime', 'services/kimi/'],
  ['prepareCodeBuddyScopedRuntime', 'services/codebuddy/'],
  ['prepareCopilotScopedRuntime', 'services/copilot/'],
  ['prepareZcodeScopedRuntime', 'services/zcode/'],
  ['resolveZcodeCommand', 'services/zcode/'],
  ['startZcodeChatTurn', 'services/zcode/'],
  ['applyZcodeEvent', 'services/zcode/'],
  ['createOpenCodeConfig', 'services/opencode/'],
  ['prepareOpenCodeBaseConfig', 'services/opencode/'],
  ['startOpenCodeTurn', 'services/opencode/'],
  ['applyOpenCodeLine', 'services/opencode/'],
  ['readOpenCodeMessageModel', 'services/opencode/'],
  ['readCodexTurnModel', 'services/codex/'],
  ['readCodexTurnAccounting', 'services/codex/'],
  ['compactCodexThread', 'services/codex/'],
  ['NativeAcpTurn', 'protocol/acp/'],
])

export function codingAgentModuleViolations(filename, source) {
  const file = filename.replaceAll('\\', '/')
  const relative = file.startsWith(`${moduleRoot}/`) ? file.slice(moduleRoot.length + 1) : null
  if (!relative) return []
  const failures = []
  if (relative.startsWith('services/native/')) failures.push(`${file}: put agent implementations in services/<agent>, and shared ACP in protocol/acp`)
  const folder = relative.match(/^services\/([^/]+)\//)?.[1]
  if (folder && folder !== 'registry' && folder !== 'runtime') {
    for (const specifier of collectModuleSpecifiers(source, file)) {
      const target = path.posix.normalize(path.posix.join(path.posix.dirname(relative), specifier))
      if (target === 'services' || target === 'services/index' || target.startsWith('services/registry/')) {
        failures.push(`${file}: agent services must receive helpers instead of importing the shared registry`)
      }
    }
  }
  const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true)
  for (const statement of tree.statements) {
    const names = ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)
      ? [statement.name?.text]
      : ts.isVariableStatement(statement)
        ? statement.declarationList.declarations.map(declaration => declaration.name.getText(tree))
        : []
    for (const name of names) {
      const owner = ownedImplementations.get(name)
      if (owner && !relative.startsWith(owner)) failures.push(`${file}: ${name} belongs in coding-agents/${owner}`)
    }
  }
  return failures
}

export async function checkCodingAgentModuleBoundaries(root) {
  const failures = []
  const runtimeFile = path.join(root, 'packages/server/src/modules/studio/contracts/agents/runtime.ts')
  const tree = ts.createSourceFile(runtimeFile, await readFile(runtimeFile, 'utf8'), ts.ScriptTarget.Latest, true)
  const codingRuntime = tree.statements.find(statement => ts.isTypeAliasDeclaration(statement) && statement.name.text === 'CodingAgentRuntime')
  for (const member of codingRuntime.type.typeArguments[1].types) {
    const id = member.literal.text
    const file = `${moduleRoot}/services/${id}/definition.ts`
    if (!existsSync(path.join(root, file))) failures.push(`Missing Coding Agent definition: ${file}`)
  }
  async function visit(directory) {
    for (const entry of await readdir(path.join(root, directory), { withFileTypes: true })) {
      const file = `${directory}/${entry.name}`
      if (entry.isDirectory()) await visit(file)
      else if (entry.name.endsWith('.ts')) failures.push(...codingAgentModuleViolations(file, await readFile(path.join(root, file), 'utf8')))
    }
  }
  await visit(moduleRoot)
  return failures
}
