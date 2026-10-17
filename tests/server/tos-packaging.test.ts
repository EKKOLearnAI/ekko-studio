import { execFileSync, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { parse } from 'yaml'
import { checkTosAbi, packTosDeb, TOS_LANGUAGES, verifyTosDeb, verifyTosIcon } from '../../scripts/pack-tos-deb.mjs'

const directories: string[] = []
afterEach(() => {
  vi.unstubAllEnvs()
  directories.splice(0).forEach(path => rmSync(path, { recursive: true, force: true }))
})

function temporary() {
  const path = mkdtempSync(join(tmpdir(), 'studio-tos-test-'))
  directories.push(path)
  return path
}

function put(root: string, path: string, content: string) {
  const destination = join(root, path)
  mkdirSync(dirname(destination), { recursive: true })
  writeFileSync(destination, content)
}

describe('TOS platform SVG constraints', () => {
  const wrap = (content: string) => `<svg xmlns="http://www.w3.org/2000/svg">${content}</svg>`
  it('accepts the exact-contour desktop icon within platform limits', () => {
    expect(() => verifyTosIcon(readFileSync('packages/tos/icon.svg', 'utf8'))).not.toThrow()
  })
  it('rejects oversized and overly complex SVGs before uploading', () => {
    expect(() => verifyTosIcon(wrap(`<!--${'x'.repeat(50_000)}-->`))).toThrow('50 KB')
    expect(() => verifyTosIcon(wrap('<path/>'.repeat(50)))).toThrow('50 nodes')
  })
  it.each([
    '<path>', '<script/>', '<path onload="bad()"/>',
    '<path href="java&#x73;cript:bad()"/>', '<image href="data:example"/>',
  ])('rejects malformed or unsafe SVG: %s', content => {
    expect(() => verifyTosIcon(wrap(content))).toThrow()
  })
  it('rejects XML directives', () => {
    expect(() => verifyTosIcon(`<!DOCTYPE svg>${wrap('')}`)).toThrow('directives')
  })
})

describe('standalone TOS test workflow', () => {
  const workflow = parse(readFileSync(resolve('.github/workflows/tos-package-test.yml'), 'utf8'))

  it('runs on published releases like Docker/npm, manual dispatch or TOS PRs', () => {
    expect(Object.keys(workflow.on)).toEqual(['workflow_dispatch', 'release', 'pull_request'])
    expect(workflow.on.release).toEqual({ types: ['published'] })
    for (const filename of ['docker-publish.yml', 'npm-publish.yml']) {
      const existing = parse(readFileSync(resolve('.github/workflows', filename), 'utf8'))
      expect(workflow.on.release).toEqual(existing.on.release)
    }
    expect(workflow.on.pull_request.paths).toEqual([
      '.github/workflows/tos-package-test.yml', 'packages/tos/**',
      'scripts/pack-tos-deb.mjs', 'scripts/test-tos-platform.mjs',
      'tests/server/tos-packaging.test.ts', 'tests/server/tos-platform.test.ts',
    ])
    expect(workflow.permissions).toEqual({ contents: 'read' })
    expect(workflow.jobs.tos['runs-on']).toBe('ubuntu-22.04')
    const checkout = workflow.jobs.tos.steps.find((step: any) => step.uses === 'actions/checkout@v4')
    expect(checkout.with.ref).toBe('${{ github.sha }}')
  })

  it('builds after production staging and keeps outputs in Actions artifacts', () => {
    const steps = workflow.jobs.tos.steps
    const build = steps.find((step: any) => step.name === 'Build and verify TOS 7 Deb')
    const pruneIndex = steps.findIndex((step: any) => step.name === 'Keep production dependencies only')
    const sharpIndex = steps.findIndex((step: any) => step.name === 'Verify image processing runtime')
    const stageIndex = steps.findIndex((step: any) => step.name === 'Stage production Web UI')
    expect(sharpIndex).toBeGreaterThan(pruneIndex)
    expect(stageIndex).toBeGreaterThan(sharpIndex)
    expect(steps.indexOf(build)).toBeGreaterThan(stageIndex)
    const upload = steps.find((step: any) => step.uses === 'actions/upload-artifact@v4')
    expect(upload.with['if-no-files-found']).toBe('error')
    expect(upload.with['retention-days']).toBe(7)
    expect(upload.with.path.trim().split('\n')).toEqual([
      'release/tos/*.deb', 'release/tos/*.deb.sha256', 'release/tos/*.deb.verification.json',
    ])
    expect(steps.some((step: any) => String(step.uses || '').includes('action-gh-release'))).toBe(false)
    expect(steps.some((step: any) => /\bgh release\b/.test(String(step.run || '')))).toBe(false)
  })

  it('only gives secrets and release writes to the release/opt-in platform job', () => {
    const platform = workflow.jobs.platform
    expect(workflow.on.workflow_dispatch.inputs.upload_to_tdp.default).toBe(false)
    expect(platform.if).toBe("github.event_name == 'release' || (github.event_name == 'workflow_dispatch' && inputs.upload_to_tdp)")
    expect(platform.permissions).toEqual({ contents: 'write', actions: 'read' })
    expect(platform.needs).toBe('tos')
    expect(platform.concurrency['cancel-in-progress']).toBe(false)
    const publish = platform.steps.find((step: any) => step.env?.TDP_API_TOKEN)
    expect(publish.env.GH_TOKEN).toBe('${{ github.token }}')
    expect(publish.env.TDP_API_TOKEN).toBe('${{ secrets.TDP_API_TOKEN }}')
    expect(publish.env.TOS_RELEASE_TAG).toBe('${{ github.event.release.tag_name || inputs.release_tag }}')
    expect(publish.env.TOS_SOURCE_SHA).toBe('${{ needs.tos.outputs.source_sha }}')
    expect(publish.run).toBe('node scripts/test-tos-platform.mjs release/tos')
    expect(JSON.stringify(workflow.jobs.tos)).not.toContain('secrets.')
  })

  it.runIf(process.platform === 'linux')('executes the staging step and exports the packaged input directory', () => {
    const stage = workflow.jobs.tos.steps.find((step: any) => step.name === 'Stage production Web UI')
    const root = temporary()
    const source = join(root, 'source')
    for (const path of ['package.json', 'package-lock.json', 'bin/entry.mjs', 'dist/client/index.html', 'node_modules/fixture/index.js']) {
      put(source, path, 'staged production input')
    }
    const githubEnv = join(root, 'github-env')
    execFileSync('bash', ['-e', '-o', 'pipefail', '-c', stage.run], {
      cwd: source, env: { ...process.env, TOS_SOURCE_DIR: '.', RUNNER_TEMP: root, GITHUB_ENV: githubEnv },
    })
    const staged = join(root, 'ekko-tos-webui')
    expect(readFileSync(githubEnv, 'utf8')).toBe(`TOS_WEBUI_DIR=${staged}\n`)
    expect(readFileSync(join(staged, 'dist/client/index.html'), 'utf8')).toBe('staged production input')
    expect(readFileSync(join(staged, 'node_modules/fixture/index.js'), 'utf8')).toBe('staged production input')
  })

  it('checks out the selected Release source separately from packaging tools', () => {
    const steps = workflow.jobs.tos.steps
    const checkout = steps.find((step: any) => step.name === 'Checkout release source')
    expect(checkout.with.ref).toBe('refs/tags/${{ github.event.release.tag_name || inputs.release_tag }}')
    expect(checkout.with.path).toBe('.tos-release-source')
    expect(workflow.jobs.tos.outputs.source_sha).toBe('${{ steps.source.outputs.sha }}')
  })

  it.each([
    { event: 'release', tag: 'v1.2.3', inputTag: '', upload: false, publish: true, sourceTag: 'v1.2.3' },
    { event: 'release', tag: 'v1.2.3', inputTag: 'v9.9.9', upload: false, publish: true, sourceTag: 'v1.2.3' },
    { event: 'workflow_dispatch', tag: '', inputTag: 'v1.2.3', upload: true, publish: true, sourceTag: 'v1.2.3' },
    { event: 'workflow_dispatch', tag: '', inputTag: 'v1.2.3', upload: false, publish: false, sourceTag: 'v1.2.3' },
    { event: 'workflow_dispatch', tag: '', inputTag: '', upload: false, publish: false, sourceTag: '' },
    { event: 'pull_request', tag: '', inputTag: '', upload: true, publish: false, sourceTag: '' },
  ])('routes source/upload/cancellation for $event (upload=$upload, tag=$tag)', scenario => {
    // These workflow conditions use the shared JS/GitHub boolean-expression subset.
    const github = { event_name: scenario.event, event: { release: { tag_name: scenario.tag } } }
    const inputs = { release_tag: scenario.inputTag, upload_to_tdp: scenario.upload }
    const evaluate = (expression: string) => Function('github', 'inputs',
      `return (${expression.replace(/^\$\{\{\s*|\s*\}\}$/g, '')})`)(github, inputs)
    expect(Boolean(evaluate(workflow.jobs.platform.if))).toBe(scenario.publish)
    const publish = workflow.jobs.platform.steps.find((step: any) => step.env?.TDP_API_TOKEN)
    expect(evaluate(publish.env.TOS_RELEASE_TAG)).toBe(scenario.sourceTag)
    const validate = workflow.jobs.tos.steps.find((step: any) => step.name === 'Validate release selection')
    expect(evaluate(validate.env.RELEASE_TAG)).toBe(scenario.sourceTag)
    expect(Boolean(evaluate(validate.env.UPLOAD_TO_TDP))).toBe(scenario.publish)
    expect(evaluate(workflow.jobs.tos.env.TOS_SOURCE_DIR)).toBe(scenario.sourceTag ? '.tos-release-source' : '.')
    expect(evaluate(workflow.concurrency['cancel-in-progress'])).toBe(scenario.event === 'pull_request')
  })

  it('requires a Release tag for uploading but permits plain PR builds', () => {
    const step = workflow.jobs.tos.steps.find((step: any) => step.name === 'Validate release selection')
    for (const env of [{ RELEASE_TAG: '', UPLOAD_TO_TDP: 'false' }, { RELEASE_TAG: 'v1.2.3', UPLOAD_TO_TDP: 'true' }]) {
      expect(() => execFileSync('bash', ['-e', '-c', step.run], { env: { ...process.env, ...env }, stdio: 'pipe' })).not.toThrow()
    }
    expect(() => execFileSync('bash', ['-e', '-c', step.run], {
      env: { ...process.env, RELEASE_TAG: '', UPLOAD_TO_TDP: 'true' }, stdio: 'pipe',
    })).toThrow()
  })

  it('records the actual source commit and rejects mismatched Release metadata', () => {
    const root = temporary()
    put(root, 'package.json', JSON.stringify({ name: 'ekko-studio', version: '1.2.3' }))
    for (const args of [
      ['init', '-q'], ['config', 'user.name', 'TOS test'], ['config', 'user.email', 'tos-test@example.invalid'],
      ['add', 'package.json'], ['commit', '-qm', 'fixture'],
    ]) execFileSync('git', ['-C', root, ...args])
    const step = workflow.jobs.tos.steps.find((step: any) => step.id === 'source')
    const output = join(root, 'outputs')
    const env = { ...process.env, TOS_SOURCE_DIR: root, RELEASE_TAG: 'v1.2.3', GITHUB_OUTPUT: output }
    execFileSync('bash', ['-e', '-c', step.run], { env, stdio: 'pipe' })
    const sha = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
    expect(readFileSync(output, 'utf8')).toBe(`sha=${sha}\n`)
    expect(() => execFileSync('bash', ['-e', '-c', step.run], {
      env: { ...env, RELEASE_TAG: 'v2.0.0' }, stdio: 'pipe',
    })).toThrow()
  })

  it.each(['webui-release.yml', 'desktop-release.yml', 'desktop-manual-build.yml'])(
    'keeps TOS orchestration out of %s', filename => {
      const source = readFileSync(resolve('.github/workflows', filename), 'utf8')
      expect(source).not.toMatch(/include_tos|pack:tos|release\/tos|tos-package-test/)
    },
  )
})

describe.runIf(process.platform === 'linux' && process.arch === 'x64')('TOS Debian artifact', () => {
  it('contains TOS metadata and a portable runtime, and launches without Electron', async () => {
    const root = temporary()
    const source = join(root, 'source')
    put(source, 'package.json', JSON.stringify({ name: 'ekko-studio', version: '99.0.0' }))
    put(source, 'bin/hermes-web-ui.mjs', '/* CLI fixture */')
    put(source, 'bin/ekko-studio-mcp.mjs', '/* MCP entry fixture */')
    put(source, 'dist/client/index.html', '<html>Ekko Studio fixture</html>')
    put(source, 'dist/server/index.js', `
      const server = require('node:http').createServer((_req, res) => res.end(JSON.stringify({
        ok: true, major: Number(process.versions.node.split('.')[0]), uid: process.getuid(),
      })));
      server.listen(0, '127.0.0.1', () => console.log(server.address().port));
      process.on('SIGTERM', () => server.close());
    `)
    put(source, 'node_modules/fixture-tool/bin/cli.js', '/* relative symlink fixture */')
    put(source, 'node_modules/agent-browser/bin/agent-browser-linux-x64', 'kept native target')
    put(source, 'node_modules/agent-browser/bin/agent-browser-linux-arm64', 'foreign target')
    put(source, 'node_modules/node-pty/prebuilds/win32-x64/pty.node', 'foreign target')
    mkdirSync(join(source, 'node_modules/.bin'))
    symlinkSync('../fixture-tool/bin/cli.js', join(source, 'node_modules/.bin/fixture-tool'))
    const output = join(root, 'output')
    const result = packTosDeb({ webuiDir: source, outputDir: output })
    const deb = join(output, result.filename)
    expect(result).toMatchObject({ id: 'com.hermeswebui.studio', version: '99.0.0', beta: true, tosDeviceTested: false })
    expect(result.filename).toBe('com.hermeswebui.studio_99.0.0_x86_64.deb')
    expect(result.elfFilesChecked).toBeGreaterThan(0)
    expect(result.md5FilesChecked).toBeGreaterThan(0)
    expect(readFileSync(`${deb}.sha256`, 'utf8')).toBe(
      `${createHash('sha256').update(readFileSync(deb)).digest('hex')}  ${result.filename}\n`,
    )
    const unpacked = join(root, 'unpacked')
    execFileSync('dpkg-deb', ['--extract', deb, unpacked])
    const controls = join(root, 'control')
    execFileSync('dpkg-deb', ['--control', deb, controls])
    execFileSync('md5sum', ['--check', join(controls, 'md5sums')], { cwd: unpacked, stdio: 'pipe' })
    const app = join(unpacked, 'usr/local', result.id)
    expect(existsSync(join(unpacked, 'usr/local/com-hermeswebui-studio'))).toBe(false)
    expect(existsSync(join(app, 'com.hermeswebui.studio.lang'))).toBe(true)
    expect(existsSync(join(app, 'images/icons/com.hermeswebui.studio.svg'))).toBe(true)
    const config = JSON.parse(readFileSync(join(app, 'config.ini'), 'utf8'))
    expect(config).toMatchObject({ open_path: true, path: 'http://${ip}:8648', application_type: 'deb', platform: 'x86_64' })
    expect(config.type).toBeUndefined()
    expect(config.user).not.toBe('root')
    const service = readFileSync(join(app, 'init.d/ekko-studio-tos.service'), 'utf8')
    for (const key of ['HERMES_WEB_UI_MCP_BIN', 'HERMES_AGENT_NODE']) {
      const configured = service.split('\n').find(line => line.startsWith(`Environment=${key}=`))!.split('=').slice(2).join('=')
      const installed = join(unpacked, configured)
      expect(existsSync(installed)).toBe(true)
      vi.stubEnv(key, installed)
    }
    vi.stubEnv('HERMES_WEB_UI_ALLOW_TRANSIENT_MCP_AUTOINJECT', '1')
    const { buildManagedEkkoMcpServers } = await import('../../packages/server/src/modules/ekko/services/mcp')
    const managed = Object.values(buildManagedEkkoMcpServers('default'))
    expect(managed.length).toBeGreaterThan(0)
    for (const server of managed) {
      expect(server.command).toBe(join(app, 'depends/bin/node'))
      expect(server.args?.[0]).toBe(join(app, 'depends/webui/bin/ekko-studio-mcp.mjs'))
    }
    expect(execFileSync('dpkg-deb', ['--field', deb, 'Depends'], { encoding: 'utf8' })).toContain('bzip2')
    const languages = readFileSync(join(app, `${result.id}.lang`), 'utf8')
    for (const language of TOS_LANGUAGES) expect(languages).toContain(`[${language}]\n`)
    const icon = readFileSync(join(app, 'images/icons', `${result.id}.svg`), 'utf8')
    expect(icon).toContain('<svg')
    expect(icon).not.toContain('<image')
    expect(readlinkSync(join(app, 'depends/webui/node_modules/.bin/fixture-tool'))).toBe('../fixture-tool/bin/cli.js')
    expect(readlinkSync(join(app, 'depends/bin/npm'))).toBe('../lib/node_modules/npm/bin/npm-cli.js')
    expect(existsSync(join(app, 'depends/webui/node_modules/agent-browser/bin/agent-browser-linux-arm64'))).toBe(false)
    expect(existsSync(join(app, 'depends/webui/node_modules/agent-browser/bin/agent-browser-linux-x64'))).toBe(true)
    expect(existsSync(join(app, 'depends/webui/node_modules/node-pty/prebuilds/win32-x64'))).toBe(false)
    expect(existsSync(join(source, 'node_modules/agent-browser/bin/agent-browser-linux-arm64'))).toBe(true)

    // Exercise the actual packaged launcher and runtime under an unprivileged uid.
    chmodSync(root, 0o755)
    const child = spawn(join(app, 'bin/ekko-studio'), [], {
      ...(process.getuid?.() === 0 ? { uid: 65534, gid: 65534 } : {}),
      env: { PATH: process.env.PATH },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const exited = once(child, 'exit')
    try {
      const port = await new Promise<number>((resolvePort, reject) => {
        const timer = setTimeout(() => reject(new Error('Packaged service did not start')), 10_000)
        child.once('error', error => { clearTimeout(timer); reject(error) })
        child.stdout.once('data', data => { clearTimeout(timer); resolvePort(Number(String(data).trim())) })
        child.once('exit', code => { clearTimeout(timer); reject(new Error(`Packaged service exited: ${code}`)) })
      })
      const response = await fetch(`http://127.0.0.1:${port}`)
      expect(await response.json()).toMatchObject({ ok: true, major: 24 })
      expect((await (await fetch(`http://127.0.0.1:${port}`)).json()).uid).not.toBe(0)
    } finally {
      child.kill('SIGTERM')
      await exited
    }
    expect(child.exitCode).toBe(0)
    // A byte change must fail verification even when Deb/TOS identities still match.
    const alteredStage = join(root, 'altered')
    execFileSync('dpkg-deb', ['--raw-extract', deb, alteredStage])
    writeFileSync(join(alteredStage, 'usr/local', result.id, 'README.md'), 'modified without updating checksums')
    const alteredDeb = join(root, 'altered.deb')
    execFileSync('dpkg-deb', ['-Zgzip', '--build', alteredStage, alteredDeb])
    expect(() => verifyTosDeb(alteredDeb)).toThrow('checksum mismatch')
    expect(JSON.parse(readFileSync(join(source, 'package.json'), 'utf8')).version).toBe('99.0.0')
  }, 120_000)

  it('rejects an incomplete Web UI build', () => {
    const root = temporary()
    expect(() => packTosDeb({ webuiDir: root, outputDir: join(root, 'output') })).toThrow('Missing packaging input')
  })

  it('rejects native code carrying a newer glibc version', () => {
    const root = temporary()
    put(root, 'future.c', 'int future(void) { return 1; }\n')
    put(root, 'versions.map', 'GLIBC_2.36 { global: future; };\n')
    execFileSync('gcc', ['-shared', '-fPIC', join(root, 'future.c'),
      `-Wl,--version-script=${join(root, 'versions.map')}`, '-o', join(root, 'libfuture.so')])
    expect(() => checkTosAbi(root)).toThrow('requires GLIBC_2.36')
  })

  it('rejects symlinks into the build machine', () => {
    const root = temporary()
    symlinkSync('/etc/passwd', join(root, 'external'))
    expect(() => checkTosAbi(root)).toThrow('external package symlink')
  })

  it('rejects an ordinary desktop Deb that lacks TOS metadata', () => {
    const root = temporary()
    put(root, 'stage/DEBIAN/control', 'Package: desktop-fixture\nVersion: 1.0.0\nArchitecture: amd64\nMaintainer: Test <test@example.com>\nDescription: Desktop fixture\n')
    put(root, 'stage/usr/share/applications/desktop.desktop', '[Desktop Entry]\nName=Desktop\n')
    const deb = join(root, 'desktop.deb')
    execFileSync('dpkg-deb', ['--build', join(root, 'stage'), deb])
    expect(() => verifyTosDeb(deb)).toThrow('config.ini')
  })
})
