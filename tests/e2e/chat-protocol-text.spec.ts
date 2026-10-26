import { expect, test } from '@playwright/test'
import { authenticate, mockChatSocket, mockHermesApi } from './fixtures'

test('chat hides leaked XML protocol, preserves examples and does not link bare filenames', async ({ page }) => {
  await authenticate(page)
  await mockHermesApi(page)
  await mockChatSocket(page)
  await page.goto('/#/hermes/chat')
  const input = page.getByPlaceholder('Type a message... (Enter to send, Shift+Enter for new line)')
  await input.fill('Inspect a document')
  await page.getByRole('button', { name: 'Send' }).click()
  await page.waitForFunction(() => (window as any).__PW_CHAT_SOCKET__?.emitted?.some((entry: any) => entry.event === 'run'))
  await page.evaluate(() => {
    const state = (window as any).__PW_CHAT_SOCKET__
    const sid = state.emitted.find((entry: any) => entry.event === 'run').payload.session_id
    const text = '<tool_call><invoke name="read_file"><parameter name="path">hidden-protocol-payload</parameter></invoke></tool_call>\n'
      + 'Visible answer: DESIGN.md backup.sh main.py\n\n'
      + '```xml\n<tool_call>documented-example</tool_call>\n```\n\nhttps://example.com'
    state.latest.__trigger('run.started', { event: 'run.started', session_id: sid, run_id: 'protocol-test' })
    state.latest.__trigger('message.delta', { event: 'message.delta', session_id: sid, run_id: 'protocol-test', delta: text })
    state.latest.__trigger('run.completed', { event: 'run.completed', session_id: sid, run_id: 'protocol-test', output: text })
  })
  const answer = page.locator('.markdown-body').filter({ hasText: 'Visible answer:' })
  await expect(answer).toBeVisible()
  await expect(answer).not.toContainText('hidden-protocol-payload')
  await expect(answer.locator('pre')).toContainText('documented-example')
  await expect(answer.locator('a[href^="http://DESIGN.md"], a[href^="http://backup.sh"], a[href^="http://main.py"]')).toHaveCount(0)
  await expect(answer.locator('a[href="https://example.com"]')).toBeVisible()
})

test('chat preserves fenced and indented literals while filtering structural protocol variants', async ({ page }) => {
  await authenticate(page)
  await mockHermesApi(page)
  await mockChatSocket(page)
  await page.goto('/#/hermes/chat')
  await page.getByPlaceholder('Type a message... (Enter to send, Shift+Enter for new line)').fill('Show literal examples')
  await page.getByRole('button', { name: 'Send' }).click()
  await page.waitForFunction(() => (window as any).__PW_CHAT_SOCKET__?.emitted?.some((entry: any) => entry.event === 'run'))
  await page.evaluate(() => {
    const state = (window as any).__PW_CHAT_SOCKET__
    const sid = state.emitted.find((entry: any) => entry.event === 'run').payload.session_id
    const text = 'Visible regression answer:\n\n'
      + '```text\nAn embedded ``` is literal.\n<tool_call>fenced-example</tool_call>\n````\n'
      + '<parameter name="path">hidden-parameter</parameter>\n'
      + '<invoke name = "read_file">hidden-invoke</invoke>\n\n'
      + '```inline```\n<tool_call>hidden-after-inline</tool_call>\n\n'
      + '    <parameter name="path">indented-example</parameter>\n'
      + '\n- ~~~xml\n  <tool_call>list-tilde-example</tool_call>\n  ~~~\n'
      + '\n- ```xml\n  <!-- literal ``` -->\n  <tool_call>list-backtick-example</tool_call>\n  ```\n'
      + '\n<tool_call>hidden-after-list</tool_call>\n'
    state.latest.__trigger('run.started', { event: 'run.started', session_id: sid, run_id: 'literal-test' })
    for (let offset = 0; offset < text.length; offset += 7) {
      state.latest.__trigger('message.delta', {
        event: 'message.delta', session_id: sid, run_id: 'literal-test', delta: text.slice(offset, offset + 7),
      })
    }
    state.latest.__trigger('run.completed', { event: 'run.completed', session_id: sid, run_id: 'literal-test', output: text })
  })
  const answer = page.locator('.markdown-body').filter({ hasText: 'Visible regression answer:' })
  await expect(answer).toBeVisible()
  await expect(answer).not.toContainText('hidden-parameter')
  await expect(answer).not.toContainText('hidden-invoke')
  await expect(answer).not.toContainText('hidden-after-inline')
  await expect(answer).not.toContainText('hidden-after-list')
  await expect(answer.locator('pre').filter({ hasText: 'fenced-example' })).toContainText('<tool_call>fenced-example</tool_call>')
  await expect(answer.locator('pre').filter({ hasText: 'indented-example' })).toContainText('<parameter name="path">indented-example</parameter>')
  await expect(answer.locator('code').filter({ hasText: /^inline$/ })).toBeVisible()
  await expect(answer.locator('li pre').filter({ hasText: 'list-tilde-example' })).toContainText('<tool_call>list-tilde-example</tool_call>')
  await expect(answer.locator('li pre').filter({ hasText: 'list-backtick-example' })).toContainText('<tool_call>list-backtick-example</tool_call>')
})
