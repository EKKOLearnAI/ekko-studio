import Router from '@koa/router'
import * as ctrl from '../controllers/petdex'

export const petdexRoutes = new Router()
export const petdexPublicRoutes = new Router()

petdexPublicRoutes.get('/api/studio/petdex/asset', ctrl.asset)
petdexRoutes.get('/api/studio/petdex/manifest', ctrl.manifest)
