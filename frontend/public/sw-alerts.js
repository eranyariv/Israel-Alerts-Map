// Service Worker for local alert notifications
// Plays audio and shows OS notification even when tab is in background

self.addEventListener('message', (event) => {
  const { type, title, audioUrl, icon } = event.data || {}
  if (type === 'ALERT_NOTIFICATION') {
    // Show OS notification
    self.registration.showNotification(title, {
      icon: icon || '/map/favicon.png',
      badge: '/map/favicon.png',
      vibrate: [200, 100, 200, 100, 200],
      tag: 'local-alert',
      renotify: true,
    })
  }
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  event.waitUntil(
    clients.matchAll({ type: 'window' }).then((list) => {
      for (const client of list) {
        if (client.url.includes('/map') && 'focus' in client) return client.focus()
      }
      if (clients.openWindow) return clients.openWindow('/map/')
    })
  )
})
