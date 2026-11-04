import { ModelApiError } from './errors'

export async function manageModelApiCloudLink(_userId: number, action: 'get' | 'create' | 'rotate' | 'revoke') {
  // Cloud-link management is owned by the official authenticated App socket.
  // Local HTTP, LAN App tokens and self-hosted servers cannot proxy this action
  // through a machine's host connection or borrow another cloud account.
  if (action === 'get') return { available: false, urls: null, reason: 'official_cloud_connection_required' }
  throw new ModelApiError('Manage cloud links through an official cloud App connection.', 403, null, 'official_cloud_connection_required')
}
