/** Authentication-owned request metadata. Neither JSON bodies nor a normal JWT
 * with a forged context header can supply a canonical Run identity. */
export interface RunRequestContext { runId?: string; sessionId: string; profile: string }
const requests = new WeakMap<object, Readonly<RunRequestContext>>()
export function bindRunRequestContext(request: object, value: RunRequestContext): () => void {
  const captured = Object.freeze({ ...value })
  requests.set(request, captured)
  return () => { if (requests.get(request) === captured) requests.delete(request) }
}
export function getRunRequestContext(request: object): Readonly<RunRequestContext> | undefined { return requests.get(request) }
