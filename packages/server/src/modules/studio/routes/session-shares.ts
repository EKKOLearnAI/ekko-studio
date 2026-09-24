import Router from '@koa/router'
import * as ctrl from '../controllers/session-shares'

// These routes authenticate App cloud identity + share token themselves. They
// must not convert a share recipient into an authenticated local Studio user.
export const sessionSharePublicRoutes = new Router()
sessionSharePublicRoutes.post('/api/studio/session-shares/claim', ctrl.claim)
sessionSharePublicRoutes.get('/api/studio/session-shares/access', ctrl.access)
sessionSharePublicRoutes.post('/api/studio/session-shares/check', ctrl.check)

export const sessionShareRoutes = new Router()
sessionShareRoutes.post('/api/studio/sessions/:sessionId/shares', ctrl.create)
sessionShareRoutes.get('/api/studio/sessions/:sessionId/shares', ctrl.list)
sessionShareRoutes.patch('/api/studio/sessions/:sessionId/shares/:shareId', ctrl.update)
sessionShareRoutes.delete('/api/studio/sessions/:sessionId/shares/:shareId', ctrl.revoke)
