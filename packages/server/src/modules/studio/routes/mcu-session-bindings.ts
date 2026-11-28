import Router from '@koa/router'
import * as ctrl from '../controllers/mcu-session-bindings'

export const mcuSessionBindingRoutes = new Router()
mcuSessionBindingRoutes.get('/api/studio/mcu/session-bindings', ctrl.getMcuSessionBinding)
mcuSessionBindingRoutes.put('/api/studio/mcu/session-bindings', ctrl.putMcuSessionBinding)
mcuSessionBindingRoutes.delete('/api/studio/mcu/session-bindings', ctrl.deleteMcuSessionBinding)
