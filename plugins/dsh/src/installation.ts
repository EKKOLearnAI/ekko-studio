import { createRequire } from 'node:module'
import { readFile, realpath, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { DshPluginError } from './errors'

export async function dshInstallation(command: string) {
  let directory: string
  try { directory = dirname(await realpath(command)) }
  catch { throw new DshPluginError(503, 'DSH_DEPENDENCY_UNAVAILABLE', 'DSH is not installed') }
  for (;;) {
    for (const candidate of [join(directory, 'package.json'), join(directory, 'node_modules/@deepseek-ai/dsh/package.json')]) {
      try { if (JSON.parse(await readFile(candidate, 'utf8')).name === '@deepseek-ai/dsh') return candidate } catch {}
    }
    const parent = dirname(directory)
    if (parent === directory) break
    directory = parent
  }
  throw new DshPluginError(422, 'DSH_CAPABILITY_UNSUPPORTED', 'Unable to locate the installed DSH package')
}

// Mirrors DSH's installation-first bundle resolution, including packages that
// do not export package.json. Reading manifests never imports plugin code.
export async function dshPackageDirectory(name: string, anchors: string[]) {
  if (!/^(?:@[\w.-]+\/)?[\w.-]+$/.test(name)) throw new Error(`Invalid DSH package name: ${name}`)
  for (const anchor of anchors) {
    for (const root of createRequire(anchor).resolve.paths(name) || []) {
      const candidate = join(root, name)
      try { if ((await stat(join(candidate, 'package.json'))).isFile()) return await realpath(candidate) } catch {}
    }
  }
  throw new DshPluginError(422, 'DSH_DEPENDENCY_UNAVAILABLE', `Cannot resolve Web profile dependency ${name}; install its dependencies in the source Web profile`)
}
