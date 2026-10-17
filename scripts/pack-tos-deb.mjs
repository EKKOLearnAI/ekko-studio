import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, readdirSync, readSync, closeSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const templates = join(repository, 'packages/tos')
const digestBuffer = Buffer.alloc(1024 * 1024)
export const TOS_LANGUAGES = ['zh-cn', 'zh-hk', 'en-us', 'fr-fr', 'de-de', 'it-it', 'es-es',
  'hu-hu', 'ja-jp', 'ko-kr', 'pl-pl', 'ru-ru', 'tr-tr', 'pt-pt']

function run(command, args) {
  return execFileSync(command, args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })
}

export function verifyTosIcon(icon) {
  if (Buffer.byteLength(icon) > 50_000) throw new Error('TOS SVG icon exceeds 50 KB')
  // ElementTree validates XML and resolves attribute entities before checks.
  // Reject directives before parsing; only ordinary SVG XML is needed here.
  const xml = icon.replace(/<!--[\s\S]*?-->/g, '')
  if (/<!|<\?(?!xml\s)/i.test(xml)) throw new Error('TOS SVG icon contains forbidden XML directives')
  execFileSync('python3', ['-c', `
import sys, xml.etree.ElementTree as E
root = E.fromstring(sys.stdin.read())
elements = list(root.iter())
assert root.tag == '{http://www.w3.org/2000/svg}svg', 'TOS icon must be an SVG vector'
assert len(elements) <= 50, 'TOS SVG icon exceeds 50 nodes'
for element in elements:
    tag = element.tag.rsplit('}', 1)[-1].lower()
    assert tag not in ('script', 'foreignobject', 'iframe', 'object', 'embed', 'image'), 'Unsafe TOS SVG element'
    for key, value in element.attrib.items():
        key = key.rsplit('}', 1)[-1].lower()
        assert not key.startswith('on'), 'Unsafe TOS SVG event attribute'
        if key == 'href':
            assert not value.strip().lower().startswith(('javascript:', 'vbscript:', 'file:', 'ftp:', 'about:', 'blob:')), 'Unsafe TOS SVG href'
`], { input: xml, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] })
}

function requireFile(path) {
  if (!existsSync(path)) throw new Error(`Missing packaging input: ${path}`)
}

function fileDigest(path, algorithm) {
  const hash = createHash(algorithm)
  const fd = openSync(path, 'r')
  try {
    let length
    while ((length = readSync(fd, digestBuffer, 0, digestBuffer.length, null))) hash.update(digestBuffer.subarray(0, length))
  } finally { closeSync(fd) }
  return hash.digest('hex')
}

function* regularFiles(root) {
  for (const entry of readdirSync(root, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const path = join(root, entry.name)
    if (entry.isDirectory()) yield* regularFiles(path)
    else if (entry.isFile()) yield path
  }
}

function render(name, values) {
  const result = readFileSync(join(templates, name), 'utf8')
    .replace(/@([A-Z_]+)@/g, (_, key) => {
      if (!(key in values)) throw new Error(`Unknown template variable ${key}`)
      return String(values[key])
    })
  return result
}

function languageFile(publisher) {
  const english = {
    name: 'Ekko Studio', auth: publisher,
    descript: 'AI workspace for multi-agent chat, coding and visual workflows, accessible in your browser.',
    important: 'TOS test build. Configure your login and model provider before use. Service port: 8648.',
  }
  const chinese = {
    ...english,
    descript: '通过浏览器使用的 AI 工作台，支持多智能体聊天、编程和可视化工作流。',
    important: 'TOS 测试版。使用前请配置登录账号和模型服务。服务端口：8648。',
  }
  return TOS_LANGUAGES.map(language => {
    const fields = language === 'zh-cn' ? chinese : english
    return `[${language}]\n${Object.entries(fields).map(([key, value]) => `${key} = ${JSON.stringify(value)}`).join('\n')}\n`
  }).join('\n')
}

function pruneForeignBinaries(webui) {
  const browser = join(webui, 'node_modules/agent-browser/bin')
  if (existsSync(browser)) {
    for (const name of readdirSync(browser)) {
      if (name.startsWith('agent-browser-') && name !== 'agent-browser-linux-x64') {
        rmSync(join(browser, name), { recursive: true, force: true })
      }
    }
  }
  const pty = join(webui, 'node_modules/node-pty/prebuilds')
  if (existsSync(pty)) {
    for (const name of readdirSync(pty)) {
      if (name !== 'linux-x64') rmSync(join(pty, name), { recursive: true, force: true })
    }
  }
}

// Node and native addons must run on TOS 7's glibc 2.35, not just on the build host.
export function checkTosAbi(root) {
  let checked = 0
  function visit(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isSymbolicLink()) {
        const target = existsSync(path) ? realpathSync(path) : null
        const outside = target ? relative(root, target) : '..'
        if (outside === '..' || outside.startsWith(`..${sep}`)) {
          throw new Error(`Broken or external package symlink: ${path}`)
        }
        continue
      }
      if (entry.isDirectory()) { visit(path); continue }
      if (!entry.isFile()) continue
      const fd = openSync(path, 'r')
      const header = Buffer.alloc(20)
      try { readSync(fd, header, 0, header.length, 0) } finally { closeSync(fd) }
      if (!header.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))) continue
      if (header[4] !== 2 || header[5] !== 1 || header.readUInt16LE(18) !== 62) throw new Error(`Not a Linux x64 ELF: ${path}`)
      const versions = run('readelf', ['--version-info', path])
      for (const match of versions.matchAll(/\bGLIBC_(\d+)\.(\d+)\b/g)) {
        if (Number(match[1]) > 2 || (Number(match[1]) === 2 && Number(match[2]) > 35)) {
          throw new Error(`TOS 7 glibc 2.35 incompatible: ${path} requires ${match[0]}; build on Ubuntu 22.04`)
        }
      }
      checked++
    }
  }
  visit(root)
  if (!checked) throw new Error('No ELF runtime found in TOS package')
  return checked
}

export function verifyTosDeb(deb) {
  const temporary = mkdtempSync(join(tmpdir(), 'ekko-tos-verify-'))
  try {
    run('dpkg-deb', ['--extract', deb, temporary])
    const defaults = JSON.parse(readFileSync(join(templates, 'config.json'), 'utf8'))
    const app = join(temporary, 'usr/local', defaults.id)
    const config = JSON.parse(readFileSync(join(app, 'config.ini'), 'utf8'))
    if (config.id !== defaults.id || config.package !== defaults.package || config.system_id !== defaults.system_id
      || config.user !== defaults.user || config.icon !== `/images/icons/${defaults.id}.svg`
      || config.application_type !== 'deb' || config.platform !== 'x86_64'
      || config.open_path !== true || 'type' in config || config.user === 'root' || !config.beta) {
      throw new Error('Invalid TOS application identity or external-open configuration')
    }
    if (run('dpkg-deb', ['--field', deb, 'Package']).trim() !== config.package
      || run('dpkg-deb', ['--field', deb, 'Version']).trim() !== config.version
      || run('dpkg-deb', ['--field', deb, 'Architecture']).trim() !== 'amd64') {
      throw new Error('Debian and TOS identities differ')
    }
    for (const file of ['bin/ekko-studio', `init.d/${config.system_id}.service`,
      `nginx/${config.id}.conf`, config.icon.replace(/^\//, ''), `${config.id}.lang`,
      'webui.bz2', 'depends/bin/node', 'depends/bin/npm', 'depends/bin/npx',
      'depends/webui/bin/ekko-studio-mcp.mjs',
      'depends/webui/dist/server/index.js', 'depends/webui/dist/client/index.html']) {
      requireFile(join(app, file))
    }
    const languages = readFileSync(join(app, `${config.id}.lang`), 'utf8')
    if (languages.charCodeAt(0) === 0xfeff || languages.includes('\r')) throw new Error('Invalid language encoding')
    for (const language of TOS_LANGUAGES) {
      const block = languages.split(`[${language}]\n`)[1]?.split('\n[')[0]
      if (!block || !['name', 'auth', 'descript'].every(key => new RegExp(`^${key} = ".+"$`, 'm').test(block))) {
        throw new Error(`Missing TOS language fields: ${language}`)
      }
    }
    const service = readFileSync(join(app, `init.d/${config.system_id}.service`), 'utf8')
    if (!service.includes(`User=${config.user}\n`) || !service.includes('NoNewPrivileges=true\n')
      || !service.includes('ProtectSystem=strict\n') || !service.includes('BIND_HOST=0.0.0.0\n')) {
      throw new Error('Invalid TOS service configuration')
    }
    if (!service.includes(`HERMES_WEB_UI_MCP_BIN=/usr/local/${config.id}/depends/webui/bin/ekko-studio-mcp.mjs\n`)
      || !service.includes(`HERMES_AGENT_NODE=/usr/local/${config.id}/depends/bin/node\n`)) {
      throw new Error('TOS managed MCP must use the packaged script and Node runtime')
    }
    const icon = readFileSync(join(app, config.icon.replace(/^\//, '')), 'utf8')
    verifyTosIcon(icon)
    const version = JSON.parse(readFileSync(join(app, 'depends/webui/package.json'), 'utf8')).version
    if (config.version !== version) throw new Error('Web UI and TOS versions differ')
    const payload = run('tar', ['-tjf', join(app, 'webui.bz2')]).split('\n')
    if (!payload.some(path => path === 'webui/index.html')) throw new Error('Missing archived frontend')
    const controls = join(temporary, 'control')
    run('dpkg-deb', ['--control', deb, controls])
    const sums = new Map(readFileSync(join(controls, 'md5sums'), 'utf8').trim().split('\n').map(line => {
      const match = /^([a-f0-9]{32})  (.+)$/.exec(line)
      if (!match) throw new Error('Malformed Debian md5sums')
      return [match[2], match[1]]
    }))
    const files = [...regularFiles(app)]
    if (sums.size !== files.length) throw new Error('Incomplete Debian md5sums')
    for (const path of files) {
      if (sums.get(relative(temporary, path)) !== fileDigest(path, 'md5')) throw new Error(`Debian checksum mismatch: ${path}`)
    }
    for (const script of ['postinst', 'prerm', 'postrm']) {
      const path = join(controls, script)
      run('bash', ['-n', path])
      if ((lstatSync(path).mode & 0o777) !== 0o755) throw new Error(`Lifecycle script not executable: ${script}`)
    }
    return { id: config.id, version, platform: config.platform, beta: config.beta,
      md5FilesChecked: files.length, elfFilesChecked: checkTosAbi(app) }
  } finally {
    rmSync(temporary, { recursive: true, force: true })
  }
}

export function packTosDeb({ webuiDir, nodeRoot = dirname(dirname(process.execPath)), outputDir }) {
  if (process.platform !== 'linux' || process.arch !== 'x64') throw new Error('TOS target currently requires a Linux x64 build host')
  webuiDir = resolve(webuiDir)
  outputDir = resolve(outputDir)
  const settings = JSON.parse(readFileSync(join(templates, 'config.json'), 'utf8'))
  verifyTosIcon(readFileSync(join(templates, 'icon.svg'), 'utf8'))
  if (settings.id.length > 50 || !/^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/.test(settings.id)) {
    throw new Error('TOS id must use lowercase alphanumeric segments separated by dots or hyphens (max 50 characters)')
  }
  for (const file of ['package.json', 'bin/hermes-web-ui.mjs', 'bin/ekko-studio-mcp.mjs', 'dist/server/index.js', 'dist/client/index.html', 'node_modules']) {
    requireFile(join(webuiDir, file))
  }
  const pkg = JSON.parse(readFileSync(join(webuiDir, 'package.json'), 'utf8'))
  if (pkg.name !== 'ekko-studio' || !/^\d+\.\d+\.\d+$/.test(pkg.version)) throw new Error('Expected a stable-version ekko-studio Web UI build')
  const node = join(nodeRoot, 'bin/node')
  const npm = join(nodeRoot, 'lib/node_modules/npm')
  requireFile(node)
  requireFile(join(npm, 'bin/npm-cli.js'))
  const runtime = JSON.parse(run(node, ['-p', 'JSON.stringify({platform:process.platform,arch:process.arch,major:Number(process.versions.node.split(".")[0])})']))
  if (runtime.platform !== 'linux' || runtime.arch !== 'x64' || runtime.major !== 24) throw new Error('TOS runtime must be Node.js 24 for Linux x64')
  const temporary = mkdtempSync(join(tmpdir(), 'ekko-tos-build-'))
  try {
    const stage = join(temporary, 'package')
    const app = join(stage, 'usr/local', settings.id)
    const put = (path, content, mode = 0o644) => {
      const destination = join(app, path)
      mkdirSync(dirname(destination), { recursive: true })
      writeFileSync(destination, content, { mode })
    }
    const values = { APP_ID: settings.id, USER: settings.user, SERVICE: settings.system_id, PORT: settings.port }
    const config = {
      ...settings, version: pkg.version, icon: `/images/icons/${settings.id}.svg`,
      exec: true, open_path: true, path: `http://\${ip}:${settings.port}`,
      recommend: false, beta: true, category: ['Utilities'], platform: 'x86_64',
      application_type: 'deb', official: 'https://ekkostudio.xyz',
      help: 'https://github.com/EKKOLearnAI/ekko-studio', depend: [], relation: [],
      all_user_display: false, allow_open_in_mobile: true,
    }
    delete config.port
    put('config.ini', JSON.stringify(config, null, 2) + '\n')
    put(`${settings.id}.lang`, languageFile(settings.publisher))
    put(`images/icons/${settings.id}.svg`, readFileSync(join(templates, 'icon.svg')))
    put('bin/ekko-studio', readFileSync(join(templates, 'launcher.sh')), 0o755)
    put(`init.d/${settings.system_id}.service`, render('ekko-studio.service.in', values))
    put(`nginx/${settings.id}.conf`, render('nginx.conf.in', values))
    put('README.md', readFileSync(join(templates, 'README.md')))
    put('LICENSE', readFileSync(join(repository, 'LICENSE')))
    const webui = join(app, 'depends/webui')
    mkdirSync(webui, { recursive: true })
    for (const path of ['package.json', 'package-lock.json', 'bin', 'dist', 'node_modules']) {
      if (existsSync(join(webuiDir, path))) cpSync(join(webuiDir, path), join(webui, path), { recursive: true, verbatimSymlinks: true })
    }
    pruneForeignBinaries(webui)
    mkdirSync(join(app, 'depends/bin'), { recursive: true })
    cpSync(node, join(app, 'depends/bin/node'))
    chmodSync(join(app, 'depends/bin/node'), 0o755)
    mkdirSync(join(app, 'depends/lib/node_modules'), { recursive: true })
    cpSync(npm, join(app, 'depends/lib/node_modules/npm'), { recursive: true, verbatimSymlinks: true })
    for (const command of ['npm', 'npx']) symlinkSync(`../lib/node_modules/npm/bin/${command}-cli.js`, join(app, 'depends/bin', command))
    const frontend = join(temporary, 'frontend/webui')
    mkdirSync(frontend, { recursive: true })
    cpSync(join(webui, 'dist/client'), frontend, { recursive: true })
    run('tar', ['-cjf', join(app, 'webui.bz2'), '-C', dirname(frontend), 'webui'])
    const control = join(stage, 'DEBIAN')
    mkdirSync(control)
    writeFileSync(join(control, 'control'), `Package: ${settings.package}
Version: ${pkg.version}
Architecture: amd64
Section: web
Priority: optional
Maintainer: EKKOLearnAI <noreply@hermes-studio.local>
Depends: libc6 (>= 2.35), libstdc++6, libgcc-s1, zlib1g, systemd, bash, bzip2, ca-certificates, git, python3 (>= 3.10), python3-venv
Description: Ekko Studio Web service for TerraMaster TOS 7
 Multi-agent chat, coding and visual workflows in your browser.
 Includes a private Node.js runtime. TOS device validation is required.
`)
    for (const script of ['postinst', 'prerm', 'postrm']) {
      writeFileSync(join(control, script), render(`${script}.in`, values), { mode: 0o755 })
    }
    // dpkg-deb --build does not run debhelper's dh_md5sums.
    writeFileSync(join(control, 'md5sums'), [...regularFiles(app)]
      .map(path => `${fileDigest(path, 'md5')}  ${relative(stage, path)}\n`).join(''))
    checkTosAbi(app)
    mkdirSync(outputDir, { recursive: true })
    const filename = `${settings.id}_${pkg.version}_x86_64.deb`
    const deb = join(outputDir, filename)
    if (existsSync(deb)) throw new Error(`Refusing to overwrite ${deb}`)
    run('dpkg-deb', ['--root-owner-group', '-Zgzip', '-z6', '--build', stage, deb])
    const verification = verifyTosDeb(deb)
    const sha256 = fileDigest(deb, 'sha256')
    writeFileSync(`${deb}.sha256`, `${sha256}  ${filename}\n`)
    const report = { ...verification, filename, sha256, nodeVersion: run(node, ['--version']).trim(), tosDeviceTested: false }
    writeFileSync(`${deb}.verification.json`, JSON.stringify(report, null, 2) + '\n')
    return report
  } finally {
    rmSync(temporary, { recursive: true, force: true })
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ options: {
    'webui-dir': { type: 'string' }, 'node-root': { type: 'string' },
    output: { type: 'string', default: join(repository, 'release/tos') },
    verify: { type: 'string' },
  } })
  if (values.verify) console.log(JSON.stringify(verifyTosDeb(resolve(values.verify)), null, 2))
  else {
    if (!values['webui-dir']) throw new Error('Provide --webui-dir with a built, production-only Web UI directory')
    console.log(JSON.stringify(packTosDeb({
      webuiDir: values['webui-dir'], nodeRoot: values['node-root'], outputDir: values.output,
    }), null, 2))
  }
}
