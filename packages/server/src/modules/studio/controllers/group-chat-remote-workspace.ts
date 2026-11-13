import type { Context } from 'koa'
import { logger } from '../public/logging'
import { getGroupChatRuntimeServer } from '../services/group-chat/runtime'
import { beginRemoteWorkspaceGrantOperation } from '../services/group-chat/remote-workspace-auth'
import { storeAgentGroupChatAttachment } from '../services/group-chat/attachments'
import {
  MAX_REMOTE_WORKSPACE_TRANSFER_BYTES,
  openRemoteWorkspaceDownload,
  performRemoteWorkspaceAction,
  uploadRemoteWorkspaceFile,
} from '../services/group-chat/remote-workspace-files'
import { resolveGroupWorkspacePath } from '../services/group-chat/workspace-files'
import { normalizeDirectoryTarget } from '../services/workspace/directory'
import { buildFileContentHeaders } from '../public/workspace-files'

function bearerToken(ctx: Context): string {
  const authorization = ctx.get('Authorization')
  const match = authorization.match(/^Bearer ([a-zA-Z0-9_-]+)$/)
  return match?.[1] || ''
}

function authorizedWorkspace(
  ctx: Context,
  grant: NonNullable<ReturnType<typeof beginRemoteWorkspaceGrantOperation>>['grant'],
): string | null {
  const server = getGroupChatRuntimeServer()
  const room = server?.getStorage().getRoom(grant.roomId)
  if (
    !room
    || Number(room.allowRemoteWorkspaceAccess || 0) !== 1
    || normalizeDirectoryTarget(String(room.workspace || '').trim()) !== grant.workspace
  ) {
    ctx.status = 403
    ctx.body = { error: 'Remote workspace access is disabled', code: 'permission_denied' }
    return null
  }
  const workspace = grant.workspace
  if (!workspace) {
    ctx.status = 404
    ctx.body = { error: 'Room workspace not found', code: 'workspace_not_found' }
    return null
  }
  return workspace
}

function handleRemoteWorkspaceError(ctx: Context, error: any): void {
  ctx.status = Number(error?.status || (error?.code === 'ENOENT' ? 404 : 500))
  ctx.body = {
    error: error?.message || 'Remote workspace action failed',
    code: error?.code || 'remote_workspace_error',
  }
}

async function publishAgentWorkspaceArtifact(
  workspace: string,
  grant: NonNullable<ReturnType<typeof beginRemoteWorkspaceGrantOperation>>['grant'],
  path: string,
): Promise<{ messageId: string; attachment: Awaited<ReturnType<typeof storeAgentGroupChatAttachment>> }> {
  const server = getGroupChatRuntimeServer()
  if (!server) throw Object.assign(new Error('Group chat not initialized'), {
    status: 503,
    code: 'group_chat_unavailable',
  })
  const source = await resolveGroupWorkspacePath(workspace, path)
  const attachment = await storeAgentGroupChatAttachment(grant.roomId, source.fullPath, path)
  const message = server.publishAgentAttachmentMessage({
    roomId: grant.roomId,
    agentId: grant.agentId,
    runId: grant.runId,
    workspacePath: path,
    attachment,
    ...(grant.agentSnapshot ? { agentSnapshot: grant.agentSnapshot } : {}),
  })
  return { messageId: message.id, attachment }
}

export async function remoteWorkspaceAction(ctx: Context): Promise<void> {
  ctx.set('Cache-Control', 'no-store')
  const operation = beginRemoteWorkspaceGrantOperation(bearerToken(ctx))
  if (!operation) {
    ctx.status = 401
    ctx.body = { error: 'Remote workspace authorization is invalid or expired', code: 'invalid_grant' }
    return
  }
  const { grant } = operation
  try {
    const workspace = authorizedWorkspace(ctx, grant)
    if (!workspace) return
    const body = (ctx.request.body || {}) as Record<string, unknown>
    const action = String(body.action || '')
    ctx.body = await performRemoteWorkspaceAction(workspace, {
      ...body,
      action,
    } as any)
    logger.info({
      roomId: grant.roomId,
      agentId: grant.agentId,
      runId: grant.runId,
      action,
      path: String(body.path || '').slice(0, 500),
    }, '[GroupChat] remote workspace action')
  } catch (error: any) {
    handleRemoteWorkspaceError(ctx, error)
  } finally {
    operation.finish()
  }
}

export async function downloadRemoteWorkspaceFile(ctx: Context): Promise<void> {
  ctx.set('Cache-Control', 'no-store')
  const operation = beginRemoteWorkspaceGrantOperation(bearerToken(ctx))
  if (!operation) {
    ctx.status = 401
    ctx.body = { error: 'Remote workspace authorization is invalid or expired', code: 'invalid_grant' }
    return
  }
  const { grant } = operation
  try {
    const workspace = authorizedWorkspace(ctx, grant)
    if (!workspace) return
    const download = await openRemoteWorkspaceDownload(workspace, ctx.query.path)
    const headers = buildFileContentHeaders({
      fileName: download.path,
      mime: 'application/octet-stream',
      size: download.size,
      download: true,
    })
    for (const [name, value] of Object.entries(headers)) ctx.set(name, value)
    ctx.set('ETag', `"sha256:${download.sha256}"`)
    ctx.set('X-Content-SHA256', download.sha256)
    ctx.body = download.stream
    logger.info({
      roomId: grant.roomId,
      agentId: grant.agentId,
      runId: grant.runId,
      action: 'download',
      path: download.path.slice(0, 500),
      size: download.size,
    }, '[GroupChat] remote workspace file transfer')
  } catch (error: any) {
    handleRemoteWorkspaceError(ctx, error)
  } finally {
    operation.finish()
  }
}

export async function uploadRemoteWorkspaceFileContent(ctx: Context): Promise<void> {
  ctx.set('Cache-Control', 'no-store')
  const operation = beginRemoteWorkspaceGrantOperation(bearerToken(ctx))
  if (!operation) {
    ctx.status = 401
    ctx.body = { error: 'Remote workspace authorization is invalid or expired', code: 'invalid_grant' }
    return
  }
  const { grant } = operation
  try {
    const workspace = authorizedWorkspace(ctx, grant)
    if (!workspace) return
    const contentType = ctx.get('Content-Type').split(';')[0]?.trim().toLowerCase()
    if (contentType !== 'application/octet-stream') {
      ctx.status = 415
      ctx.body = { error: 'Upload must use application/octet-stream', code: 'unsupported_media_type' }
      return
    }
    const declaredLength = ctx.get('Content-Length')
    if (declaredLength) {
      const size = Number(declaredLength)
      if (!Number.isSafeInteger(size) || size < 0) {
        ctx.status = 400
        ctx.body = { error: 'Invalid Content-Length', code: 'invalid_content_length' }
        return
      }
      if (size > MAX_REMOTE_WORKSPACE_TRANSFER_BYTES) {
        ctx.status = 413
        ctx.body = { error: 'File is too large for remote workspace transfer', code: 'file_too_large' }
        return
      }
    }
    const uploaded = await uploadRemoteWorkspaceFile(
      workspace,
      ctx.query.path,
      ctx.req,
      ctx.get('X-Expected-SHA256'),
    )
    const publication = await publishAgentWorkspaceArtifact(workspace, grant, uploaded.path)
    ctx.body = { ...uploaded, ...publication }
    logger.info({
      roomId: grant.roomId,
      agentId: grant.agentId,
      runId: grant.runId,
      action: 'upload',
      path: uploaded.path.slice(0, 500),
      size: uploaded.size,
    }, '[GroupChat] remote workspace file transfer')
  } catch (error: any) {
    handleRemoteWorkspaceError(ctx, error)
  } finally {
    operation.finish()
  }
}
