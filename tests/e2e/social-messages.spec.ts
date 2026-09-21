import { expect, test } from '@playwright/test'
import { authenticate, mockHermesApi, TEST_ACCESS_KEY } from './fixtures'

test('sends a Telegram message from Device Connections message push', async ({ page }) => {
  await authenticate(page, TEST_ACCESS_KEY, 'research')
  const api = await mockHermesApi(page, {
    socialMessagePlatforms: [
      {
        id: 'telegram',
        configured: true,
        recipientTypes: ['chat_id'],
        defaultRecipientType: 'chat_id',
        maxContentLength: 4096,
        supportsContextToken: false,
      },
      {
        id: 'feishu',
        configured: false,
        recipientTypes: ['chat_id', 'open_id'],
        defaultRecipientType: 'chat_id',
        maxContentLength: 20000,
        supportsContextToken: false,
      },
    ],
    socialMessageTelegramRecipients: {
      recipients: [{
        chatId: '1234',
        chatType: 'private',
        displayName: 'Alice',
        lastSeenAt: '2026-08-23T00:00:00.000Z',
      }],
      runtimeStatus: 'running',
    },
  })

  await page.goto('/#/social-messages')

  await expect(page).toHaveURL(/#\/hermes\/connections\?view=messages$/)
  await expect(page.getByRole('button', { name: 'Message Push' })).toHaveCount(0)
  await expect(page.getByText('Push target found. You can now send messages to this Telegram chat.')).toBeVisible()
  await expect(page.getByPlaceholder('Chat ID or @channel_username')).toHaveCount(0)
  await page.getByPlaceholder('Write the message to send…').fill('hello telegram')
  await page.getByRole('button', { name: 'Send message' }).click()

  await expect(page.getByText('Message sent')).toBeVisible()
  await expect(page.getByText('42', { exact: true })).toBeVisible()
  const sendRequest = api.requests.find(request => (
    request.method === 'POST' && request.pathname === '/api/social-messages/send'
  ))
  expect(sendRequest?.headers.authorization).toBe(`Bearer ${TEST_ACCESS_KEY}`)
  expect(sendRequest?.headers['x-hermes-profile']).toBe('research')
  expect(JSON.parse(sendRequest?.postData || '{}')).toEqual({
    platform: 'telegram',
    recipient: '1234',
    recipientType: 'chat_id',
    content: 'hello telegram',
  })
  expect(api.unexpectedRequests).toEqual([])
})

test('polls Weixin and warns until the bot has a push target', async ({ page }) => {
  await authenticate(page, TEST_ACCESS_KEY, 'research')
  const api = await mockHermesApi(page, {
    socialMessagePlatforms: [
      {
        id: 'weixin',
        configured: true,
        recipientTypes: ['user_id'],
        defaultRecipientType: 'user_id',
        maxContentLength: 2000,
        supportsContextToken: true,
      },
    ],
    socialMessageWeixinRecipients: {
      recipients: [],
      runtimeStatus: 'running',
    },
  })

  await page.goto('/#/social-messages')

  await expect(page.getByText(
    'Send this Bot one message in Weixin first so Studio can identify the push target.',
  )).toBeVisible()
  await expect(page.getByPlaceholder('Weixin Bot account ID')).toHaveCount(0)
  await expect(page.getByPlaceholder('Enter a new value to configure or replace')).toHaveCount(0)
  await expect.poll(() => api.requests.filter(request => (
    request.method === 'GET' && request.pathname === '/api/social-messages/weixin/recipients'
  )).length).toBeGreaterThan(1)
  expect(api.unexpectedRequests).toEqual([])
})

test('creates a standalone Feishu app by QR code', async ({ page }) => {
  await authenticate(page, TEST_ACCESS_KEY, 'research')
  const api = await mockHermesApi(page, {
    socialMessagePlatforms: [
      {
        id: 'feishu',
        configured: false,
        recipientTypes: ['chat_id', 'open_id'],
        defaultRecipientType: 'chat_id',
        maxContentLength: 20000,
        supportsContextToken: false,
      },
    ],
    socialMessageFeishuQrStatus: { status: 'confirmed', open_id: 'ou_owner' },
  })

  await page.goto('/#/social-messages')

  await expect(page.getByAltText('Feishu app registration QR code')).toBeVisible()
  await expect(page.getByText('Scan with Feishu to create and connect the app.')).toBeVisible()
  await expect(page.getByLabel('App ID')).toHaveCount(0)
  await expect(page.getByLabel('App Secret')).toHaveCount(0)
  await expect(page.getByText(
    'Send this Bot one message in Feishu first so Studio can identify the push target.',
  )).toBeVisible({ timeout: 5_000 })
  await expect(page.getByPlaceholder('Feishu recipient identifier')).toHaveCount(0)
  await expect(page.getByPlaceholder('Write the message to send…')).toHaveCount(0)

  const pollRequest = api.requests.find(request => (
    request.method === 'GET' && request.pathname === '/api/social-messages/feishu/qrcode/status'
  ))
  expect(pollRequest?.search).toBe('?session=feishu-session&locale=en')
  expect(api.requests.some(request => (
    request.method === 'GET' && request.pathname === '/api/social-messages/feishu/recipients'
  ))).toBe(true)
  expect(api.unexpectedRequests).toEqual([])
})
