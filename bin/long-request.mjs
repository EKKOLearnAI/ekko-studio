import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'

// Business deadlines can exceed fetch's fixed 300-second response-header limit.
export async function fetchLongRequest(url, options, timeoutMs = 330_000) {
  return new Promise((resolve, reject) => {
    const target = new URL(url)
    const transport = target.protocol === 'https:' ? httpsRequest : httpRequest
    let timer
    const req = transport(target, { method: options.method, headers: options.headers, signal: options.signal }, res => {
      const chunks = []
      res.on('data', chunk => chunks.push(chunk))
      res.on('error', error => { clearTimeout(timer); reject(error) })
      res.on('end', () => {
        clearTimeout(timer)
        const text = Buffer.concat(chunks).toString('utf8')
        const headers = new Headers()
        for (const [name, value] of Object.entries(res.headers)) {
          if (value != null) headers.set(name, Array.isArray(value) ? value.join(', ') : value)
        }
        resolve({ status: res.statusCode || 500, headers, text: async () => text })
      })
    })
    timer = setTimeout(() => req.destroy(new Error('Studio request transport timed out')), timeoutMs)
    req.on('error', error => { clearTimeout(timer); reject(error) })
    req.end(options.body)
  })
}
