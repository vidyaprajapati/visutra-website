const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), path = require('path');
const { seed, read, list, reset, pool, makeClient } = require('./lib/fakesb');
const { loadPage, sleep, closeAll, A, B, read: readSrc } = require('./lib/sbload');
// user-menu.js (skipped by the page loader) holds the shared invoice-date helper — load it like the real pages do
const withMenu = pg => { pg.w.eval(readSrc('billing/assets/user-menu.js')); return pg; };
const { validate } = require('./lib/gstr1-schema');
after(async () => { closeAll(); await pool.end(); });
const SA = 'users/' + A.uid, SB = 'users/' + B.uid;
const commit = (who, ops) => makeClient(() => who).rpc('vt_commit', { ops, pre: [] });

test('Seller invoice → buyer confirms → purchase, stock and GST use the INVOICE date (not the confirm date)', async () => {
  await reset();
  await seed(SA, { businessName: 'VISUTRA', gstin: '09BVHPP4321G1ZJ', stateCode: '09', profileComplete: true, roles: { seller: true } });
  await seed(SB, { businessName: 'Shop', profileComplete: true, roles: { buyer: true } });
  await seed(`sellerLinks/${A.uid}_${B.uid}`, { sellerUid: A.uid, buyerUid: B.uid, status: 'ACTIVE' });
  await seed(SA + '/customers/c1', { name: 'Shop', linkedBuyerUid: B.uid, linkStatus: 'ACTIVE' });
  await seed(SB + '/buyerSkuMappings/bm1', { status: 'ACTIVE', productName: 'My WM Cover', stock: 5, linkType: 'SELLER', sellerId: A.uid, productId: 'p1' });
  const items = [{ productId: 'p1', productName: 'WM Cover', qty: 4, rate: 300, gstRate: 5, taxable: 1200, unit: 'PCS' }];
  // what Billing does when you save an invoice (dated 20 Aug) for a linked buyer: the invoice + a "Recorded by seller" order
  assert.ok(!(await commit(A, [{ op: 'set', path: SA + '/invoices/i1', data: { invoiceNo: 'VT/01', date: '2026-08-20', customerId: 'c1', grandTotal: 1260, items: [{ productId: 'p1', name: 'WM Cover', qty: 4, gstRate: 5, taxable: 1200 }] } }])).error);
  assert.equal((await list(SB + '/buyerPurchases/')).length, 0, 'saving the invoice alone adds nothing — the buyer confirms first (no double count)');
  assert.ok(!(await commit(A, [{ op: 'set', path: 'marketplaceOrders/o1', data: { buyerUid: B.uid, sellerUid: A.uid, sellerName: 'VISUTRA', status: 'PENDING_BUYER_CONFIRMATION', orderType: 'SELLER_RECORDED',
    orderNumber: 'VT/01', invoiceId: 'i1', invoiceNo: 'VT/01', invoiceDate: '2026-08-20', items, invoiceSummary: { subtotal: 1200, igst: 0, cgst: 30, sgst: 30, grandTotal: 1260 }, createdAt: { __ts: '2026-10-06T10:00:00.000Z' } } }])).error);
  // the buyer confirms in October
  const dash = withMenu(loadPage('billing/buyer/dashboard.html', B)); await sleep(1500);
  await dash.w.eval("respondToOrderConfirm('o1', true)"); await sleep(800);
  const pur = (await list(SB + '/buyerPurchases/'))[0].data;
  assert.deepEqual([pur.date, pur.invoiceDate, pur.invoiceNo], ['2026-08-20', '2026-08-20', 'VT/01'], 'purchase dated the bill, not the confirm date');
  assert.equal((await read(SB + '/buyerSkuMappings/bm1')).stock, 9);
  const mv = (await list(SB + '/buyerStockMovements/')).map(r => r.data);
  assert.deepEqual(mv.map(m => [m.qty, m.date]), [[4, '2026-08-20']], 'stock movement in August');
  const page = loadPage('billing/buyer/stock.html', B, { hook: 'window.__mf=(id,m)=>{const x=mySkuMappingsCache.find(y=>y.id===id);return ensureAllMovementsLoaded().then(mv=>monthFigures(x,m,mv));};' }); await sleep(1300);
  const aug = await page.w.__mf('bm1', '2026-08'), oct = await page.w.__mf('bm1', '2026-10');
  assert.deepEqual([aug.opening, aug.closing, oct.opening, oct.closing], [5, 9, 9, 9], 'counted in August');
  // My Orders shows both dates
  const mo = loadPage('billing/buyer/my-orders.html', B); await sleep(1500);
  const row = mo.$('order-row-o1').textContent.replace(/\s+/g, ' ');
  assert.match(row, /2026-08-20\s*counts in Aug 2026/); assert.match(row, /2026-10-06/);
  assert.match(mo.$('ordersTable').closest('table').querySelector('thead').textContent, /Invoice date.*GST & stock.*Generated on/);
});

test('Older order without a stored invoice date reads it from the shared invoice', async () => {
  await reset();
  await seed(SB, { businessName: 'Shop', profileComplete: true, roles: { buyer: true } });
  await seed(SB + '/buyerSkuMappings/bm1', { status: 'ACTIVE', productName: 'My WM Cover', stock: 0, linkType: 'SELLER', sellerId: A.uid, productId: 'p1' });
  await seed('public_invoices/i9', { sellerUid: A.uid, invoiceNo: 'VT/09', date: '2026-07-15' });
  await seed('marketplaceOrders/o9', { buyerUid: B.uid, sellerUid: A.uid, sellerName: 'VISUTRA', status: 'PENDING_BUYER_CONFIRMATION', orderType: 'SELLER_RECORDED', orderNumber: 'VT/09', invoiceId: 'i9', invoiceNo: 'VT/09',
    items: [{ productId: 'p1', productName: 'WM Cover', qty: 2, rate: 300, gstRate: 5, taxable: 600 }], invoiceSummary: { subtotal: 600, grandTotal: 630 } });
  const dash = withMenu(loadPage('billing/buyer/dashboard.html', B)); await sleep(1500);
  await dash.w.eval("respondToOrderConfirm('o9', true)"); await sleep(800);
  assert.equal((await list(SB + '/buyerPurchases/'))[0].data.date, '2026-07-15');
});

test('One-time clean-up: duplicate auto purchases removed (stock reversed); old order purchases moved to the invoice date', async () => {
  await reset();
  await seed(SB + '/buyerSkuMappings/bm1', { status: 'ACTIVE', productName: 'My WM Cover', stock: 13 });
  // a duplicate made by the removed automatic step (the same invoice also has an order)
  await seed(SB + '/buyerPurchases/inv-dup', { autoCreatedFromInvoice: true, invoiceId: 'i1', invoiceNo: 'VT/01', date: '2026-08-20', items: [{ name: 'WM Cover', qty: 4, linkedSkuMappingId: 'bm1' }] });
  await seed('marketplaceOrders/o1', { buyerUid: B.uid, sellerUid: A.uid, status: 'ACCEPTED', invoiceId: 'i1', orderNumber: 'VT/01' });
  // an order purchase dated the acceptance day (Oct) for an invoice dated 20 Sep
  await seed(SA + '/invoices/i2', { invoiceNo: 'VT/02', date: '2026-09-20' });
  await seed('marketplaceOrders/o2', { buyerUid: B.uid, sellerUid: A.uid, status: 'ACCEPTED', invoiceId: 'i2', orderNumber: 'VT/02' });
  await seed(SB + '/buyerPurchases/bp2', { autoCreatedFromOrder: true, orderId: 'o2', invoiceId: 'i2', orderNumber: 'VT/02', date: '2026-10-06', items: [{ qty: 3, linkedSkuMappingId: 'bm1' }] });
  await seed(SB + '/buyerStockMovements/m2', { type: 'purchase-in', mappingId: 'bm1', qty: 3, date: '2026-10-06', note: 'Purchase from VISUTRA (order VT/02)' });
  await pool.query(require('fs').readFileSync(require('path').join(__dirname, '..', 'supabase', 'schema.sql'), 'utf8'));
  assert.equal(await read(SB + '/buyerPurchases/inv-dup'), undefined, 'duplicate removed');
  assert.equal((await read(SB + '/buyerSkuMappings/bm1')).stock, 9, 'its stock reversed: 13 − 4');
  assert.equal((await read(SB + '/buyerPurchases/bp2')).date, '2026-09-20', 'moved to the invoice date');
  assert.equal((await read(SB + '/buyerStockMovements/m2')).date, '2026-09-20', 'its stock movement too');
});

test('Amazon GST Ready-to-File report (real file) → GSTR-1 JSON through the GST Return Tool page', async () => {
  await reset();
  await seed(SA, { businessName: 'VISUTRA', gstin: '09BVHPP4321G1ZJ', stateCode: '09', profileComplete: true, roles: { seller: true } });
  const saved = [];
  const { w, $ } = loadPage('tools/gst-return-tool.html', A, { before: w => { w.confirm = () => true; } }); await sleep(600);
  w.VTGst.downloadJson = (o, n) => saved.push({ o: JSON.parse(JSON.stringify(o)), n });
  const buf = fs.readFileSync(path.join(__dirname, 'fixtures', 'amazon-gstr1-ready-JULY-SEPTEMBER-2026.xlsx'));
  const file = new w.File([buf], 'GSTR1-JULY-SEPTEMBER-2026-ARSQMBH2BEV54-09BVHPP4321G1ZJ.xlsx');
  // (the test browser's FileReader gives SheetJS data it can't parse; a real browser doesn't — hand it the bytes)
  w.readFileAsWorkbook = () => Promise.resolve(w.XLSX.read(buf, { type: 'buffer' }));
  w.handleFiles([file]); await sleep(800);
  assert.match($('fileList').textContent, /Amazon · GST Ready-to-File report/);
  assert.equal($('gstin').value, '09BVHPP4321G1ZJ', 'GSTIN picked up from the report');
  $('generateBtn').disabled = false; $('generateBtn').click(); await sleep(500);
  assert.equal($('gstPeriod').value, '2026-09', 'quarter Jul–Sep → return period 092026');
  assert.match($('gstToolChecks').textContent, /taxable ₹59,701 \(net of credit notes\)/);
  assert.match($('gstToolChecks').textContent, /0% GST/);
  $('downloadJsonBtn').click(); await sleep(200);
  const j = saved[0].o;
  assert.ok(validate(j), JSON.stringify(validate.errors));
  assert.equal(j.fp, '092026');
  assert.equal(j.b2b.reduce((a, c) => a + c.inv.length, 0), 8);
  assert.equal(j.cdnr.reduce((a, c) => a + c.nt.length, 0), 3);
  const hsn = [...j.hsn.hsn_b2b, ...j.hsn.hsn_b2c];
  assert.equal(hsn.reduce((a, h) => a + h.txval, 0), 59701, 'HSN split keeps the total');
  assert.equal(j.supeco.clttx[0].suppval, 59701);
});

test('Flipkart "Report for GSTR-1 and GSTR-8" (real file) → GSTR-1 JSON through the GST Return Tool page', async () => {
  await reset();
  await seed(SA, { businessName: 'VISUTRA', gstin: '09BVHPP4321G1ZJ', stateCode: '09', profileComplete: true, roles: { seller: true } });
  const saved = [];
  const { w, $ } = loadPage('tools/gst-return-tool.html', A, { before: w => { w.confirm = () => true; } }); await sleep(600);
  w.VTGst.downloadJson = (o, n) => saved.push(JSON.parse(JSON.stringify(o)));
  const buf = fs.readFileSync(path.join(__dirname, 'fixtures', 'flipkart-gstr1-gstr8-report.xlsx'));
  w.readFileAsWorkbook = () => Promise.resolve(w.XLSX.read(buf, { type: 'buffer' }));
  w.handleFiles([new w.File([buf], '3e63b54a-4253-46e0-9f1b-8783f3f239fe_1791296551000.xlsx')]); await sleep(800);
  assert.match($('fileList').textContent, /Flipkart · GST report \(GSTR-1 & GSTR-8\)/);
  assert.equal($('gstin').value, '09BVHPP4321G1ZJ');
  $('gstPeriod').value = '2026-09';
  $('generateBtn').disabled = false; $('generateBtn').click(); await sleep(500);
  assert.match($('gstToolChecks').textContent, /doesn't say which month it covers/);
  $('downloadJsonBtn').click(); await sleep(200);
  const j = saved[0];
  assert.ok(validate(j), JSON.stringify(validate.errors));
  assert.equal(r2(j.b2cs.reduce((a, x) => a + x.txval, 0)), 4526.93, '7(A)(2) + 7(B)(2) net taxable');
  assert.equal(r2(j.b2cs.reduce((a, x) => a + (x.iamt || 0), 0)), 199.97, 'IGST exactly as Flipkart');
  assert.deepEqual(j.b2cs.find(x => x.sply_ty === 'INTRA'), { sply_ty: 'INTRA', pos: '09', typ: 'E', etin: '09AACCF0683K1ZF', txval: 527.88, rt: 5, camt: 13.2, samt: 13.2, csamt: 0 });
  assert.ok(j.b2cs.find(x => x.pos === '36') && j.b2cs.find(x => x.pos === '29'), 'IN-TS → 36, IN-KA → 29');
  assert.ok(!j.b2cs.find(x => x.pos === '21'), 'fully returned state (Odisha) left out');
  assert.deepEqual(j.doc_issue.doc_det[0].docs[0], { num: 1, from: 'LWAB4JO270000293', to: 'LWAB4JO270000326', totnum: 34, cancel: 0, net_issue: 34 });
  assert.deepEqual(j.hsn.hsn_b2c.map(h => [h.hsn_sc, h.qty, h.rt, h.txval]), [['63049291', 25, 5, 4526.93]]);
  assert.equal(j.supeco.clttx[0].etin, '09AACCF0683K1ZF'); assert.equal(j.supeco.clttx[0].suppval, 4526.93);
});
function r2(n){ return Math.round(n * 100) / 100; }
