// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
const state = vi.hoisted(() => ({ bridge: undefined as any }))
vi.mock('@/utils/desktop-bridge', () => ({ desktopBridge: () => state.bridge }))
import { notifyComputerUseStarted, useComputerUsePermissionPrompt } from '@/composables/useComputerUsePermissionPrompt'

describe('Computer Use permission reminder', () => {
  const missing = { supported: true as const, accessibility: 'denied' as const, screenRecording: 'granted' as const }
  const { pending, dismiss } = useComputerUsePermissionPrompt()
  beforeEach(() => {
    dismiss()
    state.bridge = { isDesktop: true, platform: 'darwin', remoteMode: false, computerUsePermissions: {
      claimReminder: vi.fn().mockResolvedValue(missing), request: vi.fn(), getStatus: vi.fn(),
    } }
  })

  it('silently checks real use but ignores discovery, closing and unrelated tools', async () => {
    for (const action of ['list', 'describe', 'close', 'invalid']) await notifyComputerUseStarted('computer_use', { action })
    await notifyComputerUseStarted('terminal_exec', { action: 'call' })
    await notifyComputerUseStarted('computer_use', null)
    expect(state.bridge.computerUsePermissions.claimReminder).not.toHaveBeenCalled()
    await notifyComputerUseStarted('computer_use', { action: 'status' })
    expect(pending.value).toEqual(missing)
    expect(state.bridge.computerUsePermissions.request).not.toHaveBeenCalled()
    expect(state.bridge.computerUsePermissions.getStatus).not.toHaveBeenCalled()
  })

  it.each(['win32', 'linux', 'remote', 'web', 'old'])('ignores %s environments', async platform => {
    const claim = state.bridge.computerUsePermissions.claimReminder
    if (platform === 'remote') state.bridge.remoteMode = true
    else if (platform === 'web') state.bridge = undefined
    else if (platform === 'old') state.bridge.computerUsePermissions.claimReminder = undefined
    else state.bridge.platform = platform
    await notifyComputerUseStarted('computer_use', { action: 'call' })
    expect(claim).not.toHaveBeenCalled()
    expect(pending.value).toBeNull()
  })

  it('coalesces simultaneous events and leaves global deduplication to the native claim', async () => {
    let resolve!: (status: typeof missing | null) => void
    const claim = state.bridge.computerUsePermissions.claimReminder.mockImplementationOnce(() => new Promise(done => { resolve = done }))
    const first = notifyComputerUseStarted('computer_use', { action: 'call' })
    await notifyComputerUseStarted('computer_use', { action: 'call' })
    expect(claim).toHaveBeenCalledOnce()
    resolve(missing)
    await first
    await notifyComputerUseStarted('computer_use', { action: 'call' })
    expect(claim).toHaveBeenCalledOnce()
    dismiss()
    claim.mockResolvedValue(null)
    await notifyComputerUseStarted('computer_use', { action: 'call' })
    expect(pending.value).toBeNull()
  })

  it('does not infer missing grants from errors and retries on a later use', async () => {
    state.bridge.computerUsePermissions.claimReminder.mockRejectedValueOnce(new Error('unavailable'))
    await notifyComputerUseStarted('computer_use', { action: 'call' })
    expect(pending.value).toBeNull()
    await notifyComputerUseStarted('computer_use', { action: 'call' })
    expect(pending.value).toEqual(missing)
  })

  it('does not restore a pending reminder after its host unmounts', async () => {
    let resolve!: (status: typeof missing) => void
    state.bridge.computerUsePermissions.claimReminder.mockImplementationOnce(() => new Promise(done => { resolve = done }))
    const task = notifyComputerUseStarted('computer_use', { action: 'call' })
    dismiss()
    resolve(missing)
    await task
    expect(pending.value).toBeNull()
  })
})
