import { detectHermesHome } from '../modules/hermes/services/runtime/path'
import { requireSuperAdmin } from '../modules/studio/middleware/auth'
import { configureSuperAdminMiddleware } from '../modules/studio/middleware/super-admin'
import { configureUpdateRuntime } from '../modules/studio/services/update/runtime-dependencies'

configureUpdateRuntime({ getHermesHome: detectHermesHome })
configureSuperAdminMiddleware(requireSuperAdmin)

export * from '../modules/studio/controllers/update'
export { updateRoutes } from '../modules/studio/routes/update'
export { stopPreviewRuntime } from '../modules/studio/services/update/version-preview-manager'
export { startReconcileLoop, stopReconcileLoop } from '../modules/studio/services/update/reconcile'
