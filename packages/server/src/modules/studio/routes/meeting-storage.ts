import Router from '@koa/router'
import * as ctrl from '../controllers/meeting-storage'

export const meetingStorageRoutes = new Router()

// Meeting metadata
meetingStorageRoutes.get('/api/studio/meeting-storage/:meetingId', ctrl.getMeeting)
meetingStorageRoutes.put('/api/studio/meeting-storage/:meetingId', ctrl.saveMeeting)
meetingStorageRoutes.delete('/api/studio/meeting-storage/:meetingId', ctrl.deleteMeeting)
meetingStorageRoutes.get('/api/studio/meeting-storage', ctrl.listMeetings)

// Audio
meetingStorageRoutes.post('/api/studio/meeting-storage/:meetingId/audio', ctrl.uploadAudio)
meetingStorageRoutes.get('/api/studio/meeting-storage/:meetingId/audio', ctrl.downloadAudio)

// Transcript
meetingStorageRoutes.put('/api/studio/meeting-storage/:meetingId/transcript', ctrl.saveTranscript)
meetingStorageRoutes.get('/api/studio/meeting-storage/:meetingId/transcript', ctrl.getTranscript)

// JSON report
meetingStorageRoutes.put('/api/studio/meeting-storage/:meetingId/json', ctrl.saveJsonReport)
meetingStorageRoutes.get('/api/studio/meeting-storage/:meetingId/json', ctrl.downloadJsonReport)

// HTML report
meetingStorageRoutes.put('/api/studio/meeting-storage/:meetingId/html', ctrl.saveHtmlReport)
meetingStorageRoutes.get('/api/studio/meeting-storage/:meetingId/html', ctrl.downloadHtmlReport)
