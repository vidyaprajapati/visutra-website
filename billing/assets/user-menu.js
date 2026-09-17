// VISUTRA — shared account/profile dropdown menu, plus site-wide navigation.
// Used on the billing dashboard, account settings page, buyer/seller pages,
// and (via auth-guard.js) on every free tool page, so the navigation
// experience is consistent everywhere it's called from a single place.
//
// opts:
//   showBillingLink (bool) — show a "My Billing Account" link
//   basePath (string)      — relative path prefix to the billing/ folder
//                             ('' when already inside billing/, '../' when
//                             inside billing/buyer/ or billing/seller/,
//                             '../billing/' when called from a tools/ page)
function mountUserMenu(mountId, user, opts) {
  opts = opts || {};
  const base = opts.basePath || '';
  const siteRoot = base + '../'; // site root relative to wherever this page lives
  const mount = document.getElementById(mountId);
  if (!mount) return;

  const label = user.displayName || user.email || 'Account';
  const initial = (label[0] || '?').toUpperCase();

  const itemStyle = 'display:block;padding:10px 14px;font-size:13px;color:#1F1B16;text-decoration:none;white-space:nowrap';
  const dropdownStyle = 'display:none;position:absolute;left:0;top:calc(100% + 6px);background:#fff;color:#1F1B16;border:1px solid #E4D8BD;border-radius:10px;min-width:210px;box-shadow:0 8px 24px rgba(0,0,0,0.15);z-index:10000;overflow:hidden';
  const pillBtnStyle = 'background:transparent;border:1px solid currentColor;border-radius:20px;color:inherit;cursor:pointer;font-size:12px;padding:6px 12px;font-family:inherit';
  // A crisp inline house outline, sized to sit centered in the 32x32 button —
  // replaces the old Unicode "⌂" glyph, which rendered at an inconsistent
  // size/weight depending on the visitor's OS font and looked out of place
  // next to the pill buttons beside it.
  const homeIconSvg = '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 11.5 12 4l9 7.5"/><path d="M5.5 9.5V20h13V9.5"/><path d="M9.5 20v-6h5v6"/></svg>';

  mount.innerHTML = `
    <div style="display:flex;align-items:center;gap:8px;font-family:system-ui,sans-serif">
      <a href="${siteRoot}index.html" title="Home" style="display:flex;align-items:center;justify-content:center;width:32px;height:32px;border-radius:8px;color:inherit;text-decoration:none">${homeIconSvg}</a>

      <a href="${base}buyer/dashboard.html" class="topbar-role-link" style="${pillBtnStyle};text-decoration:none;display:inline-block">Buyer</a>
      <a href="${base}app.html" class="topbar-role-link" style="${pillBtnStyle};text-decoration:none;display:inline-block">Seller</a>

      <div style="position:relative;display:inline-block">
        <button id="vtUserMenuBtn" style="display:flex;align-items:center;gap:8px;background:transparent;border:none;color:inherit;cursor:pointer;font-size:13px;padding:4px 8px;border-radius:8px;font-family:inherit">
          <span style="width:26px;height:26px;border-radius:50%;background:#C1440E;color:#fff;display:flex;align-items:center;justify-content:center;font-weight:700;font-size:12px;flex:none">${initial}</span>
          <span>${escapeHtmlUM(label)}</span>
          <span style="font-size:10px">&#9662;</span>
        </button>
        <div id="vtUserMenuDropdown" style="${dropdownStyle};left:auto;right:0">
          <div style="padding:10px 14px;font-size:11.5px;color:#6B6255;border-bottom:1px solid #E4D8BD;word-break:break-all">${escapeHtmlUM(user.email || '')}</div>
          <a href="${base}account.html" style="${itemStyle}">Profile (My Account)</a>
          ${opts.showBillingLink ? `<a href="${base}app.html" style="${itemStyle}">My Billing Account</a>` : ''}
          <a href="${base}portal.html" style="${itemStyle}">Business Portal (Buyer/Seller)</a>
          <a href="#" id="vtLogoutLinkUM" style="${itemStyle};color:#9E3608;border-top:1px solid #E4D8BD">Log out</a>
        </div>
      </div>
    </div>
  `;

  wireDropdown('vtUserMenuBtn', 'vtUserMenuDropdown');
  document.addEventListener('click', closeAllVtDropdowns);

  document.getElementById('vtLogoutLinkUM').addEventListener('click', function (e) {
    e.preventDefault();
    firebase.auth().signOut().then(function () { window.location.href = base + 'login.html'; });
  });

  mountSiteDrawer(mount, base, siteRoot);
}

// The Buyer domain's own pages (its equivalent of the Seller side's big
// app.html sidebar). One list, used by every buyer/*.html page, so adding or
// renaming a section only needs to happen here. Dashboard is the Buyer
// landing page (what the topbar "Buyer" link opens directly, now that it's
// no longer a dropdown). Stock and GSTR-1 are native buyer/*.html pages —
// they read the same underlying products/purchases data as the Seller side
// (it's the same business account's one inventory), but render inside the
// Buyer's own topbar/sidebar rather than opening the Seller app screen.
const VT_BUYER_NAV = [
  { view: 'dashboard', href: 'buyer/dashboard.html', label: 'Dashboard' },
  { view: 'my-sellers', href: 'buyer/my-sellers.html', label: 'My Sellers' },
  { view: 'place-order', href: 'buyer/place-order.html', label: 'Place Order' },
  { view: 'label-order', href: 'buyer/label-order.html', label: 'Label-Based Auto Order' },
  { view: 'buyer-sku-master', href: 'buyer/buyer-sku-master.html', label: 'Buyer SKU Master' },
  { view: 'my-orders', href: 'buyer/my-orders.html', label: 'My Orders' },
  { view: 'buyer-stock', href: 'buyer/stock.html', label: 'Stock' },
  { view: 'buyer-gstr1', href: 'buyer/purchases-gstr.html', label: 'GSTR-1 Filing' }
];
// Renders the persistent left sidebar for a buyer page — the same always-
// visible-on-the-left treatment the Seller side's app.html sidebar uses,
// instead of requiring the "Buyer ▾" topbar dropdown to move between
// sections while already inside the buyer area. Call after mountUserMenu()
// with the current page's view id (matching VT_BUYER_NAV) and the same
// basePath passed to mountUserMenu.
function renderBuyerSidebar(activeView, basePath) {
  const mount = document.getElementById('buyerSidebarMount');
  if (!mount) return;
  const base = basePath || '';
  mount.innerHTML = VT_BUYER_NAV.map(function (item) {
    const active = item.view === activeView ? ' active' : '';
    return '<a href="' + base + item.href + '" class="nav-link' + active + '">' + item.label + '</a>';
  }).join('');
}

function wireDropdown(btnId, dropdownId) {
  const btn = document.getElementById(btnId);
  const dropdown = document.getElementById(dropdownId);
  if (!btn || !dropdown) return;
  btn.addEventListener('click', function (e) {
    e.stopPropagation();
    const isOpen = dropdown.style.display === 'block';
    closeAllVtDropdowns();
    dropdown.style.display = isOpen ? 'none' : 'block';
  });
}
function closeAllVtDropdowns() {
  ['vtUserMenuDropdown'].forEach(function (id) {
    const el = document.getElementById(id);
    if (el) el.style.display = 'none';
  });
}

/* Hamburger (☰) button on the left of the topbar, opening a full-site
   navigation drawer — every section of the buyer/seller system plus the
   main marketing site, reachable from any page without going back through
   the portal first. Skips silently (no error) on any page whose topbar
   doesn't use the standard .topbar/.brand markup, since a handful of free
   tool pages have their own header layout. */
function mountSiteDrawer(mount, base, siteRoot) {
  if (document.getElementById('vtSiteDrawer')) return; // already mounted (e.g. re-render)
  const topbar = mount.closest('.topbar');
  if (!topbar) return;

  const sectionStyle = 'padding:16px 18px 6px;font-family:var(--font-mono,monospace);font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:#8A8171';
  const itemStyle = 'display:block;padding:9px 18px;font-size:14px;color:#1F1B16;text-decoration:none';

  const hamburgerWrap = document.createElement('button');
  hamburgerWrap.id = 'vtHamburgerBtn';
  hamburgerWrap.title = 'Full site menu';
  hamburgerWrap.style.cssText = 'background:transparent;border:none;font-size:22px;cursor:pointer;color:inherit;padding:4px 12px 4px 0;line-height:1;font-family:inherit';
  hamburgerWrap.innerHTML = '&#9776;';

  const brand = topbar.querySelector('.brand');
  if (brand && brand.parentNode) brand.parentNode.insertBefore(hamburgerWrap, brand);
  else topbar.insertBefore(hamburgerWrap, topbar.firstChild);

  const drawer = document.createElement('div');
  drawer.id = 'vtSiteDrawer';
  drawer.style.cssText = 'display:none;position:fixed;inset:0;z-index:20000;font-family:system-ui,sans-serif';
  drawer.innerHTML = `
    <div id="vtSiteDrawerBackdrop" style="position:absolute;inset:0;background:rgba(20,15,10,0.4)"></div>
    <div style="position:absolute;left:0;top:0;bottom:0;width:290px;max-width:85vw;background:#FBF6EC;color:#1F1B16;box-shadow:6px 0 30px rgba(0,0,0,0.25);overflow-y:auto">
      <div style="display:flex;align-items:center;justify-content:space-between;padding:16px 18px;border-bottom:1px solid #E4D8BD;background:#fff">
        <b style="font-size:15px">VISUTRA</b>
        <button id="vtSiteDrawerClose" style="background:none;border:none;font-size:22px;cursor:pointer;color:inherit;line-height:1">&times;</button>
      </div>
      <div style="padding:6px 0 22px">
        <a href="${siteRoot}index.html" style="${itemStyle}">&#8962;&nbsp;&nbsp;Home</a>
        <a href="${base}account.html" style="${itemStyle}">Profile (My Account)</a>
        <a href="${base}portal.html" style="${itemStyle}">Business Portal</a>

        <div style="${sectionStyle}">Buyer</div>
        ${VT_BUYER_NAV.map(function (item) { return '<a href="' + base + item.href + '" style="' + itemStyle + '">' + item.label + '</a>'; }).join('')}

        <div style="${sectionStyle}">Seller</div>
        <a href="${base}app.html" style="${itemStyle}">GST Billing</a>
        <a href="${base}app.html?view=purchases" style="${itemStyle}">Purchase Entry</a>
        <a href="${base}app.html?view=stock" style="${itemStyle}">Stock Management</a>
        <a href="${base}app.html?view=purchase-gstr" style="${itemStyle}">Purchase GST Summary</a>
        <a href="${base}seller/order-receive.html" style="${itemStyle}">Order Receive</a>

        <div style="${sectionStyle}">Site</div>
        <a href="${siteRoot}free-services.html" style="${itemStyle}">Free Services for Sellers</a>
        <a href="${siteRoot}products.html" style="${itemStyle}">Products</a>
        <a href="${siteRoot}bulk-orders.html" style="${itemStyle}">Bulk Orders</a>
        <a href="${siteRoot}about.html" style="${itemStyle}">About</a>
        <a href="${siteRoot}contact.html" style="${itemStyle}">Contact</a>
      </div>
    </div>
  `;
  document.body.appendChild(drawer);

  hamburgerWrap.addEventListener('click', function (e) {
    e.stopPropagation();
    drawer.style.display = 'block';
  });
  document.getElementById('vtSiteDrawerClose').addEventListener('click', function () { drawer.style.display = 'none'; });
  document.getElementById('vtSiteDrawerBackdrop').addEventListener('click', function () { drawer.style.display = 'none'; });
}

function escapeHtmlUM(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}
