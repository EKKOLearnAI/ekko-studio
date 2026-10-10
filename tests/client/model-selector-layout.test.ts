import { readFileSync } from 'fs'
import { describe, expect, it } from 'vitest'

function findClosingDiv(source: string, start: number): number {
  const divTag = /<\/?div\b[^>]*>/g
  divTag.lastIndex = start

  let depth = 0
  for (let match = divTag.exec(source); match; match = divTag.exec(source)) {
    depth += match[0].startsWith('</') ? -1 : 1
    if (depth === 0) return divTag.lastIndex
  }

  return -1
}

describe('ModelCascader layout', () => {
  it('keeps the custom model controls below the scrollable model list', () => {
    const source = readFileSync('packages/client/src/components/hermes/models/ModelCascader.vue', 'utf8')
    const modalStart = source.indexOf('<NPopover')
    const modalEnd = source.indexOf('</NPopover>', modalStart)
    const modal = source.slice(modalStart, modalEnd)
    const modelListStart = modal.indexOf('<div class="model-cascader-columns"')
    const modelListEnd = findClosingDiv(modal, modelListStart)
    const customFooter = modal.indexOf('class="model-cascader-custom"')

    expect(modelListStart).toBeGreaterThanOrEqual(0)
    expect(modelListEnd).toBeGreaterThan(modelListStart)
    expect(customFooter).toBeGreaterThan(modelListEnd)
    expect(modal.slice(modelListStart, modelListEnd)).not.toContain('class="model-cascader-custom"')
  })
})
