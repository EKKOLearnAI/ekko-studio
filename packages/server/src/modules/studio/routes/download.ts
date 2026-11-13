import Router from '@koa/router'
import * as ctrl from '../controllers/download'

export const downloadRoutes = new Router()

downloadRoutes.get('/api/studio/files/download', ctrl.download)
