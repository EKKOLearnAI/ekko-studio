import { spawn } from 'node:child_process'
import { StringDecoder } from 'node:string_decoder'
import { randomUUID } from 'node:crypto'

export class OmpRpc {
  constructor(command, args, { cwd, env, signal, onEvent = async () => {} }) {
    this.pending = new Map(); this.listeners = new Set(); this.queue = Promise.resolve(); this.closed = false
    this.child = spawn(command, args, { cwd, env, windowsHide: true, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'] })
    this.stderr = ''; this.buffer = ''; this.chunk = null; this.decoder = new StringDecoder('utf8')
    this.ready = new Promise((resolve, reject) => { this.readyResolve = resolve; this.readyReject = reject })
    this.ready.catch(() => {})
    this.child.stderr.on('data', data => { this.stderr = (this.stderr + data).slice(-4000) })
    this.child.stdin.on('error', error => this.fail(error))
    this.child.once('error', error => this.fail(error))
    this.exited = new Promise(resolve => this.child.once('close', (code, reason) => {
      this.fail(new Error(`OMP process closed (${code ?? reason}): ${this.stderr}`)); resolve()
    }))
    this.onEvent = onEvent
    this.child.stdout.on('data', data => {
      this.buffer += this.decoder.write(data)
      if (Buffer.byteLength(this.buffer) > 3000000) { this.fail(new Error('OMP RPC physical frame is too large')); void this.close(); return }
      let index
      while ((index = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, index); this.buffer = this.buffer.slice(index + 1)
        if (!line.trim()) continue
        this.queue = this.queue.then(() => this.frame(JSON.parse(line))).catch(error => { this.fail(error); void this.close() })
      }
    })
    this.abort = () => { try { this.child.stdin.write(JSON.stringify({ type: 'abort', id: randomUUID() }) + '\n') } catch {} this.fail(signal.reason || new Error('OMP cancelled')); void this.close() }
    this.signal = signal; signal.addEventListener('abort', this.abort, { once: true })
    if (signal.aborted) this.abort()
  }
  async frame(frame) {
    if (frame.type === 'rpc_chunk') {
      if (!this.chunk) {
        if (frame.index !== 0 || !Number.isSafeInteger(frame.count) || frame.count < 1 || frame.count > 256 || !Number.isSafeInteger(frame.byteLength) || frame.byteLength < 1 || frame.byteLength > 67108864 || typeof frame.chunkId !== 'string') throw new Error('Invalid OMP chunk start')
        this.chunk = { id: frame.chunkId, count: frame.count, length: frame.byteLength, next: 0, parts: [], bytes: 0 }
      }
      const chunk = this.chunk
      if (frame.chunkId !== chunk.id || frame.index !== chunk.next || frame.count !== chunk.count || frame.byteLength !== chunk.length || typeof frame.data !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(frame.data)) throw new Error('Invalid OMP chunk sequence')
      const data = Buffer.from(frame.data, 'base64'); chunk.parts.push(data); chunk.bytes += data.length; chunk.next++
      if (chunk.bytes > chunk.length) throw new Error('OMP chunk exceeded its declared length')
      if (chunk.next !== chunk.count) return
      if (chunk.bytes !== chunk.length) throw new Error('Incomplete OMP chunk')
      this.chunk = null
      return this.frame(JSON.parse(new TextDecoder('utf8', { fatal: true }).decode(Buffer.concat(chunk.parts))))
    }
    if (this.chunk) throw new Error('Interrupted OMP chunk sequence')
    if (frame.type === 'ready') { this.protocol = frame; this.readyResolve(frame); return }
    if (frame.type === 'response' && frame.id) {
      const pending = this.pending.get(frame.id)
      if (pending) { this.pending.delete(frame.id); clearTimeout(pending.timer); frame.success ? pending.resolve(frame.data) : pending.reject(new Error(frame.error || `OMP ${frame.command} failed`)) }
    }
    for (const listener of [...this.listeners]) listener(frame)
    await this.onEvent(frame, this)
  }
  fail(error) {
    this.failure ||= error; this.readyReject(error)
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error) }
    this.pending.clear()
    for (const listener of [...this.listeners]) listener({ type: 'studio_process_error', error })
  }
  send(frame) {
    if (this.failure || this.closed) throw this.failure || new Error('OMP RPC closed')
    const line = JSON.stringify(frame) + '\n'
    // OMP's physical-frame advertisement applies to stdout; stdin accepts one JSONL image payload.
    if (Buffer.byteLength(line) > 67108864) throw new Error('OMP RPC input exceeds 64 MiB')
    this.child.stdin.write(line)
  }
  request(type, input = {}, timeout = 30000) {
    const id = randomUUID()
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`OMP ${type} timed out`)) }, timeout)
      this.pending.set(id, { resolve, reject, timer })
      try { this.send({ ...input, type, id }) } catch (error) { this.pending.delete(id); clearTimeout(timer); reject(error) }
    })
  }
  async initialize() {
    let timer
    try { await Promise.race([this.ready, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('OMP startup timed out')), 30000) })]) }
    finally { clearTimeout(timer) }
    if (this.protocol.supportedProtocolVersions?.includes(2)) await this.request('negotiate_protocol', { protocolVersion: 2 })
  }
  async prompt(message, images) {
    const id = randomUUID()
    let finish
    const result = new Promise((resolve, reject) => {
      finish = frame => {
        if (frame.type === 'studio_process_error') reject(frame.error)
        else if (frame.type === 'response' && frame.id === id && !frame.success) reject(new Error(frame.error || 'OMP prompt failed'))
        else if (frame.type === 'response' && frame.id === id && frame.data?.agentInvoked === false) resolve(frame)
        else if (frame.type === 'prompt_result' && frame.id === id) {
          if (frame.status !== 'completed') reject(new Error(frame.error?.message || `OMP prompt ${frame.status}`))
          else if (frame.sessionSettled) resolve(frame)
          else this.awaitingSettle = true
        } else if (frame.type === 'session_settled' && this.awaitingSettle) resolve(frame)
        else if (frame.type === 'agent_end' && frame.isTerminal !== false && frame.yielded !== false) resolve(frame)
      }
      this.listeners.add(finish)
      try { this.send({ type: 'prompt', id, message, ...(images.length ? { images } : {}) }) } catch (error) { reject(error) }
    })
    try { return await result } finally { this.listeners.delete(finish); this.awaitingSettle = false }
  }
  async close() {
    if (this.closing) return this.closing
    this.closed = true; this.signal.removeEventListener('abort', this.abort)
    return this.closing = (async () => {
      this.child.stdin.end()
      const kill = () => { try { process.platform === 'win32' ? this.child.kill('SIGKILL') : process.kill(-this.child.pid, 'SIGKILL') } catch {} }
      const timer = setTimeout(kill, 1500)
      try { await this.exited } finally { clearTimeout(timer) }
    })()
  }
}
