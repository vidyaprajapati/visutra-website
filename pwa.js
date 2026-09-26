/* Registers the service worker (sw.js) — makes the site installable and
   lets the Android app (TWA) show a friendly offline page. Harmless in
   browsers that don't support it. */
if('serviceWorker' in navigator){
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(err => console.warn('Service worker not registered:', err));
  });
}
