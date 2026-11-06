export const DEFAULT_DESKTOP_NODE_VERSION = '26.13.0'

export function desktopNodeVersion(env = process.env) {
  const version = (
    env.HERMES_DESKTOP_NODE_VERSION
    || DEFAULT_DESKTOP_NODE_VERSION
  ).trim().replace(/^v/, '')

  if (!/^\d+\.\d+\.\d+$/.test(version)) {
    throw new Error('HERMES_DESKTOP_NODE_VERSION must be an exact Node.js version')
  }
  return version
}
