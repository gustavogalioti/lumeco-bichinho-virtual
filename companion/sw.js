/* Service worker do Jarbas — só existe pra receber notificações push
   (Frente 5). Não faz cache nem funciona offline, de propósito: o app
   inteiro depende do Worker/Groq pra responder, então não há ganho real
   em cachear a página, e isso evita bugs de versão antiga presa em cache. */

self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch (e) {}
  const title = data.title || 'Jarbas';
  const body = data.body || '';

  // F2-3a: se o app já está aberto e visível em algum aparelho, o Jarbas FALA o aviso
  // em vez de mandar notificação do sistema (ia ficar redundante com a tela acesa na
  // cara da pessoa). Só cai pra notificação normal se nenhuma janela estiver visível.
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientsArr) => {
      const visible = clientsArr.filter((c) => c.visibilityState === 'visible');
      if (visible.length) {
        visible.forEach((c) => c.postMessage({ tipo: 'aviso', title, body }));
        return;
      }
      return self.registration.showNotification(title, {
        body,
        tag: 'jarbas-notification',
      });
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
