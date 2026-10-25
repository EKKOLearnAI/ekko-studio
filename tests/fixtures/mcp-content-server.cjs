const fs = require('node:fs')
require('node:readline').createInterface({ input: process.stdin }).on('line', line => {
  const message = JSON.parse(line)
  if (process.env.TRACE_FILE) fs.appendFileSync(process.env.TRACE_FILE, JSON.stringify({ method: message.method, params: message.params, pid: process.pid }) + '\n')
  if (message.id === undefined) return
  const respond = result => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }) + '\n')
  if (message.method === 'initialize') return respond({ protocolVersion: '2024-11-05', capabilities: {
    tools: {}, ...(process.env.CONTENT_MODE === 'unsupported' ? {} : { resources: {}, prompts: {} }),
  }, serverInfo: { name: 'content-fixture', version: '1.0.0' } })
  if (message.method === 'tools/list') return respond({ tools: ['fake_pid', 'fake_echo', 'fake_image'].map(name => ({ name, inputSchema: { type: 'object' } })) })
  if (message.method === 'tools/call') return respond({ content: message.params.name === 'fake_image' ? [{ type: 'image', data: 'aGk=', mimeType: 'image/png' }]
    : [{ type: 'text', text: message.params.name === 'fake_pid' ? String(process.pid) : `mcp:${message.params.arguments?.text || ''}` }] })
  if (message.method === 'resources/list') return respond({ resources: [{ uri: message.params?.cursor ? 'fixture://two' : 'fixture://one', name: 'Local resource', _meta: { private: 'omit' } }],
    ...(message.params?.cursor ? {} : { nextCursor: 'next' }) })
  if (message.method === 'resources/templates/list') return respond({ resourceTemplates: [{ name: 'Item', uriTemplate: 'fixture://item/{id}' }] })
  if (message.method === 'resources/read') {
    if (process.env.CONTENT_MODE === 'hang') return
    if (message.params.uri === 'fixture://blob') return respond({ contents: [{ uri: message.params.uri, mimeType: 'application/octet-stream', blob: 'aGk=' }] })
    return respond({ contents: [{ uri: message.params.uri, text: process.env.CONTENT_MODE === 'oversize' ? 'x'.repeat(600000) : '中文 resource', _meta: { private: 'omit' } }] })
  }
  if (message.method === 'prompts/list') return respond({ prompts: [{ name: 'greeting', description: 'Local prompt', arguments: [{ name: 'whom', required: true }] }] })
  if (message.method === 'prompts/get') return respond({ description: 'Prepared prompt', messages: [
    { role: 'user', content: { type: 'text', text: `Hello ${message.params.arguments?.whom || 'world'}`, _meta: { private: 'omit' } } },
    { role: 'assistant', content: { type: 'resource', resource: { uri: 'fixture://prompt', text: 'Context' } } },
  ] })
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Method unavailable' } }) + '\n')
})
