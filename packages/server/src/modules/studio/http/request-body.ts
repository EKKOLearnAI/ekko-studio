// Cloud-hosted clients may need substantially longer than a local connection
// to finish sending a body that was already in flight when a limit was hit.
const REJECTED_REQUEST_DRAIN_TIMEOUT_MS = 2 * 60 * 1000

/**
 * Return an iterator that leaves the request stream open when a consumer stops
 * early, allowing the remainder of a rejected body to be drained.
 */
export function nonDestroyingRequestBody(req: any): any {
  return typeof req?.iterator === 'function'
    ? req.iterator({ destroyOnReturn: false })
    : req
}

/**
 * Read and discard whatever is left of a rejected request body so the client
 * can receive the HTTP error instead of a connection reset.
 */
export function drainRejectedRequest(req: any): Promise<void> {
  if (!req || typeof req.resume !== 'function' || req.readableEnded || req.destroyed) return Promise.resolve()
  return new Promise<void>(resolve => {
    const finish = () => {
      clearTimeout(timer)
      req.off?.('end', finish)
      req.off?.('close', finish)
      req.off?.('error', finish)
      resolve()
    }
    // Bound the work for clients that never finish sending the rejected body.
    const timer = setTimeout(() => {
      req.destroy?.()
      finish()
    }, REJECTED_REQUEST_DRAIN_TIMEOUT_MS)
    timer.unref?.()
    req.on('end', finish)
    req.on('close', finish)
    req.on('error', finish)
    req.resume()
  })
}
