import { delimiter } from 'node:path'
import { describe, expect, it } from 'vitest'
import { prioritizeManagedNpmBin } from '../../packages/server/src/modules/coding-agents/services/managed-command-path'

describe('managed npm CLI priority', () => {
  it('promotes a managed bin already shadowed by an older system installation', () => {
    const env = { PATH: ['/usr/local/bin', '/home/user/.local/bin', '/studio/npm/bin', '/usr/bin'].join(delimiter) }
    prioritizeManagedNpmBin(env, '/studio/npm/bin')
    expect(env.PATH.split(delimiter)).toEqual(['/studio/npm/bin', '/usr/local/bin', '/home/user/.local/bin', '/usr/bin'])
  })
  it('deduplicates the promoted path and remains stable across repeated calls', () => {
    const env = { PATH: ['/system', '/managed', '/managed'].join(delimiter) }
    prioritizeManagedNpmBin(env, '/managed'); prioritizeManagedNpmBin(env, '/managed')
    expect(env.PATH.split(delimiter)).toEqual(['/managed', '/system'])
  })
  it('preserves path casing and leaves missing prefixes alone', () => {
    const env = { Path: ['/system', '/managed'].join(delimiter) }
    prioritizeManagedNpmBin(env, '/managed')
    expect(env.Path.split(delimiter)[0]).toBe('/managed')
    const before = env.Path
    prioritizeManagedNpmBin(env, null)
    expect(env.Path).toBe(before)
  })
})
