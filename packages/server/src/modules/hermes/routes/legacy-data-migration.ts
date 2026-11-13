import Router from '@koa/router'
import * as ctrl from '../controllers/legacy-data-migration'
import { requireSuperAdmin } from '../../studio/public/auth'

export const legacyDataMigrationRoutes = new Router()

legacyDataMigrationRoutes.get('/api/hermes/data-migrations/windows-appdata', requireSuperAdmin, ctrl.status)
legacyDataMigrationRoutes.post('/api/hermes/data-migrations/windows-appdata', requireSuperAdmin, ctrl.decide)
