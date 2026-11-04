#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { lstatSync, realpathSync, existsSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

// These are build/dependency outputs or application-owned state, not task scratch
// space. Owned documentation assets also retain their established location.
// Exemption from this check is never authorization to delete their data.
const protectedSegments = new Set(['.git', 'node_modules', '.pio', '__pycache__'])
const protectedTrees = [
  'dist', 'dist-ssr', 'logs', 'hermes_data', '.hermes', '.hermes-web-ui', '.ekko',
  '.claude', '.codex', 'packages/server/data', 'packages/ekko-agent/.ekko',
  'packages/desktop/resources', 'packages/desktop/release',
  'packages/desktop/release-update-test', 'release/npm', 'release/tos',
  'docs/screenshots',
]
// This existing tracked design/history document is not a task delivery report.
const maintainedDocumentation = new Set([
  'docs/chat-chain-changes/2026-09-27-hermes-bridge-compatibility-audit.md',
])
const artifactDirectories = new Set([
  'artifacts', '.artifacts', 'reports', 'task-reports', 'screenshots', 'recordings',
  'coverage', 'playwright-report', 'blob-report', 'all-blob-reports', 'test-results',
  'verification-output', 'tmp', '.tmp',
])
const artifactFile = /(?:^|[-_.])(?:report|verification|audit|test-results)(?:[-_.].*)?\.(?:md|txt|log|json|html|csv|zip)$/i

function inside(parent, child) {
  const relative = path.relative(parent, child)
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`))
}

// Resolve symlinks even when the requested output directory does not exist yet.
function canonicalPath(input) {
  let existing = path.resolve(input)
  const suffix = []
  for (;;) {
    try {
      lstatSync(existing)
    } catch (error) {
      if (error.code !== 'ENOENT' || path.dirname(existing) === existing) throw error
      suffix.push(path.basename(existing))
      existing = path.dirname(existing)
      continue
    }
    return path.join(realpathSync(existing), ...suffix.reverse())
  }
}

function checkoutRoots(root) {
  try {
    const output = execFileSync('git', ['-C', root, 'worktree', 'list', '--porcelain', '-z'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
    })
    return output.split('\0').filter(field => field.startsWith('worktree ')).map(field => field.slice(9))
  } catch (error) {
    // Standalone source archives have no worktree registry. Never hide failures
    // for a real checkout, where validating other worktrees is required.
    if (existsSync(path.join(root, '.git'))) throw error
    return [root]
  }
}

export function assertExternalArtifactPath(root, output) {
  if (!path.isAbsolute(output)) throw new Error('Artifact output must be an absolute path outside all repository worktrees')
  const lexical = path.resolve(output)
  const canonical = canonicalPath(output)
  for (const checkout of new Set([root, ...checkoutRoots(root)])) {
    if (inside(path.resolve(checkout), lexical) || inside(canonicalPath(checkout), canonical)) {
      throw new Error('Task artifacts must be outside all repository worktrees; choose STUDIO_TASK_ARTIFACTS_DIR outside the checkout')
    }
  }
  return lexical
}

export function taskArtifactsRoot(root, env = process.env) {
  const key = createHash('sha256').update(canonicalPath(root)).digest('hex').slice(0, 16)
  return assertExternalArtifactPath(root,
    env.STUDIO_TASK_ARTIFACTS_DIR || path.join(tmpdir(), 'ekko-studio-task-artifacts', key))
}

export function taskArtifactPath(root, category, env = process.env) {
  if (!/^[a-z][a-z0-9-]*$/.test(category)) throw new Error('Use a simple artifact category, without path separators')
  return assertExternalArtifactPath(root, path.join(taskArtifactsRoot(root, env), category))
}

export async function createTaskArtifactDirectory(root, label, env = process.env) {
  if (!/^[a-z][a-z0-9-]{0,63}$/.test(label || '')) throw new Error('Supply a task label using lowercase letters, digits and hyphens')
  const base = taskArtifactsRoot(root, env)
  await mkdir(base, { recursive: true })
  const directory = await mkdtemp(path.join(base, `${label}-`))
  await writeFile(path.join(directory, '.studio-task-artifact.json'), JSON.stringify({
    version: 1, checkout: canonicalPath(root), label, createdAt: new Date().toISOString(),
  }, null, 2) + '\n')
  return directory
}

/** Inspect actual paths, including ignored/untracked files. Never read contents,
 * follow symlinks, enter nested repositories, or delete anything. */
export async function checkTaskArtifacts(root) {
  const failures = []
  async function walk(directory, relative = '') {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const rel = relative ? `${relative}/${entry.name}` : entry.name
      const absolute = path.join(directory, entry.name)
      if (protectedSegments.has(entry.name) || protectedTrees.some(tree => rel === tree || rel.startsWith(`${tree}/`))) continue
      if (maintainedDocumentation.has(rel)) continue
      // Every package may have a normal compiled dist directory.
      if (entry.name === 'dist' || entry.name === 'dist-ssr') continue
      if (artifactDirectories.has(entry.name)) {
        failures.push(`${rel}: task/report output belongs outside the checkout (npm run artifacts:new -- <task>)`)
        continue
      }
      if (!entry.isDirectory() && (artifactFile.test(entry.name) || entry.name.endsWith('.log'))) {
        failures.push(`${rel}: one-off report/log belongs outside the checkout`)
      }
      if (!entry.isDirectory() || entry.isSymbolicLink() || existsSync(path.join(absolute, '.git'))) continue
      await walk(absolute, rel)
    }
  }
  await walk(path.resolve(root))
  return failures.sort()
}
