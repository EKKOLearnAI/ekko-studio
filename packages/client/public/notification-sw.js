self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', (event) => event.waitUntil(clients.claim()))

function safeClickUrl(value) {
  return typeof value === 'string'
    && (value === '/person' || value.startsWith('/hermes/'))
    && !value.includes('..')
    && !value.includes('\\')
    ? value
    : null
}

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  event.waitUntil((async () => {
    const clickUrl = safeClickUrl(event.notification.data?.clickUrl)
    const target = clickUrl ? `/#${clickUrl}` : '/'
    const windows = await clients.matchAll({ type: 'window', includeUncontrolled: true })
    for (const client of windows) {
      if (clickUrl && 'navigate' in client) await client.navigate(target)
      if ('focus' in client) return client.focus()
    }
    if (clients.openWindow) return clients.openWindow(target)
  })())
})
