import { expect, it } from 'vitest'
// @ts-expect-error Repository harness is ESM JavaScript.
import { checkStudioPluginBoundaries, studioPluginBoundaryViolations } from '../../scripts/studio-plugin-boundaries.mjs'

it('rejects private imports through static, dynamic and CommonJS module references', () => {
  const file = 'plugins/example/src/index.ts'
  for (const source of [
    "import { state } from '../../../packages/server/src/modules/studio/services/state'",
    "const module = await import('../../../packages/server/src/bootstrap/http')",
    "const module = require('../../other-plugin/runtime')",
    "export * from '../../../packages/client/src/stores/auth'",
  ]) expect(studioPluginBoundaryViolations(file, source)).toHaveLength(1)
  expect(studioPluginBoundaryViolations(file, "import { definePlugin } from '@ekko-studio/plugin-sdk'; import { spawn } from 'node:child_process'")).toEqual([])
})

it('keeps the checked-in SDK, runner and plugins independent of application code', async () => {
  expect(await checkStudioPluginBoundaries(process.cwd())).toEqual([])
})
