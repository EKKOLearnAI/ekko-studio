import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { execFileMock } = vi.hoisted(() => ({ execFileMock: vi.fn() }))

vi.mock('child_process', async () => {
  const actual = await vi.importActual<typeof import('child_process')>('child_process')
  return { ...actual, execFile: execFileMock }
})

const {
  clonePreview,
  checkoutPreview,
  configureUpdateRuntime,
  downloadGithubZip,
  previewTags,
  resolveGitHubToken,
} = await import('../../packages/server/src/modules/studio/services/update/version-preview-manager')

describe('Version Preview GitHub authentication', () => {
  let webUiHome: string
  const originalEnv = { ...process.env }

  beforeEach(() => {
    vi.clearAllMocks()
    process.env = { ...originalEnv }
    webUiHome = mkdtempSync(join(tmpdir(), 'version-preview-test-'))
    process.env.HERMES_WEB_UI_PREVIEW_REPO = 'https://github.com/example/private-preview'
    configureUpdateRuntime({
      getWebUiHome: () => webUiHome,
      isDockerContainer: () => false,
    })
  })

  afterEach(() => {
    process.env = { ...originalEnv }
    rmSync(webUiHome, { recursive: true, force: true })
  })

  it('resolves trimmed GITHUB_TOKEN before GH_TOKEN and gh auth token', async () => {
    process.env.GITHUB_TOKEN = '  github-token  '
    process.env.GH_TOKEN = 'gh-token'

    await expect(resolveGitHubToken()).resolves.toBe('github-token')
    expect(execFileMock).not.toHaveBeenCalled()
  })

  it('ignores blank environment values and uses gh auth token via execFile', async () => {
    delete process.env.GITHUB_TOKEN
    process.env.GH_TOKEN = '  '
    execFileMock.mockImplementationOnce((_command, _args, _options, callback) => callback(null, '  cli-token \n', ''))

    await expect(resolveGitHubToken()).resolves.toBe('cli-token')
    expect(execFileMock).toHaveBeenCalledWith(
      'gh',
      ['auth', 'token'],
      expect.objectContaining({ timeout: 3000 }),
      expect.any(Function),
    )
  })

  it('adds Bearer authentication to the GitHub tags API fallback', async () => {
    process.env.GITHUB_TOKEN = 'tags-token'
    execFileMock.mockImplementationOnce((_command, _args, _options, callback) => {
      const error = Object.assign(new Error('git unavailable'), { stderr: 'network failure' })
      callback(error, '', 'network failure')
    })
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response(JSON.stringify([
      { name: 'v1.2.3', commit: { sha: 'abc123' } },
    ]), { status: 200 }))

    const ctx: any = {}
    await previewTags(ctx)

    expect(ctx.body.tags).toEqual([
      { name: 'main', sha: '' },
      { name: 'v1.2.3', sha: 'abc123' },
    ])
    expect(fetchMock.mock.calls[0][1]).toEqual(expect.objectContaining({
      headers: expect.objectContaining({ Authorization: 'Bearer tags-token' }),
    }))
    fetchMock.mockRestore()
  })

  it('uses the GitHub API ZIP endpoint and strips Authorization after redirect', async () => {
    process.env.GITHUB_TOKEN = 'zip-token'
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(null, {
        status: 302,
        headers: { Location: 'https://codeload.github.com/example/private-preview/zip/abc' },
      }))
      .mockResolvedValueOnce(new Response(new Uint8Array([1, 2, 3]), { status: 200 }))
    execFileMock
      .mockImplementationOnce((_command, _args, _options, callback) => callback(null, '', '')) // tar
      .mockImplementationOnce((_command, _args, _options, callback) => callback(null, 'archive-root\n', '')) // ls
      .mockImplementationOnce((_command, _args, _options, callback) => callback(null, '', '')) // cp

    const targetDir = join(webUiHome, 'preview')
    await downloadGithubZip('v1.2.3', targetDir)

    expect(fetchMock.mock.calls[0][0]).toBe('https://api.github.com/repos/example/private-preview/zipball/v1.2.3')
    expect(fetchMock.mock.calls[0][1]).toEqual(expect.objectContaining({
      headers: expect.objectContaining({ Authorization: 'Bearer zip-token' }),
      redirect: 'manual',
    }))
    expect(fetchMock.mock.calls[1][1]).toEqual(expect.objectContaining({
      headers: { 'User-Agent': 'hermes-web-ui-preview' },
      redirect: 'manual',
    }))
    fetchMock.mockRestore()
  })

  it('cleans temporary askpass credentials after clone success', async () => {
    process.env.GITHUB_TOKEN = 'clone-token'
    let askpassPath = ''
    execFileMock.mockImplementationOnce((_command, args, options, callback) => {
      askpassPath = options.env.GIT_ASKPASS
      expect(options.env.GIT_TERMINAL_PROMPT).toBe('0')
      expect(args).not.toContain('clone-token')
      mkdirSync(args[args.length - 1], { recursive: true })
      callback(null, '', '')
    })

    await clonePreview('v1.2.3')

    expect(askpassPath).toBeTruthy()
    expect(existsSync(askpassPath)).toBe(false)
  })

  it('uses temporary credentials for fetch and removes them on every git call', async () => {
    process.env.GITHUB_TOKEN = 'fetch-token'
    const previewDir = join(webUiHome, 'hermes-web-ui-pereview')
    mkdirSync(join(previewDir, '.git'), { recursive: true })
    writeFileSync(join(previewDir, 'package.json'), JSON.stringify({ name: 'ekko-studio' }))
    const askpassPaths: string[] = []
    execFileMock
      .mockImplementationOnce((_command, args, options, callback) => {
        askpassPaths.push(options.env.GIT_ASKPASS)
        expect(args).toEqual(['fetch', '--tags', '--force'])
        callback(null, '', '')
      })
      .mockImplementationOnce((_command, args, options, callback) => {
        askpassPaths.push(options.env.GIT_ASKPASS)
        expect(args).toEqual(['checkout', '--force', 'v1.2.3'])
        callback(null, '', '')
      })

    await checkoutPreview('v1.2.3')

    expect(askpassPaths).toHaveLength(2)
    expect(askpassPaths.every(path => !existsSync(path))).toBe(true)
  })
})
