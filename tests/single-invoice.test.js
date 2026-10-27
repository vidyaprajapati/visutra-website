// The story: labels printed on several days, orders forgotten / not accepted by the seller →
// ONE order to the seller and ONE invoice. Real pages, real database rules.
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { seed, read, list, reset, pool } = require('./lib/fakesb');
const { loadPage, sleep, closeAll, read: readSrc, A, B } = require('./lib/sbload');
after(async () => { closeAll(); await pool.end(); });
const U = 'users/' + A.uid, SB = 'users/' + B.uid;
const UM = readSrc('billing/assets/user-menu.js');
const opts = extra => ({ before: w => { w.confirm = () => true; w.prompt = () => null; w.emailjs = { init(){}, send: async () => ({}) }; w.pdfjsLib = { GlobalWorkerOptions: {}, getDocument: () => ({ promise: Promise.resolve({ numPages: 0 }) }) }; }, ...extra });
const orders = async () => (await list('marketplaceOrders/')).map(r => ({ id: r.path.split('/').pop(), ...r.data }));
const hitsOf = (n, tag) => Array.from({ length: n }, (_, i) => ({ marketplace: 'MEESHO', sku: 'VST-A', qty: 1, key: tag + String(i).padStart(4, '0'), packKey: 'pk' + tag + i, pageHash: tag + String(i).padStart(4, '0') }));
const qtyOf = o => o.items.find(i => i.productId === 'wm00000001').qty;

async function world(){
  await reset();
  await seed(U, { email: A.email, businessName: 'VISUTRA', gstin: '09BVHPP4321G1ZJ', stateCode: '09', state: 'Uttar Pradesh', profileComplete: true });
  await seed(SB, { email: B.email, businessName: 'Visu trader', gstin: '09AAACR5055K1Z5', stateCode: '09', state: 'Uttar Pradesh', profileComplete: true, roles: { buyer: true } });
  await seed(`sellerLinks/${A.uid}_${B.uid}`, { sellerUid: A.uid, buyerUid: B.uid, status: 'ACTIVE', sellerName: 'VISUTRA', sellerEmail: A.email });
  await seed(U + '/products/wm00000001', { name: 'Washing Machine Cover', sku: 'VST-WM', hsn: '6307', unit: 'PCS', price: 200, gstRate: 5, stock: 5000, active: true, buyerVisibility: true });
  await seed(SB + '/buyerSkuMappings/bm1', { status: 'ACTIVE', productName: 'WM Cover', sellerId: A.uid, sellerName: 'VISUTRA', productId: 'wm00000001', sellerProductName: 'Washing Machine Cover', sellerSku: 'VST-WM', meeshoSku: 'VST-A', stock: 0 });
}
const labelPage = async () => { const pg = loadPage('billing/buyer/label-order.html', B, opts()); await sleep(1800); return pg; };
const send = async pg => { await pg.w.loadDrafts(); await sleep(200); await pg.w.eval(`placeAutoOrder('pending_${A.uid}')`); await sleep(1100); };

test('forgot to order yesterday → today\'s labels join yesterday\'s; ONE order for both days', async () => {
  await world();
  // yesterday: 60 labels printed, stock came off, order NOT sent
  await seed(SB + '/buyerSkuMappings/bm1', { status: 'ACTIVE', productName: 'WM Cover', sellerId: A.uid, sellerName: 'VISUTRA', productId: 'wm00000001', sellerProductName: 'Washing Machine Cover', sellerSku: 'VST-WM', meeshoSku: 'VST-A', stock: -60 });
  await seed(SB + '/labelOrderDrafts/2026-10-26_' + A.uid, { date: '2026-10-26', sellerId: A.uid, sellerName: 'VISUTRA', pageHashes: ['old1'],
    itemsByProduct: { wm00000001: { productName: 'Washing Machine Cover', sellerSku: 'VST-WM', mappingId: 'bm1', qty: 60, breakdown: { amazon: 0, meesho: 60, flipkart: 0 } } } });
  // today: 40 more
  const pg = await labelPage();
  await pg.w.processHits(hitsOf(40, 'today'), 1); await sleep(300);
  const drafts = await list(SB + '/labelOrderDrafts/');
  assert.equal(drafts.length, 1, 'one combined draft, not one per day');
  assert.equal(drafts[0].data.itemsByProduct.wm00000001.qty, 100);
  await send(pg);
  const os = await orders();
  assert.equal(os.length, 1, 'ONE order');
  assert.equal(qtyOf(os[0]), 100, '60 (yesterday) + 40 (today), stock −100');
  assert.equal(os[0].labelsFrom, '2026-10-26');
});

test('seller has not accepted → more labels next days go into the SAME pending order → accepted once = ONE invoice, stock back to 0', async () => {
  await world();
  let pg = await labelPage();
  await pg.w.processHits(hitsOf(100, 'd1'), 1); await sleep(300); await send(pg);
  assert.equal((await orders()).length, 1);
  // next day: seller still has not accepted — 30 more labels
  pg = await labelPage();
  await pg.w.processHits(hitsOf(30, 'd2'), 1); await sleep(300); await send(pg);
  // and a third day, 20 more
  pg = await labelPage();
  await pg.w.processHits(hitsOf(20, 'd3'), 1); await sleep(300); await send(pg);
  let os = await orders();
  assert.equal(os.length, 1, 'still ONE pending order');
  assert.equal(os[0].status, 'PENDING'); assert.equal(qtyOf(os[0]), 150); assert.equal(os[0].mergedCount, 2);
  assert.equal((await read(SB + '/buyerSkuMappings/bm1')).stock, -150, 'nothing ordered twice');
  // the seller accepts: ONE invoice
  const sp = loadPage('billing/seller/order-receive.html', A, opts()); await sleep(1900);
  assert.equal(sp.$('ordersTable').querySelectorAll('tr').length, 1, 'seller sees ONE order');
  await sp.w.eval(`acceptOrder('${os[0].id}')`); await sleep(1100);
  const inv = await list(U + '/invoices/');
  assert.equal(inv.length, 1, 'exactly ONE invoice');
  assert.equal(inv[0].data.items[0].qty, 150); assert.equal(inv[0].data.subtotal, 150 * 200);
  os = await orders(); assert.equal(os[0].status, 'ACCEPTED'); assert.equal(os[0].invoiceId, inv[0].path.split('/').pop());
  assert.equal((await read(U + '/products/wm00000001')).stock, 5000 - 150);
  // buyer side: one purchase, stock exactly zero
  loadPage('billing/buyer/my-orders.html', B, opts({ hook: UM })); await sleep(2600);
  assert.equal((await list(SB + '/buyerPurchases/')).length, 1, 'one purchase entry');
  assert.equal((await read(SB + '/buyerSkuMappings/bm1')).stock, 0);
});

test('the buyer adds items while the seller has the order open → Accept refuses (no surprise quantities), then works after refresh', async () => {
  await world();
  let pg = await labelPage(); await pg.w.processHits(hitsOf(100, 'a'), 1); await sleep(300); await send(pg);
  const sp = loadPage('billing/seller/order-receive.html', A, opts()); await sleep(1900);       // seller looks at ×100
  const id = (await orders())[0].id;
  pg = await labelPage(); await pg.w.processHits(hitsOf(30, 'b'), 1); await sleep(300); await send(pg);   // buyer adds 30 meanwhile
  await sp.w.eval(`acceptOrder('${id}')`); await sleep(900);
  assert.match(sp.$('pageMsg').textContent, /buyer just added more items/);
  assert.equal((await orders())[0].status, 'PENDING', 'nothing accepted');
  assert.equal((await list(U + '/invoices/')).length, 0, 'no invoice');
  await sleep(900);                                                                              // the list refreshed itself
  assert.match(sp.$('ordersTable').textContent, /Washing Machine Cover × 130/);
  await sp.w.eval(`acceptOrder('${id}')`); await sleep(1100);
  const inv = await list(U + '/invoices/');
  assert.equal(inv.length, 1); assert.equal(inv[0].data.items[0].qty, 130);
});

test('older duplicate pending orders are combined automatically when the buyer opens any buyer page (no click)', async () => {
  await world();
  const mk = (id, qty, no) => seed('marketplaceOrders/' + id, { orderNumber: no, orderType: 'LABEL_AUTO', buyerUid: B.uid, buyerEmail: B.email, sellerUid: A.uid, sellerName: 'VISUTRA', status: 'PENDING',
    buyerBusiness: { businessName: 'Visu trader', stateCode: '09' }, labelsDate: '2026-10-25', labelsFrom: '2026-10-25', note: 'x', items: [{ productId: 'wm00000001', productName: 'Washing Machine Cover', qty }] });
  await mk('ord00000001', 100, 'VIS-ORD-A'); await mk('ord00000002', 40, 'VIS-ORD-B'); await mk('ord00000003', 10, 'VIS-ORD-C');
  const sp = loadPage('billing/seller/order-receive.html', A, opts()); await sleep(1900);
  assert.match(sp.$('dupNotice').textContent, /has 3 pending orders/, 'seller is told, and that they are combined automatically');
  loadPage('billing/buyer/my-orders.html', B, opts({ hook: UM })); await sleep(3500);          // the buyer just opens a page
  const os = await orders();
  assert.equal(os.filter(o => o.status === 'PENDING').length, 1);
  assert.equal(os.filter(o => o.status === 'MERGED').length, 2);
  assert.equal(qtyOf(os.find(o => o.status === 'PENDING')), 150);
  const sp2 = loadPage('billing/seller/order-receive.html', A, opts()); await sleep(1900);
  assert.equal(sp2.$('ordersTable').querySelectorAll('tr').length, 1);
  assert.equal(sp2.$('dupNotice').textContent.trim(), '', 'no more notice');
  await sp2.w.eval(`acceptOrder('${os.find(o => o.status === 'PENDING').id}')`); await sleep(1100);
  assert.equal((await list(U + '/invoices/')).length, 1, 'ONE invoice for all three');
});
