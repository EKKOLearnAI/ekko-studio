import Router from '@koa/router'
import * as ctrl from '../controllers/mcu-firmware'

export const mcuFirmwareRoutes = new Router()

mcuFirmwareRoutes.get('/api/studio/mcu/firmware/:version/manifest', ctrl.manifest)
mcuFirmwareRoutes.get('/api/studio/mcu/firmware/:version/firmware.bin', ctrl.download)
mcuFirmwareRoutes.get('/api/studio/mcu/firmware/manifest', ctrl.legacyManifest)
mcuFirmwareRoutes.get('/api/studio/mcu/firmware.bin', ctrl.legacyDownload)
