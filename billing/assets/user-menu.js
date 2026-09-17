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

  mount.innerHTML = `
    <div style="display:flex;align-items:center;gap:8px;font-family:system-ui,sans-serif">
      <a href="${siteRoot}index.html" title="Home" style="display:flex;align-items:center;justify-content:center;width:32px;height:32px;border-radius:8px;color:inherit;text-decoration:none;font-size:17px">&#8962;</a>

      <div style="position:relative;display:inline-block">
        <button id="vtBuyerMenuBtn" style="${pillBtnStyle}">Buyer &#9662;</button>
        <div id="vtBuyerMenuDropdown" style="${dropdownStyle}">
          <a href="${base}buyer/my-sellers.html" style="${itemStyle}">My Sellers</a>
          <a href="${base}buyer/place-order.html" style="${itemStyle}">Place Order</a>
          <a href="${base}buyer/label-order.html" style="${itemStyle}">Label-Based Auto Order</a>
          <a href="${base}buyer/buyer-sku-master.html" style="${itemStyle}">Buyer SKU Master</a>
          <a href="${base}buyer/my-orders.html" style="${itemStyle}">My Orders</a>
        </div>
      </div>

      <div style="position:relative;display:inline-block">
        <button id="vtSellerMenuBtn" style="${pillBtnStyle}">Seller &#9662;</button>
        <div id="vtSellerMenuDropdown" style="${dropdownStyle}">
          <a href="${base}app.html" style="${itemStyle}">GST Billing</a>
          <a href="${base}app.html?view=purchases" style="${itemStyle}">Purchase Entry</a>
          <a href="${base}seller/order-receive.html" style="${itemStyle}">Order Receive</a>
        </div>
      </div>

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

  wireDropdown('vtBuyerMenuBtn', 'vtBuyerMenuDropdown');
  wireDropdown('vtSellerMenuBtn', 'vtSellerMenuDropdown');
  wireDropdown('vtUserMenuBtn', 'vtUserMenuDropdown');
  document.addEventListener('click', closeAllVtDropdowns);

  document.getElementById('vtLogoutLinkUM').addEventListener('click', function (e) {
    e.preventDefault();
    firebase.auth().signOut().then(function () { window.location.href = base + 'login.html'; });
  });

  mountSiteDrawer(mount, base, siteRoot);
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
  ['vtBuyerMenuDropdown', 'vtSellerMenuDropdown', 'vtUserMenuDropdown'].forEach(function (id) {
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
        <a href="${base}buyer/my-sellers.html" style="${itemStyle}">My Sellers</a>
        <a href="${base}buyer/place-order.html" style="${itemStyle}">Place Order</a>
        <a href="${base}buyer/label-order.html" style="${itemStyle}">Label-Based Auto Order</a>
        <a href="${base}buyer/buyer-sku-master.html" style="${itemStyle}">Buyer SKU Master</a>
        <a href="${base}buyer/my-orders.html" style="${itemStyle}">My Orders</a>

        <div style="${sectionStyle}">Seller</div>
        <a href="${base}app.html" style="${itemStyle}">GST Billing</a>
        <a href="${base}app.html?view=purchases" style="${itemStyle}">Purchase Entry</a>
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
