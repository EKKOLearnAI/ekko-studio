import { join } from 'path'
import { config } from './config'

/**
 * Private script invocation report state under the Web UI home (never in Hermes state):
 * immutable per-revision manifests, revocation markers, the wrapper spool and quarantine, and for
 * detached completion the producer's delivery envelopes (outbox) and import receipts.
 */
export function scriptReportsRoot(): string {
  return join(config.appHome, 'script-reports')
}

export function scriptReportBindingDir(bindingId: string): string {
  return join(scriptReportsRoot(), 'bindings', bindingId)
}

export function scriptReportManifestPath(bindingId: string, revision: number): string {
  return join(scriptReportBindingDir(bindingId), `manifest.r${revision}.json`)
}

export function scriptReportRevokedMarker(bindingId: string): string {
  return join(scriptReportBindingDir(bindingId), 'revoked')
}

export function scriptReportSpoolDir(bindingId: string): string {
  return join(scriptReportsRoot(), 'spool', bindingId)
}

export function scriptReportQuarantineDir(bindingId: string): string {
  return join(scriptReportsRoot(), 'quarantine', bindingId)
}

export function scriptReportOutboxDir(bindingId: string): string {
  return join(scriptReportsRoot(), 'outbox', bindingId)
}

export function scriptReportReceiptsDir(bindingId: string): string {
  return join(scriptReportsRoot(), 'receipts', bindingId)
}
