import { expect, it } from 'vitest'
import { checkPreparedRuntime } from '../../packages/desktop/scripts/check-prepared-runtime.mjs'

it('accepts an executable that reports the requested version', () => {
  expect(() => checkPreparedRuntime(process.execPath, ['--version'], process.versions.node, 'Node.js')).not.toThrow()
})

it('rejects an existing interpreter from another pinned generation', () => {
  expect(() => checkPreparedRuntime(process.execPath, ['--version'], '0.0.0', 'Node.js'))
    .toThrow('Build this runtime in a fresh resources target directory')
})

it('rejects a failed probe rather than treating file existence as readiness', () => {
  expect(() => checkPreparedRuntime(process.execPath, ['--studio-invalid-option'], process.versions.node, 'Node.js'))
    .toThrow('an unreadable version')
})
