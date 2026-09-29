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
    w.__setSheets([{ fileName: 'm.xlsx', sheetName: 'S', headers: H, rows, detected: w.__det(H) }]); w.eval('renderStockColumnMapUI()'); $('stockPeriod').value = '2026-09';
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
  s.w.eval('renderStockColumnMapUI()');
  s.$('stockPeriod').value = '2026-09'; await s.w.eval('aggregateStockUpload()'); await sleep(400);
  assert.equal(s.$('stockAggTable').querySelector('select').selectedOptions[0].text, '9kg WM Cover', 'a Flipkart report finds the all-platform SKU');
});

test('Reconciliation: pick the platform, map unmapped SKUs into Buyer SKU Master (incl. new product), no double count', async () => {
  await seedBuyer();
  await seed(U + '/buyerSkuMappings/bm1', { status: 'ACTIVE', productName: '9kg WM Cover', meeshoSku: 'VST-A', stock: 100, linkType: 'OWN', sellerId: B.uid, productId: 'own_bm1' });
  const { w, $ } = loadPage('billing/buyer/stock.html', B, { hook: 'window.__setSheets=v=>{stockUploadSheets=v;};window.__det=h=>detectSheetFormat(h);window.__agg=()=>stockAggregation;', prompt: () => 'Fridge Cover' });
  w.prompt = () => 'Fridge Cover';
  await sleep(1300);
  // a label for the (then unmapped) SKU NEW-1 was printed earlier, order 777 → waiting in the queue
  const qKey = w.labelKey('MEESHO', 'NEW-1', '777777777_1');
  await seed(U + '/buyerUnmappedLabelSkus/' + w.VLS.queueDocId('NEW-1'), { sku: 'NEW-1', marketplace: 'MEESHO', pending: { [qKey]: { key: qKey, marketplace: 'MEESHO', sku: 'NEW-1', qty: 1, labelDone: true } } });
  const H = ['Sub Order No', 'SKU', 'Quantity', 'Reason for Credit Entry'];
  const meesho = { fileName: 'meesho.xlsx', sheetName: 'S', headers: H, detected: w.__det(H), rows: [
    ['111111111_1', 'VST-A', 5, 'DELIVERED'], ['666666666_1', 'NEW-1', 3, 'DELIVERED'], ['777777777_1', 'NEW-1', 1, 'DELIVERED'],
    ['888888888_1', 'NEW-2', 2, 'DELIVERED'], ['999999999_1', 'SKIP-1', 1, 'DELIVERED']] };
  const generic = { fileName: 'amazon.xlsx', sheetName: 'S', headers: ['Item SKU', 'Units'], detected: null, rows: [['AMZ-9', 4]] };
  w.__setSheets([meesho, generic]); w.eval('renderStockColumnMapUI()');
  assert.equal($('stockPlatform0').value, 'MEESHO', 'Meesho file detected');
  assert.equal($('stockPlatform1').value, '', 'other files ask for the platform');
  $('stockPeriod').value = '2026-09';
  await w.eval('aggregateStockUpload()'); await sleep(300);
  assert.match($('stockUploadMsg') ? $('stockUploadMsg').textContent : w.document.body.textContent, /Choose which platform/);
  $('stockColProd1').value = '0'; $('stockColQty1').value = '1'; $('stockPlatform1').value = 'AMAZON';
  await w.eval('aggregateStockUpload()'); await sleep(500);
  const idx = sku => w.__agg().findIndex(r => r.displayKey === sku);
  const selOf = sku => $('stockAggMap' + idx(sku));
  assert.equal(selOf('VST-A').value, 'bm1', 'mapped SKU found in Buyer SKU Master');
  assert.equal(w.__agg()[idx('AMZ-9')].marketplace, 'AMAZON');
  selOf('NEW-1').value = 'bm1'; w.onReconMapChange(idx('NEW-1'));
  assert.match($('stockAggMaster' + idx('NEW-1')).textContent, /will be added \(Meesho\)/);
  selOf('NEW-2').value = '__new__'; w.onReconMapChange(idx('NEW-2'));
  selOf('AMZ-9').value = 'bm1'; w.onReconMapChange(idx('AMZ-9'));
  await sleep(300);
  await w.eval('applyStockUpload()'); await sleep(800);
  const bm1 = await read(U + '/buyerSkuMappings/bm1');
  assert.equal(bm1.stock, 87, '100 − 5 − 3 − 1 (queued label, once) − 4');
  assert.match(bm1.meeshoSku, /NEW-1/); assert.equal(bm1.amazonSku, 'AMZ-9');
  const fridge = (await list(U + '/buyerSkuMappings/')).find(r => r.data.productName === 'Fridge Cover');
  assert.ok(fridge, 'new product created'); assert.equal(fridge.data.meeshoSku, 'NEW-2'); assert.equal(fridge.data.stock, -2);
  assert.equal(await read(U + '/buyerUnmappedLabelSkus/' + w.VLS.queueDocId('NEW-1')), undefined, 'queue cleared');
  assert.ok(!(await list(U + '/buyerSkuMappings/')).some(r => /SKIP-1/.test(JSON.stringify(r.data))), 'skipped SKU not saved');
});

test('Buyer SKU Master bulk upload: Platform · Product · SKU (one row per SKU)', async () => {
  await seedBuyer();
  const XL = require('xlsx');
  await seed(U + '/buyerSkuMappings/bm1', { status: 'ACTIVE', productName: '9kg WM Cover', meeshoSku: 'VST-A', stock: 100, linkType: 'OWN', sellerId: B.uid, productId: 'own_bm1' });
  await seed(U + '/buyerSkuMappings/bm2', { status: 'ACTIVE', productName: '6kg WM Cover', flipkartSku: 'FK-6', stock: 40, linkType: 'OWN', sellerId: B.uid, productId: 'own_bm2' });
  let tpl = null;
  const m = loadPage('billing/buyer/buyer-sku-master.html', B, { hook: 'window.__t={previewBulkImport,applyBulkImport,downloadSkuRowsTemplate};', before: w => {
    w.XLSX = Object.assign({}, XL, { writeFile: (wb, name) => { tpl = { name, sheets: wb.SheetNames, rows: XL.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1 }), mine: XL.utils.sheet_to_json(wb.Sheets['My products'], { header: 1 }) }; } });
  } });
  await sleep(1200);
  const { w, $ } = m;
  // a label for NEW-M1 was printed while it was unmapped
  const qKey = w.labelKey('MEESHO', 'NEW-M1', '777777777_1');
  await seed(U + '/buyerUnmappedLabelSkus/' + w.VLS.queueDocId('NEW-M1'), { sku: 'NEW-M1', marketplace: 'MEESHO', pending: { [qKey]: { key: qKey, marketplace: 'MEESHO', sku: 'NEW-M1', qty: 1, labelDone: true } } });
  // 1. template
  w.__t.downloadSkuRowsTemplate();
  assert.deepEqual(tpl.sheets, ['SKU mapping', 'How to fill', 'My products']);
  assert.deepEqual(tpl.rows[0], ['Platform', 'Product Name', 'SKU']);
  assert.ok(tpl.mine.some(r => r[0] === '9kg WM Cover'), 'template lists your products');
  // 2. upload
  const file = [['Platform', 'Product Name', 'SKU'],
    ['Meesho', '9kg WM Cover', 'NEW-M1'], ['meesho', '9kg wm cover', 'VST-A'], ['Amazon', '9kg WM Cover', 'AMZ-9, AMZ-9B'],
    ['Flipkart', 'Fridge Cover', 'FRG-1'], ['All platforms', 'Fridge Cover', 'FRG-ALL'],
    ['Flipkart', '9kg WM Cover', 'FK-6'], ['Myntra', 'X', 'M-1'], ['Meesho', '', 'S-1'], ['', '', '']];
  const put = rows => { const wb = XL.utils.book_new(); XL.utils.book_append_sheet(wb, XL.utils.aoa_to_sheet(rows), 'S'); const buf = XL.write(wb, { type: 'array', bookType: 'xlsx' });
    Object.defineProperty($('bulkFile'), 'files', { value: [{ arrayBuffer: async () => buf }], configurable: true }); };
  put(file); await w.__t.previewBulkImport();
  const summary = $('bulkSummary').textContent;
  assert.match(summary, /one row per SKU/);
  assert.match(summary, /1 new product\(s\), 1 updated, 5 SKU\(s\) to add/);
  assert.match(summary, /2 row\(s\) not read/); assert.match(summary, /Myntra/); assert.match(summary, /no product name/);
  assert.match($('bulkTable').textContent, /FK-6/, 'clashing SKU shown as skipped');
  await w.__t.applyBulkImport(); await sleep(500);
  const bm1 = await read(U + '/buyerSkuMappings/bm1');
  assert.match(bm1.meeshoSku, /VST-A/); assert.match(bm1.meeshoSku, /NEW-M1/);
  assert.equal(bm1.amazonSku, 'AMZ-9, AMZ-9B');
  assert.ok(!/FK-6/.test(bm1.flipkartSku || ''), 'SKU of another product not added');
  assert.equal(bm1.stock, 99, 'label printed earlier with NEW-M1 deducted once');
  const fridge = (await list(U + '/buyerSkuMappings/')).find(r => r.data.productName === 'Fridge Cover').data;
  assert.deepEqual([fridge.flipkartSku, fridge.allSku], ['FRG-1', 'FRG-ALL']);
  assert.equal(await read(U + '/buyerUnmappedLabelSkus/' + w.VLS.queueDocId('NEW-M1')), undefined);
  // 3. same file again → nothing to add
  put(file); await w.__t.previewBulkImport();
  assert.match($('bulkSummary').textContent, /0 new product\(s\), 0 updated, 0 SKU\(s\) to add/);
});
