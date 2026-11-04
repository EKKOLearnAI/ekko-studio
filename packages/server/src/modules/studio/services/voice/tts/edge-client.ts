import { EdgeTTS } from 'node-edge-tts'
import {
  CHROMIUM_FULL_VERSION,
  generateSecMsGecToken_V2,
  SEC_MS_GEC_VERSION_V2,
  TRUSTED_CLIENT_TOKEN,
} from 'node-edge-tts/dist/drm'
import { WebSocket } from 'ws'

export const EDGE_TTS_TIMEOUT_MS = 15_000

// node-edge-tts 1.2.12 uses DRM v2 but its api.msedgeservices.com endpoint
// still returns HTTP 200 instead of upgrading on some networks. Use the
// Read Aloud endpoint used by edge-tts, keeping the library's audio handling.
export class EdgeTtsClient extends EdgeTTS {
  override _connectWebSocket(): Promise<WebSocket> {
    const url = new URL('wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1')
    url.searchParams.set('TrustedClientToken', TRUSTED_CLIENT_TOKEN)
    url.searchParams.set('Sec-MS-GEC', generateSecMsGecToken_V2())
    url.searchParams.set('Sec-MS-GEC-Version', SEC_MS_GEC_VERSION_V2)

    const majorVersion = CHROMIUM_FULL_VERSION.split('.')[0]
    const socket = new WebSocket(url, {
      handshakeTimeout: EDGE_TTS_TIMEOUT_MS,
      origin: 'chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold',
      headers: {
        Pragma: 'no-cache',
        'Cache-Control': 'no-cache',
        'User-Agent': `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${majorVersion}.0.0.0 Safari/537.36 Edg/${majorVersion}.0.0.0`,
        'Accept-Encoding': 'gzip, deflate, br, zstd',
        'Accept-Language': 'en-US,en;q=0.9',
      },
    })

    return new Promise((resolve, reject) => {
      const onClose = () => reject(new Error('Edge TTS WebSocket closed before the connection was established'))
      socket.once('close', onClose)
      socket.once('error', reject)
      socket.once('open', () => {
        socket.off('close', onClose)
        resolve(socket)
      })
    })
  }
}
