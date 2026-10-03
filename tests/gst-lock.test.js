const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { seed, read, list, reset, pool, makeClient } = require('./lib/fakesb');
const { loadPage, sleep, closeAll, A, B } = require('./lib/sbload');
after(async () => { closeAll(); await pool.end(); });
const SA = 'users/' + A.uid, SB = 'users/' + B.uid;
const asA = () => makeClient(() => A), asB = () => makeClient(() => B);
const commit = (c, ops) => c.rpc('vt_commit', { ops, pre: [] });
const ts = d => ({ __ts: d + 'T10:00:00.000Z' });

async function world(){
  await reset();
  await seed(SA, { businessName: 'VISUTRA', gstin: '09BVHPP4321G1ZJ', stateCode: '09', profileComplete: true, roles: { seller: true } });
  await seed(SB, { businessName: 'Shop', profileComplete: true, roles: { buyer: true } });
  await seed(`sellerLinks/${A.uid}_${B.uid}`, { sellerUid: A.uid, buyerUid: B.uid, status: 'ACTIVE' });
  await seed(SA + '/customers/c1', { name: 'Shop', linkedBuyerUid: B.uid });
  await seed(SA + '/customers/c2', { name: 'Walk-in' });
  await seed(SA + '/products/p1', { name: 'WM Cover', hsn: '63079090', unit: 'PCS', gstRate: 5, stock: 50 });
  const inv = (id, no, date, cust, extra) => seed(SA + '/invoices/' + id, Object.assign({ createdAt: ts(date), invoiceNo: no, date, customerId: cust, sameState: true, grandTotal: 315,
    customer: { name: cust === 'c1' ? 'Shop' : 'Walk-in', stateCode: '09' }, items: [{ productId: 'p1', name: 'WM Cover', hsn: '63079090', unit: 'PCS', qty: 1, rate: 300, gstRate: 5, taxable: 300 }] }, extra || {}));
  await inv('sep1', 'VT/101', '2026-09-05', 'c2');
  await inv('sep2', 'VT/102', '2026-09-06', 'c1');
  await inv('sepDel', 'VT/103', '2026-09-07', 'c2', { deleted: true });
  await inv('oct1', 'VT/104', '2026-10-02', 'c2');
  await seed(SB + '/buyerPurchases/bp2', { invoiceId: 'sep2', invoiceNo: 'VT/102', date: '2026-09-06', supplierName: 'VISUTRA', items: [{ qty: 1, linkedSkuMappingId: 'bm1' }] });
}

test('Generating GSTR-1 locks the month: no delete / restore / deletion request on either side', async () => {
  await world();
  // a request sent BEFORE the month is locked
  await seed('invoiceDeleteRequests/early', { requestedBy: 'seller', sellerUid: A.uid, buyerUid: B.uid, invoiceId: 'sep2', invoiceNo: 'VT/102', status: 'PENDING' });
  const saved = [];
  const { w, $ } = loadPage('billing/app.html', A, { before: w => { w.prompt = () => 'mistake'; } }); await sleep(1800);
  w.VTGst.downloadJson = () => saved.push(1);
  $('gstrType').value = 'monthly'; w.eval('onFilingTypeChange()'); $('gstrMonth').value = '2026-09';
  await w.eval('generateGstr1()'); await sleep(700);
  assert.match($('gstLockBox').textContent, /Not locked yet/);
  w.eval('downloadGstr1Json()'); await sleep(700);
  assert.equal((await read(SA + '/gstPeriods/2026-09')).status, 'GENERATED');
  assert.match($('gstLockBox').textContent, /September 2026: GSTR generated/);
  // seller: plain invoice in Sep can't be deleted, Oct still can
  await w.eval("activateView('invoices')"); await w.eval('loadInvoices()'); await sleep(400);
  assert.match(w.deleteActionCell('sep1', await read(SA + '/invoices/sep1'), null), /🔒 GST generated/);
  await w.eval("deleteInvoice('sep1')"); await sleep(300);
  assert.notEqual((await read(SA + '/invoices/sep1')).deleted, true, 'Sep invoice still there');
  assert.equal((await read(SA + '/products/p1')).stock, 50, 'no stock moved');
  await w.eval("deleteInvoice('oct1')"); await sleep(300);
  assert.equal((await read(SA + '/invoices/oct1')).deleted, true, 'Oct (not generated) still deletable');
  // database refuses even without the page
  const r1 = await commit(asA(), [{ op: 'update', path: SA + '/invoices/sep1', data: { deleted: true } }]);
  assert.match(r1.error.message, /VT_LOCKED: GSTR for September 2026 is already generated/);
  const r2 = await commit(asA(), [{ op: 'update', path: SA + '/invoices/sepDel', data: { deleted: false } }]);
  assert.match(r2.error.message, /can't be restored|can''t be restored|restored/, 'restoring into a generated month refused');
  // linked buyer invoice: neither side can even ask
  const r3 = await commit(asA(), [{ op: 'set', path: 'invoiceDeleteRequests/x1', data: { requestedBy: 'seller', sellerUid: A.uid, buyerUid: B.uid, invoiceId: 'sep2', status: 'PENDING' } }]);
  assert.match(r3.error.message, /already generated GSTR for September 2026/);
  const r4 = await commit(asB(), [{ op: 'set', path: 'invoiceDeleteRequests/x2', data: { requestedBy: 'buyer', sellerUid: A.uid, buyerUid: B.uid, invoiceId: 'sep2', purchaseId: 'bp2', status: 'PENDING' } }]);
  assert.match(r4.error.message, /already generated GSTR for September 2026/);
  // the early request can no longer be approved
  const r5 = await commit(asB(), [{ op: 'update', path: 'invoiceDeleteRequests/early', data: { status: 'ACCEPTED' } }]);
  assert.match(r5.error.message, /already generated GSTR/);
  assert.notEqual((await read(SA + '/invoices/sep2')).deleted, true); assert.ok(await read(SB + '/buyerPurchases/bp2'));
});

test('Re-open is possible only before filing; Mark as filed locks permanently', async () => {
  await world();
  await seed(SA + '/gstPeriods/2026-09', { status: 'GENERATED' });
  assert.ok(!(await commit(asA(), [{ op: 'delete', path: SA + '/gstPeriods/2026-09' }])).error, 're-open while only generated');
  assert.ok(!(await commit(asA(), [{ op: 'update', path: SA + '/invoices/sep1', data: { deleted: true } }])).error, 'deletable again after re-open');
  await seed(SA + '/gstPeriods/2026-09', { status: 'FILED' });
  const r = await commit(asA(), [{ op: 'delete', path: SA + '/gstPeriods/2026-09' }]);
  assert.match(r.error.message, /September 2026 is marked as filed — it can't be re-opened/);
  const r2 = await commit(asA(), [{ op: 'update', path: SA + '/gstPeriods/2026-09', data: { status: 'GENERATED' } }]);
  assert.ok(r2.error, 'cannot downgrade FILED to GENERATED');
});

test('The buyer\'s own filed month also blocks deleting that purchase', async () => {
  await world();
  await seed(SB + '/gstPeriods/2026-09', { status: 'FILED' });
  const r = await commit(asA(), [{ op: 'set', path: 'invoiceDeleteRequests/y1', data: { requestedBy: 'seller', sellerUid: A.uid, buyerUid: B.uid, invoiceId: 'sep2', status: 'PENDING' } }]);
  assert.match(r.error.message, /buyer has already filed GST for September 2026/);
  const r2 = await commit(asB(), [{ op: 'delete', path: SB + '/buyerPurchases/bp2' }]);
  assert.match(r2.error.message, /VT_LOCKED/);
  assert.ok(await read(SB + '/buyerPurchases/bp2'));
});
