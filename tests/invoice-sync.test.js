const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), path = require('path');
const { seed, read, list, reset, pool, makeClient } = require('./lib/fakesb');
const { loadPage, sleep, closeAll, A, B } = require('./lib/sbload');
const { validate } = require('./lib/gstr1-schema');
after(async () => { closeAll(); await pool.end(); });
const SA = 'users/' + A.uid, SB = 'users/' + B.uid;
const commit = (who, ops) => makeClient(() => who).rpc('vt_commit', { ops, pre: [] });

test('Seller tax invoice → linked buyer gets the purchase and stock in the BILL\'S month', async () => {
  await reset();
  await seed(SA, { businessName: 'VISUTRA', gstin: '09BVHPP4321G1ZJ', stateCode: '09', profileComplete: true, roles: { seller: true } });
  await seed(SB, { businessName: 'Shop', profileComplete: true, roles: { buyer: true } });
  await seed(`sellerLinks/${A.uid}_${B.uid}`, { sellerUid: A.uid, buyerUid: B.uid, status: 'ACTIVE' });
  await seed(SA + '/customers/c1', { name: 'Shop', linkedBuyerUid: B.uid });
  await seed(SA + '/customers/c2', { name: 'Walk-in' });
  await seed(SB + '/buyerSkuMappings/bm1', { status: 'ACTIVE', productName: 'My WM Cover', stock: 5, linkType: 'SELLER', sellerId: A.uid, productId: 'p1' });
  const inv = (id, extra) => commit(A, [{ op: 'set', path: SA + '/invoices/' + id, data: Object.assign({ invoiceNo: 'VT/0' + id, date: '2026-08-20', customerId: 'c1',
    business: { businessName: 'VISUTRA', gstin: '09BVHPP4321G1ZJ' }, grandTotal: 1575,
    items: [{ productId: 'p1', name: 'WM Cover', qty: 4, rate: 300, gstRate: 5, taxable: 1200, unit: 'PCS', hsn: '63079090' },
            { productId: 'p2', name: 'TV Cover', qty: 1, rate: 300, gstRate: 5, taxable: 300 }] }, extra || {}) }]);
  assert.ok(!(await inv('1')).error);
  const pur = await read(SB + '/buyerPurchases/inv-aaaaaaaa-1');
  assert.ok(pur, 'purchase created in the buyer account');
  assert.deepEqual([pur.date, pur.invoiceNo, pur.invoiceId, pur.sellerUid, pur.supplierName, pur.subtotal, pur.gstTotal], ['2026-08-20', 'VT/01', '1', A.uid, 'VISUTRA', 1500, 75]);
  assert.equal(pur.items[0].linkedSkuMappingId, 'bm1'); assert.equal(pur.items[1].linkedSkuMappingId, null);
  assert.equal((await read(SB + '/buyerSkuMappings/bm1')).stock, 9, '5 + 4');
  const mv = (await list(SB + '/buyerStockMovements/')).map(r => r.data);
  assert.deepEqual(mv.map(m => [m.type, m.qty, m.date, m.mappingId]), [['purchase-in', 4, '2026-08-20', 'bm1']], 'movement dated the bill date (August)');
  const sup = (await list(SB + '/buyerSuppliers/')).map(r => r.data);
  assert.equal(sup[0].sellerUid, A.uid, 'supplier record created for the seller');
  const note = (await list(SB + '/notifications/'))[0].data.text;
  assert.match(note, /VISUTRA issued invoice VT\/01/); assert.match(note, /stock added for 1 product\(s\) in August 2026/); assert.match(note, /1 product\(s\) aren't linked/);
  // the buyer's monthly stock report counts it in August
  const page = loadPage('billing/buyer/stock.html', B, { hook: 'window.__mf=(id,m)=>{const x=mySkuMappingsCache.find(y=>y.id===id);return ensureAllMovementsLoaded().then(mv=>monthFigures(x,m,mv));};' }); await sleep(1300);
  const aug = await page.w.__mf('bm1', '2026-08'), sep = await page.w.__mf('bm1', '2026-09');
  assert.deepEqual([aug.opening, aug.closing], [5, 9], 'August: 5 → 9'); assert.deepEqual([sep.opening, sep.closing], [9, 9]);
  // not for an unlinked customer, not twice for an order invoice
  await inv('2', { customerId: 'c2' }); await inv('3', { sourceOrderId: 'o1' });
  assert.equal(await read(SB + '/buyerPurchases/inv-aaaaaaaa-2'), undefined); assert.equal(await read(SB + '/buyerPurchases/inv-aaaaaaaa-3'), undefined);
  assert.equal((await read(SB + '/buyerSkuMappings/bm1')).stock, 9);
  // deleting the invoice (approved by the buyer) removes the purchase and its stock
  assert.ok(!(await commit(A, [{ op: 'set', path: 'invoiceDeleteRequests/d1', data: { requestedBy: 'seller', sellerUid: A.uid, buyerUid: B.uid, invoiceId: '1', invoiceNo: 'VT/01', status: 'PENDING' } }])).error);
  assert.ok(!(await commit(B, [{ op: 'update', path: 'invoiceDeleteRequests/d1', data: { status: 'ACCEPTED' } }])).error);
  assert.equal(await read(SB + '/buyerPurchases/inv-aaaaaaaa-1'), undefined);
  assert.equal((await read(SB + '/buyerSkuMappings/bm1')).stock, 5);
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
