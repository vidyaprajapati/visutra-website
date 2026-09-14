// VISUTRA — shared account/profile dropdown menu.
// Used on the billing dashboard, account settings page, and (via
// auth-guard.js) on every free tool page, so the login experience is
// consistent everywhere.
//
// opts:
//   showBillingLink (bool) — show a "My Billing Account" link
//   basePath (string)      — relative path prefix to the billing/ folder
//                             ('' when already inside billing/, '../billing/'
//                             when called from a tools/ page)
function mountUserMenu(mountId, user, opts) {
  opts = opts || {};
  const base = opts.basePath || '';
  const mount = document.getElementById(mountId);
  if (!mount) return;

  const label = user.displayName || user.email || 'Account';
  const initial = (label[0] || '?').toUpperCase();

  mount.innerHTML = `
    <div class="vt-user-menu" style="position:relative;display:inline-block;font-family:system-ui,sans-serif">
      <button id="vtUserMenuBtn" style="display:flex;align-items:center;gap:8px;background:transparent;border:none;color:inherit;cursor:pointer;font-size:13px;padding:4px 8px;border-radius:8px">
        <span style="width:26px;height:26px;border-radius:50%;background:#C1440E;color:#fff;display:flex;align-items:center;justify-content:center;font-weight:700;font-size:12px;flex:none">${initial}</span>
        <span>${escapeHtmlUM(label)}</span>
        <span style="font-size:10px">&#9662;</span>
      </button>
      <div id="vtUserMenuDropdown" style="display:none;position:absolute;right:0;top:calc(100% + 6px);background:#fff;color:#1F1B16;border:1px solid #E4D8BD;border-radius:10px;min-width:210px;box-shadow:0 8px 24px rgba(0,0,0,0.15);z-index:10000;overflow:hidden">
        <div style="padding:10px 14px;font-size:11.5px;color:#6B6255;border-bottom:1px solid #E4D8BD;word-break:break-all">${escapeHtmlUM(user.email || '')}</div>
        <a href="${base}account.html" style="display:block;padding:10px 14px;font-size:13px;color:#1F1B16;text-decoration:none">My Account</a>
        ${opts.showBillingLink ? `<a href="${base}app.html" style="display:block;padding:10px 14px;font-size:13px;color:#1F1B16;text-decoration:none">My Billing Account</a>` : ''}
        <a href="#" id="vtLogoutLinkUM" style="display:block;padding:10px 14px;font-size:13px;color:#9E3608;text-decoration:none;border-top:1px solid #E4D8BD">Log out</a>
      </div>
    </div>
  `;

  const btn = document.getElementById('vtUserMenuBtn');
  const dropdown = document.getElementById('vtUserMenuDropdown');
  btn.addEventListener('click', function (e) {
    e.stopPropagation();
    dropdown.style.display = dropdown.style.display === 'block' ? 'none' : 'block';
  });
  document.addEventListener('click', function () { dropdown.style.display = 'none'; });

  document.getElementById('vtLogoutLinkUM').addEventListener('click', function (e) {
    e.preventDefault();
    firebase.auth().signOut().then(function () { window.location.href = base + 'login.html'; });
  });
}

function escapeHtmlUM(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}
