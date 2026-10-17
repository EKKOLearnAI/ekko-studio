import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
// @ts-expect-error Harness scripts are plain Node modules.
import { uiThemeFindings, checkUiThemeBaseline, checkUiTheme } from '../../scripts/ui-theme-harness.mjs'

const file = 'packages/client/src/components/Example.vue'
const scan = (source: string) => uiThemeFindings(file, source)
const codes = (source: string): string[] => scan(source).map((finding: any) => finding.rule)
const vue = (style: string, template = '<div class="card" />') => `<template>${template}</template><style scoped lang="scss">${style}</style>`
const card = '<div class="card" data-theme-surface="card" />'
const baselineFor = (findings: any[]) => {
  const files: Record<string, Record<string, number>> = {}
  for (const { file, key } of findings) {
    files[file] ||= {}
    files[file][key] = (files[file][key] || 0) + 1
  }
  return { version: 1, files }
}

describe('frontend UI theme harness', () => {
  it('accepts registered cards/inputs, theme fallbacks and semantic state tints', () => {
    expect(scan(vue(`
      @use '@/styles/variables' as *;
      .card { background: $bg-card; border: 1px solid $border-light; color: $text-primary; }
      .other { background: var(--theme-card-bg, var(--theme-card-wallpaper-bg, #fff)); }
      .state { background: rgba(var(--accent-primary-rgb), 0.12); }
      .card { &:hover { background: $bg-card-hover; } &:disabled { opacity: 0.5; } }
    `, card))).toEqual([])
  })

  it.each(['#fff', '#000000', 'white', 'rgb(255 255 255 / .5)', 'hsl(0, 0%, 100%)', 'linear-gradient(#fff, #000)'])(
    'rejects an independent fill: %s', value => {
      expect(codes(vue(`.card { background: ${value}; }`))).toEqual(['literal-color', 'unowned-background'])
    },
  )

  it.each(['$bg-card', 'var(--bg-secondary)', 'rgba(var(--bg-card-rgb), 0.7)'])(
    'rejects a preset fill without ownership: %s', value => {
      expect(codes(vue(`.card { background: ${value}; }`))).toEqual(['unowned-background'])
    },
  )

  it('checks inline styles, conditional style objects and script render styles', () => {
    const source = `<template>
      <div style="background: white" />
      <div :style="{ backgroundColor: active ? '#fff' : '#000' }" />
    </template><script setup lang="ts">
      const props = { style: { backgroundColor: 'rgb(255, 255, 255)' } }
      const html = '<div style="background: white" />'
      // const ignored = { backgroundColor: '#fff' }
    </script>`
    expect(codes(source).filter(code => code === 'literal-color')).toHaveLength(4)
  })

  it('does not let inline backgrounds override a registered surface', () => {
    expect(codes(vue('', '<div data-theme-surface="card" :style="{ backgroundColor: \'var(--bg-card)\' }" />'))).toContain('inline-surface-fill')
  })

  it('rejects text/border/shadow literals and local color aliases', () => {
    expect(codes(vue('.card { color: #fff; border: 1px solid black; box-shadow: 0 0 2px rgba(0,0,0,.5); --local-bg: white; }'))).toEqual(Array(4).fill('literal-color'))
  })

  it('rejects local Naive fills even if they reference a token', () => {
    expect(codes(vue('.n-tag { --n-color: var(--bg-card); --n-td-color-hover: transparent; }'))).toEqual(['local-naive-fill', 'local-naive-fill'])
  })

  it('rejects surface opacity in SCSS nesting and inline objects', () => {
    expect(codes(vue('.card { & { opacity: .2; } }', card))).toEqual(['surface-opacity'])
    expect(codes(vue('', '<div data-theme-surface="card" :style="{ opacity: 0.2 }" />'))).toContain('surface-opacity')
    expect(codes(vue('.card .child { background: $bg-card; }', card))).toEqual(['unowned-background'])
  })

  it('requires all instances of a styled class to be registered', () => {
    expect(codes(vue('.card { background: $bg-card; }', `${card}<div class="card" />`))).toEqual(['unowned-background'])
  })

  it.each(['data-theme-surface="cards"', ':data-theme-surface="region"'])(
    'rejects unsupported surface attributes: %s', attr => {
      expect(codes(vue('', `<div ${attr} />`))).toContain('invalid-region')
    },
  )

  it('ignores comments and URLs while checking nested SCSS and multiple style blocks', () => {
    expect(codes(vue(`// background: #fff;
      /* .bad { color: black; } */
      .art { background: url("/white.png#ffffff"); }
      @media (max-width: 600px) { .card { & > .nested { background: white; } } }
    `) + '<style>.other { color: #000; }</style>')).toEqual(['literal-color', 'unowned-background', 'literal-color'])
  })

  it('limits a reasoned exception to one declaration', () => {
    expect(codes(vue(`.qr {
      /* theme-exception: qr -- Opaque quiet zone required for scanning. */
      background: white;
      color: #fff;
    }`))).toEqual(['literal-color'])
    expect(codes(`<script setup lang="ts">const style = {
      // theme-exception: artwork -- Preserve the authored illustration colors.
      color: '#fff',
    }</script>`)).toEqual([])
  })

  it.each([
    '.x { /* theme-exception: qr -- */ background: white; }',
    '/* theme-exception: qr -- Opaque quiet zone required for scanning. */ .x { background: white; }',
    '.x { /* theme-exception: qr -- Opaque quiet zone required for scanning. */ background: transparent; }',
  ])('rejects blank, broad or unused exceptions', style => {
    expect(codes(vue(style))).toContain('invalid-exception')
  })

  it('fails closed on syntax errors', () => {
    expect(codes(vue('.card { background:'))).toContain('parse-error')
  })

  it('ratchets exact findings by path, declaration and count', () => {
    const old = scan(vue('.card { background: white; }'))
    const baseline = baselineFor(old)
    expect(checkUiThemeBaseline(old, baseline)).toEqual([])
    expect(checkUiThemeBaseline([...old, ...old], baseline)).toHaveLength(2)
    expect(checkUiThemeBaseline(old.map((finding: any) => ({ ...finding, file: 'packages/client/src/New.vue' })), baseline)).toHaveLength(4)
    expect(checkUiThemeBaseline(scan(vue('.card { background: black; }')), baseline)).toHaveLength(4)
    expect(checkUiThemeBaseline([], baseline).join('\n')).toContain('stale')
    expect(checkUiThemeBaseline(old, baseline)).toEqual([]) // input was not mutated
    expect(checkUiThemeBaseline(old, { version: 0 })).toEqual(['UI theme baseline has an invalid schema'])
  })

  it('does not allow baseline exemptions for invalid regions or opacity', () => {
    const findings = scan(vue('.card { opacity: .3; }', card))
    expect(checkUiThemeBaseline(findings, baselineFor(findings)).join('\n')).toContain('Invalid UI theme baseline entry')
  })

  it('discovers new nested files and untracked styles without relying on Git', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ui-theme-harness-'))
    const write = async (file: string, source: string) => {
      await mkdir(dirname(join(root, file)), { recursive: true })
      await writeFile(join(root, file), source)
    }
    try {
      await write('scripts/ui-theme-baseline.json', JSON.stringify({ version: 1, files: {} }))
      await write(file, vue('.card { background: $bg-card; }', card))
      expect(await checkUiTheme(root)).toEqual([])
      await write('packages/client/src/new/nested/unsafe.scss', '.panel { background: white; }')
      expect((await checkUiTheme(root)).join('\n')).toContain('unsafe.scss:1: [ui-theme/unowned-background]')
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  it('accepts the current client tree with its reviewed legacy inventory', async () => {
    expect(await checkUiTheme(resolve(import.meta.dirname, '../..'))).toEqual([])
  }, 30_000) // Full-tree parsing under coverage competes with other CI workers.
})
