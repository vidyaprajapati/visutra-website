/* VISUTRA — tidy pages: long help / explanation text is folded behind a small
   "ⓘ … ＋" row. Tap to read it, tap again to hide. Works on every page that loads
   this script (website and app). Nothing is removed — the text is only collapsed.

   Opt out for one element:  data-keep="1"
   Opt in for any element:   data-info="Optional title"                              */
(function(){
  if(window.__vtInfo) return; window.__vtInfo = true;

  var HELP = '.vlc-help,.vls-help,.vlc-tx-note,.field-note,.pf-note,.tip-box,.fs-note,[data-info]';
  var SUB  = 'p.sub,div.sub';                 // billing page explanations — only the long ones fold
  var MIN_HELP = 25, MIN_SUB = 90, WRAPPED = [];

  var css = '.vt-info-btn{display:flex;width:fit-content;align-items:center;gap:8px;max-width:100%;margin:6px 0;padding:7px 12px;border:1.5px solid #E7D9C6;border-radius:999px;background:#FFF8F0;color:#8A4A1F;font:600 12.5px/1.2 system-ui,-apple-system,Segoe UI,sans-serif;cursor:pointer;text-align:left}' +
    '.vt-info-btn .i{flex:none;width:18px;height:18px;border-radius:50%;background:#E0531A;color:#fff;display:grid;place-items:center;font:700 11px/1 Georgia,serif;font-style:italic}' +
    '.vt-info-btn .t{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0}' +
    '.vt-info-btn .p{flex:none;font-size:17px;line-height:1;font-weight:700;color:#E0531A;margin-left:2px}' +
    '.vt-info-btn:active{transform:scale(.97)}' +
    '.vt-info-collapsed{display:none !important}';
  var st = document.createElement('style'); st.textContent = css; (document.head || document.documentElement).appendChild(st);

  function labelFor(el){
    var t = el.getAttribute('data-info');
    if(t) return t;
    var first = el.firstElementChild;
    if(first && /^(B|STRONG)$/.test(first.tagName) && el.firstChild === first && first.textContent.trim().length < 40) return first.textContent.trim().replace(/[:.]$/, '');
    var txt = (el.textContent || '').replace(/\s+/g, ' ').trim();
    return txt.length > 34 ? txt.slice(0, 34).replace(/\s+\S*$/, '') + '…' : txt;
  }
  function wrap(el, minLen){
    if(el.__vtInfo || el.hasAttribute('data-keep')) return;
    if(el.classList.contains('hidden') || el.closest('table,[hidden]') || el.querySelector('input,select,textarea,button')) { el.__vtInfo = 1; return; }  // status messages / controls stay as they are
    if(el.id && el.matches(SUB)) { el.__vtInfo = 1; return; }       // a .sub the page fills in itself (status text) is never folded
    var len = (el.textContent || '').replace(/\s+/g, ' ').trim().length;
    if(len < minLen) return;                      // short text stays visible (and is re-checked if it grows)
    el.__vtInfo = 1;
    var b = document.createElement('button');
    b.type = 'button'; b.className = 'vt-info-btn'; b.setAttribute('aria-expanded', 'false');
    b.innerHTML = '<span class="i">i</span><span class="t"></span><span class="p">+</span>';
    b.querySelector('.t').textContent = labelFor(el) || 'More info';
    el.classList.add('vt-info-collapsed'); el.__vtBtn = b; WRAPPED.push(el);
    b.addEventListener('click', function(ev){
      ev.preventDefault();
      var open = el.classList.toggle('vt-info-collapsed') === false;
      b.setAttribute('aria-expanded', open ? 'true' : 'false');
      b.querySelector('.p').textContent = open ? '−' : '+';
    });
    el.parentNode.insertBefore(b, el);
  }
  function scan(root){
    var r = root && root.querySelectorAll ? root : document;
    [].forEach.call(r.querySelectorAll(HELP), function(el){ wrap(el, el.hasAttribute('data-info') ? 1 : MIN_HELP); });
    [].forEach.call(r.querySelectorAll(SUB),  function(el){ wrap(el, MIN_SUB); });
    WRAPPED.forEach(function(el){ var t = el.__vtBtn.querySelector('.t'), l = labelFor(el) || 'More info'; if(t.textContent !== l) t.textContent = l; });   // text that changes later (e.g. per-platform help)
  }
  var pending = false;
  function later(){ if(pending) return; pending = true; (window.requestAnimationFrame || setTimeout)(function(){ pending = false; scan(document); }); }
  function start(){ scan(document); new MutationObserver(later).observe(document.body, { childList: true, subtree: true, characterData: true }); }
  if(document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
})();
