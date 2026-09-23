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

  // Highlights whichever of Buyer/Seller matches the page currently open, so
  // it's clear at a glance which "side" of the account you're looking at —
  // every billing/buyer/*.html page is Buyer, everything else under
  // billing/ (app.html, seller/*.html, account.html, portal.html) is Seller,
  // since none of those pages are usable without seller/business-side data
  // even when a buyer relationship is also involved.
  const isBuyerPage = window.location.pathname.includes('/buyer/');
  const activePillStyle = `${pillBtnStyle};background:var(--ink,#1F1B16);color:#fff;border-color:var(--ink,#1F1B16)`;

  mount.innerHTML = `
    <div style="display:flex;align-items:center;gap:8px;font-family:system-ui,sans-serif">
      <a href="${siteRoot}index.html" title="Home" style="display:flex;align-items:center;justify-content:center;width:32px;height:32px;border-radius:8px;color:inherit;text-decoration:none">${homeIconSvg}</a>

      <a href="${base}buyer/dashboard.html" class="topbar-role-link" style="${isBuyerPage ? activePillStyle : pillBtnStyle};text-decoration:none;display:inline-block">Buyer</a>
      <a href="${base}app.html" class="topbar-role-link" style="${isBuyerPage ? pillBtnStyle : activePillStyle};text-decoration:none;display:inline-block">Seller</a>

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
  { view: 'purchase-entry', href: 'buyer/purchase-entry.html', label: 'Purchase Entry' },
  { view: 'payment-entry', href: 'buyer/payment-entry.html', label: 'Payment Entry' },
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

  // Safety net: previously, an order accepted through the normal Place Order
  // flow only turned into a Purchase Entry + stock-in if the buyer happened
  // to open My Orders (the only page that ran the sweep below). Every
  // buyer/*.html page calls renderBuyerSidebar(), so hooking it in here means
  // it catches up no matter which buyer page you land on after an
  // acceptance — Dashboard, Stock, wherever — not just My Orders.
  if (typeof auth !== 'undefined' && auth && auth.currentUser) {
    runBuyerStockSweepOnce(auth.currentUser.uid);
  }
}

/* ---------------- Site-wide buyer stock sweep ----------------
   IMPORTANT: buyer-side stock is intentionally its OWN number, separate
   from the seller/Billing side's Products.stock — see BUYER-STOCK-REDESIGN.md
   for why. This sweep never reads or writes users/{uid}/products or
   users/{uid}/stockMovements (the seller/Billing inventory) — only
   users/{uid}/buyerSkuMappings (each doc IS a Buyer SKU Master product,
   with its own stock/reorderLevel fields) and users/{uid}/buyerStockMovements
   (a buyer-only movement log).

   Ported from my-orders.html's onload sweep + ensureBuyerPurchaseForOrder
   (that page still has its own copy, which still runs too — this is a
   second safety net, not a replacement, so nothing there needs to change).
   Finds ACCEPTED orders with no buyerPurchaseId yet and, for each one,
   creates the matching Purchase Entry (for GSTR/accounting — unaffected by
   this redesign) and, for any item that matches an ACTIVE Buyer SKU Master
   mapping for that seller, bumps that mapping's own stock. Items with no
   matching mapping are left alone and flagged — map them in Buyer SKU
   Master first, then stock will track from then on. Runs at most once per
   page load (see the _vtStockSweepRan guard). */
let _vtStockSweepRan = false;
function runBuyerStockSweepOnce(uid) {
  if (_vtStockSweepRan) return;
  _vtStockSweepRan = true;
  vtBuyerStockSweep(uid).catch(function (err) {
    console.error('Buyer stock sweep failed:', err);
  });
}

async function vtBuyerStockSweep(uid) {
  const [ordersSnap, mapSnap] = await Promise.all([
    db.collection('marketplaceOrders').where('buyerUid', '==', uid).where('status', '==', 'ACCEPTED').get(),
    db.collection('users').doc(uid).collection('buyerSkuMappings').where('status', '==', 'ACTIVE').get()
  ]);
  const skuMappings = mapSnap.docs.map(function (d) { return Object.assign({ id: d.id }, d.data()); });
  const pending = ordersSnap.docs
    .map(function (d) { return Object.assign({ id: d.id }, d.data()); })
    .filter(function (o) { return !o.buyerPurchaseId; });
  if (!pending.length) return;

  const flagged = [];
  for (const order of pending) {
    try {
      const { unmappedNames } = await vtEnsureBuyerPurchaseForOrder(uid, order, skuMappings);
      if (unmappedNames.length) flagged.push({ order, unmappedNames });
    } catch (err) {
      console.error('Buyer stock sweep: could not process order', order.id, err);
    }
  }
  if (flagged.length) vtShowUnmappedStockBanner(flagged);
}

// Finds the Buyer SKU Master mapping for this exact seller + their product —
// this is the ONLY thing that decides whether an order item's stock is
// trackable, replacing the old "match by product name" logic entirely.
function vtFindSkuMapping(skuMappings, sellerUid, sellerProductId) {
  return skuMappings.find(function (m) { return m.sellerId === sellerUid && m.productId === sellerProductId; }) || null;
}

async function vtEnsureBuyerPurchaseForOrder(uid, order, skuMappings) {
  const supplierId = await vtEnsureSupplierForSeller(uid, order.sellerUid, order.sellerName);
  const items = [];
  const stockIns = []; // {mappingId, productName, qty} — applied to buyerSkuMappings, never to products
  const unmappedNames = []; // items with no Buyer SKU Master mapping yet — stock can't attach for these

  for (const item of order.items) {
    const purchaseProductId = await vtEnsurePurchaseProduct(uid, order.sellerUid, item);
    const mapping = vtFindSkuMapping(skuMappings, order.sellerUid, item.productId);
    items.push({
      productId: purchaseProductId, name: item.productName, unit: item.unit || 'PCS', hsn: item.hsn || '',
      qty: item.qty, rate: item.rate || 0, gstRate: item.gstRate || 0,
      taxable: item.taxable || 0, gstAmt: item.gstAmt || 0, total: item.total || 0,
      priceMode: 'excl', linkedSkuMappingId: mapping ? mapping.id : null
    });
    if (mapping) stockIns.push({ mappingId: mapping.id, productName: mapping.productName || item.productName, qty: item.qty });
    else unmappedNames.push(item.productName);
  }

  const summary = order.invoiceSummary || {};
  const purchaseData = {
    supplierId, supplierName: order.sellerName,
    date: order.acceptedAt && order.acceptedAt.toDate ? order.acceptedAt.toDate().toISOString().slice(0, 10) : new Date().toISOString().slice(0, 10),
    items,
    subtotal: summary.subtotal || 0,
    gstTotal: (summary.cgst || 0) + (summary.sgst || 0) + (summary.igst || 0),
    grandTotal: summary.grandTotal || 0,
    orderId: order.id, orderNumber: order.orderNumber, invoiceId: order.invoiceId, invoiceNo: order.invoiceNo,
    autoCreatedFromOrder: true,
    createdAt: firebase.firestore.FieldValue.serverTimestamp()
  };
  const purRef = await db.collection('users').doc(uid).collection('buyerPurchases').add(purchaseData);

  for (const s of stockIns) {
    await db.collection('users').doc(uid).collection('buyerSkuMappings').doc(s.mappingId).update({
      stock: firebase.firestore.FieldValue.increment(s.qty),
      updatedAt: firebase.firestore.FieldValue.serverTimestamp()
    });
    await db.collection('users').doc(uid).collection('buyerStockMovements').add({
      type: 'purchase-in', mappingId: s.mappingId, productName: s.productName, qty: s.qty, date: purchaseData.date,
      note: 'Purchase from ' + order.sellerName + ' (order ' + (order.orderNumber || '') + ')',
      createdAt: firebase.firestore.FieldValue.serverTimestamp()
    });
  }

  // Same narrow, rule-guarded update the per-page copies use: a buyer may
  // only set buyerPurchaseId once, on an already-ACCEPTED order — see
  // firestore.rules — which is what stops this sweep (and the other two
  // copies of this logic) from ever double-creating a purchase for one order.
  await db.collection('marketplaceOrders').doc(order.id).update({
    buyerPurchaseId: purRef.id,
    buyerPurchaseCreatedAt: firebase.firestore.FieldValue.serverTimestamp()
  });

  return { unmappedNames };
}

async function vtEnsureSupplierForSeller(uid, sellerUid, sellerName) {
  const snap = await db.collection('users').doc(uid).collection('buyerSuppliers')
    .where('sellerUid', '==', sellerUid).limit(1).get();
  if (!snap.empty) return snap.docs[0].id;
  const ref = await db.collection('users').doc(uid).collection('buyerSuppliers').add({
    name: sellerName, sellerUid, gstin: '', address: '', stateCode: '', state: '', email: '', phone: '',
    autoCreatedFromOrder: true
  });
  return ref.id;
}

// Purchase Product record for GSTR/accounting purposes only — no longer
// carries any link into users/{uid}/products (that field is gone; stock
// tracking now happens entirely through buyerSkuMappings, looked up
// separately in vtEnsureBuyerPurchaseForOrder above).
async function vtEnsurePurchaseProduct(uid, sellerUid, item) {
  const snap = await db.collection('users').doc(uid).collection('purchaseProducts')
    .where('sellerUid', '==', sellerUid).where('sellerProductId', '==', item.productId).limit(1).get();
  if (!snap.empty) return snap.docs[0].id;
  const ref = await db.collection('users').doc(uid).collection('purchaseProducts').add({
    name: item.productName, hsn: item.hsn || '', unit: item.unit || 'PCS',
    sellerUid, sellerProductId: item.productId, autoCreatedFromOrder: true
  });
  return ref.id;
}

// Small dismissible corner banner telling the buyer which items didn't have
// a Buyer SKU Master mapping yet, so their stock couldn't be tracked.
function vtShowUnmappedStockBanner(flagged) {
  const lines = flagged.map(function (f) {
    return (f.order.orderNumber || f.order.id) + ' (' + (f.order.sellerName || 'seller') + '): ' + f.unmappedNames.join(', ');
  });
  console.warn('Stock not tracked for these items — add a Buyer SKU Master mapping for each seller+product first:\n' + lines.join('\n'));

  const bar = document.createElement('div');
  bar.style.cssText = 'position:fixed;bottom:16px;right:16px;max-width:360px;background:#FFF4E5;border:1px solid #E4B36B;color:#5A3B00;padding:12px 14px;border-radius:10px;font:13px/1.4 system-ui,sans-serif;box-shadow:0 8px 24px rgba(0,0,0,0.15);z-index:20001';
  bar.innerHTML = '<b>Stock not tracked for some items:</b><br>' + lines.map(escapeHtmlUM).join('<br>') +
    '<br><span style="color:#8A6A2E">Add a mapping for these in Buyer SKU Master so stock tracks next time.</span>' +
    '<br><button style="margin-top:8px;font:12px system-ui,sans-serif;padding:4px 10px;border-radius:6px;border:1px solid #5A3B00;background:transparent;color:#5A3B00;cursor:pointer" onclick="this.parentNode.remove()">Dismiss</button>';
  document.body.appendChild(bar);
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
        <a href="${base}app.html?view=gstr1" style="${itemStyle}">GSTR-1 Filing (Sales &amp; Purchases)</a>
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
