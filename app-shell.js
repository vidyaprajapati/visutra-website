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
    '.vt-app table.vt-cards tr{display:grid;grid-template-columns:1fr 1fr;column-gap:14px;background:#fff;border:1px solid #EEE6D8;border-radius:16px;padding:8px 14px;margin:0 0 10px;box-shadow:0 1px 4px rgba(28,25,23,.05)}',
    '.vt-app table.vt-cards td{display:flex;flex-direction:column;align-items:flex-start;gap:1px;border:0;padding:5px 0;text-align:left;overflow-wrap:anywhere;font-size:14px;font-weight:600;min-width:0}',
    '.vt-app table.vt-cards td:before{content:attr(data-l);font-family:var(--mono,monospace);font-size:10px;text-transform:uppercase;letter-spacing:.06em;color:#6F665A;font-weight:500}',
    '.vt-app table.vt-cards td[data-l=""]:before{display:none}',
    '.vt-app table.vt-cards td[data-l=""],.vt-app table.vt-cards td.vt-act{grid-column:1/-1}',
    '.vt-app table.vt-cards td.vt-act{flex-direction:row;flex-wrap:wrap;justify-content:flex-end;gap:8px;padding-top:8px}',
    '.vt-app table.vt-cards td.vt-act:before{display:none}',
    '.vt-app table.vt-cards td:empty{display:none}',
    '.vt-app .vt-table-wrap{border:0;overflow:visible}',
    '.vt-app table.vt-cards tr.vt-hide{display:none !important}',
    '.vt-app table.vt-cards tr.vt-compact:not(.vt-open) td.vt-more{display:none}',
    '.vt-app table.vt-cards tr.vt-compact{cursor:pointer}',
    '.vt-app table.vt-cards tr.vt-compact:after{grid-column:1/-1;content:"\\25BE  Tap for details";display:block;text-align:center;color:#B33F0F;font-size:12px;font-weight:600;padding:8px 0 6px}',
    '.vt-app table.vt-cards tr.vt-compact.vt-open:after{content:"\\25B4  Hide details"}',
    '.vt-app .grid2,.vt-app .grid3{grid-template-columns:1fr 1fr;gap:10px}',
    '.vt-app .card{padding:14px;margin-bottom:12px}',
    '.vt-app .card .sub{margin-bottom:10px;font-size:13px}',
    '.vt-app .field{margin-bottom:10px}',
    '}',
    '.vt-app table{font-size:13px}',
    '.vt-showmore{text-align:center;margin:2px 0 14px}',
    '.vt-showmore button{border:1.5px solid #E0531A;background:#fff;color:#B33F0F;border-radius:14px;padding:10px 22px;font-size:14px;font-weight:700}',
    '#vtTop{position:fixed;right:14px;bottom:calc(80px + env(safe-area-inset-bottom));width:46px;height:46px;border-radius:50%;border:0;background:#E0531A;color:#fff;box-shadow:0 4px 14px rgba(0,0,0,.25);z-index:9990;display:none;place-items:center;font-size:22px;line-height:1}',
    '#vtTop.on{display:grid}',
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
    b.insertAdjacentHTML('beforeend','<button type="button" id="vtAcc" aria-label="Switch account"><svg viewBox="0 0 24 24"><circle cx="12" cy="8" r="4"/><path d="M4 21c0-4 4-6 8-6s8 2 8 6"/></svg></button>');
    b.querySelector('#vtAcc').addEventListener('click', function(){ if(window.vtOpenAccounts) window.vtOpenAccounts(); });
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
      /* long lists: show the first few rows, "Show more" for the rest; wide rows: key fields first */
      var body = t.tBodies[0], trs = body ? [].slice.call(body.rows) : [];
      var limit = parseInt(t.getAttribute('data-vt-shown') || '6', 10), chunked = trs.length > limit + 2;
      trs.forEach(function(tr, ri){ var hide = chunked && ri >= limit; if(tr.classList.contains('vt-hide') !== hide) tr.classList.toggle('vt-hide', hide); });
      trs.forEach(function(tr){
        [].forEach.call(tr.children, function(td){ if(td.tagName === 'TD'){ var act = !!td.querySelector('button,a'); if(td.classList.contains('vt-act') !== act) td.classList.toggle('vt-act', act); } });
        var cs = [].filter.call(tr.children, function(td){ return td.tagName === 'TD'; });
        var data = cs.filter(function(td){ return td.getAttribute('data-l') && td.textContent.trim() && !td.querySelector('button,a,input,select'); });
        var compact = data.length > 5;
        if(tr.classList.contains('vt-compact') !== compact) tr.classList.toggle('vt-compact', compact);
        if(compact) data.forEach(function(td, di){ var more = di >= 4; if(td.classList.contains('vt-more') !== more) td.classList.toggle('vt-more', more); });
      });
      var host = t.parentElement && t.parentElement.classList.contains('vt-table-wrap') ? t.parentElement : t;
      var ctl = host.nextElementSibling && host.nextElementSibling.classList.contains('vt-showmore') ? host.nextElementSibling : null;
      var hidden = trs.filter(function(tr){ return tr.classList.contains('vt-hide'); }).length;
      if(hidden && !ctl){
        ctl = document.createElement('div'); ctl.className = 'vt-showmore'; ctl.innerHTML = '<button type="button"></button>';
        ctl.firstChild.addEventListener('click', function(){ t.setAttribute('data-vt-shown', String((parseInt(t.getAttribute('data-vt-shown') || '6', 10)) + 10)); schedule(); });
        host.parentNode.insertBefore(ctl, host.nextSibling);
      }
      if(ctl){ if(hidden){ var txt = 'Show ' + Math.min(10, hidden) + ' more  (' + hidden + ' left)'; if(ctl.firstChild.textContent !== txt) ctl.firstChild.textContent = txt; } else ctl.remove(); }
    }
  }
  function schedule(){ if(!pending){ pending = true; (window.requestAnimationFrame || setTimeout)(cardify); } }
  function start(){
    bar(); cardify();
    document.addEventListener('click', function(e){
      if(e.target.closest('button,a,input,select,textarea,label')) return;
      var tr = e.target.closest('table.vt-cards tr.vt-compact'); if(tr) tr.classList.toggle('vt-open');
    });
    var up = document.createElement('button'); up.id = 'vtTop'; up.type = 'button'; up.setAttribute('aria-label', 'Back to top'); up.textContent = '\u2191';
    up.addEventListener('click', function(){ window.scrollTo({ top: 0, behavior: 'smooth' }); });
    document.body.appendChild(up);
    window.addEventListener('scroll', function(){ up.classList.toggle('on', window.scrollY > window.innerHeight * 1.2); }, { passive: true });
    var sw = document.createElement('script'); sw.src = '/account-switcher.js?v=1'; sw.defer = true; document.head.appendChild(sw);
    new MutationObserver(schedule).observe(document.body, { childList: true, subtree: true });
  }
  if(document.body) start(); else document.addEventListener('DOMContentLoaded', start);
})();
