// Optional, read-only assessments. All provider access stays behind Studio's authenticated facade.
export function browserIntent(value, name) {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || !value.trim() || value.length > 2000) throw new Error(`${name} must be 1-2000 characters`)
  return value.trim()
}

function evidence(snapshot) {
  if (!snapshot?.snapshotId || !snapshot.tabId || !Array.isArray(snapshot.nodes)) throw new Error('Snapshot unavailable')
  return {
    tabId: snapshot.tabId, snapshotId: snapshot.snapshotId, title: snapshot.title,
    nodes: snapshot.nodes.map(({ ref, role, name, disabled }) => ({ ref, role, name, disabled })),
  }
}

function transportSignal(signal, timeoutMs) {
  const timeout = AbortSignal.timeout(timeoutMs)
  return signal ? AbortSignal.any([signal, timeout]) : timeout
}

// Only fixed diagnostic codes cross the tool boundary; provider bodies and credentials never do.
function unavailable(error, stage) {
  const httpStatus = Number.isInteger(error?.status) ? error.status : undefined
  const reason = httpStatus === 401 ? 'auth_required' : httpStatus === 403 ? 'access_denied'
    : httpStatus === 429 ? 'rate_limited' : error?.name === 'TimeoutError' ? 'timeout'
    : error?.code === 'invalid_assessment' ? 'invalid_result'
    : error?.name === 'TypeError' ? 'transport_unavailable'
    : stage === 'snapshot' ? 'snapshot_unavailable' : 'assessment_unavailable'
  return { status: 'unavailable', reason, stage, ...(httpStatus ? { httpStatus } : {}) }
}

async function settingsFor(request, feature, signal) {
  signal?.throwIfAborted()
  const settings = await request('/api/studio/jev/settings', { signal: transportSignal(signal, 5000) })
  if ((feature === 'match' ? settings.browserMatchEnabled : settings.browserVerifyEnabled) !== true) return { skip: 'disabled' }
  if (settings.hasApiKey !== true) return { skip: 'not_configured' }
  const timeout = feature === 'match' ? settings.browserMatchTimeoutMs : settings.browserVerifyTimeoutMs
  return { timeout: Number.isInteger(timeout) ? Math.max(100, Math.min(30000, timeout)) : 3000 }
}

async function assess(request, path, snapshot, intent, timeout, signal) {
  signal?.throwIfAborted()
  const result = await request(path, {
    method: 'POST', body: { snapshot: evidence(snapshot), ...intent }, signal: transportSignal(signal, timeout + 1000),
  })
  signal?.throwIfAborted()
  if (result?.snapshotId !== snapshot.snapshotId || result?.tabId !== snapshot.tabId
    || result.status === 'matched' && !snapshot.nodes.some(node => node.ref === result.ref && !node.disabled)) {
    throw Object.assign(new Error('Invalid assessment identity or ref'), { code: 'invalid_assessment' })
  }
  return result
}

export async function matchBrowserSnapshot(request, envelope, target, signal) {
  if (target === undefined) return envelope
  let elementMatch
  let stage = 'settings'
  try {
    const config = await settingsFor(request, 'match', signal)
    stage = 'assessment'
    elementMatch = config.skip ? { status: 'skipped', reason: config.skip }
      : await assess(request, '/api/studio/jev/browser/match', envelope.result, { target }, config.timeout, signal)
  } catch (error) {
    signal?.throwIfAborted()
    elementMatch = unavailable(error, stage)
  }
  return { ...envelope, result: { ...envelope.result, elementMatch } }
}

export async function verifyBrowserResult(request, envelope, expectation, readSnapshot, signal) {
  if (expectation === undefined) return envelope
  let verification
  let snapshot = envelope.result?.snapshot
  let stage = 'settings'
  try {
    const config = await settingsFor(request, 'verify', signal)
    if (config.skip) verification = { status: 'skipped', reason: config.skip }
    // Do not assess partial batches or reacquire a tab after a failed batch/takeover.
    else if (envelope.result?.total !== undefined && envelope.result.completed !== envelope.result.total) {
      verification = { status: 'skipped', reason: 'incomplete_batch' }
    } else if (envelope.result?.snapshotError) verification = { status: 'unavailable', reason: 'snapshot_unavailable' }
    else {
      signal?.throwIfAborted()
      stage = 'snapshot'
      snapshot ??= (await readSnapshot()).result
      stage = 'assessment'
      verification = await assess(request, '/api/studio/jev/browser/verify', snapshot, { expectation }, config.timeout, signal)
    }
  } catch (error) {
    signal?.throwIfAborted()
    verification = unavailable(error, stage)
  }
  // Outcome judgment is advisory: never change the action's completion/error, or retry it.
  return { ...envelope, result: { ...envelope.result, ...(snapshot ? { snapshot } : {}), verification } }
}
