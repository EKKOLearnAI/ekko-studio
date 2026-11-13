import Router from '@koa/router'
import * as ctrl from '../controllers/weixin'

export const weixinRoutes = new Router()

weixinRoutes.get('/api/hermes/weixin/qrcode', ctrl.getQrcode)
weixinRoutes.get('/api/hermes/weixin/qrcode/status', ctrl.pollStatus)
weixinRoutes.post('/api/hermes/weixin/save', ctrl.save)
