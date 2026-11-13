import Router from '@koa/router'
import * as ctrl from '../controllers/skills'

export const skillRoutes = new Router()

skillRoutes.get('/api/hermes/skills', ctrl.list)
skillRoutes.get('/api/hermes/skills/practice', ctrl.listPracticeSkills)
skillRoutes.get('/api/hermes/skills/usage/stats', ctrl.usageStats)
skillRoutes.get('/api/hermes/skills/external-dirs', ctrl.listExternalDirs)
skillRoutes.put('/api/hermes/skills/external-dirs', ctrl.updateExternalDirs)
skillRoutes.put('/api/hermes/skills/toggle', ctrl.toggle)
skillRoutes.put('/api/hermes/skills/pin', ctrl.pin_)
skillRoutes.post('/api/hermes/skills/import', ctrl.importSkill)
skillRoutes.put('/api/hermes/skills/:category/:skill', ctrl.updateSkill)
skillRoutes.delete('/api/hermes/skills/:category/:skill', ctrl.deleteSkill)
skillRoutes.get('/api/hermes/skills/:category/:skill/files', ctrl.listFiles)
skillRoutes.get('/api/hermes/skills/{*path}', ctrl.readFile_)
