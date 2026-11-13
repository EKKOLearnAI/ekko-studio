import Router from '@koa/router'
import * as ctrl from '../controllers/announcements'

export const announcementRoutes = new Router()
announcementRoutes.get('/api/studio/announcements', ctrl.getAnnouncements)
