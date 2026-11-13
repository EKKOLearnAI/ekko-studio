import Router from '@koa/router'
import * as ctrl from '../controllers/cron-session-bindings'

export const cronSessionBindingRoutes = new Router()

cronSessionBindingRoutes.post('/api/hermes/cron/session-bindings', ctrl.bind)
