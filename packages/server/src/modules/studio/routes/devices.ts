import Router from '@koa/router'
import * as ctrl from '../controllers/devices'
import { requireSuperAdmin } from '../middleware/auth'

export const devicePublicRoutes = new Router()
export const deviceRoutes = new Router()

devicePublicRoutes.post('/api/studio/devices/link-request', ctrl.requestDeviceLinkController)
devicePublicRoutes.post('/api/studio/devices/link-status', ctrl.requestDeviceLinkStatusController)
devicePublicRoutes.get('/api/studio/devices/link-info', ctrl.deviceLinkInfoController)

deviceRoutes.use(requireSuperAdmin)
deviceRoutes.get('/api/studio/devices', ctrl.listDevices)
deviceRoutes.get('/api/studio/devices/pairing-link', ctrl.getDevicePairingLink)
deviceRoutes.post('/api/studio/devices/scan', ctrl.scanDevices)
deviceRoutes.post('/api/studio/devices/manual-request', ctrl.requestManualDevicePairing)
deviceRoutes.post('/api/studio/devices/:id/request', ctrl.requestDevicePairing)
deviceRoutes.post('/api/studio/devices/:id/approve', ctrl.approveDevice)
deviceRoutes.post('/api/studio/devices/:id/reject', ctrl.rejectDevice)
deviceRoutes.post('/api/studio/devices/:id/block', ctrl.blockDevice)
deviceRoutes.post('/api/studio/devices/:id/unblock', ctrl.unblockDevice)
deviceRoutes.delete('/api/studio/devices/:id/request-history', ctrl.deleteDeviceRequestHistory)
deviceRoutes.get('/api/studio/devices/peer-connections', ctrl.listPeerConnections)
deviceRoutes.post('/api/studio/devices/:id/connect', ctrl.connectPeerDevice)
deviceRoutes.post('/api/studio/devices/peer-connections/:connectionId/disconnect', ctrl.disconnectPeerDevice)
deviceRoutes.post('/api/studio/devices/peer-connections/:connectionId/terminal', ctrl.createPeerTerminal)
deviceRoutes.get('/api/studio/devices/peer-connections/:connectionId/terminals', ctrl.listPeerTerminals)
deviceRoutes.get('/api/studio/devices/peer-connections/:connectionId/terminal/:terminalId/read', ctrl.readPeerTerminal)
deviceRoutes.post('/api/studio/devices/peer-connections/:connectionId/terminal/:terminalId/input', ctrl.writePeerTerminal)
deviceRoutes.post('/api/studio/devices/peer-connections/:connectionId/terminal/:terminalId/resize', ctrl.resizePeerTerminal)
deviceRoutes.post('/api/studio/devices/peer-connections/:connectionId/terminal/:terminalId/close', ctrl.closePeerTerminal)
deviceRoutes.post('/api/studio/devices/peer-connections/:connectionId/exec', ctrl.execPeerCommand)
deviceRoutes.post('/api/studio/devices/peer-connections/:connectionId/download', ctrl.downloadPeerFile)
deviceRoutes.post('/api/studio/devices/peer-connections/:connectionId/upload', ctrl.uploadPeerFile)

devicePublicRoutes.post('/api/devices/link-request', ctrl.requestDeviceLinkController)

devicePublicRoutes.post('/api/devices/link-status', ctrl.requestDeviceLinkStatusController)
