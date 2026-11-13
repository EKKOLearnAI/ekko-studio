import Router from '@koa/router'
import * as ctrl from '../controllers/meeting-asr'

export const meetingASRRoutes = new Router()

// ASR service lifecycle
meetingASRRoutes.post('/api/studio/meeting-asr/start', ctrl.startASRService)
meetingASRRoutes.post('/api/studio/meeting-asr/stop', ctrl.stopASRService)
meetingASRRoutes.get('/api/studio/meeting-asr/status', ctrl.getASRStatus)

// ASR service configuration
meetingASRRoutes.post('/api/studio/meeting-asr/config', ctrl.updateASRConfig)

// Proxy to ASR backend APIs
meetingASRRoutes.get('/api/studio/meeting-asr/healthz', ctrl.proxyHealthCheck)
meetingASRRoutes.get('/api/studio/meeting-asr/config/current', ctrl.getCurrentConfig)
meetingASRRoutes.post('/api/studio/meeting-asr/config/current', ctrl.updateCurrentConfig)

// Analysis APIs
meetingASRRoutes.post('/api/studio/meeting-asr/analysis/start', ctrl.startAnalysis)
meetingASRRoutes.post('/api/studio/meeting-asr/analysis/stop', ctrl.stopAnalysis)
meetingASRRoutes.post('/api/studio/meeting-asr/analysis/trigger', ctrl.triggerAnalysis)
meetingASRRoutes.get('/api/studio/meeting-asr/analysis/status', ctrl.getAnalysisStatus)
meetingASRRoutes.get('/api/studio/meeting-asr/analysis/result', ctrl.getAnalysisResult)
meetingASRRoutes.get('/api/studio/meeting-asr/analysis/html', ctrl.getAnalysisHTML)
meetingASRRoutes.get('/api/studio/meeting-asr/analysis/stream', ctrl.proxyAnalysisStream)

// Scene templates
meetingASRRoutes.get('/api/studio/meeting-asr/scenes', ctrl.getSceneTemplates)

// Realtime assist
meetingASRRoutes.post('/api/studio/meeting-asr/assist/start', ctrl.startAssist)
meetingASRRoutes.post('/api/studio/meeting-asr/assist/stop', ctrl.stopAssist)
meetingASRRoutes.post('/api/studio/meeting-asr/assist/sentence', ctrl.pushAssistSentence)
meetingASRRoutes.post('/api/studio/meeting-asr/assist/context', ctrl.updateAssistContext)
meetingASRRoutes.post('/api/studio/meeting-asr/assist/analyze', ctrl.analyzeAssist)

// Report generation (SSE streaming)
meetingASRRoutes.post('/api/studio/meeting-asr/report/stream', ctrl.streamReport)

// Meeting auto-naming (single lightweight title request after first AI analysis)
meetingASRRoutes.post('/api/studio/meeting-asr/title', ctrl.meetingTitle)

// Whole-file transcription (batch) — raw audio body in, job id out; the
// client then polls the status endpoint until the transcript is ready.
meetingASRRoutes.post('/api/studio/meeting-asr/transcribe/file', ctrl.startFileTranscription)
meetingASRRoutes.get('/api/studio/meeting-asr/transcribe/status/:jobId', ctrl.getFileTranscriptionStatus)

// Note: transcript and prompts endpoints were removed as dead code (v0.7.6 audit #17).
// Frontend manages transcripts locally via meetingStore; prompts are configured
// via /api/studio/meeting-asr/config and used directly by the Python analysis service.
