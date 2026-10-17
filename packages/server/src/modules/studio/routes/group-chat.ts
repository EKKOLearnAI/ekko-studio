import Router from '@koa/router'
import * as ctrl from '../controllers/group-chat'
import * as inviteCtrl from '../controllers/group-chat-invite'
import * as workspaceCtrl from '../controllers/group-chat-workspace'
import * as agentLinkCtrl from '../controllers/group-chat-agent-link'
import * as remoteWorkspaceCtrl from '../controllers/group-chat-remote-workspace'
import * as agentPresetCtrl from '../controllers/group-agent-presets'

export { getGroupChatServer, setGroupChatServer } from '../controllers/group-chat'

export const groupChatPublicRoutes = new Router()
export const groupChatRoutes = new Router()

groupChatPublicRoutes.post('/api/studio/group-chat/invites/:code/attachments', inviteCtrl.uploadInviteAttachment)
groupChatPublicRoutes.get('/api/studio/group-chat/invites/:code/attachments/:file', inviteCtrl.readInviteAttachment)
groupChatPublicRoutes.options('/api/studio/group-chat-link/v1/capabilities', agentLinkCtrl.capabilities)
groupChatPublicRoutes.get('/api/studio/group-chat-link/v1/capabilities', agentLinkCtrl.capabilities)
groupChatPublicRoutes.post('/api/studio/group-chat/invites/:code/agent-link-handoffs', agentLinkCtrl.createPairingHandoff)
groupChatPublicRoutes.post('/api/studio/group-chat/invites/:code/agent-links/:requestId/submit', agentLinkCtrl.submitPairingHandoff)
groupChatPublicRoutes.post('/api/studio/group-chat/invites/:code/agent-links/:requestId/failure', agentLinkCtrl.failPairingHandoff)
groupChatPublicRoutes.post('/api/studio/group-chat/invites/:code/agent-links', agentLinkCtrl.requestPairing)
groupChatPublicRoutes.get('/api/studio/group-chat/invites/:code/agent-links/:requestId', agentLinkCtrl.pairingStatus)
/**
 * Perform a JSON action against the current Agent run's shared group workspace.
 * Supported actions are list, read, write, mkdir, and delete. JSON write actions
 * only update the workspace and do not publish an Agent attachment message.
 */
groupChatPublicRoutes.post('/api/studio/group-chat/remote-workspace/v1', remoteWorkspaceCtrl.remoteWorkspaceAction)
groupChatPublicRoutes.get('/api/studio/group-chat/remote-workspace/v1/file', remoteWorkspaceCtrl.downloadRemoteWorkspaceFile)
/**
 * Upload a binary artifact to the current Agent run's shared group workspace.
 * Returns its workspace path, checksum, generated attachment block, and messageId.
 * A successful upload also publishes a separate Agent attachment message to the
 * room with the workspace-relative path as its text body and the image/file block
 * in the same attachment format used by the message composer.
 */
groupChatPublicRoutes.put('/api/studio/group-chat/remote-workspace/v1/file', remoteWorkspaceCtrl.uploadRemoteWorkspaceFileContent)

groupChatRoutes.get('/api/studio/group-chat-link/v1/agents', agentLinkCtrl.localAgents)
groupChatRoutes.get('/api/studio/group-chat-link/v1/connections', agentLinkCtrl.localConnections)
groupChatRoutes.post('/api/studio/group-chat-link/v1/connect', agentLinkCtrl.connectLocalAgent)
groupChatRoutes.post('/api/studio/group-chat-link/v1/connect-handoff', agentLinkCtrl.connectLocalAgentHandoff)
groupChatRoutes.put('/api/studio/group-chat-link/v1/connections/:connectorId', agentLinkCtrl.updateLocalAgent)
groupChatRoutes.put('/api/studio/group-chat-link/v1/connections/:connectorId/room-alias', agentLinkCtrl.renameLocalRoom)
groupChatRoutes.post('/api/studio/group-chat-link/v1/connections/:connectorId/leave-room', agentLinkCtrl.leaveLocalRoom)
groupChatRoutes.post('/api/studio/group-chat-link/v1/disconnect', agentLinkCtrl.disconnectLocalAgent)
groupChatRoutes.get('/api/studio/group-chat/rooms/:roomId/agent-link-requests', agentLinkCtrl.pendingPairings)
groupChatRoutes.post('/api/studio/group-chat/rooms/:roomId/agent-link-requests/:requestId/decision', agentLinkCtrl.decidePairing)
groupChatRoutes.put('/api/studio/group-chat/rooms/:roomId/guest-agent-policy', agentLinkCtrl.updateGuestAgentPolicy)
groupChatRoutes.delete('/api/studio/group-chat/rooms/:roomId/agent-connectors/:connectorId', agentLinkCtrl.revokeConnector)
groupChatRoutes.get('/api/studio/group-chat/agent-presets', agentPresetCtrl.list)
groupChatRoutes.post('/api/studio/group-chat/agent-presets', agentPresetCtrl.create)
groupChatRoutes.put('/api/studio/group-chat/agent-presets/:presetId', agentPresetCtrl.update)
groupChatRoutes.delete('/api/studio/group-chat/agent-presets/:presetId', agentPresetCtrl.remove)

groupChatRoutes.post('/api/studio/group-chat/rooms/:roomId/attachments', ctrl.uploadRoomAttachment)
groupChatRoutes.post('/api/studio/group-chat/rooms/:roomId/attachment-uploads', ctrl.openRoomAttachmentUpload)
groupChatRoutes.put('/api/studio/group-chat/rooms/:roomId/attachment-uploads/:id/chunks', ctrl.appendRoomAttachmentUploadChunk)
groupChatRoutes.post('/api/studio/group-chat/rooms/:roomId/attachment-uploads/:id/complete', ctrl.completeRoomAttachmentUpload)
groupChatRoutes.delete('/api/studio/group-chat/rooms/:roomId/attachment-uploads/:id', ctrl.abortRoomAttachmentUpload)
groupChatRoutes.get('/api/studio/group-chat/rooms/:roomId/attachments/:file', ctrl.readRoomAttachment)
groupChatPublicRoutes.get('/api/studio/group-chat/rooms/join/:code', inviteCtrl.resolveInvite)
groupChatRoutes.post('/api/studio/group-chat/rooms', ctrl.createRoom)
groupChatRoutes.post('/api/studio/group-chat/rooms/:roomId/clone', ctrl.cloneRoom)
groupChatRoutes.get('/api/studio/group-chat/rooms/:roomId', ctrl.getRoom)
groupChatRoutes.get('/api/studio/group-chat/rooms/:roomId/workspace-files/list', workspaceCtrl.listWorkspaceFiles)
groupChatRoutes.get('/api/studio/group-chat/rooms/:roomId/workspace-file/diff', workspaceCtrl.diffWorkspaceFile)
groupChatRoutes.get('/api/studio/group-chat/rooms/:roomId/workspace-file/read', workspaceCtrl.readWorkspaceFile)
groupChatRoutes.get('/api/studio/group-chat/rooms/:roomId/workspace-file/content', workspaceCtrl.readWorkspaceFileContent)
groupChatRoutes.put('/api/studio/group-chat/rooms/:roomId/workspace-file/write', workspaceCtrl.writeWorkspaceFile)
groupChatRoutes.post('/api/studio/group-chat/rooms/:roomId/workspace-file/mkdir', workspaceCtrl.mkdirWorkspaceFile)
groupChatRoutes.delete('/api/studio/group-chat/rooms/:roomId/workspace-file/delete', workspaceCtrl.deleteWorkspaceFile)
groupChatRoutes.post('/api/studio/group-chat/rooms/:roomId/workspace-file/rename', workspaceCtrl.renameWorkspaceFile)
groupChatRoutes.post('/api/studio/group-chat/rooms/:roomId/workspace-file/copy', workspaceCtrl.copyWorkspaceFile)
groupChatRoutes.get('/api/studio/group-chat/rooms', ctrl.listRooms)
groupChatRoutes.put('/api/studio/group-chat/rooms/:roomId/invite-code', ctrl.updateRoomInviteCode)
groupChatRoutes.post('/api/studio/group-chat/rooms/:roomId/agents', ctrl.addRoomAgent)
groupChatRoutes.put('/api/studio/group-chat/rooms/:roomId/agents/:agentId', ctrl.updateRoomAgent)
groupChatRoutes.get('/api/studio/group-chat/rooms/:roomId/agents', ctrl.listRoomAgents)
groupChatRoutes.delete('/api/studio/group-chat/rooms/:roomId/members/:userId', ctrl.removeRoomMember)
groupChatRoutes.delete('/api/studio/group-chat/rooms/:roomId/agents/:agentId', ctrl.removeRoomAgent)
groupChatRoutes.delete('/api/studio/group-chat/rooms/:roomId', ctrl.removeRoom)
groupChatRoutes.post('/api/studio/group-chat/rooms/:roomId/clear-context', ctrl.clearRoomContext)
groupChatRoutes.put('/api/studio/group-chat/rooms/:roomId/config', ctrl.updateRoomConfig)
groupChatRoutes.post('/api/studio/group-chat/rooms/:roomId/handoffs/:chainId/continue', ctrl.continueRoomHandoff)
groupChatRoutes.get('/api/studio/group-chat/rooms/:roomId/handoffs', ctrl.listRoomHandoffs)
groupChatRoutes.put('/api/studio/group-chat/rooms/:roomId/workspace', ctrl.updateRoomWorkspace)
groupChatRoutes.get('/api/studio/group-chat/rooms/:roomId/summary', ctrl.getRoomSummary)
groupChatRoutes.put('/api/studio/group-chat/rooms/:roomId/summary', ctrl.updateRoomSummary)

groupChatRoutes.get('/api/studio/group-chat/rooms/:roomId/message-selection', ctrl.getRoomMessageSelection)
groupChatRoutes.post('/api/studio/group-chat/rooms/:roomId/messages/delete', ctrl.deleteRoomMessages)
