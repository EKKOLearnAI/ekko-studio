import { expect, test } from '@playwright/test'
import { authenticate, mockChatSocket, mockHermesApi } from './fixtures'

for (const brightness of ['light', 'dark']) {
  for (const wallpaper of [false, true]) {
    test(`workflow run cards follow theme surfaces in ${brightness} mode with wallpaper ${wallpaper}`, async ({ page }) => {
      await authenticate(page)
      await mockChatSocket(page)
      const api = await mockHermesApi(page, {
        theme: {
          brightness, accentColor: '#bb7755',
          ...(wallpaper ? { background: { name: 'wallpaper.png', mime: 'image/png', updatedAt: 1 } } : {}),
        },
        workflows: [{ id: 'theme-flow', name: 'Theme workflow', profile: 'default', workspace: null,
          nodes: [], edges: [], viewport: null, created_at: 1, updated_at: 1 }],
        workflowRuns: ['completed', 'failed'].map((status, index) => ({
          id: `theme-run-${index}`, workflow_id: 'theme-flow', profile: 'default', workspace: null,
          start_node_ids: [], status, snapshot_nodes: [], snapshot_edges: [], compiled_loops: [],
          started_at: 1, finished_at: 2, created_at: 1, error: null,
          node_sessions: [], edge_evaluations: [], loop_epochs: [],
        })),
      })
      const path = '/#/hermes/workflow'
      await page.goto(path)
      const item = page.locator('.workflow-run-item').first()
      const panel = page.locator('.workflow-runs-panel')
      const presetBackground = brightness === 'dark' ? 'rgb(37, 37, 37)' : 'rgb(240, 240, 240)'
      const wallpaperTint = brightness === 'dark' ? 'rgba(224, 224, 224, 0.04)' : 'rgba(26, 26, 26, 0.04)'
      await expect(item).toHaveCSS('background-color', wallpaper ? wallpaperTint : presetBackground)
      if (wallpaper) await expect(panel).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')

      await page.goto('/#/hermes/theme')
      await page.getByTestId('theme-global-backgroundColor').fill('#223344')
      await page.getByTestId('theme-global-opacity').fill('0.4')
      await page.getByTestId('theme-global-opacity').dispatchEvent('change')
      await page.goto(path)
      await expect(item).toHaveCSS('background-color', 'rgba(34, 51, 68, 0.4)')
      await expect(panel).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')

      await page.goto('/#/hermes/theme')
      await page.getByTestId('theme-scope').selectOption('card')
      await page.getByTestId('theme-card-backgroundColor').fill('#336699')
      await page.getByTestId('theme-card-borderColor').fill('#6688aa')
      for (const [key, value] of [['opacity', '0.25'], ['blur', '12'], ['radius', '16'], ['shadow', '0']]) {
        await page.getByTestId(`theme-card-${key}`).fill(value)
        await page.getByTestId(`theme-card-${key}`).dispatchEvent('change')
      }
      await page.goto(path)
      await page.reload()
      await expect(item).toHaveCSS('background-color', 'rgba(51, 102, 153, 0.25)')
      await expect(item).toHaveCSS('backdrop-filter', 'blur(12px) saturate(1.1)')
      await expect(item).toHaveCSS('border-radius', '16px')
      await expect(item).toHaveCSS('border-top-color', 'rgba(102, 136, 170, 0.25)')
      await expect(item).toHaveCSS('box-shadow', 'none')
      await expect(item.locator('.workflow-run-status-dot')).toHaveCSS('background-color', 'rgb(22, 163, 74)')
      // Focus and scrollIntoView must not scroll the viewport around the page track.
      await panel.evaluate(element => { element.scrollLeft = 10 })
      expect(await panel.evaluate(element => element.scrollLeft)).toBe(0)
      await item.hover()
      await expect(item).toHaveCSS('border-top-color', 'rgba(187, 119, 85, 0.45)')
      await expect(item).toHaveCSS('background-image', /linear-gradient.*0\.06/)
      await expect(item).toHaveCSS('background-color', 'rgba(51, 102, 153, 0.25)')
      await item.click()
      await expect(page.getByTestId('workflow-evidence-overview')).toBeVisible()
      await expect(page.locator('.workflow-evidence')).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')
      const details = page.getByTestId('workflow-run-details-page')
      await expect.poll(async () => Math.round((await details.boundingBox())!.x - (await panel.boundingBox())!.x)).toBe(1)
      await page.getByTestId('workflow-run-back').click()
      await expect(page.getByTestId('workflow-runs-pages')).toHaveCSS('transform', 'matrix(1, 0, 0, 1, 0, 0)')
      await expect(item).toHaveAttribute('aria-current', 'true')
      await expect(item).toHaveCSS('border-top-color', 'rgb(187, 119, 85)')
      await expect(item).toHaveCSS('background-image', /linear-gradient.*0\.12/)
      await expect(item).toHaveCSS('background-color', 'rgba(51, 102, 153, 0.25)')
      await expect.poll(async () => Math.round((await item.boundingBox())!.x - (await panel.boundingBox())!.x)).toBe(11)
      await page.screenshot({ path: `/tmp/studio-workflow-runs-${brightness}-${wallpaper}.png` })

      await page.goto('/#/hermes/theme')
      await page.getByTestId('theme-scope').selectOption('card')
      await page.getByRole('button', { name: 'Reset Background opacity', exact: true }).click()
      await page.goto(path)
      await expect(item).toHaveCSS('background-color', 'rgba(51, 102, 153, 0.4)')
      await page.goto('/#/hermes/theme')
      await page.getByRole('button', { name: 'Restore defaults', exact: true }).click()
      await page.goto(path)
      await expect(item).toHaveCSS('background-color', wallpaper ? wallpaperTint : presetBackground)

      await page.setViewportSize({ width: 390, height: 844 })
      await page.getByRole('button', { name: 'Show run records', exact: true }).click()
      const drawerBackground = wallpaper
        ? `rgba(${brightness === 'dark' ? '26, 26, 26' : '255, 255, 255'}, 0.72)`
        : brightness === 'dark' ? 'rgb(42, 42, 42)' : 'rgb(255, 255, 255)'
      await expect(panel).toHaveCSS('background-color', drawerBackground)
      await expect(panel).toHaveCSS('backdrop-filter', wallpaper ? 'blur(8px) saturate(1.1)' : 'none')
      await item.click()
      await expect(page.locator('.workflow-evidence')).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')

      await page.goto('/#/hermes/theme')
      await page.getByTestId('theme-scope').selectOption('overlay')
      await page.getByTestId('theme-overlay-backgroundColor').fill('#335577')
      await page.getByTestId('theme-overlay-opacity').fill('0.85')
      await page.getByTestId('theme-overlay-opacity').dispatchEvent('change')
      await page.getByTestId('theme-overlay-blur').fill('12')
      await page.getByTestId('theme-overlay-blur').dispatchEvent('change')
      await page.goto(path)
      await expect(page.getByRole('button', { name: /^(Show|Hide) run records$/ })).toBeVisible()
      if (!await panel.isVisible()) await page.getByRole('button', { name: 'Show run records', exact: true }).click()
      await expect(panel).toHaveCSS('background-color', 'rgba(51, 85, 119, 0.85)')
      await expect(panel).toHaveCSS('backdrop-filter', 'blur(12px) saturate(1.1)')
      await item.click()
      await expect(page.locator('.workflow-evidence')).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')
      await expect.poll(async () => Math.round((await details.boundingBox())!.width - await panel.evaluate(element => element.clientWidth))).toBe(0)

      await page.setViewportSize({ width: 1280, height: 844 })
      await expect(panel).toHaveCSS('background-color', wallpaper ? 'rgba(0, 0, 0, 0)' : brightness === 'dark' ? 'rgb(42, 42, 42)' : 'rgb(255, 255, 255)')
      await expect(panel).toHaveCSS('backdrop-filter', 'none')
      expect(api.unexpectedRequests).toEqual([])
    })
  }
}
