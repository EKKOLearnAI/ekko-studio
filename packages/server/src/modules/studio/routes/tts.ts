import Router from '@koa/router'
import * as ctrl from '../controllers/tts'

export const ttsRoutes = new Router()
export const ttsProtectedRoutes = new Router()

ttsRoutes.post('/api/studio/tts', ctrl.generate)
ttsRoutes.post('/api/tts/proxy/audio/speech', ctrl.openaiProxy)
ttsRoutes.get('/api/studio/mcu/audio/:file', ctrl.mcuAudio)

ttsProtectedRoutes.get('/api/studio/tts/settings', ctrl.listSettings)
ttsProtectedRoutes.post('/api/studio/voice/proxy/:profile/v1/tts', ctrl.synthesizeVoiceProxy)
ttsProtectedRoutes.post('/api/studio/voice/proxy/:profile/v1/audio/speech', ctrl.synthesizeVoiceProxyOpenAi)
ttsProtectedRoutes.put('/api/studio/tts/settings/active', ctrl.saveActiveProvider)
ttsProtectedRoutes.put('/api/studio/tts/settings/:provider', ctrl.saveSettings)
ttsProtectedRoutes.delete('/api/studio/tts/settings/:provider', ctrl.deleteProvider)
ttsProtectedRoutes.delete('/api/studio/tts/settings/:provider/base-url-preset', ctrl.deleteBaseUrlPreset)
ttsProtectedRoutes.delete('/api/studio/tts/settings/:provider/secret/:secretName', ctrl.deleteSecret)
ttsProtectedRoutes.post('/api/voice/providers/probe', ctrl.probeProvider)
ttsProtectedRoutes.post('/api/studio/tts/synthesize', ctrl.synthesize)
