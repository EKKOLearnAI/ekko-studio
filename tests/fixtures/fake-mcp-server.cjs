const readline = require('node:readline')

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity })

rl.on('line', line => {
  if (!line.trim()) return
  const message = JSON.parse(line)
  if (message.id === undefined) return // Notifications never receive JSON-RPC responses.
  if (message.method === 'initialize') {
    process.stdout.write(`${JSON.stringify({
      jsonrpc: '2.0',
      id: message.id,
      result: {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'fake-mcp', version: '0.0.0' },
      },
    })}\n`)
    return
  }
  if (message.method === 'tools/list') {
    process.stdout.write(`${JSON.stringify({
      jsonrpc: '2.0',
      id: message.id,
      result: {
        tools: [
          {
            name: 'fake_echo',
            description: 'Echo a value through fake MCP.',
            inputSchema: {
              type: 'object',
              properties: { text: { type: 'string' } },
              required: ['text'],
              additionalProperties: false,
            },
          },
          {
            name: 'fake_image',
            description: 'Return an MCP image.',
            inputSchema: { type: 'object', properties: {}, additionalProperties: false },
          },
          {
            name: 'fake_pid',
            description: 'Return the persistent MCP process id.',
            inputSchema: { type: 'object', properties: {}, additionalProperties: false },
          },
        ],
      },
    })}\n`)
    return
  }
  if (message.method === 'tools/call') {
    if (message.params?.name === 'fake_image') {
      process.stdout.write(`${JSON.stringify({
        jsonrpc: '2.0', id: message.id,
        result: { content: [{ type: 'text', text: 'image result' }, { type: 'image', mimeType: 'image/png', data: 'aGVsbG8=' }] },
      })}\n`)
      return
    }
    if (message.params?.name === 'fake_pid') {
      process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: String(process.pid) }] } })}\n`)
      return
    }
    process.stdout.write(`${JSON.stringify({
      jsonrpc: '2.0',
      id: message.id,
      result: {
        content: [{ type: 'text', text: `mcp:${message.params?.arguments?.text || ''}` }],
      },
    })}\n`)
    return
  }
  process.stdout.write(`${JSON.stringify({
    jsonrpc: '2.0',
    id: message.id,
    error: { code: -32601, message: `Method not found: ${message.method}` },
  })}\n`)
})
