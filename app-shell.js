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

    '.vt-app .topbar,.vt-app .vlc-topbar,.vt-app .vlc-hero,.vt-app .vlc-stamp{display:none !important}',
    '.vt-app body{padding-top:calc(52px + env(safe-area-inset-top))}',
    '.vt-app-home body{padding-top:0}',
    '.vt-app .shell{min-height:auto}',
    '.vt-app .sidebar{top:calc(52px + env(safe-area-inset-top)) !important}',
    '#vtBar{position:fixed;top:0;left:0;right:0;z-index:9998;height:calc(52px + env(safe-area-inset-top));padding:env(safe-area-inset-top) 12px 0 6px;box-sizing:border-box;background:linear-gradient(135deg,#FF6A1A,#E0531A);color:#fff;display:flex;align-items:center;gap:6px;box-shadow:0 2px 10px rgba(0,0,0,.18);font-family:system-ui,sans-serif}',
    '#vtBar button{width:44px;height:44px;border:0;background:transparent;color:#fff;display:grid;place-items:center;border-radius:50%;padding:0}',
    '#vtBar button:active{background:rgba(255,255,255,.2)}',
    '#vtBar svg{width:24px;height:24px;fill:none;stroke:#fff;stroke-width:2.2;stroke-linecap:round;stroke-linejoin:round}',
    '#vtBar img{width:30px;height:30px;border-radius:9px;background:#fff;padding:2px;margin:0 6px 0 8px}',
    '#vtBar b{flex:1;font-size:18px;font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
    '.vt-app-bare #vtBar,.vt-app-home #vtBar{display:none}',
    '.vt-app-bare body{padding-top:0}',
    '.vt-app .card{border:0;box-shadow:0 2px 12px rgba(28,25,23,.07)}',
    '.vt-app .card h2{font-size:18px}',
    '.vt-app .btn{font-family:inherit;font-size:14px;font-weight:600;letter-spacing:0;border-radius:14px;padding:11px 18px;min-height:44px}',
    '.vt-app .btn.small{padding:8px 14px;font-size:13px;min-height:38px}',
    '.vt-app input:not([type=checkbox]):not([type=radio]):not([type=range]):not([type=file]),.vt-app select,.vt-app textarea{border-radius:12px;min-height:46px;padding:10px 12px}',
    '.vt-app table input,.vt-app table select{min-height:38px;padding:6px 8px;border-radius:8px}',
    '.vt-app .field input,.vt-app .field select,.vt-app .field textarea{width:100%}',
    '.vt-app .modal-overlay{align-items:flex-end;padding:0;z-index:10001 !important}',
    '.vt-app .modal-box{border-radius:22px 22px 0 0;max-height:88vh;max-width:100%;padding:20px 16px calc(20px + env(safe-area-inset-bottom));animation:vtUp .22s ease-out}',
    '@keyframes vtUp{from{transform:translateY(60px);opacity:.4}to{transform:none;opacity:1}}',
    '@media(max-width:820px){',
    '.vt-app table.vt-cards{display:block;border:0;width:100%}',
    '.vt-app table.vt-cards thead{display:none}',
    '.vt-app table.vt-cards tbody,.vt-app table.vt-cards tfoot{display:block}',
    '.vt-app table.vt-cards tr{display:block;background:#fff;border:1px solid #EEE6D8;border-radius:16px;padding:4px 14px;margin:0 0 10px;box-shadow:0 1px 4px rgba(28,25,23,.05)}',
    '.vt-app table.vt-cards td{display:flex;justify-content:space-between;align-items:flex-start;gap:14px;border:0;border-bottom:1px solid #F4EEE4;padding:9px 0;text-align:right;overflow-wrap:anywhere;font-size:14px}',
    '.vt-app table.vt-cards td:last-child{border-bottom:0}',
    '.vt-app table.vt-cards td:before{content:attr(data-l);font-family:var(--mono,monospace);font-size:10.5px;text-transform:uppercase;letter-spacing:.06em;color:#6F665A;text-align:left;flex:none;max-width:42%;padding-top:3px}',
    '.vt-app table.vt-cards td[data-l=""]:before{display:none}',
    '.vt-app table.vt-cards td[data-l=""]{justify-content:flex-end}',
    '.vt-app table.vt-cards td:empty{display:none}',
    '.vt-app .vt-table-wrap{border:0;overflow:visible}',
    '}',
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

  /* ---- app bar (back button + page title) ---- */
  var roots = /\/billing\/(app-home|app|account)\.html$|\/billing\/buyer\/dashboard\.html$|\/tools\/label-cropper\.html$/;
  if(/app-home\.html$/.test(P)) document.documentElement.classList.add('vt-app-home');
  function pageTitle(){
    var t = document.getElementById('topbarTitle');
    if(t && t.textContent.trim()) return t.textContent.trim();
    var h = (document.title || 'VISUTRA').split(/\s[|—–-]\s/)[0].trim();
    return h || 'VISUTRA';
  }
  function bar(){
    if(document.getElementById('vtBar')) return;
    var b = document.createElement('div'); b.id = 'vtBar';
    var root = roots.test(P);
    b.innerHTML = (root ? '<img src="/assets/logo.png" alt="">' :
      '<button type="button" aria-label="Back"><svg viewBox="0 0 24 24"><path d="M15 5l-7 7 7 7"/></svg></button>') + '<b></b>';
    var btn = b.querySelector('button');
    if(btn) btn.addEventListener('click', function(){ if(history.length > 1) history.back(); else location.href = '/billing/app-home.html'; });
    document.body.insertBefore(b, document.body.firstChild);
    var title = b.querySelector('b'); title.textContent = pageTitle();
    var tt = document.getElementById('topbarTitle');
    if(tt) new MutationObserver(function(){ title.textContent = pageTitle(); }).observe(tt, { childList: true, characterData: true, subtree: true });
  }
  /* ---- tables become cards on phones: each cell gets its column name ---- */
  var pending = false;
  function cardify(){
    pending = false;
    var tables = document.querySelectorAll('table');
    for(var i = 0; i < tables.length; i++){
      var t = tables[i];
      if(t.closest('.line-items') || t.classList.contains('no-cards')) continue;
      var ths = t.querySelectorAll('thead th'); if(!ths.length || ths.length > 10) continue;
      if(t.querySelector('tbody input, tbody select, tbody textarea')){ t.classList.remove('vt-cards'); continue; }
      var heads = [].map.call(ths, function(h){ return (h.getAttribute('data-vtlabel') || h.textContent || '').replace(/\s+/g, ' ').trim(); });
      var rows = t.querySelectorAll('tbody tr, tfoot tr');
      for(var r = 0; r < rows.length; r++){
        var col = 0, cells = rows[r].children;
        for(var c = 0; c < cells.length; c++){
          var td = cells[c]; if(td.tagName !== 'TD') continue;
          if(!td.hasAttribute('data-l')) td.setAttribute('data-l', (td.colSpan || 1) > 1 ? '' : (heads[col] || ''));
          col += (td.colSpan || 1);
        }
      }
      t.classList.add('vt-cards');
    }
  }
  function schedule(){ if(!pending){ pending = true; (window.requestAnimationFrame || setTimeout)(cardify); } }
  function start(){
    bar(); cardify();
    new MutationObserver(schedule).observe(document.body, { childList: true, subtree: true });
  }
  if(document.body) start(); else document.addEventListener('DOMContentLoaded', start);
})();
