import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import ts from 'typescript'
import { parse as parseVue } from 'vue/compiler-sfc'

const manifestPath = 'scripts/jev-integrations.json'
const sourceRoots = ['packages/server/src', 'packages/client/src', 'packages/ekko-agent/src']
const sharedFields = new Set(['baseUrl', 'model', 'apiKey', 'timeoutMs'])
// These implement transport/configuration, or explicit manual API/connection tests.
// Business integrations must be registered instead of extending this allowlist.
const infrastructure = new Set([
  'packages/server/src/bootstrap/routes.ts',
  'packages/server/src/modules/studio/services/jev/client.ts',
  'packages/server/src/modules/studio/services/jev/settings.ts',
  'packages/server/src/modules/studio/public/jev.ts',
  'packages/server/src/modules/studio/controllers/jev.ts',
  'packages/server/src/modules/studio/routes/jev.ts',
  'packages/client/src/api/studio/jev.ts',
  'packages/client/src/components/hermes/models/JevSettingsPanel.vue',
  ...['config.ts', 'config-store.ts', 'index.ts', 'setup.ts', 'runtime/runtime.ts',
    'runtime/types.ts', 'jev/client.ts', 'jev/config.ts', 'jev/index.ts']
    .map(file => `packages/ekko-agent/src/${file}`),
])
const evaluationInfrastructure = new Set([
  'packages/server/src/modules/studio/services/jev/client.ts',
  'packages/server/src/modules/studio/controllers/jev.ts',
  'packages/ekko-agent/src/jev/client.ts',
])
const sdkInfrastructure = new Set([
  'packages/server/src/modules/studio/services/jev/client.ts',
  'packages/server/src/modules/studio/public/jev.ts',
  'packages/ekko-agent/src/jev/client.ts',
  'packages/ekko-agent/src/jev/index.ts',
  'packages/client/src/api/studio/jev.ts',
])

function walk(node, visit) {
  visit(node)
  ts.forEachChild(node, child => walk(child, visit))
}

function parseSource(file, source) {
  if (file.endsWith('.vue')) {
    const { descriptor } = parseVue(source)
    source = [descriptor.script?.content, descriptor.scriptSetup?.content].filter(Boolean).join('\n')
  }
  return ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
}

function name(node) { return node?.text ?? node?.getText() }
function member(node) {
  if (ts.isPropertyAccessExpression(node)) return node.name.text
  if (ts.isElementAccessExpression(node) && ts.isStringLiteralLike(node.argumentExpression)) return node.argumentExpression.text
}
function unwrapped(node) {
  while (node && (ts.isAsExpression(node) || ts.isParenthesizedExpression(node) || ts.isSatisfiesExpression(node))) node = node.expression
  return node
}
function objectProperties(node) {
  node = unwrapped(node)
  if (node && ts.isCallExpression(node) && node.expression.getText() === 'Object.freeze') node = node.arguments[0]
  return new Map(node && ts.isObjectLiteralExpression(node)
    ? node.properties.filter(p => p.name).map(p => [name(p.name), p.initializer ?? p.name]) : [])
}
function variableObject(ast, variable) {
  let properties = new Map()
  walk(ast, node => {
    if (ts.isVariableDeclaration(node) && name(node.name) === variable) properties = objectProperties(node.initializer)
  })
  return properties
}
function interfaceFields(ast, identifier = 'JevSettings') {
  const node = ast.statements.find(n => ts.isInterfaceDeclaration(n) && n.name.text === identifier)
  return new Map(node?.members.filter(n => n.name).map(n => [name(n.name), n.type?.getText()]) ?? [])
}
function functionNode(ast, identifier) {
  return ast.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === identifier)
}

/** Inspect syntax rather than comments; import aliases still identify a consumer. */
export function jevUsage(file, source) {
  const ast = parseSource(file, source)
  let used = false
  let evaluates = false
  let directSdk = false
  const evaluators = new Set(['evaluateJev', 'evaluateMemory'])
  walk(ast, node => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      if (!node.moduleSpecifier || !ts.isStringLiteralLike(node.moduleSpecifier)) return
      const specifier = node.moduleSpecifier.text
      const clause = ts.isImportDeclaration(node) ? node.importClause : node.exportClause
      if (node.isTypeOnly || clause?.isTypeOnly) return
      const bindings = clause?.namedBindings ?? clause
      const elements = bindings && (ts.isNamedImports(bindings) || ts.isNamedExports(bindings)) ? bindings.elements : []
      if (elements.length && elements.every(item => item.isTypeOnly)) return
      for (const item of elements) {
        if (item.isTypeOnly) continue
        const imported = name(item.propertyName ?? item.name)
        if (['evaluateJev', 'evaluateMemory'].includes(imported)) evaluators.add(name(item.name))
        if (/^(EkkoJevClient|evaluateJev|getJevRuntimeConfig)$/.test(imported)) used = true
      }
      if (/(?:^|\/)jev(?:\/|$|\.)/.test(specifier)) used = true
      if (specifier === '@typesafe-ai/sdk') { used = true; directSdk = true }
    }
    if (member(node) === 'jev' || ts.isBindingElement(node) && name(node.propertyName ?? node.name) === 'jev') used = true
    if (ts.isStringLiteralLike(node) && /\/api\/studio\/jev\/(?:evaluate|test)/.test(node.text)) used = true
    if (ts.isCallExpression(node)) {
      if ((node.expression.kind === ts.SyntaxKind.ImportKeyword || name(node.expression) === 'require')
        && node.arguments[0] && ts.isStringLiteralLike(node.arguments[0])) {
        const specifier = node.arguments[0].text
        if (/(?:^|\/)jev(?:\/|$|\.)/.test(specifier)) used = true
        if (specifier === '@typesafe-ai/sdk') { used = true; directSdk = true }
      }
      const method = member(node.expression) ?? name(node.expression)
      if (evaluators.has(method) || ['systemOne', 'tryEvaluate'].includes(method)
        || method === 'evaluate' && /jev/i.test(node.expression.getText())) {
        used = true
        evaluates = true
      }
    }
  })
  return { used, evaluates, directSdk }
}

function templateElements(source) {
  const { descriptor } = parseVue(source)
  const elements = []
  function visit(node) {
    if (node.type === 1) {
      if (node.props.some(p => p.name === 'if' && p.exp?.content === 'false')) return
      elements.push(node)
    }
    for (const child of node.children ?? []) visit(child)
  }
  if (descriptor.template?.ast) visit(descriptor.template.ast)
  return elements
}

function editableControls(source) {
  const controls = []
  for (const node of templateElements(source)) {
    const props = node.props
    const disabled = props.some(p => ['disabled', 'readonly'].includes(p.name)
      || p.name === 'bind' && ['disabled', 'readonly'].includes(p.arg?.content) && p.exp?.content === 'true')
    if (disabled) continue
    const model = props.find(p => p.name === 'model' && p.arg?.content === 'value')
    const value = props.find(p => p.name === 'bind' && p.arg?.content === 'value')
    const update = props.find(p => p.name === 'on' && p.arg?.content === 'update:value')
    const binding = model?.exp?.content ?? value?.exp?.content
    let writable = Boolean(model)
    if (binding && update?.exp) walk(parseSource('update.ts', update.exp.content), node => {
      if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken
        && node.left.getText().replaceAll('!', '') === binding) writable = true
    })
    if (binding && writable) controls.push({ tag: node.tag, binding })
  }
  return controls
}

/** Pure check, also used by mutation tests with missing controls and unregistered consumers. */
export function jevHarnessViolations(sources, manifest) {
  const failures = []
  const fail = message => failures.push(`JEV: ${message}`)
  const get = file => {
    if (!sources.has(file)) fail(`missing required file ${file}`)
    return sources.get(file) ?? ''
  }
  const { settings, integrations } = manifest
  if (!settings?.fields || !Array.isArray(integrations)) return ['JEV: invalid integration manifest']
  const server = parseSource(settings.server, get(settings.server))
  const client = parseSource(settings.client, get(settings.client))
  const formSource = get(settings.form)
  const form = parseSource(settings.form, formSource)
  const defaults = variableObject(server, 'defaults')
  const serverFields = interfaceFields(server)
  const clientFields = interfaceFields(client)
  const controls = editableControls(formSource)
  if (!settings.page?.startsWith('/#/') || !settings.host || !settings.component
    || !templateElements(get(settings.host)).some(node => node.tag === settings.component)) {
    fail('the settings form must be mounted in its declared frontend page')
  }
  const savedFields = new Set()
  walk(form, node => {
    if (!ts.isCallExpression(node) || name(node.expression) !== 'saveJevSettings' || !node.arguments[1]) return
    walk(node.arguments[1], property => {
      if (ts.isPropertyAssignment(property) || ts.isShorthandPropertyAssignment(property)) savedFields.add(name(property.name))
    })
  })
  const returnedFields = new Set()
  const publicSettings = functionNode(server, 'publicSettings')
  if (publicSettings) walk(publicSettings, node => {
    if (ts.isReturnStatement(node)) for (const key of objectProperties(node.expression).keys()) returnedFields.add(key)
  })
  const acceptedFields = new Set()
  const assignedFields = new Set()
  const normalize = functionNode(server, 'normalize')
  if (normalize) walk(normalize, node => {
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken
      && ts.isPropertyAccessExpression(node.left) && name(node.left.expression) === 'next') assignedFields.add(member(node.left))
    if (ts.isForOfStatement(node) && ts.isArrayLiteralExpression(unwrapped(node.expression))) {
      let writesNext = false
      walk(node.statement, child => {
        if (ts.isBinaryExpression(child) && child.operatorToken.kind === ts.SyntaxKind.EqualsToken
          && ts.isElementAccessExpression(child.left) && name(child.left.expression) === 'next') writesNext = true
      })
      if (writesNext) for (const field of unwrapped(node.expression).elements) if (ts.isStringLiteralLike(field)) assignedFields.add(field.text)
    }
    if (ts.isCallExpression(node) && member(node.expression) === 'includes'
      && ts.isPropertyAccessExpression(node.expression) && ts.isArrayLiteralExpression(node.expression.expression)) {
      for (const field of node.expression.expression.elements) if (ts.isStringLiteralLike(field)) acceptedFields.add(field.text)
    }
  })
  for (const key of new Set([...defaults.keys(), ...serverFields.keys(), ...clientFields.keys()])) {
    if (key !== 'hasApiKey' && !settings.fields[key]) fail(`${key} has no registered frontend configuration entry`)
  }
  for (const [key, field] of Object.entries(settings.fields)) {
    if (!defaults.has(key) || !acceptedFields.has(key) || !assignedFields.has(key)) fail(`${key} must have a persisted default and be accepted by settings validation and normalization`)
    if (key !== 'apiKey' && (!serverFields.has(key) || serverFields.get(key) !== clientFields.get(key) || !returnedFields.has(key))) fail(`${key} must round-trip through matching server and client settings`)
    if (!controls.some(control => control.tag === field.control && control.binding === field.binding)) fail(`${key} needs an editable ${field.control} bound to ${field.binding} in ${settings.form}`)
    if (!savedFields.has(key)) fail(`${key} is not submitted by ${settings.form}`)
    for (const [file, source] of sources) {
      if (!/^packages\/client\/src\/i18n\/locales\/[^/]+\.ts$/.test(file)) continue
      const keys = field.label?.split('.') ?? []
      let node = parseSource(file, source).statements.find(ts.isExportAssignment)?.expression
      for (const part of keys) node = objectProperties(node).get(part)
      if (!keys.length || !node) fail(`${key} is missing label ${field.label} in ${file}`)
    }
  }
  const owners = new Map()
  const consumerFiles = new Map()
  const ids = new Set()
  for (const integration of integrations) {
    const { id, enabledKey, options, status } = integration
    if (!id || ids.has(id) || !integration.purpose?.trim()) fail(`integration ${id} needs a unique id and purpose`)
    ids.add(id)
    if (!['configuration-only', 'active'].includes(status)) fail(`${id} needs an explicit configuration-only or active status`)
    if (!enabledKey || !Array.isArray(options)) { fail(`${id} must declare an independent switch and options list`); continue }
    if (sharedFields.has(enabledKey) || serverFields.get(enabledKey) !== 'boolean' || clientFields.get(enabledKey) !== 'boolean'
      || defaults.get(enabledKey)?.kind !== ts.SyntaxKind.FalseKeyword || settings.fields[enabledKey]?.control !== 'NSwitch') {
      fail(`${id} requires its own boolean switch with a false default and frontend NSwitch`)
    }
    for (const key of [enabledKey, ...options]) {
      if (owners.has(key) || sharedFields.has(key)) fail(`${id}: ${key} must belong to one integration; shared provider settings are not feature switches`)
      owners.set(key, id)
      if (!settings.fields[key]) fail(`${id}: ${key} has no frontend configuration entry`)
    }
    if (!integration.sources?.length || !integration.tests?.length) fail(`${id} must list concrete source and regression test files`)
    for (const file of integration.sources ?? []) {
      const usage = jevUsage(file, get(file))
      if (evaluationInfrastructure.has(file) || infrastructure.has(file) && !usage.evaluates) fail(`${id}: ${file} is infrastructure, not a business integration`)
      if (!usage.used) fail(`${id}: ${file} no longer uses JEV; remove the stale registration`)
      if (status === 'configuration-only' && usage.evaluates) fail(`${id}: configuration-only registration cannot evaluate JEV`)
      consumerFiles.set(file, id)
    }
    for (const file of integration.tests ?? []) get(file)
    if (integration.runtimeConfig) {
      const runtime = integration.runtimeConfig
      const ast = parseSource(runtime.file, get(runtime.file))
      if (interfaceFields(ast, runtime.interface).get(runtime.enabledKey) !== 'boolean'
        || variableObject(ast, runtime.defaults).get(runtime.enabledKey)?.kind !== ts.SyntaxKind.FalseKeyword) fail(`${id}: standalone runtime switch must also default to false`)
      const mapping = functionNode(server, runtime.mappingFunction)
      let mapped = false
      if (mapping) walk(mapping, node => {
        if (ts.isReturnStatement(node) && name(objectProperties(node.expression).get(runtime.enabledKey)) === enabledKey) mapped = true
      })
      if (!mapped) fail(`${id}: ${runtime.mappingFunction} must map ${enabledKey} to ${runtime.enabledKey}`)
    }
  }
  for (const key of Object.keys(settings.fields)) if (!sharedFields.has(key) && !owners.has(key)) fail(`${key} must be owned by a registered JEV integration`)
  for (const [file, source] of sources) {
    if (!sourceRoots.some(root => file.startsWith(`${root}/`))) continue
    if (!/jev|typesafe|systemOne|tryEvaluate/i.test(source)) continue
    const usage = jevUsage(file, source)
    if (usage.directSdk && !sdkInfrastructure.has(file)) fail(`${file}: business integrations must use the public JEV facade, not the provider SDK`)
    // Wiring can stay in runtime/setup; a new evaluation there still needs registration.
    if (evaluationInfrastructure.has(file) || infrastructure.has(file) && !usage.evaluates) continue
    if (usage.used && !consumerFiles.has(file)) fail(`${file} is an unregistered JEV integration; register its switch and frontend options in ${manifestPath}`)
  }
  return failures
}

export async function checkJevIntegrations(root) {
  const manifest = JSON.parse(await readFile(path.join(root, manifestPath), 'utf8'))
  const sources = new Map()
  async function visit(directory) {
    for (const item of await readdir(path.join(root, directory), { withFileTypes: true })) {
      const file = `${directory}/${item.name}`
      if (item.isDirectory()) await visit(file)
      else if (/\.(?:[cm]?ts|tsx|[cm]?js|vue)$/.test(item.name)) sources.set(file, await readFile(path.join(root, file), 'utf8'))
    }
  }
  await Promise.all(sourceRoots.map(visit))
  for (const integration of manifest.integrations) for (const file of integration.tests ?? []) {
    try { sources.set(file, await readFile(path.join(root, file), 'utf8')) } catch (error) { if (error.code !== 'ENOENT') throw error }
  }
  return jevHarnessViolations(sources, manifest)
}
