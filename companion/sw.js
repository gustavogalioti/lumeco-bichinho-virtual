/* Service worker do Jarbas — só existe pra receber notificações push
   (Frente 5). Não faz cache nem funciona offline, de propósito: o app
   inteiro depende do Worker/Groq pra responder, então não há ganho real
   em cachear a página, e isso evita bugs de versão antiga presa em cache. */

self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch (e) {}
  const title = data.title || 'Jarbas';
  const body = data.body || '';
  event.waitUntil(
    self.registration.showNotification(title, {
      body,
      tag: 'jarbas-notification',
    })
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const scopeUrl = self.registration.scope;
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientsArr) => {
      for (const client of clientsArr) {
        if (client.url.startsWith(scopeUrl) && 'focus' in client) return client.focus();
      }
      if (self.clients.openWindow) return self.clients.openWindow(scopeUrl);
    })
  );
});
