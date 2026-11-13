import { getDeployDir, getHermesHome, getUploadDir, getWebUiHome } from '../../public/config'
import type { UpdateRuntimePaths } from './types'

export function resolveUpdateRuntimePaths(
  env: Record<string, string | undefined> = process.env,
  cwd = process.cwd(),
): UpdateRuntimePaths {
  return {
    deployDir: getDeployDir(env, cwd),
    webUiHome: getWebUiHome(env),
    uploadDir: getUploadDir(env),
    hermesHome: getHermesHome(env),
  }
}
