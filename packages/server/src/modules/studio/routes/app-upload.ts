import Router from '@koa/router'
import * as ctrl from '../controllers/app-upload'

export const appUploadRoutes = new Router()

appUploadRoutes.post('/api/studio/app-uploads', ctrl.open)
appUploadRoutes.put('/api/studio/app-uploads/:id/chunks', ctrl.appendChunk)
appUploadRoutes.post('/api/studio/app-uploads/:id/complete', ctrl.complete)
appUploadRoutes.delete('/api/studio/app-uploads/:id', ctrl.abort)
