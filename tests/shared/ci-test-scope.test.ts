import { describe, expect, it, vi } from 'vitest'
import { changedFiles, selectTestScope } from '../../scripts/ci-test-scope.mjs'

describe('CI test scope', () => {
  it('keeps feature and documentation changes on core regression coverage', () => {
    expect(selectTestScope('pull_request', {}, [
      'packages/server/src/modules/hermes/controllers/models.ts',
      'packages/client/src/components/hermes/models/ProviderCard.vue', 'README.md',
    ])).toEqual({ e2e: 'core', packaging: false })
  })

  it.each([
    'packages/client/src/styles/_theme-surfaces.scss',
    'packages/client/src/components/layout/PageHeader.vue',
    'packages/client/src/components/common/StudioLoading.vue',
    'packages/desktop/src/preload.ts',
    'packages/shared/theme-appearance.ts',
    'packages/server/src/modules/studio/services/theme/archive.ts',
    'tests/e2e/fixtures.ts', 'tests/e2e/theme-surfaces.spec.ts',
    'tests/e2e/header-actions-layout.spec.ts', 'playwright.config.ts',
  ])('runs the full browser matrix when %s changes', file => {
    expect(selectTestScope('pull_request', {}, [file]).e2e).toBe('full')
  })

  it.each([
    'packages/tos/icon.svg', 'scripts/pack-tos-deb.mjs', 'scripts/build-server.mjs',
    'tests/server/tos-packaging.test.ts', 'bin/ekko-studio-mcp.mjs', 'LICENSE',
    'packages/server/src/modules/ekko/services/mcp.ts',
    'packages/server/src/modules/studio/public/config.ts',
    ...['tos-package-test', 'build', 'docker-publish', 'npm-publish', 'webui-release',
      'desktop-release', 'desktop-manual-build'].map(name => `.github/workflows/${name}.yml`),
  ])('includes real packaging checks for %s', file => {
    expect(selectTestScope('push', {}, [file])).toEqual({ e2e: 'core', packaging: true })
  })

  it.each(['package-lock.json', 'scripts/ci-test-scope.mjs'])('expands both suites when shared test inputs change: %s', file => {
    expect(selectTestScope('pull_request', {}, [file])).toEqual({ e2e: 'full', packaging: true })
  })

  it('keeps nightly, manual full runs and missing change data comprehensive', () => {
    for (const [name, event, files] of [
      ['schedule', {}, ['README.md']], ['workflow_dispatch', { inputs: { suite: 'full' } }, undefined],
      ['pull_request', {}, undefined], ['push', {}, []],
    ]) expect(selectTestScope(name, event, files)).toEqual({ e2e: 'full', packaging: true })
    expect(selectTestScope('workflow_dispatch', { inputs: { suite: 'core' } })).toEqual({ e2e: 'core', packaging: false })
  })

  it('diffs the tested PR merge against its first parent and preserves renamed paths', () => {
    const git = vi.fn(args => args[0] === 'diff' ? 'packages/client/src/styles/old.scss\0styles/new.scss\0' : '')
    expect(changedFiles('pull_request', {}, git)).toEqual(['packages/client/src/styles/old.scss', 'styles/new.scss'])
    expect(git).toHaveBeenCalledWith(['diff', '--name-only', '--no-renames', '-z', 'HEAD^1', 'HEAD'])
  })

  it('fetches a push baseline outside shallow history and checks the entire pushed range', () => {
    const git = vi.fn(args => {
      if (args[0] === 'cat-file') throw new Error('missing history')
      return args[0] === 'diff' ? 'scripts/pack-tos-deb.mjs\0' : ''
    })
    expect(changedFiles('push', { before: 'old-commit' }, git)).toEqual(['scripts/pack-tos-deb.mjs'])
    expect(git).toHaveBeenCalledWith(['fetch', '--no-tags', '--depth=1', 'origin', 'old-commit'])
  })

  it('falls back to full validation when history cannot be compared', () => {
    const git = vi.fn(() => { throw new Error('unavailable') })
    expect(selectTestScope('push', {}, changedFiles('push', { before: 'old-commit' }, git)))
      .toEqual({ e2e: 'full', packaging: true })
  })
})
