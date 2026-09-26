import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  checkUpdateAgent,
  deleteCodingAgent,
  getCodingAgentNpmInvocationCount,
  installCodingAgent,
  resetCodingAgentNpmInvocationCount,
} from '../../../../packages/server/src/modules/coding-agents/services'
import { codingAgentRunManager } from '../../../../packages/server/src/modules/coding-agents/services/runtime/run-manager'
import { getAgentUpdateManager } from '../../../../packages/server/src/modules/coding-agents/services/update-manager'

describe('Cursor CLI install policy', () => {
  afterEach(() => {
    resetCodingAgentNpmInvocationCount()
  })

  it('does not call npm when installing cursor', async () => {
    resetCodingAgentNpmInvocationCount()
    await installCodingAgent('cursor')
    expect(getCodingAgentNpmInvocationCount()).toBe(0)
  })

  it('reports Cursor update checks as unsupported instead of current', async () => {
    const result = await checkUpdateAgent('cursor')
    expect(result.success).toBe(false)
    expect(result.updateAvailable).toBe(false)
    expect(result.latestVersion).toBe('')
    const policy = await getAgentUpdateManager()
    expect(policy.snapshot().cursor?.autoUpdateSupported).toBe(false)
  })

  it('does not stop Cursor sessions when removal is unsupported', async () => {
    const stopMatching = vi.spyOn(codingAgentRunManager, 'stopMatching')
    try {
      const result = await deleteCodingAgent('cursor')
      expect(result.success).toBe(false)
      expect(result.code).toBe('UNSUPPORTED')
      expect(getCodingAgentNpmInvocationCount()).toBe(0)
      expect(stopMatching).not.toHaveBeenCalled()
    } finally {
      stopMatching.mockRestore()
    }
  })
})
