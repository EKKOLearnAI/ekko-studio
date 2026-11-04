export const DEFAULT_HERMES_VERSION = '0.22.5'
export const DEFAULT_HERMES_SOURCE_REPOSITORY = 'https://github.com/NousResearch/hermes-agent.git'
export const DEFAULT_HERMES_SOURCE_REF = 'v0.22.5'
export const DEFAULT_HERMES_SOURCE_COMMIT = 'bf0203a794a07aac3ff764972ab9087baa4e4f4e'

export function hermesVersion(env = process.env) {
  return env.HERMES_VERSION || DEFAULT_HERMES_VERSION
}

export function hermesSource(env = process.env) {
  const version = hermesVersion(env).trim()
  const repository = (
    env.HERMES_SOURCE_REPOSITORY
    || DEFAULT_HERMES_SOURCE_REPOSITORY
  ).trim()
  const ref = (env.HERMES_SOURCE_REF || DEFAULT_HERMES_SOURCE_REF).trim()
  const commit = (env.HERMES_SOURCE_COMMIT || DEFAULT_HERMES_SOURCE_COMMIT).trim().toLowerCase()

  const releaseOverridePresent = Boolean(
    env.HERMES_VERSION?.trim()
    || env.HERMES_SOURCE_REF?.trim()
    || env.HERMES_SOURCE_COMMIT?.trim(),
  )
  if (releaseOverridePresent) {
    const missing = [
      ['HERMES_VERSION', env.HERMES_VERSION],
      ['HERMES_SOURCE_REF', env.HERMES_SOURCE_REF],
      ['HERMES_SOURCE_COMMIT', env.HERMES_SOURCE_COMMIT],
    ]
      .filter(([, value]) => !value?.trim())
      .map(([name]) => name)
    if (missing.length > 0) {
      throw new Error(
        `Hermes source overrides are atomic; missing ${missing.join(', ')}`,
      )
    }
  }
  if (!/^[0-9a-f]{40}$/.test(commit)) {
    throw new Error('HERMES_SOURCE_COMMIT must be a full 40-character Git commit')
  }
  if (!version || !repository || !ref) {
    throw new Error('Hermes source version, repository, and ref must be non-empty')
  }

  return { version, repository, ref, commit }
}

export function runtimeReleaseTag(env = process.env) {
  const version = hermesVersion(env)
  return env.HERMES_DESKTOP_RUNTIME_RELEASE_TAG
    || env.RUNTIME_RELEASE_TAG
    || `hermes-${version}-runtime`
}
