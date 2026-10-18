import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import ts from 'typescript'
import { parse as parseVue } from 'vue/compiler-sfc'
import scss from 'postcss-scss'
import { list } from 'postcss'

const clientRoot = 'packages/client/src'
const baselinePath = 'scripts/ui-theme-baseline.json'
// Only palette definitions and theme adapters may define arbitrary theme colors.
const infrastructure = new Set([
  'styles/variables.scss', 'styles/theme.ts', 'styles/theme-appearance.ts',
  'styles/_theme-surfaces.scss',
].map(file => `${clientRoot}/${file}`))
const surfaceRegions = new Set(['card', 'input'])
const stateSelector = /:(?:hover|active|focus[\w-]*|disabled|checked)|(?:--|\.)(?:active|selected|disabled|error|success|warning)\b/
const themeFill = /var\(\s*--(?:theme-(?:chrome|sidebar|content|card|input|overlay|userMessage|assistantMessage)-bg|card-container-bg|message-theme-bg)\b/
const semanticFill = /(?:var\(\s*--|\$)(?:accent[\w-]*|success[\w-]*|error[\w-]*|warning[\w-]*|info[\w-]*|text[\w-]*|border[\w-]*)(?:\b)/
const colorLiteral = /#[\da-f]{3,8}\b|\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\(\s*[-+.\d]|\b(?:white|black|red|blue|green|yellow|gray|grey|orange|purple|pink|navy|teal|silver|maroon|lime|olive|aqua|fuchsia|rebeccapurple)\b/i
const normalize = text => text.replace(/\s+/g, ' ').trim()
const cssProperty = name => name.startsWith('--') ? name : name.replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`)

// Ignore literal preset fallbacks inside a token, but inspect colors outside it.
function withoutTokens(value) {
  let result = ''
  for (let i = 0; i < value.length; i++) {
    if (/^(?:var|url)\(/i.test(value.slice(i))) {
      let depth = 0
      do {
        if (value[i] === '(') depth++
        if (value[i] === ')') depth--
        i++
      } while (i < value.length && (depth > 0 || value[i - 1] !== ')'))
      i--
    } else result += value[i]
  }
  return result
}

function selectorOf(node) {
  const parents = []
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (parent.type === 'rule') parents.unshift(parent.selector)
  }
  let selectors = ['']
  for (const parent of parents) {
    selectors = selectors.flatMap(outer => list.comma(parent).map(inner =>
      inner.includes('&') ? inner.replaceAll('&', outer) : `${outer} ${inner}`))
  }
  return normalize(selectors.join(', ')) || '<root>'
}

/** Full-tree source inspection; no Git history or running server required. */
export function uiThemeFindings(file, source) {
  if (infrastructure.has(file)) return []
  const findings = []
  const owners = new Set()
  const add = (rule, location, property, value, line = 1) => findings.push({
    file, line, rule, key: `${rule} | ${normalize(location)} | ${property}: ${normalize(value)}`,
  })
  function isSurface(selector) {
    // Match the styled element, not an ancestor that happens to be a surface.
    return selector.split(',').some(branch => {
      const terminal = branch.replace(/:[\w-]+\([^()]*\)/g, '').trim().split(/\s+|[>+~]/).filter(Boolean).at(-1) || ''
      return /\[data-theme-surface/.test(terminal) || [...terminal.matchAll(/\.([\w-]+)/g)].some(match => owners.has(match[1]))
    })
  }
  function inspect(property, value, location, line, owned = false, exception = '') {
    property = cssProperty(property)
    const before = findings.length
    const state = stateSelector.test(location)
    const bare = withoutTokens(value)
    const isFill = /^(?:background|background-color|background-image)$/.test(property)
    const theme = themeFill.test(value)
    if (/^--n-(?:color|color-modal|color-popover|td-color|th-color|rail-color)(?:$|-)/.test(property)) {
      add('local-naive-fill', location, property, value, line)
    }
    if ((/^(?:color|background(?:-color|-image)?|border(?:-[\w-]+)?|outline(?:-color)?|(?:box|text)-shadow|fill|stroke)$/.test(property)
      || /^--[\w-]*(?:color|bg|background|border|shadow|fill|stroke)[\w-]*$/.test(property)) && colorLiteral.test(bare)) {
      add('literal-color', location, property, value, line)
    }
    if (isFill && owned && location.startsWith('<')) add('inline-surface-fill', location, property, value, line)
    if (isFill && !theme && !state && !owned && !semanticFill.test(value)
      && !/^(?:transparent|none|inherit|initial|unset|currentColor)$/i.test(value.trim())
      && !/^url\(/i.test(value.trim())) {
      add('unowned-background', location, property, value, line)
    }
    if (property === 'opacity' && owned && !state && !/^(?:1|inherit|initial|unset)$/.test(value.trim())) {
      add('surface-opacity', location, property, value, line)
    }
    if (exception) {
      const valid = /^theme-exception: (?:artwork|semantic|external|qr|preview|state) -- .{12,}$/.test(exception)
      if (!valid || findings.length === before) {
        add('invalid-exception', location, property, exception, line)
      } else {
        // Exceptions are local to this one declaration, never a file or subtree.
        findings.splice(before)
      }
    }
  }
  function inspectStyles(text, offset = 0, location, owned = false) {
    try {
      const ast = scss.parse(text, { from: file })
      ast.walkDecls(decl => {
        const selector = location || selectorOf(decl)
        const previous = decl.prev()
        const exception = previous?.type === 'comment' && previous.text.startsWith('theme-exception:') ? previous.text : ''
        inspect(decl.prop, decl.value, selector, offset + (decl.source?.start?.line || 1), owned || isSurface(selector), exception)
      })
      ast.walkComments(comment => {
        if (comment.text.startsWith('theme-exception:') && comment.next()?.type !== 'decl') {
          add('invalid-exception', selectorOf(comment), 'comment', comment.text, offset + comment.source.start.line)
        }
      })
    } catch (error) {
      add('parse-error', location || '<style>', 'scss', error.reason || error.message, offset + (error.line || 1))
    }
  }
  function inspectScript(text, offset = 0, location = '<script>', owned = false) {
    const ast = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
    const visit = node => {
      if (ts.isPropertyAssignment(node) && node.initializer) {
        const property = node.name.text
        const line = offset + ast.getLineAndCharacterOfPosition(node.getStart(ast)).line + 1
        const comments = ts.getLeadingCommentRanges(text, node.pos) || []
        const exception = comments.map(comment => text.slice(comment.pos, comment.end).replace(/^\/\*|\*\/$|^\/\//g, '').trim()).find(comment => comment.startsWith('theme-exception:')) || ''
        function inspectValue(value) {
          if (ts.isStringLiteralLike(value) || ts.isNumericLiteral(value)) {
            if (property === 'style' && value.text.includes(':')) inspectStyles(value.text, line - 1, location, owned)
            else if (property) inspect(property, value.text, location, line, owned, exception)
          } else if (ts.isConditionalExpression(value)) {
            inspectValue(value.whenTrue)
            inspectValue(value.whenFalse)
          }
        }
        inspectValue(node.initializer)
      }
      ts.forEachChild(node, visit)
    }
    visit(ast)
  }
  if (file.endsWith('.vue')) {
    const { descriptor, errors } = parseVue(source, { filename: file })
    for (const error of errors) add('parse-error', '<vue>', 'source', String(error))
    const elements = []
    function visit(node) {
      if (node.type === 1) elements.push(node)
      for (const child of node.children || []) visit(child)
    }
    if (descriptor.template?.ast) visit(descriptor.template.ast)
    const attribute = (element, name) => element.props.find(prop => prop.type === 6 && prop.name === name)
    const classOwnership = new Map()
    for (const element of elements) {
      const region = attribute(element, 'data-theme-surface')
      if (region) {
        if (!surfaceRegions.has(region.value?.content)) add('invalid-region', element.tag, 'data-theme-surface', region.value?.content || '', region.loc.start.line)
      }
      for (const name of (attribute(element, 'class')?.value?.content || '').split(/\s+/)) {
        if (name) classOwnership.set(name, (classOwnership.get(name) ?? true) && Boolean(region))
      }
      for (const prop of element.props) {
        if (prop.type === 7 && prop.name === 'bind' && prop.arg?.content === 'data-theme-surface') {
          add('invalid-region', element.tag, ':data-theme-surface', prop.exp?.content || '', prop.loc.start.line)
        }
      }
    }
    for (const [name, owned] of classOwnership) if (owned) owners.add(name)
    for (const element of elements) {
      const location = `<${element.tag}${attribute(element, 'class') ? ` class="${attribute(element, 'class').value?.content}"` : ''}>`
      const owned = Boolean(attribute(element, 'data-theme-surface'))
      for (const prop of element.props) {
        if (prop.type === 6 && prop.name === 'style') inspectStyles(prop.value?.content || '', prop.loc.start.line - 1, location, owned)
        if (prop.type === 7 && prop.name === 'bind' && prop.arg?.content === 'style' && prop.exp) {
          inspectScript(`(${prop.exp.content})`, prop.loc.start.line - 1, location, owned)
        }
      }
    }
    for (const style of descriptor.styles) inspectStyles(style.content, style.loc.start.line - 1)
    for (const script of [descriptor.script, descriptor.scriptSetup]) if (script) inspectScript(script.content, script.loc.start.line - 1)
  } else if (/\.(?:scss|css)$/.test(file)) inspectStyles(source)
  else inspectScript(source)
  return findings
}

export async function collectUiThemeFindings(root) {
  const findings = []
  async function visit(directory) {
    for (const item of await readdir(path.join(root, directory), { withFileTypes: true })) {
      const file = `${directory}/${item.name}`
      if (item.isDirectory()) await visit(file)
      else if (/\.(?:vue|scss|css|ts|tsx|js|jsx|mjs)$/.test(file)) findings.push(...uiThemeFindings(file, await readFile(path.join(root, file), 'utf8')))
    }
  }
  await visit(clientRoot)
  return findings
}

/** Exact declaration counts prevent old debt from allowing new copies. */
export function checkUiThemeBaseline(findings, baseline) {
  if (baseline?.version !== 1 || !baseline.files || typeof baseline.files !== 'object' || Array.isArray(baseline.files)) return ['UI theme baseline has an invalid schema']
  const remaining = structuredClone(baseline.files)
  const failures = []
  for (const [file, entries] of Object.entries(remaining)) {
    if (!file.startsWith(`${clientRoot}/`) || !entries || typeof entries !== 'object' || Array.isArray(entries)) {
      failures.push(`Invalid UI theme baseline file: ${file}`)
      delete remaining[file]
      continue
    }
    for (const [key, count] of Object.entries(entries)) {
      if (!Number.isSafeInteger(count) || count < 1 || !/^(?:literal-color|unowned-background|local-naive-fill) \| /.test(key)) {
        failures.push(`Invalid UI theme baseline entry: ${file}: ${key}`)
        delete entries[key]
      }
    }
  }
  for (const finding of findings) {
    if (remaining[finding.file]?.[finding.key] > 0) remaining[finding.file][finding.key]--
    else failures.push(`${finding.file}:${finding.line}: [ui-theme/${finding.rule}] ${finding.key}. See docs/harness/frontend-ui.md`)
  }
  for (const [file, entries] of Object.entries(remaining)) {
    for (const [key, count] of Object.entries(entries)) if (count > 0) failures.push(`Remove stale UI theme baseline entry (${count}): ${file}: ${key}`)
  }
  return failures
}

export async function checkUiTheme(root) {
  try {
    const baseline = JSON.parse(await readFile(path.join(root, baselinePath), 'utf8'))
    return checkUiThemeBaseline(await collectUiThemeFindings(root), baseline)
  } catch (error) {
    return [`UI theme harness failed: ${error.message}`]
  }
}
