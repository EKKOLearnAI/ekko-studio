import { createHash } from 'node:crypto'

export function pluginToolName(pluginId, toolName) {
  // Escape separators and dots so identifiers stay unambiguous and work with
  // clients that only allow letters, numbers, underscores and hyphens.
  const encode = value => value.replace(/_/g, '_u').replace(/\./g, '_d')
  const plugin = encode(pluginId), tool = encode(toolName)
  const name = `${plugin}__${tool}`
  if (name.length <= 64) return name
  const suffix = createHash('sha256').update(JSON.stringify([pluginId, toolName])).digest('hex').slice(0, 16)
  return `${plugin.slice(0, 22)}__${tool.slice(0, 22)}__${suffix}`
}

/** Managed MCP exposes global plugin tools; each call keeps its authenticated run context. */
export function createPluginTools(request) {
  async function catalog(signal) {
    const snapshot = await request('/api/studio/plugins', { signal })
    return (snapshot.plugins || []).filter(plugin => plugin.status === 'active').flatMap(plugin => plugin.tools.map(tool => ({
      pluginId: plugin.manifest.id, tool: tool.name,
      definition: {
        name: pluginToolName(plugin.manifest.id, tool.name),
        description: `[${plugin.manifest.name}/${tool.name}] ${tool.description}`,
        inputSchema: tool.inputSchema,
        annotations: { readOnlyHint: tool.readOnly === true, destructiveHint: tool.readOnly !== true },
      },
    })))
  }
  return {
    async list() {
      try { return (await catalog(AbortSignal.timeout(5000))).map(item => item.definition) }
      catch (error) { process.stderr.write(`Studio plugin discovery: ${error.message}\n`); return [] }
    },
    async call(name, input, signal) {
      const entry = (await catalog(signal)).find(item => item.definition.name === name)
      if (!entry) throw new Error('Plugin tool is no longer available; refresh tools')
      const { result } = await request(`/api/studio/plugins/${encodeURIComponent(entry.pluginId)}/invoke`, {
        method: 'POST', signal, body: { kind: 'tool', name: entry.tool, input },
      })
      return { isError: !result.ok, content: [{ type: 'text', text: result.content || result.error || JSON.stringify(result.data ?? null) }] }
    },
  }
}
