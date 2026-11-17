self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', (event) => event.waitUntil(clients.claim()))

function safeClickUrl(value) {
  return typeof value === 'string'
    && (value === '/person' || value.startsWith('/person?') || value.startsWith('/hermes/'))
    && !value.includes('..')
    && !value.includes('\\')
    ? value
    : null
}

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  event.waitUntil((async () => {
    const clickUrl = safeClickUrl(event.notification.data?.clickUrl)
    const target = new URL(self.registration.scope)
    if (clickUrl) target.hash = clickUrl
    const windows = await clients.matchAll({ type: 'window', includeUncontrolled: true })
    for (const client of windows) {
      if (!client.url.startsWith(self.registration.scope)) continue
      if (clickUrl && 'navigate' in client) await client.navigate(target.href)
      if ('focus' in client) return client.focus()
    }
    if (clients.openWindow) return clients.openWindow(target.href)
  })())
})
