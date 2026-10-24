import { existsSync } from 'node:fs'
import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { collectModuleSpecifiers } from './server-module-boundaries.mjs'

const roots = ['packages/studio-plugin-sdk', 'packages/studio-plugin-runner', 'packages/studio-agent-drivers', 'plugins']

/** Independently distributable code must not reach into the application or another plugin. */
export function studioPluginBoundaryViolations(filename, source) {
  const file = filename.replaceAll('\\', '/')
  const root = file.startsWith('plugins/') ? file.split('/').slice(0, 2).join('/') : roots.find(root => file.startsWith(`${root}/`))
  if (!root) return []
  const failures = []
  for (const specifier of collectModuleSpecifiers(source, file)) {
    const target = specifier.startsWith('.') ? path.posix.normalize(path.posix.join(path.posix.dirname(file), specifier)) : specifier
    const own = target === root || target.startsWith(`${root}/`)
    const sdk = target === '@ekko-studio/plugin-sdk' || target.startsWith('@ekko-studio/plugin-sdk/') || target.startsWith('packages/studio-plugin-sdk/')
    const driver = target.startsWith('@ekko-studio/agent-driver') || target.startsWith('packages/studio-agent-drivers/')
    if (own || sdk || driver) continue
    if (specifier.startsWith('.') || target.startsWith('/') || /^(?:@[^/]+\/)?(?:server|client|studio)(?:\/|$)/.test(target) || target.startsWith('packages/')) {
      failures.push(`${file}: plugin boundary forbids application or sibling imports: ${specifier}`)
    }
  }
  return failures
}

export async function checkStudioPluginBoundaries(root) {
  const failures = []
  async function visit(relative) {
    if (!existsSync(path.join(root, relative))) return
    for (const entry of await readdir(path.join(root, relative), { withFileTypes: true })) {
      if (['node_modules', 'dist', '.git'].includes(entry.name)) continue
      const file = `${relative}/${entry.name}`
      if (entry.isDirectory()) await visit(file)
      else if (/\.[cm]?[jt]sx?$/.test(file)) failures.push(...studioPluginBoundaryViolations(file, await readFile(path.join(root, file), 'utf8')))
    }
  }
  for (const directory of roots) await visit(directory)
  return failures
}
