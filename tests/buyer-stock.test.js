const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { seed, read, list, reset, pool, makeClient } = require('./lib/fakesb');
const { loadPage, loadCore, mkPdf, sleep, closeAll, A, B, C } = require('./lib/sbload');
after(async () => { closeAll(); await pool.end(); });

const U = 'users/' + B.uid;
async function seedBuyer(){
  await reset();
  await seed(U, { businessName: 'Shop', gstin: '09AAACR5055K1Z5', stateCode: '09', profileComplete: true, roles: { buyer: true } });
}
const stock = async id => (await read(U + '/buyerSkuMappings/' + id)).stock;

test('Reconciliation: Total orders − Returns = Actual sales; stock follows actual sales', async () => {
  await seedBuyer();
  await seed(U + '/buyerSkuMappings/bm1', { status: 'ACTIVE', productName: '9kg WM Cover', meeshoSku: 'VST-A', stock: 100, linkType: 'OWN', sellerId: B.uid, productId: 'own_bm1' });
  await seed(U + '/buyerStockMovements/m0', { type: 'purchase-in', mappingId: 'bm1', qty: 102, date: '2026-08-01' });
  await seed(U + '/buyerStockMovements/m1', { type: 'sale-out', mappingId: 'bm1', qty: -1, date: '2026-09-03' });
  await seed(U + '/buyerStockMovements/m2', { type: 'sale-out', mappingId: 'bm1', qty: -1, date: '2026-09-04' });
  const { w, $ } = loadPage('billing/buyer/stock.html', B, { hook: 'window.__setSheets=v=>{stockUploadSheets=v;};window.__det=h=>detectSheetFormat(h);window.__agg=()=>stockAggregation;' }); await sleep(1300);
  for(const o of ['111111111_1', '222222222_1']) await seed(U + '/buyerProcessedLabels/' + w.labelKey('MEESHO', 'VST-A', o), { sku: 'VST-A', qty: 1 });
  const H = ['Sub Order No', 'SKU', 'Quantity', 'Reason for Credit Entry'];
  const rows = [['111111111_1', 'VST-A', 1, 'DELIVERED'], ['222222222_1', 'VST-A', 1, 'RTO_COMPLETE'], ['333333333_1', 'VST-A', 5, 'DELIVERED'], ['444444444_1', 'VST-A', 2, 'RTO_COMPLETE'], ['555555555_1', 'VST-A', 1, 'CANCELLED']];
  for(const round of [1, 2]){
    w.__setSheets([{ fileName: 'm.xlsx', sheetName: 'S', headers: H, rows, detected: w.__det(H) }]); $('stockPeriod').value = '2026-09';
    await w.eval('aggregateStockUpload()'); await sleep(500);
    const r = w.__agg()[0];
    assert.equal(r.displayKey, 'VST-A');
    assert.deepEqual([r.orders, r.returns, r.actualSales, r.cancelledQty], [9, 3, 6, 1]);
    assert.equal(r.netChange, round === 1 ? -4 : 0, round === 1 ? 'deduct 5 new sales, add back the printed-label RTO' : 'same file again changes nothing');
    const summary = [...$('reconSummaryBox').querySelector('tbody tr').children].slice(2).map(td => td.textContent.trim()).join(' ');
    assert.match(summary, round === 1 ? /102 9 3 6 1 5 1 -4 96 96/ : /102 9 3 6 6 0 0 0 96 96/);
    await w.eval('applyStockUpload()'); await sleep(500);
    assert.equal(await stock('bm1'), 96);
  }
});

test('Manual monthly update (month totals) applies only the difference', async () => {
  await seedBuyer();
  await seed(U + '/buyerSkuMappings/bm1', { status: 'ACTIVE', productName: '9kg WM Cover', stock: 100, linkType: 'OWN', sellerId: B.uid, productId: 'own_bm1' });
  await seed(U + '/buyerStockMovements/m0', { type: 'purchase-in', mappingId: 'bm1', qty: 110, date: '2026-08-01' });
  await seed(U + '/buyerStockMovements/m1', { type: 'sale-out', mappingId: 'bm1', qty: -10, date: '2026-09-05' });
  const { w, $ } = loadPage('billing/buyer/stock.html', B); await sleep(1300);
  const fill = async (sold, ret) => {
    $('manualSrMonth').value = '2026-09';
    const row = $('manualSrTable').querySelector('tr'); row.querySelector('select').value = 'bm1';
    const [s, r] = row.querySelectorAll('input'); s.value = String(sold); r.value = String(ret);
    await w.eval('refreshManualSrRows()'); await sleep(150);
    return row.querySelector('.msr-eff').textContent;
  };
  assert.match(await fill(25, 3), /^-12/);
  await w.eval('applyManualSr()'); await sleep(300);
  assert.equal(await stock('bm1'), 88);
  assert.match(await fill(25, 3), /nothing to change/);
  await w.eval('applyManualSr()'); await sleep(300);
  assert.equal(await stock('bm1'), 88, 'applying the same totals twice changes nothing');
  await fill(22, 3); await w.eval('applyManualSr()'); await sleep(300);
  assert.equal(await stock('bm1'), 91, 'lowering the sold total gives stock back');
});

test('Buyer SKU Master: "All platforms" SKU is used by Label Cropper and reconciliation', async () => {
  await seedBuyer();
  await seed(U + '/buyerSkuMappings/bm1', { status: 'ACTIVE', productName: '9kg WM Cover', linkType: 'OWN', sellerId: B.uid, productId: 'own_bm1', stock: 50 });
  await seed(U + '/buyerSkuMappings/bm2', { status: 'ACTIVE', productName: '6kg WM Cover', linkType: 'OWN', sellerId: B.uid, productId: 'own_bm2', meeshoSku: 'VST-6KG', stock: 40 });
  const m = loadPage('billing/buyer/buyer-sku-master.html', B, { hook: 'window.__t={saveMapping,onMapProductSelect};' }); await sleep(1200);
  m.$('mProductSel').value = 'bm1'; m.w.__t.onMapProductSelect(); await sleep(150);
  m.$('mAllSku').value = 'VST-WMC-9'; await m.w.__t.saveMapping(); await sleep(200);
  assert.equal((await read(U + '/buyerSkuMappings/bm1')).allSku, 'VST-WMC-9');
  m.$('mProductSel').value = 'bm2'; m.w.__t.onMapProductSelect(); await sleep(150);
  m.$('mFlipkartSku').value = 'VST-WMC-9'; await m.w.__t.saveMapping(); await sleep(150);
  assert.match(m.$('mappingMsg').textContent, /already used by "9kg WM Cover"/);
  const s = loadPage('billing/buyer/stock.html', B, { hook: 'window.__setSheets=v=>{stockUploadSheets=v;};window.__det=h=>detectSheetFormat(h);' }); await sleep(1200);
  const H = ['Order Date', 'Order ID', 'SKU Name', 'Order Status', 'Gross Units'];
  s.w.__setSheets([{ fileName: 'fk.xlsx', sheetName: 'S', headers: H, rows: [['2026-09-06', 'OD111122223333444402', 'VST-WMC-9', 'DELIVERED', 1]], detected: s.w.__det(H) }]);
  s.$('stockPeriod').value = '2026-09'; await s.w.eval('aggregateStockUpload()'); await sleep(400);
  assert.equal(s.$('stockAggTable').querySelector('select').selectedOptions[0].text, '9kg WM Cover', 'a Flipkart report finds the all-platform SKU');
});
