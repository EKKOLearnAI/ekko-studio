import Router from '@koa/router'
import * as ctrl from '../controllers/desktop-browser'

export const desktopBrowserRoutes = new Router()
// Auth/profile middleware is composed by bootstrap before protected routes.
desktopBrowserRoutes.post('/api/studio/desktop-browser/request', ctrl.requestDesktopBrowser)
