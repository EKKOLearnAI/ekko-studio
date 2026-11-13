import { DshPluginError } from './errors'
import { dshInstallation } from './installation'
import { readDshWebPackages } from './plugin-inventory'

const NAME = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/
export function nativePluginArgs(body: any): string[] {
  if (body?.action === 'remove' && typeof body.packageName === 'string' && NAME.test(body.packageName)) return ['plugin', '--profile', 'web', 'remove', body.packageName]
  if (body?.action === 'install' && typeof body.packageSpec === 'string' && body.packageSpec.length < 512) {
    const spec = body.packageSpec
    const split = spec.lastIndexOf('@')
    const registry = split > 0 && NAME.test(spec.slice(0, split)) && /^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(spec.slice(split + 1))
    const github = /^github:[\w.-]+\/[\w.-]+#[a-f0-9]{7,40}$/.test(spec)
    if (registry || github) return ['plugin', '--profile', 'web', 'add', spec]
  }
  throw new DshPluginError(400, 'DSH_SELECTION_INVALID', 'Use package@exact-version or github:owner/repo#commit')
}
const running = new Map<string, AbortController>()
export async function shutdownDshPluginOperations() { for (const abort of running.values()) abort.abort() }
export async function changeNativeDshPlugins(input: { command: string; sourceHome: string; body: any; revision: string;
  execute(home: string, args: string[], signal: AbortSignal): Promise<void> }) {
  const args = nativePluginArgs(input.body)
  if (running.has(input.sourceHome)) throw new DshPluginError(409, 'DSH_OPERATION_CONFLICT', 'Another Web plugin operation is running')
  const abort = new AbortController(); running.set(input.sourceHome, abort)
  try {
    const { web } = await readDshWebPackages(await dshInstallation(input.command), input.sourceHome)
    if (!input.revision || input.revision !== web.revision) throw new DshPluginError(412, 'DSH_REVISION_CHANGED', 'Web profile changed; reload before continuing')
    if (input.body.action === 'remove' && !web.packages.some(pkg => pkg.name === input.body.packageName)) throw new DshPluginError(400, 'DSH_SELECTION_INVALID', 'Package is not installed in the Web profile')
    await input.execute(input.sourceHome, args, abort.signal)
  } finally { running.delete(input.sourceHome) }
}
