import Router from '@koa/router'
import * as ctrl from '../controllers/usb'

export const usbRoutes = new Router()

usbRoutes.get('/api/studio/usb/devices', ctrl.listUSBDevices)
usbRoutes.get('/api/studio/usb/history', ctrl.listUSBHistory)
usbRoutes.get('/api/studio/usb/devices/:uuid/ls', ctrl.listUSBFiles)
usbRoutes.get('/api/studio/usb/devices/:uuid/stat', ctrl.statUSBPath)
usbRoutes.get('/api/studio/usb/devices/:uuid/read', ctrl.readUSBFile)
usbRoutes.get('/api/studio/usb/devices/:uuid/disk-usage', ctrl.usbDiskUsage)
usbRoutes.post('/api/studio/usb/devices/:uuid/copy-to-workspace', ctrl.copyUSBFileToWorkspace)
