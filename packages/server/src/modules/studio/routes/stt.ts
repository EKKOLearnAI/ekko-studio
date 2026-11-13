import Router from '@koa/router'
import * as ctrl from '../controllers/stt'
import * as localModelCtrl from '../controllers/local-stt-model'

export const sttProtectedRoutes = new Router()

sttProtectedRoutes.get('/api/studio/stt/settings', ctrl.listSettings)
sttProtectedRoutes.get('/api/studio/stt/local-model', localModelCtrl.status)
sttProtectedRoutes.post('/api/studio/stt/local-model/download', localModelCtrl.download)
sttProtectedRoutes.post('/api/studio/voice/proxy/:profile/v1/audio/transcriptions', ctrl.transcribeVoiceProxy)
sttProtectedRoutes.get('/api/studio/stt/profile-status', ctrl.profileStatus)
sttProtectedRoutes.get('/api/studio/stt/profile-status/missing-audio', ctrl.missingProfileAudio)
sttProtectedRoutes.post('/api/studio/mcu/voice-turn', ctrl.mcuVoiceTurn)
sttProtectedRoutes.put('/api/studio/stt/settings/active', ctrl.saveActiveProvider)
sttProtectedRoutes.put('/api/studio/stt/settings/:provider', ctrl.saveSettings)
sttProtectedRoutes.delete('/api/studio/stt/settings/:provider', ctrl.deleteProvider)
sttProtectedRoutes.delete('/api/studio/stt/settings/:provider/base-url-preset', ctrl.deleteBaseUrlPreset)
sttProtectedRoutes.delete('/api/studio/stt/settings/:provider/secret/:secretName', ctrl.deleteSecret)
sttProtectedRoutes.post('/api/studio/stt/local-stream', ctrl.startLocalStream)
sttProtectedRoutes.post('/api/studio/stt/local-stream/:sessionId/chunk', ctrl.pushLocalStreamChunk)
sttProtectedRoutes.post('/api/studio/stt/local-stream/:sessionId/finish', ctrl.finishLocalStream)
sttProtectedRoutes.delete('/api/studio/stt/local-stream/:sessionId', ctrl.cancelLocalStream)
sttProtectedRoutes.post('/api/studio/stt/transcribe', ctrl.transcribe)
