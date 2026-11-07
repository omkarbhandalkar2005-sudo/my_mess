// My Mess - Service Worker (push notifications)

// Server se push aaya → notification dikhao
self.addEventListener('push', (event) => {
    let data = { title: 'My Mess', body: '', url: '/home.html' };

    try {
        if (event.data) data = { ...data, ...event.data.json() };
    } catch (e) {
        // JSON nahi tha toh default hi chalega
    }

    event.waitUntil(
        self.registration.showNotification(data.title, {
            body:  data.body,
            icon:  '/web-app-manifest-192x192.png',
            badge: '/favicon-96x96.png',
            data:  { url: data.url }
        })
    );
});

// Notification par tap kiya → app kholo
self.addEventListener('notificationclick', (event) => {
    event.notification.close();
    const url = (event.notification.data && event.notification.data.url) || '/home.html';

    event.waitUntil(
        clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
            for (const c of list) {
                if (c.url.includes(url) && 'focus' in c) return c.focus();
            }
            return clients.openWindow(url);
        })
    );
});