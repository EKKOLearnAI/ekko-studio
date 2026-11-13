import Router from '@koa/router'
import { requireSuperAdmin } from '../public/auth'
import * as ctrl from '../controllers/files'
import * as previewCtrl from '../controllers/file-preview'

export const fileRoutes = new Router()

fileRoutes.get('/api/studio/files/preview', previewCtrl.previewProfileFile)
fileRoutes.get('/api/studio/files/list', ctrl.list)
fileRoutes.get('/api/studio/files/stat', ctrl.stat)
fileRoutes.get('/api/studio/files/read', requireSuperAdmin, ctrl.read)
fileRoutes.put('/api/studio/files/write', requireSuperAdmin, ctrl.write)
fileRoutes.delete('/api/studio/files/delete', requireSuperAdmin, ctrl.remove)
fileRoutes.post('/api/studio/files/rename', requireSuperAdmin, ctrl.rename)
fileRoutes.post('/api/studio/files/mkdir', requireSuperAdmin, ctrl.mkdir)
fileRoutes.post('/api/studio/files/copy', requireSuperAdmin, ctrl.copy)
fileRoutes.post('/api/studio/files/upload', requireSuperAdmin, ctrl.upload)
