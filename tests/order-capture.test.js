// Capture order ID + customer state while labels are read/printed → used when the month's report is uploaded
// (profit / loss, state-wise selling, state-wise returns) → "Clear" frees the space but keeps every monthly figure.
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { seed, read, list, reset, pool } = require('./lib/fakesb');
const { loadPage, mkPdf, sleep, closeAll, A, B } = require('./lib/sbload');
after(async () => { closeAll(); await pool.end(); });
const UB = 'users/' + B.uid, UA = 'users/' + A.uid;
const BUYER_HOOK = 'window.__setSheets=v=>{stockUploadSheets=v;};window.__det=h=>detectSheetFormat(h);window.__setOld=v=>{oldSheets=v;};';
const pageOpts = { before: w => { w.confirm = () => true; w.emailjs = { init(){}, send: async () => ({}) }; w.pdfjsLib = { GlobalWorkerOptions: {}, getDocument: () => ({ promise: Promise.resolve({ numPages: 0 }) }) }; } };
const H = ['Sub Order No', 'Order Date', 'Supplier SKU', 'Live Order Status', 'Product GST %', 'Quantity', 'Final Settlement Amount'];
const row = (id, status, qty, settle) => [id + '_1', '2026-09-05', 'VST-A', status, 5, qty, settle];
const ORDERS = { '111111111': ['Uttar Pradesh', '09', '201206'], '222222222': ['Maharashtra', '27', '400069'], '333333333': ['Karnataka', '29', '560001'] };

async function buyerWorld(){
  await reset();
  await seed(UB, { businessName: 'Visu trader', gstin: '09AAACR5055K1Z5', stateCode: '09', profileComplete: true, roles: { buyer: true } });
  await seed(UB + '/buyerSkuMappings/bm1', { status: 'ACTIVE', productName: 'Washing Machine Cover', meeshoSku: 'VST-A', stock: 100, linkType: 'OWN', sellerUid: B.uid, sellerId: B.uid, productId: 'own_bm1', costPrice: 100 });
}
// what reading a label PDF produces (the page reads state/orderId off the label text)
const hit = (pg, id, cap) => ({ marketplace: 'MEESHO', sku: 'VST-A', qty: 1, key: 'k' + id, packKey: pg.w.packingKey('MEESHO', id + '_1'), pageHash: 'k' + id, orderId: id + '_1',
  cap: cap ? { state: cap[0], stateCode: cap[1], pin: cap[2], via: 'name' } : { state: '', stateCode: '', pin: '', via: '' } });
async function printLabels(pg, ids){ await pg.w.processHits(ids.map(id => hit(pg, id, ORDERS[id])), 1); await sleep(400); }
const month = (u, m) => read(u + '/' + (u === UB ? 'buyerMonthlyProfit/' : 'sellerMonthlyProfit/') + m);

test('BUYER: reading labels keeps one small record per order — order ID, state, state code, PIN — and only where a state was read', async () => {
  await buyerWorld();
  const pg = loadPage('billing/buyer/label-order.html', B, pageOpts); await sleep(1500);
  const hits = ['111111111', '222222222'].map(id => hit(pg, id, ORDERS[id])).concat([hit(pg, '999999999', null)]);   // the third label has no readable address
  await pg.w.processHits(hits, 1); await sleep(400);
  const caps = await list(UB + '/buyerOrderCaptures/');
  assert.equal(caps.length, 2, 'the label without a state is not stored');
  const up = caps.find(c => c.data.orderId === '111111111_1').data;
  assert.deepEqual([up.state, up.stateCode, up.pin, up.marketplace, up.month], ['Uttar Pradesh', '09', '201206', 'MEESHO', new Date().toISOString().slice(0, 7)]);
  assert.equal(caps.find(c => c.data.orderId === '111111111_1').path.split('/').pop(), pg.w.packingKey('MEESHO', '111111111_1'), 'stored under the shipment key');
  const again = await pg.w.VLS.captureOrders(B.uid, 'buyer', hits);
  assert.deepEqual([again.written, again.known], [0, 2], 're-reading the same labels writes nothing new');
});

test('BUYER monthly reconciliation: profit / loss, state-wise selling and state-wise returns use the captured states', async () => {
  await buyerWorld();
  let pg = loadPage('billing/buyer/label-order.html', B, pageOpts); await sleep(1500);
  await printLabels(pg, Object.keys(ORDERS));
  pg = loadPage('billing/buyer/stock.html', B, { hook: BUYER_HOOK, prompt: () => '' }); await sleep(1500);
  assert.match(pg.$('capCount').textContent, /3 order\(s\) stored/);
  pg.$('stockPeriod').value = '2026-09';
  pg.w.__setSheets([{ fileName: 'm.xlsx', sheetName: 'S', headers: H, detected: pg.w.__det(H), rows: [row('111111111', 'DELIVERED', 1, 168), row('222222222', 'DELIVERED', 2, 336), row('333333333', 'RTO_COMPLETE', 1, -52.5)] }]);
  pg.w.eval('renderStockColumnMapUI()');
  await pg.w.eval('aggregateStockUpload()'); await sleep(700);
  await pg.w.eval('applyStockUpload()'); await sleep(2000);
  const m = await month(UB, '2026-09');
  assert.deepEqual([m.soldUnits, m.returnUnits, m.profit, m.returnCharges], [3, 1, 130, 50], '60 + 120 − 50');
  assert.deepEqual([m.byState['Uttar Pradesh'].soldUnits, m.byState['Uttar Pradesh'].profit], [1, 60], 'state-wise SELLING');
  assert.deepEqual([m.byState.Maharashtra.soldUnits, m.byState.Maharashtra.profit], [2, 120]);
  assert.deepEqual([m.byState.Karnataka.returnUnits, m.byState.Karnataka.returnCharges, m.byState.Karnataka.profit], [1, 50, -50], 'state-wise RETURNING');
  assert.ok(!m.byState.Unknown, 'no order was left without a state');
  const kar = [...pg.$('profitStatesTable').rows].map(r => [...r.cells].map(c => c.textContent.trim())).find(r => r[0] === 'Karnataka');
  assert.deepEqual(kar, ['Karnataka', '0', '1', '100%', '₹50.00', '−₹50.00', '−₹50.00', '0%'], 'the state-wise table: 1 unit returned, 100% return rate, ₹50 return charge');
});

test('CLEAR: deletes the captured order IDs and states, keeps the monthly profit, state-wise selling and returns', async () => {
  await buyerWorld();
  let pg = loadPage('billing/buyer/label-order.html', B, pageOpts); await sleep(1500);
  await printLabels(pg, Object.keys(ORDERS));
  pg = loadPage('billing/buyer/stock.html', B, { hook: BUYER_HOOK, prompt: () => '' }); await sleep(1500);
  pg.$('stockPeriod').value = '2026-09';
  pg.w.__setSheets([{ fileName: 'm.xlsx', sheetName: 'S', headers: H, detected: pg.w.__det(H), rows: [row('111111111', 'DELIVERED', 1, 168), row('222222222', 'DELIVERED', 2, 336), row('333333333', 'RTO_COMPLETE', 1, -52.5)] }]);
  pg.w.eval('renderStockColumnMapUI()'); await pg.w.eval('aggregateStockUpload()'); await sleep(700); await pg.w.eval('applyStockUpload()'); await sleep(2000);
  const before = JSON.stringify(await month(UB, '2026-09')), rowsBefore = (await list(UB + '/buyerProfitOrders/')).length;
  await pg.w.clearCaptured(); await sleep(700);
  assert.equal((await list(UB + '/buyerOrderCaptures/')).length, 0, 'every captured order is gone');
  assert.match(pg.$('capMsg').textContent, /Cleared 3 captured order\(s\)\. Monthly profit and state-wise figures are untouched/);
  assert.equal(pg.$('capCount').textContent, 'nothing stored');
  const after = await month(UB, '2026-09');
  assert.equal(JSON.stringify(after).replace(/"updatedAt":[^,}]*,?/g, ''), before.replace(/"updatedAt":[^,}]*,?/g, ''), 'the month figures are exactly as before');
  assert.equal((await list(UB + '/buyerProfitOrders/')).length, rowsBefore, 'the per-order profit records (they stop the same report being counted twice) are kept');
  assert.equal(after.byState.Maharashtra.profit, 120);
  // the page still shows the state-wise graphs and table from the kept month totals
  assert.match(pg.$('chStateSales').innerHTML, /Maharashtra: 2/); assert.match(pg.$('profitStatesTable').textContent, /Karnataka/);
  // nothing left to clear → friendly message, no error
  await pg.w.clearCaptured(); assert.match(pg.$('capMsg').textContent, /no captured orders to clear/);
});

test('CLEAR "only those captured before this month" removes old captures and keeps this month\'s', async () => {
  await buyerWorld();
  const pg = loadPage('billing/buyer/stock.html', B, { hook: BUYER_HOOK, prompt: () => '' }); await sleep(1500);
  const now = new Date().toISOString().slice(0, 7);
  await seed(UB + '/buyerOrderCaptures/oldOne', { marketplace: 'MEESHO', orderId: '1_1', state: 'Goa', stateCode: '30', pin: '403001', month: '2025-01' });
  await seed(UB + '/buyerOrderCaptures/oldTwo', { marketplace: 'MEESHO', orderId: '2_1', state: 'Goa', stateCode: '30', pin: '403001', month: '2025-02' });
  await seed(UB + '/buyerOrderCaptures/newOne', { marketplace: 'MEESHO', orderId: '3_1', state: 'Goa', stateCode: '30', pin: '403001', month: now });
  pg.$('capScope').value = 'old'; await pg.w.clearCaptured(); await sleep(600);
  assert.deepEqual((await list(UB + '/buyerOrderCaptures/')).map(r => r.path.split('/').pop()), ['newOne']);
  assert.match(pg.$('capMsg').textContent, /Cleared 2 captured order/);
});

test('an order cleared BEFORE its report is uploaded simply shows as "Unknown" state (profit itself is still right)', async () => {
  await buyerWorld();
  let pg = loadPage('billing/buyer/label-order.html', B, pageOpts); await sleep(1500);
  await printLabels(pg, ['111111111']);
  await pg.w.VLS.clearCaptures(B.uid, 'buyer');
  pg = loadPage('billing/buyer/stock.html', B, { hook: BUYER_HOOK, prompt: () => '' }); await sleep(1500);
  pg.$('stockPeriod').value = '2026-09';
  pg.w.__setSheets([{ fileName: 'm.xlsx', sheetName: 'S', headers: H, detected: pg.w.__det(H), rows: [row('111111111', 'DELIVERED', 1, 168)] }]);
  pg.w.eval('renderStockColumnMapUI()'); await pg.w.eval('aggregateStockUpload()'); await sleep(700); await pg.w.eval('applyStockUpload()'); await sleep(1800);
  const m = await month(UB, '2026-09');
  assert.deepEqual([m.profit, Object.keys(m.byState)], [60, ['Unknown']]);
});

test('BUYER old payment data also uses the captured states, and says so', async () => {
  await buyerWorld();
  let pg = loadPage('billing/buyer/label-order.html', B, pageOpts); await sleep(1500);
  await printLabels(pg, ['111111111', '222222222']);
  pg = loadPage('billing/buyer/stock.html', B, { hook: BUYER_HOOK, prompt: () => '' }); await sleep(1500);
  const PH = [...H, 'Payment Date'];
  const sh = { fileName: 'old.xlsx', sheetName: 'S', headers: PH, rows: [[...row('111111111', 'DELIVERED', 1, 168), '2026-09-10'], [...row('222222222', 'DELIVERED', 2, 336), '2026-09-11']] };
  sh.detected = pg.w.__det(PH); pg.w.__setOld([sh]); pg.w.eval('renderOldMapUI()');
  await pg.w.eval('prepareOld()'); await sleep(900);
  assert.match(pg.$('oldPreviewBox').textContent, /2 order\(s\) from the labels you printed/);
  await pg.w.eval('applyOld()'); await sleep(2200);
  const m = await month(UB, '2026-09');
  assert.deepEqual([m.byState['Uttar Pradesh'].profit, m.byState.Maharashtra.profit], [60, 120]);
});

/* ---------------- SELLER ---------------- */
const P1 = 'prodP1aaaa', P2 = 'prodP2aaaa';
async function sellerWorld(){
  await reset();
  await seed(UA, { businessName: 'VISUTRA', gstin: '09BVHPP4321G1ZJ', stateCode: '09', state: 'Uttar Pradesh', profileComplete: true });
  await seed(UA + '/products/' + P1, { name: 'Washing Machine Cover', sku: 'VST-A', unit: 'PCS', price: 150, gstRate: 5, stock: 100, active: true });
  await seed(UA + '/products/' + P2, { name: 'Fridge Top', sku: 'VST-F', unit: 'PCS', price: 100, gstRate: 12, stock: 50, active: true });
  await seed(UA + '/purchases/purchase0001', { supplierId: 's1', supplierName: 'Supplier', date: '2026-01-10', items: [{ linkedProductId: P1, qty: 100, rate: 80, taxable: 8000 }] });   // 80 / unit
}
const sellerPage = hook => loadPage('billing/app.html', A, { ...pageOpts, hook });
const SELLER_HOOK = 'window.__setRecon=v=>{stockUploadSheets=v;};window.__det=h=>detectSheetFormat(h);window.__setSheets=v=>{spSheets=v;};';

test('SELLER monthly reconciliation records profit, return charges and state-wise figures (states from the labels printed)', async () => {
  await sellerWorld();
  const pg = sellerPage(SELLER_HOOK); await sleep(2200);
  await pg.w.VLS.captureOrders(A.uid, 'seller', Object.entries(ORDERS).map(([id, c]) => ({ marketplace: 'MEESHO', packKey: pg.w.packingKey('MEESHO', id + '_1'), orderId: id + '_1', cap: { state: c[0], stateCode: c[1], pin: c[2] } })));
  pg.w.__setRecon([{ fileName: 'm.xlsx', sheetName: 'S', headers: H, detected: pg.w.__det(H), rows: [row('111111111', 'DELIVERED', 1, 168), row('222222222', 'DELIVERED', 2, 336), row('333333333', 'RTO_COMPLETE', 1, -52.5)] }]);
  pg.w.eval('renderStockColumnMapUI()'); pg.$('stockPeriod').value = '2026-09';
  await pg.w.eval('aggregateStockUpload()'); await sleep(700);
  pg.$('stockAggMap0').value = P1;
  await pg.w.eval('applyStockUpload()'); await sleep(2200);
  const m = await month(UA, '2026-09');
  // cost 80: 168/1.05 − 80 = +80 · 320 − 160 = +160 · RTO −50 → 190
  assert.deepEqual([m.soldUnits, m.returnUnits, m.revenue, m.cogs, m.profit, m.returnCharges], [3, 1, 430, 240, 190, 50]);
  assert.deepEqual([m.byState['Uttar Pradesh'].profit, m.byState.Maharashtra.profit, m.byState.Karnataka.returnUnits, m.byState.Karnataka.returnCharges], [80, 160, 1, 50]);
  assert.match(pg.$('stockUploadMsg').textContent, /profit recorded for 3 order line\(s\): ₹190\.00/);
  assert.equal((await read(UA + '/products/' + P1)).stock, 100 - 3 + 1, 'stock follows the reconciliation exactly as before');
});

test('SELLER reconciliation: a product with NO cost yet is left out of profit (not locked in at ₹0) — set the cost, upload again', async () => {
  await sellerWorld();
  const pg = sellerPage(SELLER_HOOK); await sleep(2200);
  const H2 = ['Sub Order No', 'Order Date', 'Supplier SKU', 'Live Order Status', 'Product GST %', 'Quantity', 'Final Settlement Amount'];
  pg.w.__setRecon([{ fileName: 'm.xlsx', sheetName: 'S', headers: H2, detected: pg.w.__det(H2), rows: [['444444444_1', '2026-09-05', 'VST-F', 'DELIVERED', 12, 1, 112]] }]);
  pg.w.eval('renderStockColumnMapUI()'); pg.$('stockPeriod').value = '2026-09';
  await pg.w.eval('aggregateStockUpload()'); await sleep(700);
  pg.$('stockAggMap0').value = P2;
  await pg.w.eval('applyStockUpload()'); await sleep(1800);
  assert.match(pg.$('stockUploadMsg').textContent, /1 order line\(s\) were left out of profit because their product has no cost yet/);
  assert.equal(await month(UA, '2026-09'), undefined, 'nothing recorded');
  assert.equal((await read(UA + '/products/' + P2)).stock, 49, 'the stock part still happened');
  // set the cost, upload the same file again: profit is recorded now, stock is NOT deducted twice
  await pg.w.spSaveCost(P2, '60'); await sleep(400);
  pg.w.__setRecon([{ fileName: 'm.xlsx', sheetName: 'S', headers: H2, detected: pg.w.__det(H2), rows: [['444444444_1', '2026-09-05', 'VST-F', 'DELIVERED', 12, 1, 112]] }]);
  pg.w.eval('renderStockColumnMapUI()'); pg.$('stockPeriod').value = '2026-09';
  await pg.w.eval('aggregateStockUpload()'); await sleep(700);
  pg.$('stockAggMap0').value = P2;
  await pg.w.eval('applyStockUpload()'); await sleep(1800);
  assert.equal((await month(UA, '2026-09')).profit, 40, '112 ÷ 1.12 = 100 − 60');
  assert.equal((await read(UA + '/products/' + P2)).stock, 49, 'not deducted twice');
});

test('SELLER Profit page: e-commerce upload uses captured states; Clear keeps the monthly profit and state-wise figures', async () => {
  await sellerWorld();
  const pg = sellerPage(SELLER_HOOK); await sleep(2200);
  pg.w.activateView('profit'); await sleep(1800);
  assert.match(pg.$('spCapCount').textContent, /nothing stored/);
  await pg.w.VLS.captureOrders(A.uid, 'seller', Object.entries(ORDERS).map(([id, c]) => ({ marketplace: 'MEESHO', packKey: pg.w.packingKey('MEESHO', id + '_1'), orderId: id + '_1', cap: { state: c[0], stateCode: c[1], pin: c[2] } })));
  const PH = [...H, 'Payment Date'], sh = { fileName: 'p.xlsx', sheetName: 'S', headers: PH, rows: [[...row('111111111', 'DELIVERED', 1, 168), '2026-09-10'], [...row('222222222', 'DELIVERED', 2, 336), '2026-09-11'], [...row('333333333', 'RTO_COMPLETE', 1, -52.5), '2026-09-20']] };
  sh.detected = pg.w.__det(PH); pg.w.__setSheets([sh]); pg.w.eval('spRenderMap()');
  await pg.w.eval('spPrepare()'); await sleep(900);
  assert.match(pg.$('spPreviewBox').textContent, /3 order\(s\) from the labels you printed/);
  await pg.w.eval('spApply()'); await sleep(2600);
  const before = await month(UA, '2026-09');
  assert.deepEqual([before.byState.Maharashtra.profit, before.byState.Karnataka.returnUnits], [160, 1]);
  assert.match(pg.$('spCapCount').textContent, /3 order\(s\) stored/);
  await pg.w.spClearCaptured(); await sleep(700);
  assert.equal((await list(UA + '/sellerOrderCaptures/')).length, 0);
  assert.equal(pg.$('spCapCount').textContent, 'nothing stored');
  assert.match(pg.$('spCapMsg').textContent, /Cleared 3 captured order\(s\)/);
  const after = await month(UA, '2026-09');
  assert.equal(after.profit, before.profit); assert.equal(after.byState.Maharashtra.profit, 160); assert.equal(after.byState.Karnataka.returnCharges, before.byState.Karnataka.returnCharges);
  assert.match(pg.$('spChStateSales').innerHTML, /Maharashtra: 2/);                       // graphs unchanged after the clear
});

test('LABEL CROPPER (seller): exporting labels captures each order\'s customer state from the label text', async () => {
  await sellerWorld();
  await seed(UA + '/skuMappings/m1', { rawKey: 'led-clr-55', productId: P1, productName: 'Washing Machine Cover' });
  await seed(UA + '/buyerPackagingSizes/bag', { name: 'Poly Bag', stock: 50, minQty: 2 });
  await seed(UA + '/buyerLabelSizes/lblOld', { name: 'Old roll', stock: 100 });
  await seed(UA + '/buyerLabelSizes/paper_4x6', { name: '4 × 6 in', paperKey: '4x6', stock: 30, minQty: 5, active: true });
  const HEAD = 'Tax Invoice/Bill of Supply/Cash Memo (Original for Recipient) Sold By : VISUTRA Muradnagar Ghaziabad PAN No: ABCDE1234F GST Registration No: 09BVHPP4321G1ZJ ';
  const inv = (o, addr) => HEAD + `Order Number: ${o} Invoice Number : IN-1 Shipping Address: ${addr} Place of Supply: ${addr.split(',')[1].trim().toUpperCase()} Display Shield | B0G433K43L ( led-clr-55 ) HSN:63049291 ₹419.00 1 ₹419.00 TOTAL amazon`;
  const PAGES = ['Ship to A amazon', inv('404-1111111-1111111', 'Pooja Singh, Rajasthan, 302006'), 'Ship to B amazon', inv('404-2222222-2222222', 'Rahul Das, West Bengal, 700001')];
  const { w, $ } = loadPage('tools/label-cropper.html', A, { query: '?role=seller', before: w => {
    w.pdfjsLib = { GlobalWorkerOptions: {}, getDocument: () => ({ promise: Promise.resolve({ numPages: PAGES.length, getPage: async i => ({ getTextContent: async () => ({ items: [{ str: PAGES[i - 1] }] }), getViewport: () => ({ width: 100, height: 141 }), render: () => ({ promise: Promise.resolve() }) }) }) }) };
  } });
  const file = async (n, name) => ({ type: 'application/pdf', name, arrayBuffer: async () => (await mkPdf(n)).buffer });
  await sleep(500);
  w.document.querySelector('.vlc-plat[data-p="amazon"]').click(); await sleep(20); $('vlcOutSize').value = '4x6';
  await w.eval('handleFile')(await file(4, 'amz.pdf')); await sleep(300);
  await w.eval('processPdf')(); await sleep(600);
  const caps = await list(UA + '/sellerOrderCaptures/');
  assert.deepEqual(caps.map(c => [c.data.orderId, c.data.state, c.data.stateCode, c.data.pin]).sort(), [['404-1111111-1111111', 'Rajasthan', '08', '302006'], ['404-2222222-2222222', 'West Bengal', '19', '700001']].sort());
});
