import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

// Keep both desktop rail and the compact sidebar on the same device metaphor.
const path = 'M3 4h14a1 1 0 0 1 1 1v4M3 4a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h9M7 16v4M5 20h7M15 9h6a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1h-6a1 1 0 0 1-1-1V10a1 1 0 0 1 1-1M17 18h2'
describe('Device connections icon', () => {
  it('uses the same monitor + phone outline in both navigation surfaces', () => {
    for (const file of ['StudioNavigationRail.vue', 'PageSidebarNav.vue']) {
      const source = readFileSync(`packages/client/src/components/layout/${file}`, 'utf8')
      expect(source).toContain(path)

    }
  })
  it('keeps the workflow branch icon distinct', () => {
    const source = readFileSync('packages/client/src/components/layout/StudioNavigationRail.vue', 'utf8')
    const workflow = source.split("key: 'workflow'")[1].split('\n')[0]
    const connections = source.split("key: 'connections'")[1].split('\n')[0]
    expect(workflow).not.toContain(path)
    expect(connections).toContain(path)
  })
})
