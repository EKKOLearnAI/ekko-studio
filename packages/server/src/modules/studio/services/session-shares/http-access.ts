import type { Context, Next } from 'koa'
import { SessionShareError, type SessionShareAction } from '../../contracts/session-shares'
import { authenticateSessionShare, authorizeSessionShare, assertShareProfile, sessionShareExecutionUser, watchSessionShare, type SessionShareAccess } from './access'

declare module 'koa' { interface DefaultState { sessionShare?: SessionShareAccess; sessionShareFileAction?: 'workspaceRead' | 'workspaceWrite' | 'download' } }

/** Closed allowlist: a temporary credential never grants account-level API access. */
export function sessionShareHttpOperation(method: string, path: string, query: Record<string, unknown>, body: any): { action: SessionShareAction; sessionId?: string; fileAction?: 'workspaceRead' | 'workspaceWrite' | 'download' } {
  let match = /^\/api\/studio\/sessions\/conversations\/([^/]+)\/messages(?:\/paginated)?$/.exec(path)
  if (method === 'GET' && match) return { action: 'read', sessionId: decodeURIComponent(match[1]) }
  match = /^\/api\/studio\/sessions\/([^/]+)(?:\/(.*))?$/.exec(path)
  if (match) {
    const sessionId = decodeURIComponent(match[1])
    if (['conversations', 'count', 'hermes', 'search', 'usage', 'context-length'].includes(sessionId)) throw new SessionShareError('share_endpoint_forbidden')
    const suffix = match[2] || ''
    if (method === 'GET' && ['', 'context', 'usage'].includes(suffix)) return { action: 'read', sessionId }
    if (method === 'GET' && suffix === 'export') return { action: 'download', sessionId }
    if (method === 'GET' && ['workspace-files/list', 'workspace-file/read', 'workspace-file/diff', 'workspace-file/content'].includes(suffix)) {
      const action = suffix === 'workspace-file/content' && query.download === '1' ? 'download' : 'workspaceRead'
      return { action, sessionId, fileAction: action }
    }
    if (['PUT workspace-file/write', 'POST workspace-file/mkdir', 'DELETE workspace-file/delete', 'POST workspace-file/rename', 'POST workspace-file/copy'].includes(`${method} ${suffix}`)) {
      return { action: 'workspaceWrite', sessionId, fileAction: 'workspaceWrite' }
    }
    if (method === 'GET' && /^workspace-run-changes(?:\/[^/]+\/files\/\d+)?$/.test(suffix)) return { action: 'workspaceRead', sessionId }
  }
  if (method === 'POST' && path === '/api/studio/chat-run/runs') {
    if (typeof body?.session_id !== 'string' || !body.session_id) throw new SessionShareError('share_session_required', 400)
    return { action: 'input', sessionId: body.session_id }
  }
  if ((method === 'POST' && ['/api/studio/uploads', '/api/studio/app-uploads'].includes(path))
    || (method === 'PUT' && /^\/api\/studio\/app-uploads\/[^/]+\/chunks$/.test(path))
    || (method === 'POST' && /^\/api\/studio\/app-uploads\/[^/]+\/complete$/.test(path))
    || (method === 'DELETE' && /^\/api\/studio\/app-uploads\/[^/]+$/.test(path))) return { action: 'upload' }
  if (method === 'GET' && path === '/api/studio/files/download') return { action: 'download' }
  throw new SessionShareError('share_endpoint_forbidden')
}

export async function handleSessionShareHttp(ctx: Context, next: Next): Promise<boolean> {
  const bearer = String(ctx.headers.authorization || '').replace(/^Bearer\s+/i, '')
  const token = String(ctx.headers['x-session-share-token'] || '') || (bearer.startsWith('sst1_') ? bearer : '')
  if (!token) return false
  let dispose: (() => void) | undefined
  try {
    const operation = sessionShareHttpOperation(ctx.method, ctx.path, ctx.query, ctx.request.body)
    const access = await authenticateSessionShare(token, ctx.get('x-app-access-token'))
    const body = ctx.request.body as any
    assertShareProfile(access, ctx.get('x-hermes-profile'), ctx.query.profile, body?.profile)
    authorizeSessionShare(access, operation.action, operation.sessionId)
    ctx.state.sessionShare = access
    ctx.state.sessionShareFileAction = operation.fileAction
    ctx.state.profile = { name: access.share.profile }
    ctx.state.user = sessionShareExecutionUser(access)
    dispose = watchSessionShare(access, operation.action, () => ctx.res.destroy())
    await next()
    authorizeSessionShare(access, operation.action, operation.sessionId)
  } catch (error) {
    if (!(error instanceof SessionShareError)) throw error
    ctx.status = error.status
    ctx.body = { error: error.message, code: error.code }
  } finally {
    dispose?.()
    ctx.set('Cache-Control', 'no-store')
    ctx.set('Referrer-Policy', 'no-referrer')
  }
  return true
}
