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

describe('ModelSelector layout', () => {
  it('keeps the custom provider controls below the scrollable model list', () => {
    const source = readFileSync('packages/client/src/components/layout/ModelSelector.vue', 'utf8')
    const modalStart = source.indexOf('<NModal')
    const modalEnd = source.indexOf('</NModal>', modalStart)
    const modal = source.slice(modalStart, modalEnd)
    const modelListStart = modal.indexOf('<div class="model-list">')
    const modelListEnd = findClosingDiv(modal, modelListStart)
    const customFooter = modal.indexOf('<div class="model-custom">')

    expect(modelListStart).toBeGreaterThanOrEqual(0)
    expect(modelListEnd).toBeGreaterThan(modelListStart)
    expect(customFooter).toBeGreaterThan(modelListEnd)
    expect(modal.slice(modelListStart, modelListEnd)).not.toContain('class="model-custom"')
  })
})

describe('ModelSelector OrcaRouter catalog', () => {
  it('replaces the group models with the capability-filtered chat list', () => {
    const source = readFileSync('packages/client/src/components/layout/ModelSelector.vue', 'utf8')
    const computedStart = source.indexOf('const modelGroupsWithCustom = computed(')
    const computedEnd = source.indexOf('function isOrcaRouterGroup')
    const body = source.slice(computedStart, computedEnd)

    expect(computedStart).toBeGreaterThanOrEqual(0)
    // OrcaRouter groups take the server capability list; every other provider
    // keeps the existing merge with locally added models.
    expect(body).toContain("modelsForCapability(g as CapabilityCatalogGroup, 'chat')")
    expect(body).toContain('appStore.customModels[g.provider]')
  })

  it('surfaces the degraded catalog notice above the scrollable list', () => {
    const source = readFileSync('packages/client/src/components/layout/ModelSelector.vue', 'utf8')
    const modalStart = source.indexOf('<NModal')
    const modal = source.slice(modalStart, source.indexOf('</NModal>', modalStart))
    const degraded = modal.indexOf('data-testid="orca-router-catalog-degraded"')
    const modelList = modal.indexOf('<div class="model-list">')
    const customFooter = modal.indexOf('<div class="model-custom">')

    expect(degraded).toBeGreaterThanOrEqual(0)
    expect(degraded).toBeLessThan(modelList)
    expect(modelList).toBeLessThan(customFooter)
  })
})
