import { afterEach, describe, expect, it, vi } from 'vitest'

const statMock = vi.fn()

vi.mock('fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs/promises')>()
  return { ...actual, stat: (...args: unknown[]) => statMock(...args) }
})

describe('session category preset workspace probe', () => {
  afterEach(() => {
    statMock.mockReset()
    vi.useRealTimers()
  })

  it('treats a hung folder check as unknown after the timeout instead of blocking or reporting it missing', async () => {
    vi.useFakeTimers()
    statMock.mockReturnValue(new Promise(() => {}))
    const { describeSessionCategoryPresetStatus, probeDirectory } = await import(
      '../../packages/server/src/modules/studio/services/session-category-preset'
    )
    const pending = describeSessionCategoryPresetStatus({ workspace: '/mnt/slow-share' }, path => probeDirectory(path, 50))
    await vi.advanceTimersByTimeAsync(50)
    await expect(pending).resolves.toBeUndefined()
  })

  it('reports missing folders as false and other stat errors as unknown', async () => {
    const { probeDirectory } = await import('../../packages/server/src/modules/studio/services/session-category-preset')
    statMock.mockResolvedValueOnce({ isDirectory: () => true })
    await expect(probeDirectory('/work/app')).resolves.toBe(true)
    statMock.mockResolvedValueOnce({ isDirectory: () => false })
    await expect(probeDirectory('/work/file.txt')).resolves.toBe(false)
    statMock.mockRejectedValueOnce(Object.assign(new Error('missing'), { code: 'ENOENT' }))
    await expect(probeDirectory('/work/deleted')).resolves.toBe(false)
    statMock.mockRejectedValueOnce(Object.assign(new Error('denied'), { code: 'EACCES' }))
    await expect(probeDirectory('/root/secret')).resolves.toBeUndefined()
  })

  it('runs checks in parallel, so one slow folder does not delay the others', async () => {
    vi.useFakeTimers()
    statMock.mockImplementation((path: string) => path === '/slow'
      ? new Promise(() => {})
      : Promise.resolve({ isDirectory: () => true }))
    const { describeSessionCategoryPresetStatus, probeDirectory } = await import(
      '../../packages/server/src/modules/studio/services/session-category-preset'
    )
    const probe = (path: string) => probeDirectory(path, 100)
    const all = Promise.all([
      describeSessionCategoryPresetStatus({ workspace: '/slow' }, probe),
      describeSessionCategoryPresetStatus({ workspace: '/fast-a' }, probe),
      describeSessionCategoryPresetStatus({ workspace: '/fast-b' }, probe),
    ])
    // Every stat starts before any timer fires.
    expect(statMock).toHaveBeenCalledTimes(3)
    await vi.advanceTimersByTimeAsync(100)
    await expect(all).resolves.toEqual([undefined, { workspace_exists: true }, { workspace_exists: true }])
  })
})
