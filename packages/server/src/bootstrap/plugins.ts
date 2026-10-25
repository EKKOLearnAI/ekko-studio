import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { configureStudioPluginRuntime, createStudioPluginRuntime } from '../modules/studio/services/plugins/runtime'

/** Initialize storage and API access; activate workers after runtime ports are registered. */
export function initializeStudioPlugins() {
  const bundled = resolve(__dirname, 'plugin-runner.cjs')
  const runnerPath = existsSync(bundled) ? bundled : resolve(__dirname, '../../../../dist/server/plugin-runner.cjs')
  const runtime = createStudioPluginRuntime(runnerPath)
  configureStudioPluginRuntime(runtime)
  return runtime
}
