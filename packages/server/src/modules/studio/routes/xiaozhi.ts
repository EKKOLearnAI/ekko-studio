import Router from '@koa/router'
import { requireSuperAdmin } from '../middleware/auth'
import { provision, status } from '../controllers/xiaozhi'
import { analyzeCameraFrame, uploadCameraPhoto, captureCameraPhoto, getCameraPhoto } from '../controllers/xiaozhi-camera'
export const xiaozhiPublicRoutes = new Router()
xiaozhiPublicRoutes.get('/api/studio/xiaozhi/ota/:code', provision)
xiaozhiPublicRoutes.post('/api/studio/xiaozhi/ota/:code', provision)
xiaozhiPublicRoutes.post('/api/studio/xiaozhi/camera/upload', uploadCameraPhoto)
xiaozhiPublicRoutes.post('/api/studio/xiaozhi/camera/analyze', analyzeCameraFrame)
export const xiaozhiProtectedRoutes = new Router()
xiaozhiProtectedRoutes.get('/api/studio/xiaozhi/status', requireSuperAdmin, status)
xiaozhiProtectedRoutes.post('/api/studio/xiaozhi/camera/capture', requireSuperAdmin, captureCameraPhoto)
xiaozhiProtectedRoutes.get('/api/studio/xiaozhi/photos/:id', requireSuperAdmin, getCameraPhoto)

// Released firmware retains these provisioning/camera URLs across Studio upgrades.
xiaozhiPublicRoutes.get('/api/xiaozhi/ota/:code', provision)
xiaozhiPublicRoutes.post('/api/xiaozhi/ota/:code', provision)
xiaozhiPublicRoutes.post('/api/xiaozhi/camera/upload', uploadCameraPhoto)
xiaozhiPublicRoutes.post('/api/xiaozhi/camera/analyze', analyzeCameraFrame)
