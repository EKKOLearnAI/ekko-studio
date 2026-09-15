import { expect, test, type Page } from '@playwright/test'
import { authenticate, mockChatSocket, mockHermesApi, TEST_ACCESS_KEY } from './fixtures'

const inputPlaceholder = 'Type a message... (Enter to send, Shift+Enter for new line)'

async function waitForRun(page: Page, index: number) {
  const handle = await page.waitForFunction((runIndex) => {
    const state = (window as any).__PW_CHAT_SOCKET__
    const runs = state?.emitted?.filter((item: any) => item.event === 'run') || []
    return runs[runIndex]?.payload || null
  }, index)
  return handle.jsonValue() as Promise<any>
}

test('annotates an exact assistant excerpt and sends immutable annotation-only evidence', async ({ page }) => {
  await authenticate(page, TEST_ACCESS_KEY, 'research')
  const api = await mockHermesApi(page)
  await mockChatSocket(page)
  await page.goto('/#/hermes/chat')

  const input = page.getByPlaceholder(inputPlaceholder)
  await input.fill('Give me a precise answer')
  await page.getByRole('button', { name: 'Send' }).click()
  const firstRun = await waitForRun(page, 0)

  await page.evaluate((sessionId) => {
    const socket = (window as any).__PW_CHAT_SOCKET__.latest
    socket.__trigger('run.started', { event: 'run.started', session_id: sessionId, run_id: 'annotation-run' })
    socket.__trigger('message.delta', {
      event: 'message.delta', session_id: sessionId, run_id: 'annotation-run',
      delta: 'The precise response excerpt appears here, with **Markdown** and `inline code`.',
    })
    socket.__trigger('run.completed', {
      event: 'run.completed', session_id: sessionId, run_id: 'annotation-run',
      output: 'The precise response excerpt appears here, with **Markdown** and `inline code`.',
    })
  }, firstRun.session_id)

  const source = page.locator('.response-annotation-source').last()
  await expect(source).toContainText('The precise response excerpt appears here')
  await source.evaluate((root) => {
    const targetText = 'precise response excerpt'
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
    let node: Text | null = null
    while ((node = walker.nextNode() as Text | null)) {
      const start = node.data.indexOf(targetText)
      if (start < 0) continue
      const range = document.createRange()
      range.setStart(node, start)
      range.setEnd(node, start + targetText.length)
      const selection = window.getSelection()!
      selection.removeAllRanges()
      selection.addRange(range)
      document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
      return
    }
    throw new Error('selection text not found')
  })

  await expect(page.getByRole('toolbar', { name: 'Response annotation actions' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Add to chat' })).toBeVisible()
  await expect(page.getByText('Ask in side chat')).toHaveCount(0)
  await page.getByRole('button', { name: 'Add to chat' }).click()

  const editor = page.getByTestId('response-annotation-editor')
  await expect(editor).toBeVisible()
  await editor.getByPlaceholder('Add an optional comment...').fill('Why is this precise?')
  await editor.getByRole('button', { name: 'Save' }).click()

  await expect(source.getByTestId('response-annotation-highlight')).toBeVisible()
  await expect(source.getByTestId('response-annotation-marker')).toHaveText('1')
  await expect(page.getByTestId('response-annotation-count')).toContainText('1 annotation')

  await page.getByRole('button', { name: 'Send' }).click()
  const secondRun = await waitForRun(page, 1)
  expect(secondRun.input).toContain('<response_annotations>')
  expect(secondRun.input).toContain('precise response excerpt')
  expect(secondRun.input).toContain('Why is this precise?')
  expect(secondRun.storage_message).toBe(secondRun.input)
  expect(JSON.parse(secondRun.display_input)).toMatchObject({
    __hermes_studio_response_annotations__: 1,
    body: '',
    annotations: [{ selectedText: 'precise response excerpt', comment: 'Why is this precise?' }],
  })
  await page.evaluate(({ sessionId, queueId }) => {
    const socket = (window as any).__PW_CHAT_SOCKET__.latest
    socket.__trigger('run.started', {
      event: 'run.started', session_id: sessionId, run_id: 'annotation-follow-up', queue_id: queueId,
    })
  }, { sessionId: secondRun.session_id, queueId: secondRun.queue_id })
  await expect(page.locator('.chat-input-area [data-testid="response-annotation-count"]')).toHaveCount(0)

  const sentTurn = page.locator('.message.user').last()
  await expect(sentTurn.locator('.message-bubble')).toHaveCount(0)
  await sentTurn.getByTestId('response-annotation-count').click()
  const sentCard = page.getByTestId('response-annotation-sent-card')
  await expect(sentCard).toContainText('Selected excerpt')
  await expect(sentCard).toContainText('Why is this precise?')
  await sentCard.getByRole('button', { name: 'Show source' }).click()
  await expect(source).toHaveClass(/response-annotation-source--flash/)
  expect(api.unexpectedRequests).toEqual([])
})
