import { request } from '@/api/client'
export function gradingApi<T = any>(action: string, body: unknown = {}): Promise<T> {
  return request<T>(`/api/studio/scanner/grading/${action}`, { method: 'POST', body: JSON.stringify(body) })
}
export type { Annotation, Submission } from '../../../../server/src/modules/studio/services/grading/types'
