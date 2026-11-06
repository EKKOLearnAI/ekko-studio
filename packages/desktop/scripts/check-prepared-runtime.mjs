import { spawnSync } from 'node:child_process'

export function checkPreparedRuntime(command, args, expectedVersion, label) {
  const probe = spawnSync(command, args, { encoding: 'utf8', windowsHide: true })
  const version = String(probe.stdout || '').trim().replace(/^v/, '')
  if (probe.status !== 0 || version !== expectedVersion) {
    throw new Error(
      `Prepared ${label} at ${command} reports ${version || 'an unreadable version'}; expected ${expectedVersion}. `
      + 'Build this runtime in a fresh resources target directory instead of reusing the old interpreter.',
    )
  }
}
