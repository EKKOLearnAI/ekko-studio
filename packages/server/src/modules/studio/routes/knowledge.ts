/**
 * Knowledge plugin — route registration.
 *
 * Mounts all /api/studio/knowledge/* endpoints. Must be registered before
 * any proxy catch-all (AGENTS.md rule).
 */

import Router from '@koa/router'
import * as ctrl from '../controllers/knowledge'
import type { KnowledgeService } from '../services/knowledge/knowledge.service'

export const knowledgeRoutes = new Router()

/**
 * Initialize the knowledge routes with a service instance.
 * Must be called before the routes are mounted.
 */
export function initKnowledgeRoutes(service: KnowledgeService): void {
  ctrl.setKnowledgeService(service)
}

// --- Management endpoints (§5.1) ---

knowledgeRoutes.get('/api/studio/knowledge/vaults', ctrl.listVaults)
knowledgeRoutes.post('/api/studio/knowledge/vaults', ctrl.createVault)
knowledgeRoutes.delete('/api/studio/knowledge/vaults/:id', ctrl.deleteVault)

// --- Default-vault bootstrap + quota + directory browser (task-12) ---

knowledgeRoutes.post('/api/studio/knowledge/vaults/bootstrap-defaults', ctrl.bootstrapDefaultVaults)
knowledgeRoutes.get('/api/studio/knowledge/quota', ctrl.getQuota)
knowledgeRoutes.get('/api/studio/knowledge/dirs', ctrl.listDirs)
knowledgeRoutes.get('/api/studio/knowledge/drives', ctrl.listDrives)
knowledgeRoutes.get('/api/studio/knowledge/usb-volumes', ctrl.listUsbVolumesCtrl)
knowledgeRoutes.post('/api/studio/knowledge/usb-volumes/:uuid/scan', ctrl.scanUsbVolumeCtrl)
knowledgeRoutes.post('/api/studio/knowledge/task-archive/:sessionId', ctrl.taskArchiveCtrl)

knowledgeRoutes.get('/api/studio/knowledge/documents', ctrl.listDocuments)
knowledgeRoutes.get('/api/studio/knowledge/documents/:id/chunks', ctrl.listDocumentChunks)
knowledgeRoutes.get('/api/studio/knowledge/documents/:id/references', ctrl.listDocumentReferences)
knowledgeRoutes.get('/api/studio/knowledge/documents/:id', ctrl.getDocument)
knowledgeRoutes.post('/api/studio/knowledge/documents/:id/index', ctrl.indexDocument)
knowledgeRoutes.delete('/api/studio/knowledge/documents/:id', ctrl.deleteDocument)

knowledgeRoutes.post('/api/studio/knowledge/reindex', ctrl.reindex)

// --- Search (§5.2) ---

knowledgeRoutes.post('/api/studio/knowledge/search', ctrl.searchKnowledge)

// --- Settings (reachable even when the service is uninitialized) ---

knowledgeRoutes.get('/api/studio/knowledge/settings', ctrl.getKeySettings)
knowledgeRoutes.post('/api/studio/knowledge/settings', ctrl.saveKeySettings)

// --- Health ---

knowledgeRoutes.get('/api/studio/knowledge/health', ctrl.health)
