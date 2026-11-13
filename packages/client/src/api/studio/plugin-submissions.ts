export const PLUGIN_SUBMISSION_URL = 'https://api.ekkostudio.xyz/api/studio/plugins/submissions'
export const submissionLimits = { repository: 2048, name: 160, description: 4000 } as const
export interface PluginSubmission { repository: string; name: string; description: string }
export interface PluginSubmissionReceipt { submissionId: string; pluginId: string; status: 'pending'; createTime: number }
type SubmissionFailure = 'invalidInput' | 'rateLimited' | 'failed' | 'uncertain'
export class PluginSubmissionError extends Error {
  readonly kind: SubmissionFailure
  constructor(kind: SubmissionFailure) { super(kind); this.kind = kind }
}

export function validSubmissionField(field: keyof PluginSubmission, value: string): boolean {
  if (typeof value !== 'string' || !value.trim() || value.length > submissionLimits[field]) return false
  if (field !== 'repository') return true
  const raw = value.trim()
  if (/\s|\\/.test(raw) || !/^https?:\/\//i.test(raw)) return false
  try {
    const url = new URL(raw), path = url.pathname.replace(/\/+$/, '').replace(/\.git$/, '')
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash && !!path && path !== '/'
  } catch { return false }
}

export async function submitPlugin(input: PluginSubmission, signal?: AbortSignal): Promise<PluginSubmissionReceipt> {
  if (!(Object.keys(submissionLimits) as Array<keyof PluginSubmission>).every(field => validSubmissionField(field, input[field]))) throw new PluginSubmissionError('invalidInput')
  // Public cloud API: never use the local authenticated/Profile-scoped request helper.
  const body: PluginSubmission = { repository: input.repository.trim(), name: input.name.trim(), description: input.description.trim() }
  const controller = new AbortController(), abort = () => controller.abort()
  signal?.addEventListener('abort', abort, { once: true })
  if (signal?.aborted) abort()
  const timeout = setTimeout(abort, 30_000)
  try {
    const response = await fetch(PLUGIN_SUBMISSION_URL, {
      method: 'POST', credentials: 'omit', referrerPolicy: 'no-referrer', redirect: 'error',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(body), signal: controller.signal,
    })
    if (response.status === 429) throw new PluginSubmissionError('rateLimited')
    if (!response.ok) throw new PluginSubmissionError(response.status === 400 ? 'invalidInput' : 'failed')
    const result = await response.json()
    const receipt = result?.data
    if (result?.ok !== true || receipt?.status !== 'pending' || typeof receipt.submissionId !== 'string' || !receipt.submissionId
      || typeof receipt.pluginId !== 'string' || !/^[a-f0-9]{64}$/.test(receipt.pluginId) || !Number.isFinite(receipt.createTime)) throw new PluginSubmissionError('uncertain')
    return { submissionId: receipt.submissionId, pluginId: receipt.pluginId, status: receipt.status, createTime: receipt.createTime }
  } catch (error) {
    if (error instanceof PluginSubmissionError) throw error
    // A lost response does not prove that the server rejected the submission. Never retry automatically.
    throw new PluginSubmissionError('uncertain')
  } finally { clearTimeout(timeout); signal?.removeEventListener('abort', abort) }
}
