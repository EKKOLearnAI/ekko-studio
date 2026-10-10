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
  it('keeps custom controls inside the right column and below its scrollable model list', () => {
    const source = readFileSync('packages/client/src/components/hermes/models/ModelCascader.vue', 'utf8')
    const modalStart = source.indexOf('<NModal')
    const modalEnd = source.indexOf('</NModal>', modalStart)
    const modal = source.slice(modalStart, modalEnd)
    const rightColumnStart = modal.indexOf('<div class="model-cascader-model-pane"')
    const rightColumnEnd = findClosingDiv(modal, rightColumnStart)
    const rightColumn = modal.slice(rightColumnStart, rightColumnEnd)
    const modelListStart = rightColumn.indexOf('<div :id="menuId"')
    const modelListEnd = findClosingDiv(rightColumn, modelListStart)
    const customFooter = rightColumn.indexOf('class="model-cascader-custom"')

    expect(rightColumnStart).toBeGreaterThanOrEqual(0)
    expect(rightColumnEnd).toBeGreaterThan(rightColumnStart)
    expect(modelListStart).toBeGreaterThanOrEqual(0)
    expect(modelListEnd).toBeGreaterThan(modelListStart)
    expect(customFooter).toBeGreaterThan(modelListEnd)
    expect(rightColumn.slice(modelListStart, modelListEnd)).not.toContain('class="model-cascader-custom"')
  })
})
