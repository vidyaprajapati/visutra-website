/* Registers the service worker (sw.js) — makes the site installable and
   lets the Android app (TWA) show a friendly offline page. Harmless in
   browsers that don't support it.
   Also: when the page is running INSIDE the app (installed app / Android app),
   loads app-shell.js, which gives it the app look (bottom tab bar, no website
   header/footer). In a normal browser tab nothing changes. */
if('serviceWorker' in navigator){
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(err => console.warn('Service worker not registered:', err));
  });
}
(function(){
  var app = false;
  try{
    if(new URLSearchParams(location.search).get('source') === 'app') sessionStorage.setItem('vtApp', '1');
    app = (window.matchMedia && matchMedia('(display-mode: standalone)').matches) || navigator.standalone === true ||
          (document.referrer || '').indexOf('android-app://') === 0 || /VISUTRA-App/.test(navigator.userAgent) || sessionStorage.getItem('vtApp') === '1';
  }catch(e){}
  if(!app) return;
  document.documentElement.classList.add('vt-app');
  // the app opens on the Portal page → show the app home instead
  if(/\/billing\/portal\.html$/.test(location.pathname)){ location.replace('/billing/app-home.html'); return; }
  var s = document.createElement('script'); s.src = '/app-shell.js?v=4'; s.defer = true; document.head.appendChild(s);
})();
