import Router from '@koa/router'
import * as ctrl from '../controllers/social-messages'

export const socialMessageRoutes = new Router()

socialMessageRoutes.get('/api/social-messages/platforms', ctrl.listPlatforms)
socialMessageRoutes.put('/api/social-messages/active/:platform', ctrl.setActivePlatform)
socialMessageRoutes.put('/api/social-messages/locale/:platform', ctrl.updatePlatformLocale)
socialMessageRoutes.post('/api/social-messages/send', ctrl.sendMessage)
socialMessageRoutes.put('/api/social-messages/credentials/:platform', ctrl.savePlatformCredentials)
socialMessageRoutes.delete('/api/social-messages/credentials/:platform', ctrl.clearPlatformCredentials)
socialMessageRoutes.get('/api/social-messages/telegram/recipients', ctrl.getTelegramRecipients)
socialMessageRoutes.get('/api/social-messages/weixin/qrcode', ctrl.getWeixinQrcode)
socialMessageRoutes.get('/api/social-messages/weixin/qrcode/status', ctrl.pollWeixinQrcodeStatus)
socialMessageRoutes.post('/api/social-messages/weixin/credentials', ctrl.saveWeixinCredentials)
socialMessageRoutes.get('/api/social-messages/weixin/recipients', ctrl.getWeixinRecipients)
socialMessageRoutes.get('/api/social-messages/feishu/qrcode', ctrl.getFeishuQrcode)
socialMessageRoutes.get('/api/social-messages/feishu/qrcode/status', ctrl.pollFeishuQrcodeStatus)
socialMessageRoutes.get('/api/social-messages/feishu/recipients', ctrl.getFeishuRecipients)
