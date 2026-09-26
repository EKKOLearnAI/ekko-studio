import { describe, expect, it } from 'vitest'
import { profileDisplayLabel, profileSelectLabel } from '../../packages/client/src/lib/profileDisplay'

describe('profileDisplay helpers', () => {
  it('uses displayName when set', () => {
    expect(profileDisplayLabel({ name: 'wazj', displayName: '网安专家数字人' })).toBe('网安专家数字人')
  })

  it('falls back to alias then canonical id', () => {
    expect(profileDisplayLabel({ name: 'wazj', alias: 'cyber' })).toBe('cyber')
    expect(profileDisplayLabel({ name: 'wazj' })).toBe('wazj')
  })

  it('select label includes id when display name differs', () => {
    expect(profileSelectLabel({ name: 'wazj', displayName: '网安专家数字人' })).toBe(
      '网安专家数字人 (wazj)',
    )
    expect(profileSelectLabel({ name: 'default' })).toBe('default')
  })
})
