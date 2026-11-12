#!/usr/bin/env node
import { mkdir, writeFile, rm } from 'node:fs/promises'
import { resolve, join, isAbsolute } from 'node:path'
const [destination, id] = process.argv.slice(2)
if (!destination || !isAbsolute(destination) || !/^[a-z][a-z0-9-]{0,63}$/.test(id || '')) {
  throw new Error('Usage: node scripts/create-plugin.mjs /absolute/new/directory plugin-id')
}
const target = resolve(destination)
await mkdir(target, { recursive: false })
try {
  await writeFile(join(target, 'package.json'), JSON.stringify({ name: `studio-plugin-${id}`, version: '0.1.0', type: 'module', private: true }, null, 2) + '\n')
  await writeFile(join(target, 'plugin.json'), JSON.stringify({ id, name: id, version: '0.1.0', apiVersion: 1, server: 'server.mjs', client: 'client.mjs', capabilities: ['ui'], views: [{ id: 'settings', title: id, slot: 'settings' }] }, null, 2) + '\n')
  await writeFile(join(target, 'server.mjs'), `export function apply(ctx) {\n  ctx.rpc.register('get-settings', async (_input, run) => await ctx.storage.namespace(String(run.identity.userId), run.identity.profile).get('settings') ?? {})\n  ctx.rpc.register('save-settings', async (input, run) => {\n    await ctx.storage.namespace(String(run.identity.userId), run.identity.profile).set('settings', input)\n    return { ok: true }\n  })\n}\n`)
  await writeFile(join(target, 'client.mjs'), `export async function mount(root, ctx) {\n  const editor = document.createElement('textarea')\n  editor.rows = 12; editor.style.width = '100%'\n  editor.value = JSON.stringify(await ctx.rpc('get-settings'), null, 2)\n  const save = document.createElement('button')\n  save.textContent = 'Save settings'\n  save.onclick = async () => {\n    try { await ctx.rpc('save-settings', JSON.parse(editor.value)); ctx.ui.notify('Saved', 'success') }\n    catch (error) { ctx.ui.notify(error.message, 'error') }\n  }\n  root.append(editor, save)\n}\n`)
  console.log(`Plugin created at ${target}. Install this directory from Studio plugins.`)
} catch (error) { await rm(target, { recursive: true, force: true }); throw error }
