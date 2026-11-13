import { request } from '../client'
import type { ApiRelayUsageResult } from '../../../../server/src/modules/studio/contracts/api-relay'

export type { ApiRelayAccount, ApiRelayPeriodUsage } from '../../../../server/src/modules/studio/contracts/api-relay'

export function fetchApiRelayUsage(signal?: AbortSignal): Promise<ApiRelayUsageResult> {
  return request('/api/hermes/api-relay/usage', { signal })
}
