/* VISUTRA app look — only loaded inside the installed / Android app (see pwa.js).
   Adds a bottom tab bar, hides website-only parts (footer, ads, "free services"),
   and makes taps, inputs and scrolling feel like an app. */
(function(){
  var P = location.pathname;
  if(/\/(login|reset-password|complete-profile)\.html$|\/admin\.html$|\/supplier\/login\.html$/.test(P)) { document.documentElement.classList.add('vt-app-bare'); }

  var css = [
    '.vt-app *{-webkit-tap-highlight-color:transparent}',
    '.vt-app body{overscroll-behavior-y:contain;animation:vtIn .18s ease-out;padding-bottom:calc(68px + env(safe-area-inset-bottom))}',
    '.vt-app-bare body{padding-bottom:0}',
    '@keyframes vtIn{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}',
    '.vt-app footer,.vt-app .site-footer,.vt-app ins.adsbygoogle,.vt-app .vt-adslot,.vt-app a[href*="free-services"],.vt-app .vt-webonly{display:none !important}',
    '.vt-app input:not([type=checkbox]):not([type=radio]):not([type=range]),.vt-app select,.vt-app textarea{font-size:16px}',
    '.vt-app .btn,.vt-app button{min-height:40px}',
    '.vt-app .btn:active,.vt-app button:active{transform:scale(.97)}',
    '.vt-app .topbar{position:sticky;top:0;z-index:60;padding-top:calc(10px + env(safe-area-inset-top))}',
    '.vt-app .card{border-radius:18px}',
    '.vt-app table{font-size:13px}',
    '#vtTabs{position:fixed;left:0;right:0;bottom:0;z-index:9999;display:flex;background:#fff;border-top:1px solid #E9E1D3;box-shadow:0 -4px 18px rgba(28,25,23,.08);padding-bottom:env(safe-area-inset-bottom);font-family:system-ui,sans-serif}',
    '#vtTabs a{flex:1;display:flex;flex-direction:column;align-items:center;gap:3px;padding:8px 2px 7px;text-decoration:none;color:#6F665A;font-size:11px;font-weight:600;position:relative}',
    '#vtTabs svg{width:23px;height:23px;fill:none;stroke:currentColor;stroke-width:1.9;stroke-linecap:round;stroke-linejoin:round}',
    '#vtTabs a.on{color:#E0531A}',
    '#vtTabs a.on:before{content:"";position:absolute;top:0;left:30%;right:30%;height:3px;border-radius:0 0 4px 4px;background:#E0531A}',
    '.vt-app-bare #vtTabs{display:none}',
    '@media print{#vtTabs{display:none}}'
  ].join('\n');
  var st = document.createElement('style'); st.textContent = css; document.head.appendChild(st);

  var ic = {
    home: '<path d="M3 11l9-8 9 8"/><path d="M5 10v10h14V10"/>',
    sell: '<path d="M14 3H6v18h12V7z"/><path d="M14 3v4h4M9 12h6M9 16h6"/>',
    buy:  '<path d="M6 7h12l1 14H5z"/><path d="M9 7a3 3 0 016 0"/>',
    lab:  '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M7 9h6M7 13h10"/>',
    me:   '<circle cx="12" cy="8" r="4"/><path d="M4 21c0-4 4-6 8-6s8 2 8 6"/>'
  };
  var tabs = [
    ['home', 'Home',    '/billing/app-home.html', /app-home/],
    ['sell', 'Sell',    '/billing/app.html',      /\/billing\/(app\.html|expenses|seller\/|invoice-view)/],
    ['buy',  'Buy',     '/billing/buyer/dashboard.html', /\/billing\/(buyer|order-place)/],
    ['lab',  'Labels',  '/tools/label-cropper.html', /\/tools\//],
    ['me',   'Account', '/billing/account.html',  /\/billing\/account/]
  ];
  function mount(){
    if(document.getElementById('vtTabs')) return;
    var nav = document.createElement('nav'); nav.id = 'vtTabs'; nav.setAttribute('aria-label', 'App menu');
    nav.innerHTML = tabs.map(function(t){
      return '<a href="' + t[2] + '" class="' + (t[3].test(P) ? 'on' : '') + '"><svg viewBox="0 0 24 24" aria-hidden="true">' + ic[t[0]] + '</svg>' + t[1] + '</a>';
    }).join('');
    document.body.appendChild(nav);
  }
  if(document.body) mount(); else document.addEventListener('DOMContentLoaded', mount);
})();
