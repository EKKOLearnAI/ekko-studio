import { delimiter } from 'node:path'

/** npm install -g writes to this prefix. Promote it even when it already
 * exists later in PATH; otherwise an older system CLI shadows the update. */
export function prioritizeManagedNpmBin(env: NodeJS.ProcessEnv, npmBin: string | null): void {
  if (!npmBin) return
  const key = Object.keys(env).find(key => key.toLowerCase() === 'path') || 'PATH'
  const entries = (env[key] || '').split(delimiter).filter(Boolean)
  const identity = (value: string) => process.platform === 'win32' ? value.toLowerCase() : value
  env[key] = [npmBin, ...entries.filter(entry => identity(entry) !== identity(npmBin))].join(delimiter)
}
