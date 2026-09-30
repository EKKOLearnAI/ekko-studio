import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { readDesktopUpdateSource, resolveDesktopUpdateSource, validateTestUpdateUrl } from '../../packages/desktop/src/main/updater-source'

describe('packaged desktop update source', () => {
  it('preserves production primary and fallback feeds for normal packages', () => {
    expect(resolveDesktopUpdateSource({ name: 'hermes-studio', version: '1.0.0' })).toEqual({
      channel: 'stable', url: 'https://download.ekkolearnai.com/latest',
      fallbackUrl: 'https://github.com/EKKOLearnAI/ekko-studio/releases/latest/download',
    })
  })

  it('normalizes a test directory and provides no production fallback', () => {
    expect(resolveDesktopUpdateSource({ desktopUpdate: { channel: 'test', url: 'https://updates.example.com/mac-arm64' } })).toEqual({
      channel: 'test', url: 'https://updates.example.com/mac-arm64/',
    })
    expect(validateTestUpdateUrl('https://download.ekkolearnai.com/update-test/mac/')).toBe('https://download.ekkolearnai.com/update-test/mac/')
  })

  it.each([null, [], 'test', {}, { channel: 'stable' }, { channel: 'test' }, { channel: 'test', url: '' }])(
    'rejects malformed test metadata instead of selecting production: %j', config => {
      expect(() => resolveDesktopUpdateSource({ desktopUpdate: config })).toThrow()
    },
  )

  it.each([
    '', 'not a URL', 'http://localhost:8080/test/', 'file:///tmp/test/',
    'https://user:pass@updates.example.com/', 'https://updates.example.com/?token=secret',
    'https://updates.example.com/#test', 'https://updates.example.com/latest-mac.yml',
    'https://updates.example.com/latest.yml/', 'https://updates.example.com/\nlatest/',
    'https://download.ekkolearnai.com/', 'https://download.ekkolearnai.com/latest/',
    'https://download.ekkolearnai.com/latest/mac/',
    'https://github.com/EKKOLearnAI/ekko-studio/releases/latest/download',
    'https://github.com/EKKOLearnAI/ekko-studio/releases/download/v1.2.3/',
  ])('rejects unsafe, production or non-directory test feeds: %s', url => {
    expect(() => validateTestUpdateUrl(url)).toThrow()
  })

  it('reads the installed package and fails closed on missing or damaged metadata', () => {
    const directory = mkdtempSync(join(tmpdir(), 'ekko-update-source-'))
    try {
      expect(() => readDesktopUpdateSource(directory)).toThrow()
      writeFileSync(join(directory, 'package.json'), '{broken')
      expect(() => readDesktopUpdateSource(directory)).toThrow()
      writeFileSync(join(directory, 'package.json'), JSON.stringify({ desktopUpdate: { channel: 'test', url: 'https://updates.example.com/win/' } }))
      expect(readDesktopUpdateSource(directory)).toEqual({ channel: 'test', url: 'https://updates.example.com/win/' })
    } finally { rmSync(directory, { recursive: true, force: true }) }
  })
})
