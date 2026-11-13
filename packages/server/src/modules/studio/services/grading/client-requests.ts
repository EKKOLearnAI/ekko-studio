import { randomUUID } from 'node:crypto'
import type { Server, Namespace } from 'socket.io'
import { authenticateUserToken } from '../../middleware/auth'
import { listUserProfiles } from '../../repositories/users-store'
import { fail } from './store'
let namespace: Namespace | undefined
const pending = new Map<string, { profile: string; resolve: (value: any) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>()
export function installGradingSocket(io: Server) {
  namespace = io.of('/grading')
  namespace.use(async (socket, next) => {
    const user = await authenticateUserToken(String(socket.handshake.auth?.token || ''))
    const profile = String(socket.handshake.query.profile || 'default')
    if (!user || (user.role !== 'super_admin' && !listUserProfiles(user.id).some(p => p.profile_name === profile))) { next(new Error('Profile access denied')); return }
    socket.data.gradingProfile = profile
    next()
  })
  namespace.on('connection', socket => { void socket.join(socket.data.gradingProfile) })
}
export async function requestClient(profile: string, action: 'capture' | 'render', args: any) {
  if (!namespace || !(await namespace.in(profile).fetchSockets()).length) fail('Open the grading workspace before requesting camera or export', 409)
  const requestId = randomUUID()
  return new Promise<any>((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(requestId); reject(Object.assign(new Error('Grading client request timed out'), { status: 408 })) }, 120000)
    pending.set(requestId, { profile, resolve, reject, timer })
    namespace!.to(profile).emit('grading.request', { requestId, action, ...args })
  })
}
export function completeClientRequest(profile: string, requestId: string, value: any) {
  const request = pending.get(requestId)
  if (!request || request.profile !== profile) fail('Client request not found', 404)
  clearTimeout(request.timer); pending.delete(requestId)
  if (value.cancelled) request.reject(Object.assign(new Error('Teacher cancelled the request'), { status: 409 }))
  else request.resolve(value)
}
