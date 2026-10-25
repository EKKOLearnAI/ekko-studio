import { StudioError, type AgentCliInstallPlan } from '../../contracts/plugins'
import { jsonCopy } from '../plugins/validation'
import { valid } from 'semver'

/** An artifact may select a package, never a shell command, URL, tag or target directory. */
export function parseAgentCliInstall(value: unknown): AgentCliInstallPlan {
  const plan = jsonCopy(value) as AgentCliInstallPlan
  if (!plan || typeof plan !== 'object' || Array.isArray(plan)
    || Object.keys(plan).some(key => !['kind', 'packageName', 'version', 'bin', 'runner', 'preferDedupe', 'nativeHomeEnv'].includes(key))
    || ('preferDedupe' in plan && typeof plan.preferDedupe !== 'boolean')
    || ('nativeHomeEnv' in plan && (!Array.isArray(plan.nativeHomeEnv) || plan.nativeHomeEnv.length > 8
      || plan.nativeHomeEnv.some(key => typeof key !== 'string' || !/^[A-Z][A-Z0-9_]{0,63}_(?:HOME|DIR)$/.test(key))
      || new Set(plan.nativeHomeEnv).size !== plan.nativeHomeEnv.length))
    || plan.kind !== 'npm' || typeof plan.packageName !== 'string' || plan.packageName.length > 214
    || !/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/.test(plan.packageName)
    || typeof plan.version !== 'string' || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/.test(plan.version) || plan.version.length > 128 || valid(plan.version) !== plan.version
    || typeof plan.bin !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(plan.bin)
    || !['node', 'binary'].includes(plan.runner)) throw new StudioError('INVALID_ARGUMENT', 'Invalid native CLI installation plan')
  return plan
}
