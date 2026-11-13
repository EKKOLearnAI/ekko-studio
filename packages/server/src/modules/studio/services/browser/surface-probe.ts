/**
 * Composition root glue (spec-02 decision 0).
 *
 * The spec-01 gate lives in `config/` and must stay free of service imports, so
 * the real browser resolver is injected from the startup path instead. The gate
 * uses the cheap `version` validation (one `--version` spawn) — the full
 * headless smoke run happens when spec-05 actually starts the runtime.
 *
 * The resolved version is recorded in the gate report because the target device
 * reuses the apt-managed system chromium, i.e. the version drifts with apt and
 * otherwise leaves no trace anywhere.
 */

import {
  defaultBrowserSurfaceProbe,
  type BrowserSurfaceProbe,
} from '../../public/browser-surface'
import { logger } from '../../public/logging'
import { resolveBrowserExecutableWithTrace } from './executable'

export function createBrowserSurfaceProbe(): BrowserSurfaceProbe {
  let cached: { path: string | null, version: string | null } | null = null

  const resolve = (env: Record<string, string | undefined>) => {
    if (cached) return cached
    try {
      const resolution = resolveBrowserExecutableWithTrace({ env, validate: 'version' })
      cached = {
        path: resolution.executable.path,
        version: resolution.executable.version,
      }
      logger.info(
        '[browser] executable resolved path=%s source=%s version=%s launcher=%s',
        resolution.executable.path,
        resolution.executable.source,
        resolution.executable.version || 'unknown',
        resolution.executable.launcher,
      )
    } catch (err) {
      cached = { path: null, version: null }
      logger.warn(err, '[browser] no usable browser executable found')
    }
    return cached
  }

  return {
    ...defaultBrowserSurfaceProbe,
    resolveBrowserExecutable(env) {
      return resolve(env).path
    },
    resolveBrowserExecutableVersion(env) {
      return resolve(env).version
    },
  }
}
