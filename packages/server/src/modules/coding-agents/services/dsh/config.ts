import { isAlias, isMap, isNode, isScalar, isSeq, parseDocument, visit, type YAMLMap, type YAMLSeq } from 'yaml'

const MCP_PLUGIN = '@deepseek-ai/dsh-mcp-client'

function invalid(message: string): never {
  throw Object.assign(new Error(message), { status: 400 })
}

function document(content: string) {
  // Parse YAML as data only. Preserve DSH's !!js nodes without evaluating them.
  const doc = parseDocument(content, { logLevel: 'silent' })
  if (doc.errors.length) invalid(`Invalid DSH YAML: ${doc.errors[0].message}`)
  return doc
}

export function validateDshSettings(content: string): void {
  const doc = document(content)
  if (doc.contents !== null && !isMap(doc.contents)) invalid('DSH settings must be a YAML mapping')
}

function patchDocument(content: string) {
  const doc = document(content.trim() ? content : '[]\n')
  if (!isSeq(doc.contents)) invalid('DSH cordis.patch.yml must be a YAML sequence')
  return doc
}

interface McpRow { row: YAMLMap; parent: YAMLSeq; name: string }

function mcpRows(root: YAMLSeq): McpRow[] {
  const rows: McpRow[] = []
  const scan = (parent: YAMLSeq) => {
    for (const node of parent.items) {
      if (!isMap(node)) continue
      if (node.get('name') === MCP_PLUGIN) {
        const name = node.getIn(['config', 'serverName'])
        if (typeof name !== 'string' || !name) invalid('DSH MCP entry requires a literal serverName')
        if (rows.some(row => row.name === name)) invalid(`Duplicate DSH MCP server: ${name}`)
        rows.push({ row: node, parent, name })
      }
      // New plugins in a patch are mounted through insert, not bare rows.
      const inserted = node.get('insert', true)
      if (isSeq(inserted)) scan(inserted)
    }
  }
  scan(root)
  return rows
}

export function readDshMcpServers(content: string): Map<string, Record<string, any>> {
  const doc = patchDocument(content)
  return new Map(mcpRows(doc.contents as YAMLSeq).map(({ row, name }) => {
    const value = row.get('config', true)
    if (!isMap(value)) invalid(`Invalid DSH MCP config: ${name}`)
    const config = value.toJS(doc) as Record<string, any>
    delete config.serverName
    return [name, { ...config, enabled: row.get('disabled') !== true }]
  }))
}

export function validateDshMcpServer(name: string, config: Record<string, any>): void {
  if (!/^[A-Za-z0-9_-]{1,32}$/.test(name)) invalid('DSH MCP names must contain 1–32 letters, digits, underscores or hyphens')
  if (!config || typeof config !== 'object' || Array.isArray(config)) invalid('DSH MCP config must be an object')
  const transport = config.transport || config.type || (config.url ? 'http' : 'stdio')
  if (!['stdio', 'http', 'streamable-http', 'streamable_http', 'streamableHttp'].includes(transport)) {
    invalid('DSH supports stdio and Streamable HTTP MCP only')
  }
  if (transport === 'stdio' && !config.command) invalid('DSH stdio MCP requires a command')
  if (transport !== 'stdio' && !config.url) invalid('DSH HTTP MCP requires a url')
  if (config.command && config.url) invalid('DSH MCP requires either command or url, not both')
  if (typeof config.enabled !== 'undefined' && typeof config.enabled !== 'boolean') invalid('MCP enabled must be a boolean')
}

export function updateDshMcpServer(content: string, name: string, config: Record<string, any> | null): string {
  const doc = patchDocument(content)
  const root = doc.contents as YAMLSeq
  const existing = mcpRows(root).find(row => row.name === name)
  if (config === null) {
    if (!existing) return content
    existing.parent.items.splice(existing.parent.items.indexOf(existing.row), 1)
    return doc.toString()
  }
  validateDshMcpServer(name, config)
  const native: Record<string, any> = { ...config, serverName: name, transport: config.url ? 'streamable-http' : 'stdio' }
  delete native.enabled
  delete native.type
  if (existing) {
    const current = existing.row.get('config', true)
    if (!isMap(current)) invalid(`Invalid DSH MCP config: ${name}`)
    // Leave unchanged nodes intact, including comments, anchors and !!js expressions.
    for (const pair of [...current.items]) {
      const key = String(isScalar(pair.key) ? pair.key.value : pair.key)
      if (!(key in native)) current.delete(key)
    }
    for (const [key, value] of Object.entries(native)) {
      const prior: unknown = current.get(key, true)
      const plain = isNode(prior) ? prior.toJS(doc) : prior
      if (JSON.stringify(plain) !== JSON.stringify(value)) current.set(key, doc.createNode(value))
    }
    existing.row.set('disabled', config.enabled === false)
  } else {
    root.add(doc.createNode({ insert: [{
      id: `mcp-${name}`, name: MCP_PLUGIN, disabled: config.enabled === false, config: native,
    }] }))
  }
  return doc.toString()
}

export function assertDshMcpProbeIsLiteral(content: string, name: string): void {
  const doc = patchDocument(content)
  const row = mcpRows(doc.contents as YAMLSeq).find(row => row.name === name)
  if (!row) return
  const seen = new Set<unknown>()
  const check = (root: YAMLMap | YAMLSeq | ReturnType<typeof doc.createNode>) => visit(root, (_key, node) => {
    if (seen.has(node)) return visit.SKIP
    seen.add(node)
    if (isAlias(node)) {
      const target = node.resolve(doc)
      if (target) check(target)
    }
    if ((isScalar(node) || isMap(node) || isSeq(node)) && node.tag?.includes(':js')) {
      invalid('This DSH MCP configuration contains JavaScript expressions; test it in DSH after resolving its environment')
    }
  })
  check(row.row)
}
