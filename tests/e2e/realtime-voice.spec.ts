import { expect, test, type WebSocketRoute } from '@playwright/test'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

// A short valid WAV exercises the browser decoder and native Audio ended events in CI.
function silentWav() {
  const audio = Buffer.alloc(44 + 1600)
  audio.write('RIFF'); audio.writeUInt32LE(audio.length - 8, 4); audio.write('WAVEfmt ', 8)
  audio.writeUInt32LE(16, 16); audio.writeUInt16LE(1, 20); audio.writeUInt16LE(1, 22)
  audio.writeUInt32LE(8000, 24); audio.writeUInt32LE(16000, 28)
  audio.writeUInt16LE(2, 32); audio.writeUInt16LE(16, 34); audio.write('data', 36)
  audio.writeUInt32LE(1600, 40)
  return audio
}

test('speaks streaming text once across reconnect, terminal ID alignment and a tool boundary', async ({ page }, testInfo) => {
  test.setTimeout(60_000)
  const errors: string[] = [], spoken: string[] = []
  let socket: WebSocketRoute | undefined
  let namespace = ''
  let runs = 0
  let resumes = 0
  page.on('pageerror', error => errors.push(error.message))
  await page.addInitScript(() => {
    localStorage.setItem('hermes_locale', 'en')
    localStorage.setItem('hermes-tts-settings-v2', JSON.stringify({ provider: 'edge', edgeVoice: 'en-US-AriaNeural' }))
    ;(window as any).__APP_VERSION__ = 'test'
    ;(window as any).audioEvents = { played: 0, ended: 0, failed: 0 }
    const nativePlay = HTMLMediaElement.prototype.play
    HTMLMediaElement.prototype.play = function () {
      ;(window as any).audioEvents.played++
      this.addEventListener('ended', () => (window as any).audioEvents.ended++, { once: true })
      this.addEventListener('error', () => (window as any).audioEvents.failed++, { once: true })
      return nativePlay.call(this)
    }
  })
  await page.routeWebSocket('**/socket.io/**', ws => {
    ws.send('0' + JSON.stringify({ sid: 'voice-fixture', upgrades: [], pingInterval: 60000, pingTimeout: 60000 }))
    ws.onMessage(async raw => {
      const value = String(raw)
      if (value.startsWith('40')) {
        const prefix = value.split(',')[0]!
        ws.send(prefix + ',' + JSON.stringify({ sid: 'voice-fixture' }))
        if (prefix === '40/chat-run') { socket = ws; namespace = '42/chat-run,' }
      }
      if (!value.startsWith('42/chat-run,')) return
      const [event] = JSON.parse(value.slice(value.indexOf('[')))
      if (event === 'run') {
        runs++
        ws.send(namespace + JSON.stringify(['run.started', { event: 'run.started', session_id: 'voice-browser', run_id: `run-${runs}` }]))
      }
      if (event === 'resume') {
        const messages = await page.evaluate(() => (window as any).voiceFixture.chat.messages.map((m: any) => ({
          id: m.id, role: m.role, content: m.content, timestamp: m.timestamp / 1000,
        })))
        ws.send(namespace + JSON.stringify(['resumed', { session_id: 'voice-browser', messages, isWorking: true, events: [] }]))
        resumes++
      }
    })
  })
  await page.route(url => url.pathname.startsWith('/api/'), async route => {
    const path = new URL(route.request().url()).pathname
    if (path === '/api/studio/tts/synthesize') {
      const { text } = route.request().postDataJSON()
      spoken.push(text)
      const audioDir = process.env.REALTIME_VOICE_AUDIO_DIR
      const index = ['First sentence.', 'A partial sentence without punctuation', 'A partial'].indexOf(text)
      const realAudio = audioDir ? await readFile(resolve(audioDir, `real-edge-${index}.mp3`)) : undefined
      await route.fulfill({ body: realAudio || silentWav(), contentType: realAudio ? 'audio/mpeg' : 'audio/wav',
        headers: { 'X-TTS-Engine': realAudio ? 'edge' : 'fixture', 'X-TTS-Provider': 'edge' } })
      return
    }
    let json: unknown = {}
    if (path === '/api/auth/me') json = { user: { id: 1, username: 'fixture', role: 'super_admin' } }
    else if (path.includes('/profiles')) json = { profiles: [{ name: 'default', active: true }] }
    else if (path.includes('/stt/settings')) json = { provider: 'browser', settings: {} }
    await route.fulfill({ json })
  })
  const entry = '/@fs/' + resolve('tests/e2e/fixtures/realtime-voice.ts').replaceAll('\\', '/').replace(/^\//, '')
  await page.route('**/__realtime_voice__', route => route.fulfill({ contentType: 'text/html',
    body: `<!doctype html><html><body><div id="app"></div><script type="module" src="${entry}"></script></body></html>` }))
  await page.goto('/__realtime_voice__')
  await expect(page.getByTestId('realtime-voice-stage')).toBeVisible()
  async function send(event: string, data = {}) {
    await expect.poll(() => !!socket).toBe(true)
    socket!.send(namespace + JSON.stringify([event, { event, session_id: 'voice-browser', run_id: `run-${runs}`, ...data }]))
  }
  await page.getByRole('button', { name: 'Send transcript' }).click()
  await expect.poll(() => runs).toBe(1)
  await send('message.delta', { delta: 'First sentence. A partial' })
  await expect.poll(() => spoken).toEqual(['First sentence.'])
  await send('workspace.diff.completed', { change: { assistant_message_id: 'persisted-1' } })
  await expect.poll(() => page.evaluate(() => (window as any).voiceFixture.chat.messages.at(-1).id)).toBe('persisted-1')
  expect(spoken).toEqual(['First sentence.'])
  const previousSocket = socket
  socket!.close()
  await expect.poll(() => socket !== previousSocket && resumes === 1).toBe(true)
  await send('message.delta', { delta: ' sentence without punctuation' })
  await send('run.completed', { run_usage: { runId: 'run-1', assistantMessageId: 'persisted-1' } })
  await expect.poll(() => spoken).toEqual(['First sentence.', 'A partial sentence without punctuation'])
  await expect.poll(() => page.evaluate(() => (window as any).audioEvents), { timeout: 20_000 }).toEqual({ played: 2, ended: 2, failed: 0 })

  await page.getByRole('button', { name: 'Send transcript' }).click()
  await expect.poll(() => runs).toBe(2)
  await send('message.delta', { delta: 'First sentence. A partial' })
  await expect.poll(() => spoken.length).toBe(3)
  await send('tool.started', { tool: 'read_file', tool_call_id: 'read-1', arguments: { path: '/fixture' } })
  await expect(page.getByTestId('realtime-voice-tool-calls')).toContainText('read_file')
  await expect.poll(() => spoken.length).toBe(4)
  await send('tool.completed', { tool: 'read_file', tool_call_id: 'read-1', result: 'ok' })
  await send('message.delta', { delta: 'First sentence. ' })
  await send('run.completed', { run_usage: { runId: 'run-2', assistantMessageId: 'persisted-2' } })
  await expect.poll(() => spoken).toEqual(['First sentence.', 'A partial sentence without punctuation', 'First sentence.', 'A partial', 'First sentence.'])
  await expect.poll(() => page.evaluate(() => (window as any).audioEvents), { timeout: 20_000 }).toEqual({ played: 5, ended: 5, failed: 0 })
  expect(errors).toEqual([])
  await testInfo.attach('speech-observation', { body: JSON.stringify({ spoken, realEdgeAudio: !!process.env.REALTIME_VOICE_AUDIO_DIR }), contentType: 'application/json' })
  await testInfo.attach('voice-stage', { body: await page.screenshot(), contentType: 'image/png' })
})
