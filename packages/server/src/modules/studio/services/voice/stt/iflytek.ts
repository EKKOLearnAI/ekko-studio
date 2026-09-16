// iflytek.ts — 讯飞 STT 阶段 1（IAT 一句话识别，HTTP 上传式）
// 文档: https://www.xfyun.cn/doc/asr/voicedictation/API.html
// 认证: APPID + APIKey + APISecret；通过 HMAC-SHA256 签名生成 wss URL（用 wss 但一次性发送，简化）
// 限制: 音频 ≤ 60s，pcm/wav/mp3 格式
import type { SttTranscribeInput, SttTranscribeResult } from './types'
import { SttProviderConfigError } from './openai'

export class IflytekConfigError extends Error {}

interface IflytekCredentials {
  appId: string
  apiKey: string
  apiSecret: string
}

function readCredentials(input: SttTranscribeInput): IflytekCredentials {
  // appId 走 settings.appId（独立字段）
  // apiKey + apiSecret 约定合并在 secrets.apiKey 一栏，格式: 'apiKey|apiSecret'
  const appId = String(input.settings.appId || '').trim()
  const combined = String(input.secrets.apiKey || '').trim()
  if (!appId) throw new IflytekConfigError('iflytek STT appId is required (settings.appId)')
  if (!combined) throw new IflytekConfigError('iflytek STT apiKey 为空（apiKey|apiSecret）')
  const pipeIdx = combined.indexOf('|')
  if (pipeIdx < 0) throw new IflytekConfigError('iflytek STT apiKey 需包含 apiSecret，格式: apiKey|apiSecret')
  const apiKey = combined.slice(0, pipeIdx).trim()
  const apiSecret = combined.slice(pipeIdx + 1).trim()
  if (!apiKey) throw new IflytekConfigError('iflytek STT apiKey 为空')
  if (!apiSecret) throw new IflytekConfigError('iflytek STT apiSecret 为空')
  return { appId, apiKey, apiSecret }
}

/**
 * 讯飞 IAT URL 签名（HMAC-SHA256 写在 URL 查询参数里）
 * 文档: https://www.xfyun.cn/doc/asr/voicedictation/API.html#%E6%8E%A5%E5%8F%A3%E8%AF%B4%E6%98%8E
 */
function buildIatUrl(host: string, path: string, apiKey: string, apiSecret: string): string {
  const now = new Date()
  const date = now.toUTCString() // RFC 1123, e.g. 'Fri, 09 May 2025 03:18:23 GMT'
  // signature_origin: "host: $host\ndate: $date\nGET $path HTTP/1.1"
  const signatureOrigin = `host: ${host}\ndate: ${date}\nGET ${path} HTTP/1.1`
  const crypto = require('crypto') as typeof import('crypto')
  const signatureSha = crypto.createHmac('sha256', apiSecret).update(signatureOrigin).digest('base64')
  const authorizationOrigin = `api_key=\"${apiKey}\", algorithm=\"hmac-sha256\", headers=\"host date request-line\", signature=\"${signatureSha}\"`
  const authorization = Buffer.from(authorizationOrigin).toString('base64')
  const url = `wss://${host}${path}?authorization=${encodeURIComponent(authorization)}&date=${encodeURIComponent(date)}&host=${host}`
  return url
}

/**
 * 通过 ws 库（node 已有）建立 WSS 连一次，发送整段音频，接收首条 result=2 收尾。
 * 避免引入依赖：node 内置 'ws' via undici 或 ws module。fallback to raw upgrade。
 *
 * 简化策略：用 node 内置 'ws'（如果存在）否则 throw 提示 npm i ws。
 */
export async function transcribeIflytekIat(input: SttTranscribeInput): Promise<SttTranscribeResult> {
  const startedAt = Date.now()
  const { appId, apiKey, apiSecret } = readCredentials(input)
  if (!Buffer.isBuffer(input.audio) || input.audio.length === 0) {
    throw new Error('iflytek STT audio is empty')
  }
  const host = 'iat-api.xfyun.cn'
  const path = '/v2/iat'
  const url = buildIatUrl(host, path, apiKey, apiSecret)

  // 选 ws 实现：用户环境已装 ws（很多其他模块依赖），如果没装给出明确错误
  let WebSocketImpl: any
  try {
    WebSocketImpl = (await import('ws' as any)).default || (await import('ws' as any))
  } catch {
    throw new IflytekConfigError("iflytek STT requires 'ws' npm package. Run: npm install ws")
  }

  const result = await new Promise<string>((resolve, reject) => {
    const ws = new WebSocketImpl(url, { perMessageDeflate: false })
    const timeout = setTimeout(() => {
      try { ws.close() } catch {}
      reject(new IflytekConfigError('iflytek STT timeout (60s)'))
    }, 60_000)
    let finalText = ''
    let errorReason: string | null = null
    let frameSent = false
    const sendOneFrame = (status: number) => {
      // status: 0=第一帧 1=中间 2=最后一帧
      const data: Record<string, unknown> = {
        common: { app_id: appId },
        business: {
          language: 'zh_cn',
          domain: 'iat',
          accent: 'mandarin',
          vad_eos: 5000,
          dwa: 'wpgs',
        },
        data: {
          status,
          format: 'audio/L16;rate=16000', // 默认按 16k pcm；如果 mimeType 是 wav/mp3 强制 PCM
          encoding: 'raw',
          audio: (input.audio as Buffer).toString('base64'),
        },
      }
      ws.send(JSON.stringify(data))
    }
    ws.on('open', () => {
      try { sendOneFrame(0) } catch (e) { reject(e) }
      sendOneFrame(2) // 一次性发送两帧（首+末）
      frameSent = true
    })
    ws.on('message', (raw: Buffer | string) => {
      try {
        const text = raw.toString('utf8')
        const msg = JSON.parse(text)
        if (msg.code !== undefined && msg.code !== 0) {
          errorReason = `iflytek STT error code=${msg.code}: ${msg.message || 'unknown'}`
        } else if (msg.data && msg.data.result) {
          const wsArr = msg.data.result.ws as Array<{ cw: Array<{ w: string }> }> | undefined
          if (wsArr) {
            for (const wsItem of wsArr) {
              for (const cw of wsItem.cw || []) {
                finalText += cw.w || ''
              }
            }
          }
          // 收尾：status=2 表示服务端已识别结束
          if (msg.data.status === 2) {
            clearTimeout(timeout)
            try { ws.close() } catch {}
            resolve(finalText)
          }
        }
      } catch (e) {
        // 解析错误忽略（中间可能含控制帧）
      }
    })
    ws.on('error', (e: Error) => {
      clearTimeout(timeout)
      reject(e)
    })
    ws.on('close', (code: number) => {
      clearTimeout(timeout)
      if (errorReason) reject(new IflytekConfigError(errorReason))
      else if (finalText) resolve(finalText)
      else if (frameSent) reject(new IflytekConfigError(`iflytek STT closed without result (code=${code})`))
    })
    if (input.signal) {
      input.signal.addEventListener('abort', () => {
        try { ws.close() } catch {}
        clearTimeout(timeout)
        reject(new Error('aborted'))
      })
    }
  })

  const text = (result || '').trim()
  if (!text) throw new Error('iflytek STT returned empty text')
  return {
    text,
    provider: 'iflytek',
    model: 'iat-zh',
    language: 'zh_cn',
    durationMs: Date.now() - startedAt,
  }
}
