import type { Page } from '@playwright/test'
import { defaultNavigationSettings } from '../../../packages/shared/navigation-settings'

/** Existing plugin journeys start with explicitly saved shortcuts. */
export async function mockSavedNavigation(page: Page, pluginEntries: string[]) {
  let items = [...defaultNavigationSettings().items, ...pluginEntries]
  await page.route(url => url.pathname === '/api/navigation', route => {
    if (route.request().method() === 'PUT') items = route.request().postDataJSON().items
    return route.fulfill({ json: { items } })
  })
}
