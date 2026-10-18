import { readPresetStyleSource as readFileSync } from './preset-style-source'
import { describe, expect, it } from 'vitest'

describe('FileToolbar icon actions', () => {
  it('renders file actions as labelled icon-only buttons', () => {
    const source = readFileSync('packages/client/src/components/hermes/files/FileToolbar.vue', 'utf8')

    expect(source).toContain('NTooltip')
    expect(source).toContain(':aria-label="t(\'files.newFile\')"')
    expect(source).toContain(':aria-label="t(\'files.newFolder\')"')
    expect(source).toContain(':aria-label="t(\'files.upload\')"')
    expect(source).toContain(':aria-label="t(\'files.refresh\')"')
    expect(source.match(/\bcircle\b/g)?.length).toBe(4)
    expect(source).not.toContain("{{ t('files.newFile') }}\n      </NButton>")
    expect(source).not.toContain("{{ t('files.newFolder') }}\n      </NButton>")
    expect(source).not.toContain("{{ t('files.refresh') }}\n      </NButton>")
  })

  it('keeps the drawer main toolbar compact without nested toolbar padding', () => {
    const source = readFileSync('packages/client/src/components/hermes/chat/FilesPanel.vue', 'utf8')

    expect(source).toMatch(/\.main-toolbar\s*\{[\s\S]*padding: 5px 10px;/)
    expect(source).toMatch(/:deep\(\.file-toolbar\)\s*\{\s*padding: 0;/)
  })
})
