import { describe, expect, it, vi } from 'vitest'
import { providerHttpError } from '../../packages/ekko-agent/src/model/http'

function jsonError(body: unknown, status = 400): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

describe('providerHttpError', () => {
  it('surfaces the provider message and keeps the parsed body as details', async () => {
    const body = { error: { message: 'messages[214].content: unexpected end of hex escape at line 1 column 572568' } }
    const error = await providerHttpError('deepseek', jsonError(body))

    expect(error.message).toBe(body.error.message)
    expect(error.statusCode).toBe(400)
    expect(error.retryable).toBe(false)
    expect(error.details).toEqual(body)
  })

  it('keeps the raw body when the provider answers with non-JSON', async () => {
    const error = await providerHttpError(
      'gateway',
      new Response('<html>\n  <h1>502 Bad Gateway</h1>\n</html>', { status: 502 }),
    )

    expect(error.message).toContain('HTTP 502')
    expect(error.message).toContain('502 Bad Gateway')
    expect(error.details).toBe('<html>\n  <h1>502 Bad Gateway</h1>\n</html>')
    expect(error.retryable).toBe(true)
  })

  it('reads the response body exactly once', async () => {
    const response = jsonError({ error: 'bad request' })
    const text = vi.spyOn(response, 'text')
    const json = vi.spyOn(response, 'json')

    const error = await providerHttpError('provider', response)

    expect(error.message).toBe('bad request')
    expect(text).toHaveBeenCalledTimes(1)
    expect(json).not.toHaveBeenCalled()
  })

  it('falls back to the status line when the body is empty', async () => {
    const error = await providerHttpError('provider', new Response('', { status: 500 }))

    expect(error.message).toBe('Model provider request failed with HTTP 500.')
    expect(error.details).toBeUndefined()
  })
})
