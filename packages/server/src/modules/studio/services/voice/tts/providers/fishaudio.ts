import type { TtsProvider, TtsProviderId } from './types'
import { cleanTtsText, clampTtsText } from './text'
import { assertSafeTtsBaseUrl } from './url-safety'

/**
 * Fish Audio TTS（s2 系列，含免费 s2.1-pro-free）
 *
 * 接口要点（非 OpenAI 兼容）：
 *   POST {baseUrl}/v1/tts
 *   Header: Authorization: Bearer <key>、Content-Type: application/json、
 *           model: <model 名>（注意：model 必须放 header，不是 body）
 *   Body:   { text, reference_id: <voice id>, format: mp3|wav|pcm|opus, ... }
 *
 * 国内访问 fish.audio 需代理：DB settings 的 proxy 字段会经 mergeStoredTtsOptions
 * 进入 opts.proxy。运行环境未装 undici，故手写 HTTP CONNECT 隧道（http 代理 + https 目标）。
 *
 * 隧道实现要点（v2，修复"invalid HTTP response / 挂起"）：
 *   - 纯 Buffer 解析，不把音频转 utf8 再切
 *   - 按 Content-Length 精确收 body（读够即返回），不依赖连接 close/end
 *     （服务端 keep-alive 不关连接时旧实现永不返回 → 挂起）
 *   - chunked 传输也支持（解析到 0-length chunk）
 *   - 总超时兜底强制失败，绝不悬挂
 */
export interface FishAudioTtsProviderOptions {
  baseUrl?: string
  apiKey?: string
  model?: string
  /** reference_id（voice 库中的音色 ID） */
  voice?: string
  format?: string
  /** http 代理 URL，如 http://user:pass@host:port（无则直连） */
  proxy?: string
}

interface ProxyTarget {
  host: string
  port: number
  authHeader?: string
}

function parseHttpProxy(proxyUrl: string): ProxyTarget {
  const url = new URL(proxyUrl)
  if (url.protocol !== 'http:') {
    throw new Error(`fishaudio proxy must be http:// (got ${url.protocol}//)`)
  }
  const authHeader =
    url.username || url.password
      ? `Basic ${Buffer.from(`${decodeURIComponent(url.username)}:${decodeURIComponent(url.password)}`).toString('base64')}`
      : undefined
  return { host: url.hostname, port: Number(url.port || 80), authHeader }
}

interface ProxyHttpResponse {
  status: number
  contentType: string
  body: Buffer
}

function parseProxyHeader(raw: Buffer): { headerEnd: number; headers: Record<string, string>; status: number } | null {
  const idx = raw.indexOf(Buffer.from('\r\n\r\n'))
  if (idx === -1) return null
  const head = raw.subarray(0, idx).toString('latin1')
  const lines = head.split('\r\n')
  const status = Number(lines[0]?.split(' ')[1] || 0)
  const headers: Record<string, string> = {}
  for (const line of lines.slice(1)) {
    const colon = line.indexOf(':')
    if (colon > 0) {
      const key = line.slice(0, colon).trim().toLowerCase()
      const value = line.slice(colon + 1).trim()
      // 同名 header（如多个 Set-Cookie）拼接即可
      headers[key] = headers[key] ? `${headers[key]}, ${value}` : value
    }
  }
  return { headerEnd: idx + 4, headers, status }
}

/** 从 chunked 编码流中提取已完整到达的块，返回 {body, consumed} */
function consumeChunked(buf: Buffer): { body: Buffer; complete: boolean } {
  let offset = 0
  const chunks: Buffer[] = []
  for (;;) {
    const lineEnd = buf.indexOf(Buffer.from('\r\n'), offset)
    if (lineEnd === -1) return { body: Buffer.concat(chunks), complete: false }
    const sizeLine = buf.subarray(offset, lineEnd).toString('latin1').trim()
    const size = Number.parseInt(sizeLine, 16)
    if (!Number.isFinite(size)) return { body: Buffer.concat(chunks), complete: false }
    if (size === 0) return { body: Buffer.concat(chunks), complete: true }
    const dataStart = lineEnd + 2
    if (buf.length < dataStart + size + 2) return { body: Buffer.concat(chunks), complete: false }
    chunks.push(buf.subarray(dataStart, dataStart + size))
    offset = dataStart + size + 2
  }
}

/** 通过 http 代理 POST（https 目标走 CONNECT 隧道）。读够 Content-Length / chunked 结束即返回。 */
async function postViaProxy(
  targetUrl: string,
  proxyUrl: string,
  headers: Record<string, string>,
  body: string,
  signal?: AbortSignal,
): Promise<ProxyHttpResponse> {
  const http = await import('node:http')
  const https = await import('node:https')
  const tls = await import('node:tls')
  const target = new URL(targetUrl)
  const targetPort = Number(target.port || 443)
  const proxy = parseHttpProxy(proxyUrl)
  const proxyHeaders: Record<string, string> = { Host: `${target.hostname}:${targetPort}` }
  if (proxy.authHeader) proxyHeaders['Proxy-Authorization'] = proxy.authHeader

  return new Promise((resolve, reject) => {
    let settled = false
    const done = (err?: Error, res?: ProxyHttpResponse) => {
      if (settled) return
      settled = true
      clearTimeout(overallTimer)
      signal?.removeEventListener('abort', onAbort)
      if (err) reject(err)
      else if (res) resolve(res)
    }
    const onAbort = () => done(new Error('aborted'))
    const overallTimer = setTimeout(() => done(new Error('fishaudio proxy: timeout')), 40_000)
    if (signal?.aborted) {
      done(new Error('aborted'))
      return
    }
    signal?.addEventListener('abort', onAbort, { once: true })

    const connectReq = http.request({
      host: proxy.host,
      port: proxy.port,
      method: 'CONNECT',
      path: `${target.hostname}:${targetPort}`,
      headers: proxyHeaders,
    })
    connectReq.on('error', err => done(err))
    connectReq.on('connect', (_res, socket) => {
      const tlsSocket = tls.connect({ socket, servername: target.hostname })
      const payload = Buffer.from(body, 'utf-8')
      const reqHeaders = Object.entries(headers)
        .map(([k, v]) => `${k}: ${v}`)
        .join('\r\n')
      const reqHead = Buffer.from(
        `POST ${target.pathname} HTTP/1.1\r\nHost: ${target.hostname}:${targetPort}\r\nContent-Length: ${payload.length}\r\n${reqHeaders}\r\n\r\n`,
        'utf8',
      )
      const received: Buffer[] = []
      let accumulated = Buffer.alloc(0)
      let parsed: { headerEnd: number; headers: Record<string, string>; status: number } | null = null
      let bodyBuf = Buffer.alloc(0)
      let bodyExpected = -1
      let chunked = false
      let finished = false

      tlsSocket.on('error', err => {
        if (!finished) done(err)
      })
      tlsSocket.on('close', () => {
        // 连接关闭但 body 未收全（content-length 未满）→ 尽力返回已收内容
        if (!finished && parsed && bodyExpected >= 0 && bodyBuf.length < bodyExpected) {
          done(new Error(`fishaudio proxy: connection closed early (${bodyBuf.length}/${bodyExpected})`))
        } else if (!finished && !parsed) {
          done(new Error('fishaudio proxy: invalid HTTP response'))
        }
      })
      tlsSocket.on('data', (chunk: Buffer) => {
        accumulated = Buffer.concat([accumulated, chunk])
        if (!parsed) {
          parsed = parseProxyHeader(accumulated)
          if (!parsed) return
          const cl = parsed.headers['content-length']
          const te = parsed.headers['transfer-encoding']
          if (te && te.toLowerCase().includes('chunked')) {
            chunked = true
          } else if (cl !== undefined) {
            bodyExpected = Number(cl)
          }
        }
        // ⚠️ 每次 data 都要重算：accumulated 会随 concat 换新 buffer，
        // 只在首帧快照 subarray 的话 bodyBuf 永远不增长 → Content-Length 永远收不满 → 挂死
        bodyBuf = accumulated.subarray(parsed.headerEnd)
        if (!finished && !chunked && bodyExpected >= 0 && bodyBuf.length >= bodyExpected) {
          finished = true
          done(undefined, { status: parsed.status, contentType: parsed.headers['content-type'] || 'audio/mpeg', body: bodyBuf.subarray(0, bodyExpected) })
          return
        }
        // chunked 增量消费
        if (!finished && chunked) {
          const { body, complete } = consumeChunked(bodyBuf)
          if (complete) {
            finished = true
            done(undefined, { status: parsed.status, contentType: parsed.headers['content-type'] || 'audio/mpeg', body })
          }
        }
      })
      tlsSocket.write(reqHead)
      tlsSocket.write(payload)
    })
    connectReq.end()
  })
}

export function createFishAudioTtsProvider(id: Extract<TtsProviderId, 'fishaudio'>): TtsProvider<FishAudioTtsProviderOptions> {
  return {
    id,
    async synthesize(req, opts) {
      const baseUrl = String(opts.baseUrl || '').trim().replace(/\/+$/, '')
      if (!baseUrl) throw new Error('fishaudio TTS baseUrl is required')
      const url = new URL(baseUrl)
      assertSafeTtsBaseUrl(url, 'fishaudio')
      const text = clampTtsText(cleanTtsText(req.text))
      if (!text) throw new Error('fishaudio TTS text is empty after cleaning')
      if (!opts.apiKey) throw new Error('fishaudio TTS apiKey is required')
      const model = opts.model || 's2.1-pro-free'
      const format = opts.format || 'mp3'
      const endpoint = `${baseUrl}/v1/tts`
      const payload = JSON.stringify({
        text,
        ...(opts.voice ? { reference_id: opts.voice } : {}),
        format,
      })
      const headers: Record<string, string> = {
        Authorization: `Bearer ${opts.apiKey}`,
        'Content-Type': 'application/json',
        model,
        Accept: 'audio/mpeg, audio/wav, audio/opus, application/json',
      }

      let status: number
      let contentType: string
      let body: Buffer
      if (opts.proxy) {
        const res = await postViaProxy(endpoint, opts.proxy, headers, payload, req.signal)
        status = res.status
        contentType = res.contentType
        body = res.body
      } else {
        const res = await fetch(endpoint, {
          method: 'POST',
          headers,
          body: payload,
          signal: req.signal,
        })
        status = res.status
        contentType = res.headers.get('content-type') || 'audio/mpeg'
        body = Buffer.from(await res.arrayBuffer())
      }

      if (status < 200 || status >= 300) {
        const msg = body.toString('utf8').slice(0, 300)
        throw new Error(`fishaudio TTS returned ${status}: ${msg}`)
      }
      return { audio: body, contentType, engine: 'fishaudio', provider: id }
    },
  }
}

export const fishaudioTtsProvider: TtsProvider<FishAudioTtsProviderOptions> = createFishAudioTtsProvider('fishaudio')
