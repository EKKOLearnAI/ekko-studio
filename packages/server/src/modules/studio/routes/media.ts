import Router from '@koa/router'
import * as ctrl from '../controllers/media'

export const mediaRoutes = new Router()

mediaRoutes.post('/api/studio/media/grok-image-to-video', ctrl.grokImageToVideo)
mediaRoutes.post('/api/studio/media/apikey-image-generate', ctrl.apiKeyImageGenerate)
mediaRoutes.post('/api/studio/media/minimax-image-to-video', ctrl.miniMaxImageToVideo)
