import { createServer, type Server } from 'node:net'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises'
import { dirname } from 'node:path'

export type ApprovalChoice = 'once' | 'session' | 'always' | 'deny'
export interface ApprovalRequest { approvalId: string; command: string; description: string; choices: ApprovalChoice[]; timeoutMs: number }
const choices: ApprovalChoice[] = ['once', 'session', 'always', 'deny']
function canonical(value: any): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
  return JSON.stringify(value)
}
export class AntigravityApprovalGate {
  private pending = new Map<string, { finish: (choice: ApprovalChoice) => void }>()
  private sessionAllow = new Set<string>()
  private closed = false
  private writes: Promise<void> = Promise.resolve()
  readonly token = randomBytes(32).toString('hex')
  readonly server: Server
  constructor(readonly endpoint: string, private readonly grantsPath: string, private readonly emit: (event: string, payload: any) => void, private readonly timeoutMs = 300_000) {
    this.server = createServer(socket => {
      let data = ''
      socket.setTimeout(this.timeoutMs + 5000, () => socket.destroy())
      socket.on('error', () => {})
      socket.on('data', chunk => {
        data += chunk.toString('utf8')
        if (Buffer.byteLength(data) > 65536) { socket.destroy(); return }
        const newline = data.indexOf('\n')
        if (newline < 0) return
        socket.pause()
        let value: any
        try { value = JSON.parse(data.slice(0, newline)) } catch { socket.destroy(); return }
        if (value.token !== this.token || this.closed) { socket.end('{"decision":"deny"}\n'); return }
        let requestId = ''
        void this.request(value.request, id => { requestId = id }).then(choice => {
          if (!socket.destroyed) socket.end(`${JSON.stringify({ decision: choice === 'deny' ? 'deny' : 'allow', reason: 'Studio approval decision; native rules remain authoritative' })}\n`)
        }).catch(() => { if (!socket.destroyed) socket.end('{"decision":"deny"}\n') })
        socket.once('close', () => { if (requestId) this.respond(requestId, 'deny') })
      })
    })
    // Server startup errors fail closed: the hook cannot connect and returns deny.
    this.server.on('error', () => this.close())
    this.server.listen(endpoint)
    this.server.unref()
  }
  async request(raw: any, onId: (id: string) => void = () => {}): Promise<ApprovalChoice> {
    if (this.closed || !raw?.toolCall || typeof raw.toolCall.name !== 'string' || !raw.toolCall.args || typeof raw.toolCall.args !== 'object' || Array.isArray(raw.toolCall.args)) return 'deny'
    const key = createHash('sha256').update(canonical({ name: raw.toolCall.name, args: raw.toolCall.args })).digest('hex')
    if (this.sessionAllow.has(key)) return 'session'
    let permanent: string[] = []
    try { const value = JSON.parse(await readFile(this.grantsPath, 'utf8')); if (!Array.isArray(value.allow) || !value.allow.every((key: any) => typeof key === 'string')) return 'deny'; permanent = value.allow }
    catch (error: any) { if (error.code !== 'ENOENT') return 'deny' }
    if (this.closed) return 'deny'
    if (permanent.includes(key)) return 'always'
    const id = randomUUID(); onId(id)
    return new Promise(resolve => {
      let settled = false
      const timer = setTimeout(() => finish('deny'), this.timeoutMs); timer.unref()
      const finish = (choice: ApprovalChoice) => {
        if (settled) return; settled = true; clearTimeout(timer); this.pending.delete(id)
        void (async () => {
          if (this.closed) choice = 'deny'
          if (choice === 'session') this.sessionAllow.add(key)
          if (choice === 'always') {
            try {
              this.writes = this.writes.catch(() => {}).then(async () => {
                if (this.closed) throw new Error('Approval stopped')
                let allow: string[] = []
                try { allow = JSON.parse(await readFile(this.grantsPath, 'utf8')).allow } catch (error: any) { if (error.code !== 'ENOENT') throw error }
                if (!Array.isArray(allow)) throw new Error('Invalid grants')
                await mkdir(dirname(this.grantsPath), { recursive: true })
                const temporary = `${this.grantsPath}.${randomUUID()}.tmp`
                await writeFile(temporary, JSON.stringify({ allow: [...new Set([...allow, key])] }), { mode: 0o600 })
                await rename(temporary, this.grantsPath)
              }); await this.writes
            } catch { choice = 'deny' }
          }
          if (this.closed) choice = 'deny'
          try { this.emit('approval.resolved', { approval_id: id, choice }) } catch {}
          resolve(choice)
        })()
      }
      this.pending.set(id, { finish })
      try { this.emit('approval.requested', { approval_id: id, command: `${raw.toolCall.name} ${canonical(raw.toolCall.args)}`, description: 'Approve this exact tool operation. Native CLI permissions still apply.', choices, allow_permanent: true, timeout_ms: this.timeoutMs, requested_at: Date.now(), remaining_timeout_ms: this.timeoutMs }) } catch { finish('deny') }
    })
  }
  respond(id: string, choice: string): { handled: boolean; resolved: boolean } {
    const pending = this.pending.get(id)
    if (!pending) return { handled: false, resolved: false }
    if (!choices.includes(choice as ApprovalChoice)) return { handled: true, resolved: false }
    pending.finish(choice as ApprovalChoice); return { handled: true, resolved: true }
  }
  denyPending(): void { for (const pending of [...this.pending.values()]) pending.finish('deny') }
  close(): void {
    if (this.closed) return; this.closed = true
    this.denyPending()
    this.server.close()
  }
}

export const ANTIGRAVITY_APPROVAL_HOOK = `import net from 'node:net';
let input='';for await(const chunk of process.stdin){input+=chunk;if(Buffer.byteLength(input)>65536)process.exit(2)}
const deny=()=>{console.log(JSON.stringify({decision:'deny',reason:'Studio approval unavailable, canceled or timed out'}));process.exit(0)};
let request;try{request=JSON.parse(input)}catch{deny()}
const endpoint=process.env.EKKO_AGY_APPROVAL_ENDPOINT,token=process.env.EKKO_AGY_APPROVAL_TOKEN;
if(!endpoint||!token)deny();
const socket=net.connect(endpoint);let output='';const timer=setTimeout(deny,305000);
socket.on('connect',()=>socket.write(JSON.stringify({token,request})+'\\n'));
socket.on('error',deny);socket.on('end',()=>{clearTimeout(timer);try{const reply=JSON.parse(output.trim());if(!['allow','deny'].includes(reply.decision))deny();console.log(JSON.stringify(reply))}catch{deny()}});
socket.on('data',chunk=>{output+=chunk;if(Buffer.byteLength(output)>65536)deny()});
`
