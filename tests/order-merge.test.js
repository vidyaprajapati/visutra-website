// ONE pending order per buyer+seller: later sends are merged into it; order cost is shown;
// free-tools strip is on top of every buyer and seller page. Real SQL (RLS + guard) + real pages.
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { seed, read, list, reset, pool, makeClient } = require('./lib/fakesb');
const { loadPage, sleep, closeAll, read: readSrc, A, B, C } = require('./lib/sbload');
const UM = readSrc('billing/assets/user-menu.js');   // the harness skips it by default — these tests want the real one
after(async () => { closeAll(); await pool.end(); });
const U = 'users/' + A.uid, SB = 'users/' + B.uid;
const commit = (who, ops) => makeClient(() => who).rpc('vt_commit', { ops, pre: [] });
const denied = r => !!r.error;
const txt = pg => pg.w.document.body.textContent.replace(/\s+/g, ' ');
const pageOpts = { before: w => { w.confirm = () => true; w.emailjs = { init(){}, send: async () => ({}) }; w.pdfjsLib = { GlobalWorkerOptions: {}, getDocument: () => ({ promise: Promise.resolve({ numPages: 0 }) }) }; } };

async function world(){
  await reset();
  await seed(U, { email: A.email, businessName: 'VISUTRA', gstin: '09BVHPP4321G1ZJ', stateCode: '09', state: 'Uttar Pradesh', profileComplete: true });
  await seed(SB, { email: B.email, businessName: 'Visu trader', gstin: '09AAACR5055K1Z5', stateCode: '09', state: 'Uttar Pradesh', profileComplete: true });
  await seed(`sellerLinks/${A.uid}_${B.uid}`, { sellerUid: A.uid, buyerUid: B.uid, status: 'ACTIVE', sellerName: 'VISUTRA', sellerEmail: A.email });
  await seed(U + '/products/p1', { name: 'Washing Machine Cover', sku: 'VST-WM', unit: 'PCS', price: 300, gstRate: 5, stock: 100, active: true, buyerVisibility: true });
  await seed(U + '/products/p2', { name: 'Fridge Top', sku: 'VST-FT', unit: 'PCS', price: 100, gstRate: 12, stock: 50, active: true, buyerVisibility: true });
  await mappings(-3, -2);
}
const mappings = async (s1, s2) => {
  await seed(SB + '/buyerSkuMappings/bm1', { status: 'ACTIVE', productName: 'WM Cover', sellerId: A.uid, sellerName: 'VISUTRA', productId: 'p1', sellerProductName: 'Washing Machine Cover', sellerSku: 'VST-WM', stock: s1 });
  await seed(SB + '/buyerSkuMappings/bm2', { status: 'ACTIVE', productName: 'Fridge Top', sellerId: A.uid, sellerName: 'VISUTRA', productId: 'p2', sellerProductName: 'Fridge Top', sellerSku: 'VST-FT', stock: s2 });
};
const draft = (items, hash, date) => seed(SB + '/labelOrderDrafts/pending_' + A.uid, { date, firstDate: date, lastDate: date, dates: [date], sellerId: A.uid, sellerName: 'VISUTRA', pageHashes: [hash],
  itemsByProduct: Object.fromEntries(Object.entries(items).map(([pid, q]) => [pid, { productName: pid === 'p1' ? 'Washing Machine Cover' : 'Fridge Top', sellerSku: pid === 'p1' ? 'VST-WM' : 'VST-FT', mappingId: pid === 'p1' ? 'bm1' : 'bm2', qty: q, breakdown: { amazon: 0, meesho: q, flipkart: 0 } }])) });
// open the Label Auto Order page fresh and send whatever draft is pending
async function sendDraft(){
  const pg = loadPage('billing/buyer/label-order.html', B, pageOpts); await sleep(1500);
  await pg.w.loadDrafts(); await sleep(150);
  await pg.w.eval(`placeAutoOrder('pending_${A.uid}')`); await sleep(900);
  return pg;
}
const orders = async () => (await list('marketplaceOrders/')).map(r => ({ id: r.path.split('/').pop(), ...r.data }));

test('a later send is merged into the ONE pending order (same day or next day)', async () => {
  await world();
  await draft({ p1: 3 }, 'h1', '2026-10-25');
  await sendDraft();
  let os = await orders();
  assert.equal(os.length, 1); assert.equal(os[0].status, 'PENDING');
  const firstNo = os[0].orderNumber;
  // same buyer sends again (next day's labels, plus a second product) while the seller hasn't confirmed
  await mappings(-4, -2);
  await draft({ p1: 4, p2: 2 }, 'h2', '2026-10-26');
  const pg = await sendDraft();
  os = await orders();
  assert.equal(os.length, 1, 'still ONE order');
  const o = os[0];
  assert.equal(o.orderNumber, firstNo); assert.equal(o.status, 'PENDING'); assert.equal(o.mergedCount, 1);
  const by = Object.fromEntries(o.items.map(i => [i.productId, i]));
  assert.equal(by.p1.qty, 7); assert.equal(by.p1.marketplaceBreakdown.meesho, 7); assert.equal(by.p2.qty, 2);
  assert.equal(o.labelsFrom, '2026-10-25'); assert.equal(o.labelsDate, '2026-10-26');
  assert.match(o.note, /^Labels dispatched 25 Oct 2026 – 26 Oct 2026/);
  assert.match(pg.$('sendResultMsg').textContent, /Added to .*pending order .* has been emailed/, 'the buyer is told it was added to the pending order');
  assert.equal((await read(SB + '/processedLabels/h2')).orderId, o.id, 'labels point at the one order');
});

test('seller sees ONE order with its cost (taxable + GST at their prices) and per-item amounts', async () => {
  await world();
  await draft({ p1: 3 }, 'h1', '2026-10-25'); await sendDraft();
  await mappings(-4, -2); await draft({ p1: 4, p2: 2 }, 'h2', '2026-10-26'); await sendDraft();
  const pg = loadPage('billing/seller/order-receive.html', A, pageOpts); await sleep(1800);
  const rows = [...pg.$('ordersTable').querySelectorAll('tr')];
  assert.equal(rows.length, 1, 'one row');
  const t = rows[0].textContent.replace(/\s+/g, ' ');
  assert.match(t, /₹2,429\.00/, '7×300+5% = 2205 and 2×100+12% = 224 → taxable 2300 + GST 129');
  assert.match(t, /₹2,300\.00 \+ ₹129\.00 GST/);
  assert.match(t, /one combined order — 1 later send added/);
  assert.match(t, /Washing Machine Cover × 7.*₹2,205\.00/);
});

test('after the seller accepts, the next send is a NEW order (never changes an accepted one)', async () => {
  await world();
  await draft({ p1: 3 }, 'h1', '2026-10-25'); await sendDraft();
  const first = (await orders())[0];
  await pool.query("update public.docs set data = data || '{\"status\":\"ACCEPTED\"}' where path = $1", ['marketplaceOrders/' + first.id]);
  await mappings(-4, -2); await draft({ p1: 4 }, 'h2', '2026-10-26'); await sendDraft();
  const os = await orders();
  assert.equal(os.length, 2);
  assert.equal(os.find(o => o.id === first.id).items[0].qty, 3, 'accepted order untouched');
  assert.equal(os.find(o => o.id !== first.id).status, 'PENDING');
});

test('Place Order (manual) also merges into the pending order and shows the cost', async () => {
  await world();
  await draft({ p1: 3 }, 'h1', '2026-10-25'); await sendDraft();
  const pg = loadPage('billing/buyer/place-order.html', B, { ...pageOpts, hook: 'window.__setCart=(c)=>{cart=c;renderCart();}' }); await sleep(1500);
  pg.$('oSeller').value = A.uid; await pg.w.onSellerChange(); await sleep(500);
  pg.w.__setCart({ p2: 3, p1: 2 }); await sleep(600);
  assert.match(pg.$('cartTotal').textContent, /Order cost: ₹966\.00/, '2×300 +5% = 630, 3×100 +12% = 336');
  assert.match(pg.$('cartPendingNote').textContent, /already have a pending order/);
  await pg.w.placeOrder(); await sleep(900);
  const os = await orders();
  assert.equal(os.length, 1, 'merged, not a second order');
  const by = Object.fromEntries(os[0].items.map(i => [i.productId, i.qty]));
  assert.deepEqual([by.p1, by.p2], [5, 3]);
  assert.equal(os[0].mergedCount, 1);
});

test('orders already sent twice are combined into one with a click; the seller then sees one order', async () => {
  await world();
  const mk = (id, items, no) => seed('marketplaceOrders/' + id, { orderNumber: no, orderType: 'LABEL_AUTO', buyerUid: B.uid, buyerEmail: B.email, sellerUid: A.uid, sellerName: 'VISUTRA',
    buyerBusiness: { businessName: 'Visu trader' }, items, status: 'PENDING', note: 'Labels dispatched', labelsDate: '2026-10-25', labelsFrom: '2026-10-25' });
  await mk('o1', [{ productId: 'p1', productName: 'Washing Machine Cover', qty: 5, marketplaceBreakdown: { amazon: 0, meesho: 5, flipkart: 0 } }], 'VIS-ORD-1');
  await mk('o2', [{ productId: 'p1', productName: 'Washing Machine Cover', qty: 2, marketplaceBreakdown: { amazon: 1, meesho: 1, flipkart: 0 } }, { productId: 'p2', productName: 'Fridge Top', qty: 4 }], 'VIS-ORD-2');
  await mk('o3', [{ productId: 'p2', productName: 'Fridge Top', qty: 1 }], 'VIS-ORD-3');
  const pg = loadPage('billing/buyer/my-orders.html', B, pageOpts); await sleep(1800);
  assert.match(pg.$('mergeBanner').textContent, /VISUTRA has 3 pending orders/);
  assert.match(pg.$('ordersTable').textContent, /₹/, 'order value column');
  await pg.w.combinePending(); await sleep(900);
  const os = await orders(); const by = Object.fromEntries(os.map(o => [o.id, o]));
  assert.equal(os.filter(o => o.status === 'PENDING').length, 1);
  assert.equal(by.o1.status, 'PENDING'); assert.equal(by.o2.status, 'MERGED'); assert.equal(by.o3.status, 'MERGED');
  assert.equal(by.o2.mergedInto, 'o1');
  const q = Object.fromEntries(by.o1.items.map(i => [i.productId, i.qty]));
  assert.deepEqual([q.p1, q.p2], [7, 5]);
  assert.deepEqual(by.o1.items.find(i => i.productId === 'p1').marketplaceBreakdown, { amazon: 1, meesho: 6, flipkart: 0 });
  assert.equal(by.o1.mergedCount, 2);
  const sp = loadPage('billing/seller/order-receive.html', A, pageOpts); await sleep(1800);
  assert.equal(sp.$('ordersTable').querySelectorAll('tr').length, 1, 'seller sees ONE pending order');
  sp.$('fStatus').value = ''; sp.w.renderOrders();
  assert.equal(sp.$('ordersTable').querySelectorAll('tr').length, 1, '"All" hides the folded ones too');
  sp.$('fStatus').value = 'MERGED'; sp.w.renderOrders();
  assert.match(sp.$('ordersTable').textContent, /Merged into VIS-ORD-1/);
});

test('database rules: only the buyer, only a PENDING order, only adding items / folding into another pending order', async () => {
  await world();
  const base = { buyerUid: B.uid, sellerUid: A.uid, orderType: 'LABEL_AUTO', items: [{ productId: 'p1', qty: 1 }] };
  await seed('marketplaceOrders/m1', { ...base, status: 'PENDING', orderNumber: 'M1' });
  await seed('marketplaceOrders/m2', { ...base, status: 'PENDING', orderNumber: 'M2' });
  await seed('marketplaceOrders/m3', { ...base, status: 'ACCEPTED', orderNumber: 'M3' });
  await seed('marketplaceOrders/x1', { ...base, buyerUid: C.uid, status: 'PENDING', orderNumber: 'X1' });
  const upd = (who, id, data) => commit(who, [{ op: 'update', path: 'marketplaceOrders/' + id, data }]);
  assert.ok(!denied(await upd(B, 'm1', { items: [{ productId: 'p1', qty: 9 }], mergedCount: 1 })), 'buyer adds items to own pending order');
  assert.ok(denied(await upd(B, 'm3', { items: [{ productId: 'p1', qty: 9 }] })), 'not once accepted');
  assert.ok(denied(await upd(C, 'm1', { items: [] })), 'another buyer cannot');
  assert.ok(denied(await upd(A, 'm1', { items: [{ productId: 'p1', qty: 99 }] })), 'the seller cannot edit the buyer\'s items');
  assert.ok(denied(await upd(B, 'm1', { items: [], sellerUid: C.uid })), 'cannot change who it is addressed to');
  assert.ok(denied(await upd(B, 'm1', { status: 'ACCEPTED' })), 'buyer still cannot accept');
  assert.ok(denied(await upd(B, 'm2', { status: 'MERGED', mergedInto: 'm3' })), 'cannot fold into an accepted order');
  assert.ok(denied(await upd(B, 'm2', { status: 'MERGED', mergedInto: 'x1' })), 'cannot fold into someone else\'s order');
  assert.ok(denied(await upd(B, 'm2', { status: 'MERGED', mergedInto: 'm2' })), 'cannot fold into itself');
  assert.ok(denied(await upd(B, 'm2', { status: 'MERGED' })), 'must name the order');
  assert.ok(!denied(await upd(B, 'm2', { status: 'MERGED', mergedInto: 'm1' })), 'fold into own pending order with the same seller');
  assert.ok(denied(await commit(B, [{ op: 'delete', path: 'marketplaceOrders/m1' }])), 'orders still cannot be deleted');
});

test('free-tools strip sits at the top of the buyer and seller pages and points at the real tool pages', async () => {
  await world();
  const fs = require('fs'), path = require('path');
  for (const [pgName, who] of [['billing/app.html', A], ['billing/seller/order-receive.html', A], ['billing/buyer/my-orders.html', B], ['billing/buyer/dashboard.html', B], ['billing/buyer/label-order.html', B]]) {
    const pg = loadPage(pgName, who, { ...pageOpts, hook: UM }); await sleep(1700);   // real user-menu.js (the harness skips it)
    const bar = pg.w.document.getElementById('vtToolsBar');
    assert.ok(bar, pgName + ': tools bar present');
    assert.equal(bar.previousElementSibling.className.includes('topbar'), true, pgName + ': directly under the top bar');
    const hrefs = [...bar.querySelectorAll('a')].map(a => a.getAttribute('href'));
    assert.equal(hrefs.length, 4);
    for (const h of hrefs) {
      const target = path.resolve(path.dirname(path.join(__dirname, '..', pgName)), h);
      assert.ok(fs.existsSync(target), pgName + ': ' + h + ' exists');
    }
    assert.match(bar.textContent, /Label Studio.*Label Cropper.*GST Return Tool.*All free tools/);
  }
});

test('Label Auto Order page shows the order cost, and warns that it will be added into the pending order', async () => {
  await world();
  await draft({ p1: 3 }, 'h1', '2026-10-25');
  let pg = loadPage('billing/buyer/label-order.html', B, pageOpts); await sleep(2200);
  assert.match(pg.$('summaryBySeller').textContent, /Order cost: ₹945\.00/, '3 × 300 + 5% GST');
  assert.ok(!/already have a pending order/.test(pg.$('summaryBySeller').textContent));
  await pg.w.eval(`placeAutoOrder('pending_${A.uid}')`); await sleep(900);
  await mappings(-2, -2); await draft({ p2: 2 }, 'h2', '2026-10-26');
  pg = loadPage('billing/buyer/label-order.html', B, pageOpts); await sleep(2200);
  const t = pg.$('summaryBySeller').textContent.replace(/\s+/g, ' ');
  assert.match(t, /already have a pending order VIS-ORD-\d+-\w+ with VISUTRA.*added into it/);
  assert.match(t, /Order cost: ₹224\.00/, '2 × 100 + 12% GST');
});
