import { execFileSync } from 'node:child_process'
import { appendFileSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const sharedTestInputs = /^(?:package(?:-lock)?\.json|vitest\.config\.ts|scripts\/ci-test-scope\.mjs|tests\/shared\/ci-test-scope\.test\.ts)$/
const themeInputs = /^(?:playwright\.config\.ts|\.github\/workflows\/playwright\.yml|tests\/e2e\/(?:theme[^/]*\.spec\.ts|fixtures\.ts|header-actions-layout\.spec\.ts)|packages\/shared\/theme[^/]*\.ts|packages\/desktop\/src\/|packages\/client\/src\/(?:App\.vue|styles\/|components\/(?:layout|common)\/|composables\/usePageLoading\.ts|api\/(?:client\.ts|studio\/theme\.ts)|views\/hermes\/ThemeView\.vue|i18n\/theme-)|packages\/server\/src\/modules\/studio\/(?:controllers\/theme\.ts|routes\/theme\.ts|repositories\/user-theme-store\.ts|services\/theme\/)|scripts\/ui-theme)/
const packagingInputs = /^(?:packages\/tos\/|bin\/|LICENSE$|packages\/server\/src\/modules\/(?:ekko\/services\/mcp\.ts|studio\/public\/config\.ts)|scripts\/(?:[^/]*tos[^/]*|build-server)\.mjs|tests\/server\/tos-[^/]*\.test\.ts|\.github\/workflows\/(?:tos-[^/]*|build|(?:docker|npm)-publish|(?:webui|desktop)-release|desktop-manual-build)\.yml)/

export function selectTestScope(eventName, event, files) {
  if (eventName === 'workflow_dispatch' && event.inputs?.suite === 'core') {
    return { e2e: 'core', packaging: false }
  }
  if (!['pull_request', 'push'].includes(eventName) || !files?.length) {
    return { e2e: 'full', packaging: true }
  }
  const shared = files.some(file => sharedTestInputs.test(file))
  return {
    e2e: shared || files.some(file => themeInputs.test(file)) ? 'full' : 'core',
    packaging: shared || files.some(file => packagingInputs.test(file)),
  }
}

export function changedFiles(eventName, event, git = args => execFileSync('git', args, { encoding: 'utf8' })) {
  if (!['pull_request', 'push'].includes(eventName)) return undefined
  try {
    // Checkout uses the PR merge commit. Its first parent is the exact base
    // being tested, including base updates since the PR was opened.
    const base = eventName === 'pull_request' ? 'HEAD^1' : event.before
    if (!base || /^0+$/.test(base)) return undefined
    try { git(['cat-file', '-e', `${base}^{commit}`]) } catch {
      if (eventName !== 'push') return undefined
      git(['fetch', '--no-tags', '--depth=1', 'origin', base])
    }
    // Include both sides of renames so moving a theme file cannot hide it.
    return git(['diff', '--name-only', '--no-renames', '-z', base, 'HEAD']).split('\0').filter(Boolean)
  } catch {
    // Missing history must expand validation rather than silently omit tests.
    return undefined
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const eventName = process.env.GITHUB_EVENT_NAME || ''
  const event = process.env.GITHUB_EVENT_PATH ? JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8')) : {}
  const scope = selectTestScope(eventName, event, changedFiles(eventName, event))
  const output = `e2e=${scope.e2e}\npackaging=${scope.packaging}\n`
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, output)
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY,
    `Browser suite: **${scope.e2e}**. TOS packaging tests: **${scope.packaging ? 'included' : 'deferred to relevant changes/nightly'}**.\n`)
  process.stdout.write(output)
}
