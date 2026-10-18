import { expect, test, type Page } from '@playwright/test'
import { screenshotOverlayHtml } from '../../packages/desktop/src/main/screenshot-overlay'
import { authenticate, mockChatSocket, mockHermesApi, TEST_ACCESS_KEY } from './fixtures'

async function openOverlay(page: Page) {
  await page.setViewportSize({ width: 1000, height: 700 })
  const dataUrl = await page.evaluate(() => {
    const canvas = document.createElement('canvas')
    canvas.width = 1000
    canvas.height = 700
    const context = canvas.getContext('2d')!
    context.fillStyle = '#edf2f7'
    context.fillRect(0, 0, 1000, 700)
    context.fillStyle = '#247bca'
    context.fillRect(100, 100, 500, 350)
    context.fillStyle = '#fff'
    context.font = '28px sans-serif'
    context.fillText('Ekko Studio screenshot', 130, 160)
    const state = { submitted: [] as unknown[], cancelled: 0, selected: 0 }
    const target = window as any
    target.__SCREENSHOT__ = state
    target.screenshotOverlay = {
      submit: (rect: unknown) => state.submitted.push(rect),
      cancel: () => state.cancelled++,
      select: () => state.selected++,
      onReset: (callback: () => void) => { target.__RESET_SCREENSHOT__ = callback },
      onInit: (callback: (payload: unknown) => void) => { target.__INIT_SCREENSHOT__ = callback },
      onClear: (callback: () => void) => { target.__CLEAR_SCREENSHOT__ = callback },
    }
    return canvas.toDataURL('image/png')
  })
  await page.setContent(screenshotOverlayHtml(dataUrl, {
    hint: '拖动框选区域，Enter 确认，Esc 或右键取消。',
    confirm: '完成', cancel: '取消', reset: '重新框选',
    tools: { select: '选择 / 移动', rectangle: '矩形', ellipse: '圆形', arrow: '箭头', pen: '画笔', text: '文字', mosaic: '马赛克', undo: '撤销', redo: '重做', color: '颜色', lineWidth: '线条粗细', textPlaceholder: '输入文字' },
  }))
  await page.waitForFunction(() => (document.getElementById('annotations') as HTMLCanvasElement).width === 1000)
}

async function drag(page: Page, start: [number, number], end: [number, number]) {
  await page.mouse.move(...start)
  await page.mouse.down()
  await page.mouse.move(...end, { steps: 6 })
  await page.mouse.up()
}

async function annotationPixel(page: Page, x: number, y: number) {
  return page.evaluate(({ x, y }) => Array.from((document.getElementById('annotations') as HTMLCanvasElement).getContext('2d')!.getImageData(x, y, 1, 1).data), { x, y })
}

test('toolbar draws colored shapes and supports undo and redo', async ({ page }) => {
  await openOverlay(page)
  await drag(page, [100, 100], [600, 420])
  for (const label of ['矩形', '圆形', '箭头', '画笔', '文字', '马赛克', '撤销', '重做']) await expect(page.getByRole('button', { name: label, exact: true })).toBeVisible()
  await page.locator('#rectangle').click()
  await page.locator('[data-color="#30d158"]').click()
  await page.locator('#line-width').selectOption('8')
  await drag(page, [150, 180], [420, 340])
  await expect.poll(() => annotationPixel(page, 150, 260)).toEqual([48, 209, 88, 255])
  await page.locator('#undo').click()
  await expect.poll(() => annotationPixel(page, 150, 260)).toEqual([0, 0, 0, 0])
  await page.locator('#redo').click()
  await expect.poll(() => annotationPixel(page, 150, 260)).toEqual([48, 209, 88, 255])
  await page.keyboard.press('Control+z')
  await expect.poll(() => annotationPixel(page, 150, 260)).toEqual([0, 0, 0, 0])
  await page.keyboard.press('Control+Shift+z')
  await expect.poll(() => annotationPixel(page, 150, 260)).toEqual([48, 209, 88, 255])
})

test('exported PNG includes arrows, pen strokes, and text at crop coordinates', async ({ page }) => {
  await openOverlay(page)
  await drag(page, [100, 100], [600, 420])
  await page.locator('#arrow').click()
  await drag(page, [150, 240], [450, 240])
  await page.locator('#pen').click()
  await drag(page, [160, 300], [450, 300])
  await page.locator('#text').click()
  await page.mouse.click(200, 180)
  await page.locator('#text-editor').fill('Hello 截图')
  await page.locator('#text-editor').press('Enter')
  await expect(page.locator('#text-editor')).toBeHidden()
  await page.locator('#confirm').click()
  await expect.poll(() => page.evaluate(() => (window as any).__SCREENSHOT__.submitted.length)).toBe(1)
  const result = await page.evaluate(async () => {
    const payload = (window as any).__SCREENSHOT__.submitted[0]
    const bitmap = await createImageBitmap(new Blob([payload.png], { type: 'image/png' }))
    const canvas = document.createElement('canvas')
    canvas.width = bitmap.width
    canvas.height = bitmap.height
    const context = canvas.getContext('2d')!
    context.drawImage(bitmap, 0, 0)
    const arrow = Array.from(context.getImageData(200, 140, 1, 1).data)
    const pen = Array.from(context.getImageData(200, 200, 1, 1).data)
    const text = context.getImageData(100, 80, 180, 40).data
    let textPixels = 0
    for (let i = 0; i < text.length; i += 4) if (text[i] > 200 && text[i + 1] < 100) textPixels++
    return { width: bitmap.width, height: bitmap.height, arrow, pen, textPixels }
  })
  expect(result).toMatchObject({ width: 500, height: 320, arrow: [255, 69, 58, 255], pen: [255, 69, 58, 255] })
  expect(result.textPixels).toBeGreaterThan(20)
})

test('mosaic changes screenshot pixels and survives PNG export', async ({ page }) => {
  await openOverlay(page)
  await drag(page, [100, 100], [600, 420])
  await page.locator('#mosaic').click()
  await drag(page, [120, 130], [500, 175])
  await page.locator('#confirm').click()
  await expect.poll(() => page.evaluate(() => (window as any).__SCREENSHOT__.submitted.length)).toBe(1)
  const changed = await page.evaluate(async () => {
    const result = (window as any).__SCREENSHOT__.submitted[0]
    const edited = await createImageBitmap(new Blob([result.png], { type: 'image/png' }))
    const before = document.createElement('canvas'), after = document.createElement('canvas')
    before.width = after.width = 500
    before.height = after.height = 320
    before.getContext('2d')!.drawImage(document.getElementById('screen') as HTMLImageElement, 100, 100, 500, 320, 0, 0, 500, 320)
    after.getContext('2d')!.drawImage(edited, 0, 0)
    const original = before.getContext('2d')!.getImageData(20, 30, 380, 45).data
    const mosaic = after.getContext('2d')!.getImageData(20, 30, 380, 45).data
    let count = 0
    for (let i = 0; i < original.length; i += 4) if (original[i] !== mosaic[i] || original[i + 1] !== mosaic[i + 1]) count++
    return count
  })
  expect(changed).toBeGreaterThan(100)
})

test('native bitmap input preserves Retina pixels and clears the cached editor between captures', async ({ page }) => {
  await openOverlay(page)
  await page.evaluate(() => {
    const native = document.createElement('canvas')
    native.width = 2000
    native.height = 1400
    const context = native.getContext('2d')!
    context.drawImage(document.getElementById('screen') as HTMLCanvasElement, 0, 0, 2000, 1400)
    ;(window as any).__INIT_SCREENSHOT__({ requestId: 'retina', bitmap: { width: 2000, height: 1400, data: context.getImageData(0, 0, 2000, 1400).data }, labels: { hint: '框选', confirm: '完成', reset: '重选', cancel: '取消' } })
  })
  await page.waitForFunction(() => (document.getElementById('annotations') as HTMLCanvasElement).width === 2000)
  await drag(page, [100, 100], [600, 420])
  await page.locator('#ellipse').click()
  await drag(page, [150, 200], [450, 360])
  await expect.poll(() => annotationPixel(page, 300, 560)).toEqual([255, 69, 58, 255])
  await page.locator('#confirm').click()
  await expect.poll(() => page.evaluate(() => (window as any).__SCREENSHOT__.submitted.length)).toBe(1)
  const result = await page.evaluate(async () => {
    const payload = (window as any).__SCREENSHOT__.submitted[0]
    const bitmap = await createImageBitmap(new Blob([payload.png], { type: 'image/png' }))
    const output = document.createElement('canvas')
    output.width = bitmap.width
    output.height = bitmap.height
    const context = output.getContext('2d')!
    context.drawImage(bitmap, 0, 0)
    return { requestId: payload.requestId, width: bitmap.width, height: bitmap.height, shape: Array.from(context.getImageData(100, 360, 1, 1).data), source: Array.from(context.getImageData(800, 500, 1, 1).data) }
  })
  expect(result).toEqual({ requestId: 'retina', width: 1000, height: 640, shape: [255, 69, 58, 255], source: [36, 123, 202, 255] })
  await page.evaluate(() => (window as any).__CLEAR_SCREENSHOT__())
  await expect(page.locator('#selection')).toBeHidden()
  await expect(page.locator('#toolbar')).toBeHidden()
  expect(await page.locator('#screen').evaluate((node: HTMLCanvasElement) => node.width)).toBe(1)
})

test('desktop overlay supports selection, moving, resizing, and direct confirmation', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  await openOverlay(page)
  await drag(page, [100, 120], [450, 360])
  await expect(page.locator('#size')).toHaveText('350 × 240')
  await expect(page.locator('#toolbar')).toBeVisible()
  await expect(page.locator('#confirm')).toHaveAttribute('aria-label', '完成')
  await expect(page.locator('#confirm')).toHaveText('')
  await drag(page, [200, 200], [240, 250])
  await drag(page, [490, 410], [530, 450])
  await expect(page.locator('#size')).toHaveText('390 × 280')
  await page.locator('#confirm').click()
  await expect.poll(() => page.evaluate(() => (window as any).__SCREENSHOT__.submitted.map((value: any) => value.region))).toEqual([{ x: 140, y: 170, width: 390, height: 280 }])
  expect(errors).toEqual([])
})

test('desktop overlay supports reverse selection, Enter, reset, and Esc', async ({ page }) => {
  await openOverlay(page)
  await drag(page, [600, 500], [150, 100])
  await page.keyboard.press('Enter')
  await expect.poll(() => page.evaluate(() => (window as any).__SCREENSHOT__.submitted.map((value: any) => value.region))).toEqual([{ x: 150, y: 100, width: 450, height: 400 }])
  await page.locator('#reset').click()
  await expect(page.locator('#selection')).toBeHidden()
  await page.keyboard.press('Escape')
  expect(await page.evaluate(() => (window as any).__SCREENSHOT__.cancelled)).toBe(1)
})

test('desktop overlay keeps controls on screen and cancels on right-click', async ({ page }) => {
  await openOverlay(page)
  await drag(page, [950, 650], [999, 699])
  const toolbar = await page.locator('#toolbar').boundingBox()
  expect(toolbar!.x).toBeGreaterThanOrEqual(0)
  expect(toolbar!.x + toolbar!.width).toBeLessThanOrEqual(1000)
  expect(toolbar!.y + toolbar!.height).toBeLessThanOrEqual(700)
  await page.evaluate(() => (window as any).__RESET_SCREENSHOT__())
  await expect(page.locator('#selection')).toBeHidden()
  await page.mouse.click(500, 300, { button: 'right' })
  expect(await page.evaluate(() => (window as any).__SCREENSHOT__.cancelled)).toBe(1)
})

test('native region result becomes a composer attachment without a second crop dialog', async ({ page }) => {
  await authenticate(page, TEST_ACCESS_KEY, 'research')
  const api = await mockHermesApi(page)
  await mockChatSocket(page)
  await page.addInitScript(() => {
    const state = { captures: 0, hideWindows: [] as boolean[] }
    ;(window as any).__NATIVE_SCREENSHOT__ = state
    ;(window as any).hermesDesktop = {
      isDesktop: true, platform: 'darwin', windowKind: 'main',
      screenshot: {
        captureRegion: async (request: { hideWindows: boolean }) => {
          state.captures++
          state.hideWindows.push(request.hideWindows)
          const canvas = document.createElement('canvas')
          canvas.width = 200
          canvas.height = 100
          const context = canvas.getContext('2d')!
          context.fillStyle = '#247bca'
          context.fillRect(0, 0, 200, 100)
          return { dataUrl: canvas.toDataURL('image/png'), width: 200, height: 100 }
        },
        cancel: async () => true,
      },
    }
  })
  await page.goto('/#/hermes/chat')
  await page.getByRole('button', { name: 'Take screenshot' }).click()
  await expect(page.locator('.attachment-thumb')).toBeVisible()
  await expect(page.locator('.attachment-remove')).toBeVisible()
  expect(await page.evaluate(() => (window as any).__NATIVE_SCREENSHOT__.captures)).toBe(1)
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await page.locator('.attachment-remove').click()
  await expect(page.locator('.attachment-thumb')).toHaveCount(0)
  await page.getByRole('button', { name: 'Screenshot options' }).click()
  expect(await page.evaluate(() => (window as any).__NATIVE_SCREENSHOT__.captures)).toBe(1)
  await page.getByText('Hide window and take screenshot', { exact: true }).click()
  await expect(page.locator('.attachment-thumb')).toBeVisible()
  expect(await page.evaluate(() => (window as any).__NATIVE_SCREENSHOT__.hideWindows)).toEqual([false, true])
  await page.locator('.attachment-remove').click()
  await page.getByRole('button', { name: 'Take screenshot', exact: true }).click()
  await expect(page.locator('.attachment-thumb')).toBeVisible()
  expect(await page.evaluate(() => (window as any).__NATIVE_SCREENSHOT__.hideWindows)).toEqual([false, true, false])
  expect(api.unexpectedRequests).toEqual([])
})

test('web composer has no screenshot entry', async ({ page }) => {
  await authenticate(page, TEST_ACCESS_KEY, 'research')
  await mockHermesApi(page)
  await mockChatSocket(page)
  await page.goto('/#/hermes/chat')
  await expect(page.locator('.input-textarea')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Take screenshot' })).toHaveCount(0)
})

async function installShortcutBridge(page: Page, platform: string, hideSupported = true) {
  await page.addInitScript(({ platform, hideSupported }) => {
    const config = JSON.parse(localStorage.getItem('test-screenshot-shortcut') || '{"accelerator":"","hideWindows":false}')
    const listeners = new Set<(request: unknown) => void>()
    const state = {
      config, editing: false, targetId: '', captures: [] as boolean[],
      fire: () => { if (config.accelerator && !state.editing) for (const listener of listeners) listener({ targetId: state.targetId, hideWindows: config.hideWindows }) },
    }
    ;(window as any).__SHORTCUT__ = state
    ;(window as any).hermesDesktop = {
      isDesktop: true, platform, windowKind: 'main',
      screenshot: {
        getCapabilities: async () => ({ capture: 'electron', presentation: 'desktop-overlay', hideWindows: hideSupported, regionSelection: 'studio' }),
        shortcut: {
          getState: async () => ({ ...config, registered: !!config.accelerator && !state.editing, error: '' }),
          setTarget: async (targetId: string, active: boolean | null) => { if (active !== null) state.targetId = targetId; else if (state.targetId === targetId) state.targetId = ''; return true },
          setEditing: async (_targetId: string, editing: boolean) => { state.editing = editing; return { ...config, registered: !editing && !!config.accelerator, error: '' } },
          save: async (next: typeof config) => {
            if (next.accelerator === 'Control+Alt+C') return { ...config, registered: false, error: 'conflict' }
            Object.assign(config, next)
            localStorage.setItem('test-screenshot-shortcut', JSON.stringify(config))
            return { ...config, registered: false, error: '' }
          },
          onTrigger: (callback: (request: unknown) => void) => { listeners.add(callback); return () => listeners.delete(callback) },
          onStateChange: () => () => {},
        },
        captureRegion: async (request: { hideWindows: boolean }) => {
          state.captures.push(request.hideWindows)
          const canvas = document.createElement('canvas')
          canvas.width = 200; canvas.height = 100
          canvas.getContext('2d')!.fillRect(0, 0, 200, 100)
          return { dataUrl: canvas.toDataURL('image/png'), width: 200, height: 100 }
        },
        cancel: async () => true,
      },
    }
  }, { platform, hideSupported })
}

test('shortcut settings record, persist and clear a global capture binding', async ({ page }, testInfo) => {
  await authenticate(page, TEST_ACCESS_KEY, 'research')
  const api = await mockHermesApi(page)
  await mockChatSocket(page)
  await installShortcutBridge(page, 'darwin')
  await page.goto('/#/hermes/chat')
  await page.getByRole('button', { name: 'Screenshot options' }).click()
  await page.getByText('Set screenshot shortcut', { exact: true }).click()
  await expect(page.locator('.screenshot-shortcut-dialog')).toBeVisible()
  await page.getByLabel('Global shortcut', { exact: true }).press('Meta+Shift+s')
  await expect(page.locator('.shortcut-key')).toHaveValue('Shift + Cmd + S')
  await page.locator('.shortcut-modes .n-radio').filter({ hasText: 'Hide window and take screenshot' }).click()
  await expect(page.getByRole('radio', { name: 'Hide window and take screenshot', exact: true })).toBeChecked()
  await page.screenshot({ path: testInfo.outputPath('shortcut-settings.png') })
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(page.locator('.screenshot-shortcut-dialog')).toHaveCount(0)
  await expect.poll(() => page.evaluate(() => (window as any).__SHORTCUT__.editing)).toBe(false)
  await page.evaluate(() => (window as any).__SHORTCUT__.fire())
  await expect(page.locator('.attachment-thumb')).toHaveCount(1)
  expect(await page.evaluate(() => (window as any).__SHORTCUT__.captures)).toEqual([true])
  await page.reload()
  await page.getByRole('button', { name: 'Screenshot options' }).click()
  await page.getByText('Set screenshot shortcut', { exact: true }).click()
  await expect(page.locator('.shortcut-key')).toHaveValue('Shift + Cmd + S')
  await expect(page.getByRole('radio', { name: 'Hide window and take screenshot', exact: true })).toBeChecked()
  await page.getByRole('button', { name: 'Clear', exact: true }).click()
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(page.locator('.screenshot-shortcut-dialog')).toHaveCount(0)
  expect(await page.evaluate(() => (window as any).__SHORTCUT__.config.accelerator)).toBe('')
  expect(api.unexpectedRequests).toEqual([])
})

test('Linux shortcuts explain conflicts and keep unsupported hiding disabled', async ({ page }) => {
  await authenticate(page, TEST_ACCESS_KEY, 'research')
  await mockHermesApi(page)
  await mockChatSocket(page)
  await installShortcutBridge(page, 'linux', false)
  await page.goto('/#/hermes/chat')
  await page.getByRole('button', { name: 'Screenshot options' }).click()
  await page.getByText('Set screenshot shortcut', { exact: true }).click()
  await expect(page.getByRole('radio', { name: 'Hide window and take screenshot', exact: true })).toBeDisabled()
  await page.getByLabel('Global shortcut', { exact: true }).press('Control+Alt+c')
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(page.getByRole('alert')).toHaveText('The shortcut is in use or unavailable on this system. Try another combination.')
  await expect(page.locator('.screenshot-shortcut-dialog')).toBeVisible()
  await page.getByLabel('Global shortcut', { exact: true }).press('Control+Alt+s')
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(page.locator('.screenshot-shortcut-dialog')).toHaveCount(0)
  await expect.poll(() => page.evaluate(() => (window as any).__SHORTCUT__.editing)).toBe(false)
  await page.evaluate(() => (window as any).__SHORTCUT__.fire())
  await expect(page.locator('.attachment-thumb')).toHaveCount(1)
  expect(await page.evaluate(() => (window as any).__SHORTCUT__.captures)).toEqual([false])
})

async function openImageEditor(page: Page, initialSelection = true) {
  await openOverlay(page)
  await page.evaluate(initial => {
    const source = document.getElementById('screen') as HTMLCanvasElement
    const canvas = document.createElement('canvas')
    canvas.width = 2000; canvas.height = 1400
    canvas.getContext('2d')!.drawImage(source, 0, 0, 2000, 1400)
    ;(window as any).__INIT_SCREENSHOT__({
      requestId: 'portal', frameId: 'image-frame', presentation: 'image-editor',
      bitmap: { width: 2000, height: 1400, data: canvas.getContext('2d')!.getImageData(0, 0, 2000, 1400).data },
      ...(initial ? { initialSelection: { x: 0, y: 0, width: 2000, height: 1400 } } : {}),
      labels: { hint: '框选', confirm: '完成', reset: '重选', cancel: '取消', tools: { zoomIn: '放大', zoomOut: '缩小', fit: '适应窗口', source: '截图画面' } },
    })
  }, initialSelection)
  await expect(page.locator('#view-controls')).toBeVisible()
  await page.waitForFunction(() => (document.getElementById('screen') as HTMLCanvasElement).width === 2000)
}

async function imageDrag(page: Page, from: [number, number], to: [number, number]) {
  const bounds = (await page.locator('#stage').boundingBox())!
  const convert = ([x, y]: [number, number]): [number, number] => [bounds.x + x * bounds.width / 2000, bounds.y + y * bounds.height / 1400]
  await drag(page, convert(from), convert(to))
}

test('image editor ignores margins and keeps full-resolution marks through zoom, scrolling, and resize', async ({ page }) => {
  await openImageEditor(page)
  await expect(page.locator('#size')).toHaveText('2000 × 1400')
  await drag(page, [8, 80], [30, 120])
  await expect(page.locator('#size')).toHaveText('2000 × 1400')
  await page.locator('#rectangle').click()
  await imageDrag(page, [400, 500], [1000, 800])
  await expect.poll(() => annotationPixel(page, 400, 650)).toEqual([255, 69, 58, 255])
  await page.locator('#zoom-in').click()
  await page.setViewportSize({ width: 800, height: 600 })
  await page.locator('#viewport').evaluate(node => { node.scrollTop = 120; node.scrollLeft = 40 })
  await expect.poll(() => annotationPixel(page, 400, 650)).toEqual([255, 69, 58, 255])
  await page.locator('#undo').click()
  await expect.poll(() => annotationPixel(page, 400, 650)).toEqual([0, 0, 0, 0])
  await page.locator('#redo').click()
  await page.locator('#confirm').click()
  // Chromium schedules PNG encoding in idle tasks; large exports can exceed the
  // default five-second assertion budget on CI runners.
  await expect.poll(() => page.evaluate(() => (window as any).__SCREENSHOT__.submitted.length), { timeout: 15_000 }).toBe(1)
  const output = await page.evaluate(async () => {
    const payload = (window as any).__SCREENSHOT__.submitted[0]
    const bitmap = await createImageBitmap(new Blob([payload.png], { type: 'image/png' }))
    const canvas = document.createElement('canvas')
    canvas.width = bitmap.width; canvas.height = bitmap.height
    canvas.getContext('2d')!.drawImage(bitmap, 0, 0)
    return { frameId: payload.frameId, width: bitmap.width, height: bitmap.height, pixel: Array.from(canvas.getContext('2d')!.getImageData(400, 650, 1, 1).data) }
  })
  expect(output).toEqual({ frameId: 'image-frame', width: 2000, height: 1400, pixel: [255, 69, 58, 255] })
})

test('image selection stays in original pixels after fitting to a different window size', async ({ page }) => {
  await openImageEditor(page, false)
  await imageDrag(page, [200, 200], [1000, 800])
  await expect(page.locator('#size')).toHaveText('800 × 600')
  await page.setViewportSize({ width: 700, height: 520 })
  await expect(page.locator('#size')).toHaveText('800 × 600')
  await page.locator('#confirm').click()
  await expect.poll(() => page.evaluate(() => (window as any).__SCREENSHOT__.submitted.length)).toBe(1)
  const result = await page.evaluate(async () => {
    const payload = (window as any).__SCREENSHOT__.submitted[0]
    const bitmap = await createImageBitmap(new Blob([payload.png], { type: 'image/png' }))
    return { width: bitmap.width, height: bitmap.height, region: payload.region }
  })
  expect(result.width).toBe(800)
  expect(result.height).toBe(600)
  expect(result.region.x).toBeCloseTo(200)
  expect(result.region.y).toBeCloseTo(200)
})

test('image editor switches independent captured images and exports only the selected frame', async ({ page }) => {
  await openImageEditor(page)
  await page.evaluate(() => {
    const bitmap = (width: number, height: number) => ({ width, height, data: new Uint8Array(width * height * 4).fill(255) })
    ;(window as any).__INIT_SCREENSHOT__({
      requestId: 'sources', frameId: 'a', presentation: 'image-editor', bitmap: bitmap(500, 400),
      frames: [{ id: 'a', bitmap: bitmap(500, 400) }, { id: 'b', bitmap: bitmap(300, 200), initialSelection: { x: 0, y: 0, width: 300, height: 200 } }],
      labels: { hint: '框选', confirm: '完成', reset: '重选', cancel: '取消' },
    })
  })
  await expect(page.locator('#source')).toBeVisible()
  await page.locator('#source').selectOption('b')
  await expect(page.locator('#size')).toHaveText('300 × 200')
  await page.locator('#confirm').click()
  await expect.poll(() => page.evaluate(() => (window as any).__SCREENSHOT__.submitted.length)).toBe(1)
  const result = await page.evaluate(async () => {
    const payload = (window as any).__SCREENSHOT__.submitted[0]
    const bitmap = await createImageBitmap(new Blob([payload.png], { type: 'image/png' }))
    return { frameId: payload.frameId, width: bitmap.width, height: bitmap.height }
  })
  expect(result).toEqual({ frameId: 'b', width: 300, height: 200 })
})
