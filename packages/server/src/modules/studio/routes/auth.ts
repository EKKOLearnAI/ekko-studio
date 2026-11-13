import Router from '@koa/router'
import * as ctrl from '../controllers/auth'
import * as device from '../controllers/device-auth'
import { requireSuperAdmin } from '../middleware/auth'

// Public routes (no auth required)
export const authPublicRoutes = new Router()
authPublicRoutes.get('/api/auth/status', ctrl.authStatus)
authPublicRoutes.post('/api/auth/login', ctrl.login)
authPublicRoutes.post('/api/auth/app-login', ctrl.appLogin)
authPublicRoutes.post('/api/auth/mcu-login', ctrl.microcontrollerLogin)
authPublicRoutes.post('/api/auth/device-login', device.deviceLogin)
authPublicRoutes.post('/api/auth/device-login/create-user', device.createWeChatUser)
authPublicRoutes.post('/api/auth/device-login/bind-by-credentials', device.bindByCredentialsDeviceLogin)
// Older clients used this path with username/password. Keep that verified flow.
authPublicRoutes.post('/api/auth/device-login/bind-super-admin', device.bindByCredentialsDeviceLogin)

// Protected routes (auth required)
export const authProtectedRoutes = new Router()
authProtectedRoutes.post('/api/auth/setup', ctrl.setupPassword)
authProtectedRoutes.get('/api/auth/me', ctrl.currentUser)
authProtectedRoutes.get('/api/auth/device-binding', device.getDeviceBinding)
authProtectedRoutes.delete('/api/auth/device-binding', device.clearDeviceBindingController)
authProtectedRoutes.post('/api/auth/set-password', device.setPassword)
authProtectedRoutes.post('/api/auth/model-guide', device.updateMyModelGuideStatus)
authProtectedRoutes.post('/api/auth/bind-phone', device.bindPhone)
authProtectedRoutes.delete('/api/auth/phone', device.unbindPhone)
authProtectedRoutes.post('/api/auth/change-password', ctrl.changePassword)
authProtectedRoutes.post('/api/auth/change-username', ctrl.changeUsername)
authProtectedRoutes.get('/api/auth/avatar', ctrl.getMyAvatar)
authProtectedRoutes.put('/api/auth/avatar', ctrl.updateMyAvatar)
authProtectedRoutes.delete('/api/auth/password', ctrl.removePassword)
authProtectedRoutes.get('/api/auth/users', requireSuperAdmin, ctrl.listManagedUsers)
authProtectedRoutes.post('/api/auth/users', requireSuperAdmin, ctrl.createManagedUser)
authProtectedRoutes.put('/api/auth/users/:id', requireSuperAdmin, ctrl.updateManagedUser)
authProtectedRoutes.delete('/api/auth/users/:id', requireSuperAdmin, ctrl.deleteManagedUser)
authProtectedRoutes.get('/api/auth/users/:id/export', requireSuperAdmin, device.exportManagedUser)
authProtectedRoutes.get('/api/auth/locked-ips', requireSuperAdmin, ctrl.listLockedIps)
authProtectedRoutes.delete('/api/auth/locked-ips', requireSuperAdmin, ctrl.unlockIpHandler)
