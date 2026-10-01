import { expect, test } from '@playwright/test'
import { authenticate, mockHermesApi } from './fixtures'

for (const width of [1440, 390]) {
  test(`uses the shared profile menu and batch icons for workflows at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 })
    await authenticate(page, undefined, 'research')
    const workflows = ['research', 'default'].map(profile => ({
      id: `wf-${profile}`, name: `${profile} workflow`, profile, workspace: null,
      nodes: [], edges: [], viewport: { x: 80, y: 80, zoom: .75 }, created_at: 1, updated_at: 1,
    }))
    await mockHermesApi(page, { workflows })
    const deletedIds: string[][] = []
    await page.route('**/api/studio/workflows/batch-delete', route => {
      const ids = route.request().postDataJSON().ids as string[]
      deletedIds.push(ids)
      return route.fulfill({ json: { deleted: ids.length, failed: 0, errors: [] } })
    })
    await page.goto('/#/hermes/workflow')
    if (width < 769) await page.getByRole('button', { name: 'Menu', exact: true }).click()
    const sidebar = page.locator('.workflow-sidebar')
    await expect(sidebar).toBeVisible()
    if (width < 769) {
      const content = page.locator('.studio-mobile-navigation__content')
      expect((await sidebar.boundingBox())!.width).toBeCloseTo((await content.boundingBox())!.width, 2)
    } else {
      await expect(sidebar).toHaveCSS('width', '240px')
    }
    const more = sidebar.getByRole('button', { name: 'Workflow list actions', exact: true })
    await expect(sidebar.locator('.workflow-list-item')).toHaveCount(2)
    await expect(sidebar.locator('.workflow-list-toolbar')).toHaveCount(0)
    await expect(sidebar.locator('.page-sidebar-top')).toHaveCSS('border-bottom-width', '0px')
    expect((await more.boundingBox())!.y).toBe((await sidebar.getByRole('button', { name: 'Search', exact: true }).boundingBox())!.y)
    await more.click()
    await page.getByText('Filter by Profile', { exact: true }).click()
    await page.locator('.n-dropdown-option-body').filter({ hasText: /^research$/ }).click()
    await expect(sidebar.locator('.workflow-profile-indicator')).toHaveCount(0)
    await expect(sidebar.locator('.workflow-list-item')).toHaveCount(1)
    await expect(sidebar.locator('.workflow-list-item')).toContainText('research workflow')

    await more.click()
    await page.getByText('Batch selection', { exact: true }).click()
    const toolbar = sidebar.locator('.workflow-list-toolbar')
    await toolbar.getByRole('button', { name: 'Select all', exact: true }).click()
    await expect(toolbar).toContainText('1 selected')
    await expect(toolbar.getByRole('button', { name: 'Cancel', exact: true })).toHaveText('')
    await sidebar.locator('.page-sidebar-top').hover({ position: { x: 2, y: 2 } })
    expect(await toolbar.getByRole('button', { name: 'Delete', exact: true }).evaluate(element => getComputedStyle(element).color))
      .toBe(await toolbar.getByRole('button', { name: 'Select all', exact: true }).evaluate(element => getComputedStyle(element).color))
    await page.screenshot({ animations: 'disabled', path: `/tmp/studio-workflow-batch-${width}.png` })
    await toolbar.getByRole('button', { name: 'Delete', exact: true }).click()
    await expect(page.getByText('Delete 1 selected workflows?', { exact: true })).toBeVisible()
    await page.locator('.n-popconfirm').getByRole('button', { name: 'Cancel', exact: true }).click()
    expect(deletedIds).toEqual([])
    await toolbar.getByRole('button', { name: 'Cancel', exact: true }).click()
    await expect(toolbar).toHaveCount(0)
    await expect(sidebar.locator('.workflow-select-indicator')).toHaveCount(0)

    await more.click()
    await page.getByText('Batch selection', { exact: true }).click()
    await toolbar.getByRole('button', { name: 'Select all', exact: true }).click()
    await toolbar.getByRole('button', { name: 'Delete', exact: true }).click()
    await page.locator('.n-popconfirm').getByRole('button', { name: 'Confirm', exact: true }).click()
    await expect(toolbar).toHaveCount(0)
    expect(deletedIds).toEqual([['wf-research']])
    await more.click()
    await page.getByText('Filter by Profile', { exact: true }).click()
    await expect(page.locator('.n-dropdown-option-body').filter({ hasText: 'research' })).toContainText('✓')
    await page.locator('.n-dropdown-option-body').filter({ hasText: 'All profiles' }).click()
    await expect(sidebar.locator('.workflow-list-item')).toHaveCount(1)
    await expect(sidebar.locator('.workflow-list-item')).toContainText('default workflow')
    await expect(sidebar.locator('.workflow-profile-indicator')).toHaveCount(0)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    if (width < 769) {
      await page.locator('.studio-mobile-navigation__close').click()
      await expect(sidebar).toBeHidden()
      await expect(page.getByRole('button', { name: 'Menu', exact: true })).toHaveAttribute('aria-expanded', 'false')
    }
  })
}
