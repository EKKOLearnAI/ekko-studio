#!/usr/bin/env node
import { cp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { resolve, join, isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'
const [destination, id] = process.argv.slice(2)
if (!destination || !isAbsolute(destination) || !/^[a-z][a-z0-9-]{0,63}$/.test(id || '')) {
  throw new Error('Usage: node scripts/create-plugin.mjs /absolute/new/directory plugin-id')
}
const target = resolve(destination)
await mkdir(target, { recursive: false })
try {
  await cp(fileURLToPath(new URL('../examples/plugins/notebook/', import.meta.url)), target, { recursive: true, force: false })
  const file = join(target, 'package.json'), pkg = JSON.parse(await readFile(file, 'utf8'))
  pkg.name = `studio-plugin-${id}`
  await writeFile(file, JSON.stringify(pkg, null, 2) + '\n')
  const manifestFile = join(target, 'plugin.json'), manifest = JSON.parse(await readFile(manifestFile, 'utf8'))
  manifest.id = id; manifest.name = id
  delete manifest.repository; delete manifest.documentation; delete manifest.author
  await writeFile(manifestFile, JSON.stringify(manifest, null, 2) + '\n')
  console.log(`Plugin created at ${target}. Install this directory from Studio plugins.`)
} catch (error) { await rm(target, { recursive: true, force: true }); throw error }
