import { afterEach, describe, expect, it } from 'vitest'
import {
  getCodingAgentNpmInvocationCount,
  installCodingAgent,
  resetCodingAgentNpmInvocationCount,
} from '../../../../packages/server/src/modules/coding-agents/services'

describe('Cursor CLI install policy', () => {
  afterEach(() => {
    resetCodingAgentNpmInvocationCount()
  })

  it('does not call npm when installing cursor', async () => {
    resetCodingAgentNpmInvocationCount()
    await installCodingAgent('cursor')
    expect(getCodingAgentNpmInvocationCount()).toBe(0)
  })
})
