import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { dirname, join, resolve } from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import verifyPackagedWebUi, { targetArchName } from '../../packages/desktop/scripts/verify-packaged-webui.mjs'

const tempRoots: string[] = []

function packagedRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'hermes-packaged-webui-'))
  tempRoots.push(root)
  return root
}

function createPackagedWebUi(appOutDir: string, platform = 'win32', arch = 'x64'): void {
  const webUiRoot = join(appOutDir, 'resources', 'webui')
  const sharpRoot = `node_modules/@img/sharp-${platform}-${arch}`
  const sharpRuntimeFiles = platform === 'win32'
    ? [`${sharpRoot}/lib/sharp-${platform}-${arch}.node`]
    : [
        `${sharpRoot}/lib/sharp-${platform}-${arch}.node`,
        `node_modules/@img/sharp-libvips-${platform}-${arch}/package.json`,
        `node_modules/@img/sharp-libvips-${platform}-${arch}/lib/${platform === 'darwin' ? 'libvips-cpp.8.18.3.dylib' : 'libvips-cpp.so.8.18.3'}`,
      ]
  const sherpaPlatform = platform === 'win32' ? 'win' : platform
  const sherpaRoot = `node_modules/sherpa-onnx-${sherpaPlatform}-${arch}`
  const sherpaFiles = platform === 'win32'
    ? ['sherpa-onnx.node', 'onnxruntime.dll', 'onnxruntime_providers_shared.dll', 'sherpa-onnx-c-api.dll', 'sherpa-onnx-cxx-api.dll']
    : platform === 'darwin'
      ? ['sherpa-onnx.node', 'libonnxruntime.dylib', 'libsherpa-onnx-c-api.dylib', 'libsherpa-onnx-cxx-api.dylib']
      : ['sherpa-onnx.node', 'libonnxruntime.so', 'libsherpa-onnx-c-api.so', 'libsherpa-onnx-cxx-api.so']
  const files = [
    'package.json',
    'bin/hermes-web-ui.mjs',
    'dist/server/index.js',
    'dist/ekko-skills/THIRD_PARTY_NOTICES.md',
    'dist/ekko-skills/1password/SKILL.md',
    'dist/ekko-skills/apple-notes/SKILL.md',
    'dist/ekko-skills/apple-reminders/SKILL.md',
    'dist/ekko-skills/document-to-action-items/SKILL.md',
    'dist/ekko-skills/docx/SKILL.md',
    'dist/ekko-skills/gh-issues/SKILL.md',
    'dist/ekko-skills/github/SKILL.md',
    'dist/ekko-skills/grok-image-to-video/SKILL.md',
    'dist/ekko-skills/hermes-studio-installation/SKILL.md',
    'dist/ekko-skills/image-gen/SKILL.md',
    'dist/ekko-skills/node-inspect-debugger/SKILL.md',
    'dist/ekko-skills/obsidian/SKILL.md',
    'dist/ekko-skills/ocr-and-documents/SKILL.md',
    'dist/ekko-skills/pdf/SKILL.md',
    'dist/ekko-skills/powerpoint/SKILL.md',
    'dist/ekko-skills/python-debugpy/SKILL.md',
    'dist/ekko-skills/skill-creator/SKILL.md',
    'dist/ekko-skills/spike/SKILL.md',
    'dist/ekko-skills/tmux/SKILL.md',
    'dist/ekko-skills/video-frames/SKILL.md',
    'dist/ekko-skills/weather/SKILL.md',
    'dist/ekko-skills/xlsx/SKILL.md',
    'dist/ekko-skills/hermes-studio-installation/references/coding-agents.md',
    'dist/ekko-skills/hermes-studio-installation/references/hermes-runtime.md',
    'dist/ekko-skills/hermes-studio-installation/references/studio.md',
    'dist/ekko-skills/document-to-action-items/LICENSE',
    'dist/ekko-skills/docx/LICENSE',
    'dist/ekko-skills/docx/references/revisions-and-comments.md',
    'dist/ekko-skills/docx/scripts/docx_create.py',
    'dist/ekko-skills/docx/scripts/docx_edit.py',
    'dist/ekko-skills/docx/scripts/docx_read.py',
    'dist/ekko-skills/docx/scripts/docx_validate.py',
    'dist/ekko-skills/image-gen/scripts/studio-image-gen.mjs',
    'dist/ekko-skills/grok-image-to-video/scripts/grok-image-to-video.mjs',
    'dist/ekko-skills/ocr-and-documents/LICENSE',
    'dist/ekko-skills/ocr-and-documents/scripts/extract_marker.py',
    'dist/ekko-skills/ocr-and-documents/scripts/extract_pymupdf.py',
    'dist/ekko-skills/pdf/LICENSE',
    'dist/ekko-skills/pdf/references/forms.md',
    'dist/ekko-skills/pdf/scripts/pdf_create.py',
    'dist/ekko-skills/pdf/scripts/pdf_page_image.py',
    'dist/ekko-skills/pdf/scripts/pdf_read.py',
    'dist/ekko-skills/pdf/scripts/pdf_secure.py',
    'dist/ekko-skills/powerpoint/LICENSE',
    'dist/ekko-skills/powerpoint/scripts/pptx_create.py',
    'dist/ekko-skills/powerpoint/scripts/pptx_read.py',
    'dist/ekko-skills/powerpoint/scripts/pptx_render.py',
    'dist/ekko-skills/xlsx/LICENSE',
    'dist/ekko-skills/xlsx/references/restructuring.md',
    'dist/ekko-skills/xlsx/scripts/xlsx_create.py',
    'dist/ekko-skills/xlsx/scripts/xlsx_read.py',
    'dist/ekko-skills/xlsx/scripts/xlsx_recalc.py',
    'node_modules/node-pty/package.json',
    'node_modules/node-pty/prebuilds/win32-x64/pty.node',
    'node_modules/socket.io/package.json',
    'node_modules/sharp/package.json',
    `${sharpRoot}/package.json`,
    ...sharpRuntimeFiles,
    'node_modules/sherpa-onnx-node/package.json',
    `${sherpaRoot}/package.json`,
    ...sherpaFiles.map(file => `${sherpaRoot}/${file}`),
  ]
  for (const file of files) {
    const target = join(webUiRoot, file)
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, '')
  }
}

function createCompiledLinuxNodePty(appOutDir: string): void {
  const nodePtyRoot = join(appOutDir, 'resources', 'webui', 'node_modules', 'node-pty')
  rmSync(join(nodePtyRoot, 'prebuilds'), { recursive: true, force: true })
  const target = join(nodePtyRoot, 'build', 'Release', 'pty.node')
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, '')
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('packaged desktop Web UI', () => {
  it('maps electron-builder architecture values without desktop-only dependencies', () => {
    expect(targetArchName(1)).toBe('x64')
    expect(targetArchName(3)).toBe('arm64')
  })

  it('copies production dependencies through a dedicated node_modules matcher', () => {
    const config = readFileSync(resolve('packages/desktop/electron-builder.yml'), 'utf8')

    expect(config).toContain('afterPack: "./scripts/verify-packaged-webui.mjs"')
    expect(config).toContain('- "!scripts/**"')
    expect(config).not.toContain('!**/{.git,.github,docs,tests,playwright.config.ts,README*,scripts,*.map}')
    expect(config).toContain('from: "../../node_modules"')
    expect(config).toContain('to: "webui/node_modules"')
    const buildExclusion = config.indexOf('!node-pty/build/**')
    expect(buildExclusion).toBeGreaterThan(-1)
    expect(config.indexOf('node-pty/build/Release/pty.node')).toBeGreaterThan(buildExclusion)
  })

  it('uses the electron-builder 26 desktop entry schema for deb packages', () => {
    const script = readFileSync(resolve('packages/desktop/scripts/electron-builder.mjs'), 'utf8')

    expect(script).toContain('--config.linux.desktop.entry.Name=Ekko Studio')
    expect(script).not.toContain('--config.linux.desktop.Name=Ekko Studio')
  })

  it('accepts a package containing the server and target native dependencies', async () => {
    const appOutDir = packagedRoot()
    createPackagedWebUi(appOutDir)

    await expect(verifyPackagedWebUi({
      appOutDir,
      electronPlatformName: 'win32',
      arch: 1,
      packager: { appInfo: { productFilename: 'Ekko Studio' } },
    } as never)).resolves.toBeUndefined()
  })

  it('rejects a package that omitted production dependencies', async () => {
    const appOutDir = packagedRoot()
    createPackagedWebUi(appOutDir)
    rmSync(join(appOutDir, 'resources', 'webui', 'node_modules'), { recursive: true, force: true })

    await expect(verifyPackagedWebUi({
      appOutDir,
      electronPlatformName: 'win32',
      arch: 1,
      packager: { appInfo: { productFilename: 'Ekko Studio' } },
    } as never)).rejects.toThrow('Packaged Web UI is incomplete')
  })

  it('rejects a package that omitted Ekko built-in skills', async () => {
    const appOutDir = packagedRoot()
    createPackagedWebUi(appOutDir)
    rmSync(join(appOutDir, 'resources', 'webui', 'dist', 'ekko-skills'), {
      recursive: true,
      force: true,
    })

    await expect(verifyPackagedWebUi({
      appOutDir,
      electronPlatformName: 'win32',
      arch: 1,
      packager: { appInfo: { productFilename: 'Ekko Studio' } },
    } as never)).rejects.toThrow(/dist[/\\]ekko-skills[/\\]github[/\\]SKILL\.md/)
  })

  it('rejects a package that omitted the target sherpa-onnx runtime', async () => {
    const appOutDir = packagedRoot()
    createPackagedWebUi(appOutDir)
    rmSync(join(appOutDir, 'resources', 'webui', 'node_modules', 'sherpa-onnx-win-x64'), { recursive: true, force: true })

    await expect(verifyPackagedWebUi({
      appOutDir,
      electronPlatformName: 'win32',
      arch: 1,
      packager: { appInfo: { productFilename: 'Ekko Studio' } },
    } as never)).rejects.toThrow('sherpa-onnx-win-x64')
  })

  it('rejects a package that omitted the target sharp native runtime', async () => {
    const appOutDir = packagedRoot()
    createPackagedWebUi(appOutDir)
    rmSync(join(appOutDir, 'resources', 'webui', 'node_modules', '@img', 'sharp-win32-x64'), { recursive: true, force: true })

    await expect(verifyPackagedWebUi({
      appOutDir,
      electronPlatformName: 'win32',
      arch: 1,
      packager: { appInfo: { productFilename: 'Ekko Studio' } },
    } as never)).rejects.toThrow('sharp-win32-x64')
  })

  it('rejects a package that omitted the target sharp libvips runtime', async () => {
    const appOutDir = packagedRoot()
    createPackagedWebUi(appOutDir, 'linux', 'arm64')
    createCompiledLinuxNodePty(appOutDir)
    rmSync(join(appOutDir, 'resources', 'webui', 'node_modules', '@img', 'sharp-libvips-linux-arm64'), { recursive: true, force: true })

    await expect(verifyPackagedWebUi({
      appOutDir,
      electronPlatformName: 'linux',
      arch: 3,
      packager: { appInfo: { productFilename: 'Ekko Studio' } },
    } as never)).rejects.toThrow('sharp-libvips-linux-arm64')
  })

  it('accepts source-built node-pty runtime files on Linux', async () => {
    const appOutDir = packagedRoot()
    createPackagedWebUi(appOutDir, 'linux', 'arm64')
    createCompiledLinuxNodePty(appOutDir)

    await expect(verifyPackagedWebUi({
      appOutDir,
      electronPlatformName: 'linux',
      arch: 3,
      packager: { appInfo: { productFilename: 'Ekko Studio' } },
    } as never)).resolves.toBeUndefined()
  })

  it('rejects a Linux libvips package without a shared library', async () => {
    const appOutDir = packagedRoot()
    createPackagedWebUi(appOutDir, 'linux', 'x64')
    createCompiledLinuxNodePty(appOutDir)
    rmSync(join(
      appOutDir,
      'resources',
      'webui',
      'node_modules',
      '@img',
      'sharp-libvips-linux-x64',
      'lib',
      'libvips-cpp.so.8.18.3',
    ))

    await expect(verifyPackagedWebUi({
      appOutDir,
      electronPlatformName: 'linux',
      arch: 1,
      packager: { appInfo: { productFilename: 'Ekko Studio' } },
    } as never)).rejects.toThrow('sharp-libvips-linux-x64')
  })

  it('rejects a missing source-built node-pty module on Linux', async () => {
    const appOutDir = packagedRoot()
    createPackagedWebUi(appOutDir, 'linux', 'arm64')
    createCompiledLinuxNodePty(appOutDir)
    rmSync(join(appOutDir, 'resources', 'webui', 'node_modules', 'node-pty', 'build', 'Release', 'pty.node'))

    await expect(verifyPackagedWebUi({
      appOutDir,
      electronPlatformName: 'linux',
      arch: 3,
      packager: { appInfo: { productFilename: 'Ekko Studio' } },
    } as never)).rejects.toThrow('pty.node')
  })
})
