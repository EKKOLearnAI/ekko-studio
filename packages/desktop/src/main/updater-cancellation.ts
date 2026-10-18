import type { CancellationToken } from 'electron-updater'
import type { ElectronHttpExecutor } from 'electron-updater/out/electronHttpExecutor'
import type { Writable } from 'node:stream'

/**
 * electron-updater's full-download token rejects the promise but its HTTP
 * executor does not abort the request. Scope this adapter to one download,
 * including redirected and differential requests, so Stop releases the network.
 * The executor is an internal upstream field; test:updater covers this contract
 * against the installed library and must run when upgrading that dependency.
 */
export function bindUpdateRequestCancellation(updater: object, token: CancellationToken): () => void {
  const executor = (updater as { httpExecutor?: ElectronHttpExecutor }).httpExecutor
  if (!executor || typeof executor.createRequest !== 'function') {
    throw new Error('Desktop updater does not expose a cancellable HTTP transport')
  }
  const createRequest = executor.createRequest
  const requests = new Set<Electron.ClientRequest>()
  const streams = new Set<Writable>()
  const streamCleanups = new Set<() => void>()
  function abort(request: Electron.ClientRequest) {
    try { request.abort() } catch (err) { console.warn('[updater] failed to abort download request:', err) }
  }
  const cancel = () => { for (const request of requests) abort(request) }
  executor.createRequest = function (requestOptions, callback) {
    const request = createRequest.call(this, requestOptions, response => {
      // Aborting the response alone leaves upstream's piped file writer open.
      // Destroy the first pipe destination too: the updater's pipeline error
      // handler closes its writer, allowing immediate retry on Windows.
      const pipe = response.pipe
      response.pipe = (destination: Writable, pipeOptions?: { end?: boolean }) => {
        response.pipe = pipe
        const closeStream = () => destination.destroy(new Error('Update download interrupted'))
        // Differential downloads may pipe several responses into one stream.
        if (!streams.has(destination)) {
          streams.add(destination)
          const cleanup = () => {
            token.removeListener('cancel', closeStream)
            streamCleanups.delete(cleanup)
            streams.delete(destination)
          }
          streamCleanups.add(cleanup)
          token.once('cancel', closeStream)
          destination.once('close', cleanup)
        }
        response.once('aborted', closeStream)
        response.once('error', closeStream)
        if (token.cancelled) queueMicrotask(closeStream)
        return pipe.call(response, destination, pipeOptions)
      }
      callback(response)
    })
    requests.add(request)
    request.once('close', () => requests.delete(request))
    // Let the caller attach its error handlers before aborting a late request.
    if (token.cancelled) queueMicrotask(() => abort(request))
    return request
  }
  token.once('cancel', cancel)
  return () => {
    token.removeListener('cancel', cancel)
    executor.createRequest = createRequest
    for (const stream of streams) stream.destroy()
    for (const cleanup of streamCleanups) cleanup()
    requests.clear()
  }
}
