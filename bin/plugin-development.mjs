import { mkdir, readFile, writeFile, realpath, readdir, rm, cp, link, unlink } from 'node:fs/promises'
import { resolve, join, dirname } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'

export const pluginHome = () => resolve(process.env.HERMES_WEB_UI_HOME?.trim() || process.env.HERMES_WEBUI_STATE_DIR?.trim() || join(homedir(), '.hermes-web-ui'))
const registry = home => join(home, 'plugins', 'development')
function identifier(id) {
  if (typeof id !== 'string' || !/^[a-z][a-z0-9._-]{0,79}$/.test(id) || id.includes('..') || ['constructor', 'prototype'].includes(id)) throw new Error('Invalid plugin id: use lowercase letters, numbers, dots, underscores and hyphens.')
  return id
}
export async function scaffoldPlugin(destination, id) {
  identifier(id)
  if (!destination) {
    throw new Error('Specify a directory and a lowercase plugin id')
  }
  const target = resolve(destination)
  await mkdir(dirname(target), { recursive: true })
  await mkdir(target, { recursive: false })
  try {
    await writeFile(join(target, 'package.json'), JSON.stringify({ name: `studio-plugin-${id}`, version: '0.1.0', type: 'module', private: true }, null, 2) + '\n')
    await writeFile(join(target, 'plugin.json'), JSON.stringify({ id, name: id, version: '0.1.0', apiVersion: 1, server: 'server.mjs', client: 'client.mjs', permissions: ['ui'], views: [{ id: 'settings', title: id, slot: 'settings' }], navigation: { settings: [{ viewId: 'settings', icon: 'settings' }] } }, null, 2) + '\n')
    const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
    const sdk = await realpath(join(root, 'packages/plugin-sdk')).catch(() => realpath(join(root, 'dist/plugin-sdk')))
    await mkdir(join(target, 'sdk'))
    await cp(join(sdk, 'package.json'), join(target, 'sdk/package.json'))
    for (const part of ['src', 'docs', 'harness', 'template']) await cp(join(sdk, part), join(target, 'sdk', part), { recursive: true })
    await cp(join(sdk, 'template'), target, { recursive: true })
    const pkg = JSON.parse(await readFile(join(target, 'package.json'), 'utf8'))
    pkg.scripts = { dev: 'ekko-studio plugins dev .', 'harness:check': 'node scripts/plugin-harness.mjs check', test: 'node --test tests/*.test.mjs', prepack: 'npm run harness:check && npm test && npm run build --if-present && npm run harness:check' }
    pkg.devDependencies = { '@ekko-studio/plugin-sdk': 'file:./sdk' }
    await writeFile(join(target, 'package.json'), JSON.stringify(pkg, null, 2) + '\n')
    await writeFile(join(target, '.gitignore'), 'node_modules/\ndist/\n.env\n.env.*\n')
    await cp(join(sdk, 'docs'), join(target, 'docs'), { recursive: true })
    return target
  } catch (error) { await rm(target, { recursive: true, force: true }); throw error }
}

export async function registerPlugin(directory, home = pluginHome()) {
  directory = await realpath(resolve(directory))
  const manifest = JSON.parse(await readFile(join(directory, 'plugin.json'), 'utf8'))
  const id = identifier(manifest.id), target = join(registry(home), `${id}.json`)
  await mkdir(dirname(target), { recursive: true, mode: 0o700 })
  const record = { schema: 1, id, directory, createdAt: Date.now() }
  const temporary = `${target}.${randomUUID()}.new`
  await writeFile(temporary, JSON.stringify(record, null, 2) + '\n', { mode: 0o600 })
  try {
    // Atomic exclusive publication: concurrent commands cannot replace a registration.
    await link(temporary, target)
  } catch (error) {
    if (error.code !== 'EEXIST') throw error
    const existing = JSON.parse(await readFile(target, 'utf8'))
    if (existing.directory !== directory) throw new Error(`Plugin ${id} is already registered at ${existing.directory}. Unlink it before changing directories.`)
    return existing
  } finally { await unlink(temporary) }
  return record
}
export async function listProjects(home = pluginHome()) {
  const entries = await readdir(registry(home)).catch(error => { if (error.code === 'ENOENT') return []; throw error })
  return Promise.all(entries.filter(name => /^[a-z][a-z0-9._-]{0,79}\.json$/.test(name)).sort().map(async name => {
    const record = JSON.parse(await readFile(join(registry(home), name), 'utf8'))
    try { await readFile(join(record.directory, 'plugin.json')); return record }
    catch { return { ...record, missing: true } }
  }))
}
export async function runPluginCommand(args, { home = pluginHome(), output = console.log } = {}) {
  const [action = 'help', first, second, ...extra] = args
  if (extra.length || second && action !== 'create' || first && ['list', 'help', '--help', '-h'].includes(action)) throw new Error('Unexpected plugin command arguments')
  if (['help', '--help', '-h'].includes(action)) {
    output(`Usage: ekko-studio plugins <command>\n\n  create <id> [directory]  Create and register a standalone project\n  link <directory>        Register an existing project\n  list                    List registered project directories\n  dev [id|directory]      Select a linked project in Studio\n  unlink <id>             Unregister; retain source, installed snapshot and data\n\nDefault projects: ${join(home, 'plugin-projects')}\nRegistry: ${registry(home)}\nUse the same HERMES_WEB_UI_HOME as the running Studio server.\nEnable linked projects in the plugin center after trusting their source.`)
    return
  }
  if (action === 'list') {
    output(JSON.stringify({ registry: registry(home), projects: await listProjects(home) }, null, 2)); return
  }
  if (action === 'unlink') {
    await unlink(join(registry(home), `${identifier(first)}.json`))
    output(`Unregistered ${first}. Source, installed snapshot and data retained.`); return
  }
  let project
  if (action === 'create') {
    identifier(first)
    if ((await listProjects(home)).some(project => project.id === first)) throw new Error(`Plugin ${first} is already registered`)
    const directory = await scaffoldPlugin(second || join(home, 'plugin-projects', first), first)
    project = await registerPlugin(directory, home)
  } else if (action === 'link' || action === 'dev') {
    if (action === 'link' && !first) throw new Error('Usage: ekko-studio plugins link <directory>')
    project = action === 'dev' && first ? (await listProjects(home)).find(project => project.id === first) : undefined
    project ||= await registerPlugin(first || process.cwd(), home)
  } else throw new Error(`Unknown plugin command: ${action}`)
  output(`Registered ${project.id}: ${project.directory}\nOpen Studio → Plugins → Enable.\nStudio builds and watches this directory while the plugin is enabled.\nRegistry: ${registry(home)}`)
}
