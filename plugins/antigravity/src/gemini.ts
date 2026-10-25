import { randomBytes, timingSafeEqual } from 'node:crypto'
import { createServer, type ServerResponse } from 'node:http'
import { geminiToResponses, responsesToGemini } from '@ekko-studio/agent-drivers'
import { StudioError, type JsonObject, type ModelGatewayHandle } from '@ekko-studio/plugin-sdk'
import { record } from './protocol'

function fields(value: JsonObject, allowed: string[]) {
  if (Object.keys(value).some((key) => !allowed.includes(key)))
    throw new StudioError('CAPABILITY_UNSUPPORTED', 'Unsupported Gemini request field')
}
/** Explicitly reject semantics the public portable codec cannot represent. */
export function convertRequest(value: unknown): JsonObject {
  if (!record(value)) throw new StudioError('INVALID_ARGUMENT', 'Invalid Gemini request')
  fields(value, ['contents', 'systemInstruction', 'tools', 'generationConfig', 'toolConfig'])
  if (!Array.isArray(value.contents) || value.contents.length > 2048) throw new StudioError('INVALID_ARGUMENT', 'Invalid Gemini contents')
  const parts = (value: unknown, system = false) => {
    if (!record(value)) throw new StudioError('INVALID_ARGUMENT', 'Invalid Gemini content')
    fields(value, ['role', 'parts'])
    if (value.role !== undefined && !['user', 'model'].includes(String(value.role)))
      throw new StudioError('CAPABILITY_UNSUPPORTED', 'Unsupported Gemini role')
    if (!Array.isArray(value.parts)) throw new StudioError('INVALID_ARGUMENT', 'Invalid Gemini parts')
    for (const part of value.parts) {
      if (!record(part)) throw new StudioError('INVALID_ARGUMENT', 'Invalid Gemini part')
      for (const key of ['inlineData', 'fileData'])
        if (part[key] !== undefined) {
          const media = part[key]
          if (!record(media)) throw new StudioError('INVALID_ARGUMENT', 'Invalid Gemini media')
          fields(media, key === 'inlineData' ? ['mimeType', 'data'] : ['mimeType', 'fileUri'])
        }
      fields(part, system ? ['text'] : ['text', 'thought', 'inlineData', 'fileData', 'functionCall', 'functionResponse'])
      if (part.functionCall) {
        if (!record(part.functionCall)) throw new StudioError('INVALID_ARGUMENT', 'Invalid Gemini function call')
        fields(part.functionCall, ['id', 'name', 'args'])
      }
      if (part.functionResponse) {
        if (!record(part.functionResponse)) throw new StudioError('INVALID_ARGUMENT', 'Invalid Gemini function response')
        fields(part.functionResponse, ['id', 'name', 'response', 'parts'])
      }
    }
  }
  for (const content of value.contents) parts(content)
  if (value.systemInstruction) parts(value.systemInstruction, true)
  if (value.tools !== undefined && !Array.isArray(value.tools)) throw new StudioError('INVALID_ARGUMENT', 'Invalid Gemini tools')
  for (const tool of Array.isArray(value.tools) ? value.tools : []) {
    if (!record(tool)) throw new StudioError('INVALID_ARGUMENT', 'Invalid Gemini tool')
    fields(tool, ['functionDeclarations'])
    if (!Array.isArray(tool.functionDeclarations)) throw new StudioError('INVALID_ARGUMENT', 'Invalid Gemini function declarations')
    for (const declaration of Array.isArray(tool.functionDeclarations) ? tool.functionDeclarations : []) {
      if (!record(declaration)) throw new StudioError('INVALID_ARGUMENT', 'Invalid Gemini function declaration')
      fields(declaration, ['name', 'description', 'parameters', 'parametersJsonSchema'])
    }
  }
  if (value.generationConfig) {
    if (!record(value.generationConfig)) throw new StudioError('INVALID_ARGUMENT', 'Invalid Gemini generation config')
    fields(value.generationConfig, ['temperature', 'maxOutputTokens', 'thinkingConfig'])
  }
  const converted = geminiToResponses(value) as JsonObject
  if (record(value.generationConfig) && value.generationConfig.maxOutputTokens !== undefined)
    converted.max_output_tokens = value.generationConfig.maxOutputTokens
  if (record(value.generationConfig) && value.generationConfig.thinkingConfig !== undefined) {
    const thinking = value.generationConfig.thinkingConfig
    if (!record(thinking)) throw new StudioError('INVALID_ARGUMENT', 'Invalid Gemini thinking config')
    fields(thinking, ['includeThoughts', 'thinkingBudget'])
    // Native fixed token budgets are projected to portable effort bands. No native token-budget guarantee is claimed.
    if (
      thinking.thinkingBudget !== undefined &&
      (!Number.isSafeInteger(thinking.thinkingBudget) || Number(thinking.thinkingBudget) < 0 || Number(thinking.thinkingBudget) > 32768)
    )
      throw new StudioError('CAPABILITY_UNSUPPORTED', 'Unsupported Gemini thinking budget')
    if (thinking.includeThoughts !== undefined && typeof thinking.includeThoughts !== 'boolean')
      throw new StudioError('INVALID_ARGUMENT', 'Invalid Gemini thought visibility')
    const budget = thinking.thinkingBudget
    converted.reasoning = {
      ...(typeof budget === 'number'
        ? { effort: budget === 0 ? 'none' : budget <= 1024 ? 'low' : budget <= 8192 ? 'medium' : 'high' }
        : {}),
      ...(thinking.includeThoughts ? { summary: 'auto' } : {}),
    }
  }
  if (value.toolConfig) {
    if (!record(value.toolConfig)) throw new StudioError('INVALID_ARGUMENT', 'Invalid Gemini tool config')
    fields(value.toolConfig, ['functionCallingConfig'])
    const cfg = value.toolConfig.functionCallingConfig
    if (!record(cfg)) throw new StudioError('INVALID_ARGUMENT', 'Invalid Gemini function calling config')
    fields(cfg, ['mode'])
    const choices: Record<string, string> = { AUTO: 'auto', ANY: 'required', NONE: 'none' }
    if (cfg.mode !== undefined && !choices[String(cfg.mode)])
      throw new StudioError('CAPABILITY_UNSUPPORTED', 'Unsupported Gemini function calling mode')
    if (cfg.mode !== undefined) converted.tool_choice = choices[String(cfg.mode)]
  }
  return converted
}
const respond = (res: ServerResponse, status: number, value: unknown) => {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(value))
}
export async function geminiBridge(gateway: ModelGatewayHandle, signal: AbortSignal) {
  const token = randomBytes(32).toString('hex'),
    controllers = new Set<AbortController>(),
    tasks = new Set<Promise<void>>()
  let disposed = false
  const server = createServer((req, res) => {
    const task = (async () => {
      let controller: AbortController | undefined
      try {
        if (disposed || signal.aborted) return respond(res, 503, { error: { message: 'Run ended' } })
        const url = new URL(req.url || '/', 'http://127.0.0.1'),
          key = req.headers['x-goog-api-key'] || url.searchParams.get('key')
        const supplied = Buffer.from(typeof key === 'string' ? key : '')
        if (supplied.length !== token.length || !timingSafeEqual(supplied, Buffer.from(token)))
          return respond(res, 401, { error: { message: 'Unauthorized' } })
        if (
          req.method !== 'POST' ||
          !/^\/v1beta\/models\/[A-Za-z0-9_.:-]+:(streamGenerateContent|generateContent)$/.test(url.pathname) ||
          [...url.searchParams.keys()].some((key) => !['alt', 'key'].includes(key))
        )
          return respond(res, 404, { error: { message: 'Unsupported native route' } })
        if (controllers.size >= 4) return respond(res, 429, { error: { message: 'Native request limit exceeded' } })
        controller = new AbortController()
        controllers.add(controller)
        const close = () => {
          if (!res.writableEnded) controller?.abort()
        }
        res.on('close', close)
        const chunks: Buffer[] = []
        let length = 0
        for await (const chunk of req) {
          const bytes = Buffer.from(chunk)
          length += bytes.length
          if (length > 4 * 1024 * 1024) throw new StudioError('RESOURCE_EXHAUSTED', 'Native request too large')
          chunks.push(bytes)
        }
        const body = convertRequest(JSON.parse(Buffer.concat(chunks).toString('utf8')))
        const response = await fetch(`${gateway.baseUrl.replace(/\/$/, '')}/responses`, {
          method: 'POST',
          signal: controller.signal,
          headers: { 'content-type': 'application/json', authorization: `Bearer ${gateway.token}` },
          body: JSON.stringify({ ...body, model: gateway.model, stream: false }),
        })
        if (!response.ok || !response.body) throw new StudioError('RUNTIME_UNAVAILABLE', 'Studio model request failed')
        const output: Uint8Array[] = []
        let size = 0
        for await (const chunk of response.body) {
          size += chunk.length
          if (size > 16 * 1024 * 1024) {
            controller.abort()
            throw new StudioError('RESOURCE_EXHAUSTED', 'Native response too large')
          }
          output.push(chunk)
        }
        const responseValue: unknown = JSON.parse(Buffer.concat(output).toString('utf8'))
        if (
          !record(responseValue) ||
          !Array.isArray(responseValue.output) ||
          responseValue.output.some((item) => !record(item) || !['message', 'function_call'].includes(String(item.type)))
        )
          throw new StudioError('CAPABILITY_UNSUPPORTED', 'Unsupported provider output in native Gemini adapter')
        const value = responsesToGemini(responseValue)
        if (url.pathname.endsWith(':streamGenerateContent')) {
          res.writeHead(200, { 'content-type': 'text/event-stream' })
          res.end(`data: ${JSON.stringify(value)}\n\n`)
        } else respond(res, 200, value)
        res.off('close', close)
      } catch (error) {
        if (!res.headersSent)
          respond(res, error instanceof StudioError && error.code === 'CAPABILITY_UNSUPPORTED' ? 400 : 502, {
            error: { message: error instanceof StudioError ? error.message : 'Invalid native model request' },
          })
        else res.destroy()
      } finally {
        if (controller) controllers.delete(controller)
      }
    })()
    tasks.add(task)
    void task.finally(() => tasks.delete(task))
  })
  server.requestTimeout = 120000
  server.headersTimeout = 10000
  server.maxHeadersCount = 32
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject)
      resolve()
    })
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new StudioError('INTERNAL', 'Native bridge failed to bind')
  let closing: Promise<void> | undefined
  const dispose = () =>
    (closing ??= (async () => {
      disposed = true
      signal.removeEventListener('abort', abort)
      for (const controller of controllers) controller.abort()
      const closed = new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
      server.closeAllConnections()
      await Promise.allSettled([...tasks])
      await closed
    })())
  const abort = () => {
    void dispose().catch(() => {})
  }
  signal.addEventListener('abort', abort, { once: true })
  if (signal.aborted) await dispose()
  return { baseUrl: `http://127.0.0.1:${address.port}`, token, dispose }
}
