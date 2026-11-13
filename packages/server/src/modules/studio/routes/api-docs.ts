import Router from '@koa/router'
import * as ctrl from '../controllers/api-docs'

export const apiDocsRoutes = new Router()

apiDocsRoutes.get('/api/openapi.json', ctrl.openapi)
