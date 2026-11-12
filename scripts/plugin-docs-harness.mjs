import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { realpath } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { checkSdk } from '../packages/plugin-sdk/harness/sdk.mjs'

const run = promisify(execFile)
const sdk = 'packages/plugin-sdk/'
const guides = ['ARCHITECTURE.md', 'STUDIO_CTX.md', 'STUDIO_RETURNS.md'].map(name => `${sdk}docs/${name}`)
export async function checkPluginDocs(root, { base = process.env.PLUGIN_DOCS_BASE } = {}) {
  await checkSdk(join(root, sdk))
  const git = async (...args) => (await run('git', args, { cwd: root, maxBuffer: 4 * 1024 * 1024 })).stdout
  // Distribution archives have no Git history. They still require the shipped docs/types.
  const top = await git('rev-parse', '--show-toplevel').catch(() => '')
  if (!top) {
    if (base) throw new Error('Plugin documentation comparison requires Git history')
    return
  }
  if (await realpath(top.trim()) !== await realpath(root)) return
  const verify = (files, scope) => {
    if (files.some(file => file.startsWith(`${sdk}src/`)) && !files.some(file => guides.includes(file))) {
      throw new Error(`Plugin SDK changed (${scope}). Edit the relevant guide in packages/plugin-sdk/docs (architecture, ctx or return contracts) alongside the code, including compatibility/default behavior where needed.`)
    }
  }
  const paths = [sdk + 'src', sdk + 'docs']
  // Inspect uncommitted work separately so earlier guide edits cannot hide a new omission.
  const hasHead = await git('rev-parse', '--verify', 'HEAD').then(() => true, () => false)
  const working = hasHead ? await git('diff', '--no-renames', '--name-only', '-z', 'HEAD', '--', ...paths) : await git('ls-files', '-z', '--', ...paths)
  const untracked = await git('ls-files', '--others', '--exclude-standard', '-z', '--', ...paths)
  verify((working + untracked).split('\0').filter(Boolean), 'working tree')
  // Build CI supplies the PR base or push-before SHA and checks the complete change.
  if (base && !/^0+$/.test(base)) {
    if (!/^[a-f0-9]{40,64}$/i.test(base)) throw new Error('PLUGIN_DOCS_BASE must be a commit SHA')
    const ancestor = (await git('merge-base', base, 'HEAD')).trim()
    verify((await git('diff', '--no-renames', '--name-only', '-z', ancestor, 'HEAD', '--', ...paths)).split('\0').filter(Boolean), 'PR/push')
  }
}

const self = fileURLToPath(import.meta.url)
if (process.argv[1] && resolve(process.argv[1]) === self) {
  try { await checkPluginDocs(resolve(dirname(self), '..')); console.log('Plugin development documentation checked.') }
  catch (error) { console.error(error.message); process.exitCode = 1 }
}
