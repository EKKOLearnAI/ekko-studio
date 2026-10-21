import Router from '@koa/router'
import * as ctrl from '../controllers/mcu-devices'

export const mcuDevicePublicRoutes = new Router()

// Compatibility for shipped Small Box firmware's manual backend connection.
mcuDevicePublicRoutes.get('/api/devices/link-info', ctrl.mcuBackendInfoController)

export const mcuDeviceRoutes = new Router()

mcuDeviceRoutes.get('/api/mcu-devices', ctrl.listMcuDevicesController)
mcuDeviceRoutes.post('/api/mcu-devices', ctrl.createMcuDeviceController)
mcuDeviceRoutes.post('/api/mcu-devices/:id/remote-connect', ctrl.connectMcuDeviceRemoteController)
mcuDeviceRoutes.post('/api/mcu-devices/:id/remote-disconnect', ctrl.disconnectMcuDeviceRemoteController)
mcuDeviceRoutes.patch('/api/mcu-devices/:id', ctrl.updateMcuDeviceController)
mcuDeviceRoutes.delete('/api/mcu-devices/:id', ctrl.deleteMcuDeviceController)
