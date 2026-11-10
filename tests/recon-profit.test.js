// Monthly Inventory Reconciliation: Return / RTO stock add-back, LOST handling, and monthly profit.
// Real upload path (detect → aggregate → apply) against the real database rules.
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { seed, read, list, reset, pool } = require('./lib/fakesb');
const { loadPage, sleep, closeAll, B } = require('./lib/sbload');
after(async () => { closeAll(); await pool.end(); });
const U = 'users/' + B.uid;
const HOOK = 'window.__setSheets=v=>{stockUploadSheets=v;};window.__det=h=>detectSheetFormat(h);window.__agg=()=>stockAggregation;';
const H = ['Sub Order No', 'Order Date', 'Supplier SKU', 'Live Order Status', 'Product GST %', 'Quantity', 'Final Settlement Amount'];
const stock = async () => (await read(U + '/buyerSkuMappings/bm1')).stock;
const monthDoc = m => read(U + '/buyerMonthlyProfit/' + m);

async function world(mapping){
  await reset();
  await seed(U, { businessName: 'Visu trader', gstin: '09AAACR5055K1Z5', stateCode: '09', profileComplete: true, roles: { buyer: true } });
  await seed(U + '/buyerSkuMappings/bm1', { status: 'ACTIVE', productName: 'Washing Machine Cover', meeshoSku: 'VST-A', stock: 100, linkType: 'OWN', sellerId: B.uid, productId: 'own_bm1', costPrice: 100, ...mapping });
}
const open = async () => { const pg = loadPage('billing/buyer/stock.html', B, { hook: HOOK, prompt: () => '' }); await sleep(1500); return pg; };
// run one upload through Read → Match → (Apply)
async function upload(pg, rows, { month = '2026-09', addAll = true, removeGst = true, header = H, apply = true } = {}){
  pg.$('stockPeriod').value = month;
  pg.w.__setSheets([{ fileName: 'meesho.xlsx', sheetName: 'Order Payments', headers: header, rows, detected: pg.w.__det(header) }]);
  pg.w.eval('renderStockColumnMapUI()');
  pg.$('reconAddAllReturns').checked = addAll; pg.$('reconRemoveGst').checked = removeGst;
  await pg.w.eval('aggregateStockUpload()'); await sleep(700);
  if(apply){ await pg.w.eval('applyStockUpload()'); await sleep(1500); }
}
const O = (id, status, qty, settle, gst = 5) => [id + '_1', '2026-09-05', 'VST-A', status, gst, qty, settle];

test('profit and stock from one Meesho payment file: sales, RTO added back, LOST not added back, cancelled ignored', async () => {
  await world();
  const pg = await open();
  await upload(pg, [
    O('111111111', 'DELIVERED', 1, 168),        // revenue 168/1.05 = 160.00, cost 100   → +60.00
    O('222222222', 'DELIVERED', 2, 336),        // revenue 320.00, cost 200              → +120.00
    O('333333333', 'RTO_COMPLETE', 1, -52.5),   // revenue −50.00, item back on shelf, no cost → −50.00
    O('444444444', 'CANCELLED', 1, 0),          // ignored
    O('555555555', 'LOST', 1, 100)              // paid 100 (compensation): revenue 95.24, cost 100 → −4.76, never added back
  ]);
  assert.equal(await stock(), 97, '100 − 1 − 2 − 1 (LOST stays gone) + 1 (RTO back on the shelf)');
  const m = await monthDoc('2026-09');
  assert.deepEqual([m.soldUnits, m.returnUnits], [4, 1]);
  assert.equal(m.revenue, 525.24, '160 + 320 − 50 + 95.24');
  assert.equal(m.cogs, 400, '100 + 200 + 0 + 100');
  assert.equal(m.profit, 125.24);
  assert.equal(m.returnCharges, 50, 'the RTO cost you 52.50 incl. GST = 50.00 ex-GST');
  assert.equal(m.margin, 23.8);
  assert.equal(m.byProduct.bm1.profit, 125.24);
  assert.equal(m.byPlatform.MEESHO.soldUnits, 4);
  assert.match(pg.$('stockUploadMsg').textContent, /1 returned \/ RTO unit\(s\) added back to stock even though this system had not deducted/);
  assert.match(pg.$('stockUploadMsg').textContent, /profit recorded for 4 order line\(s\): ₹125\.24/);
  // the Monthly Profit table shows it
  assert.deepEqual([...pg.$('profitMonthsTable').rows[0].cells].map(c => c.textContent.trim()), ['September 2026', '4', '1', '₹50.00', '₹525.24', '₹400.00', '₹125.24', '23.8%']);
  assert.deepEqual([...pg.$('profitProductsTable').rows[0].cells].map(c => c.textContent.trim()), ['Washing Machine Cover', '4', '1', '₹50.00', '₹525.24', '₹400.00', '₹125.24', '23.8%']);
});

test('uploading the same report again changes nothing — no stock, no profit counted twice', async () => {
  await world();
  const pg = await open();
  const rows = [O('111111111', 'DELIVERED', 1, 168), O('222222222', 'DELIVERED', 2, 336), O('333333333', 'RTO_COMPLETE', 1, -52.5)];
  await upload(pg, rows);
  const s1 = await stock(), m1 = await monthDoc('2026-09');
  const lines1 = (await list(U + '/buyerProfitOrders/')).length;
  await upload(pg, rows);
  assert.equal(await stock(), s1, 'stock the same');
  const m2 = await monthDoc('2026-09');
  assert.equal(m2.profit, m1.profit); assert.equal(m2.soldUnits, m1.soldUnits); assert.equal(m2.returnUnits, m1.returnUnits);
  assert.equal((await list(U + '/buyerProfitOrders/')).length, lines1, 'no new order records');
  assert.match(pg.$('stockUploadMsg').textContent, /already recorded|Stock updated/);
});

test('the preview shows profit BEFORE applying, with the cost per unit editable (and remembered)', async () => {
  await world({ costPrice: 0 });                       // no cost known yet
  const pg = await open();
  await upload(pg, [O('111111111', 'DELIVERED', 1, 168)], { apply: false });
  const box = pg.$('reconSummaryBox').textContent.replace(/\s+/g, ' ');
  assert.match(box, /type it — cost unknown/);
  assert.match(box, /Some products have no cost yet/);
  const input = pg.$('reconSummaryBox').querySelector('input[data-costkey="bm1"]');
  input.value = '100'; pg.w.onReconCostEdit(input); await sleep(900);
  assert.match(pg.$('reconSummaryBox').textContent.replace(/\s+/g, ' '), /Profit for September 2026: ₹60\.00 from 1 new order line/);
  await pg.w.eval('applyStockUpload()'); await sleep(1500);
  assert.equal((await monthDoc('2026-09')).profit, 60);
  assert.equal((await read(U + '/buyerSkuMappings/bm1')).costPrice, 100, 'the cost you typed is saved on the product');
});

test('cost per unit comes from what you were invoiced (weighted average of your purchases, ex-GST)', async () => {
  await world({ costPrice: 0 });
  await seed(U + '/buyerPurchases/p1', { date: '2026-08-01', items: [{ linkedSkuMappingId: 'bm1', qty: 3, rate: 90, taxable: 270, gstRate: 5 }] });
  await seed(U + '/buyerPurchases/p2', { date: '2026-08-10', items: [{ linkedSkuMappingId: 'bm1', qty: 1, rate: 130, taxable: 130, gstRate: 5 }, { linkedSkuMappingId: 'other', qty: 9, rate: 1, taxable: 9 }] });
  const pg = await open();
  await upload(pg, [O('111111111', 'DELIVERED', 2, 210)], { apply: false });
  const input = pg.$('reconSummaryBox').querySelector('input[data-costkey="bm1"]');
  assert.equal(input.value, '100', '(270 + 130) ÷ (3 + 1)');
  assert.match(pg.$('reconSummaryBox').textContent, /from your purchases/);
});

test('a sold order that is returned in a LATER month gives its cost back — and counts once per month', async () => {
  await world();
  const pg = await open();
  await upload(pg, [O('777777777', 'DELIVERED', 1, 168)], { month: '2026-10' });      // sold in October: +60.00
  assert.equal((await monthDoc('2026-10')).profit, 60); assert.equal(await stock(), 99);
  await upload(pg, [O('777777777', 'RTO_COMPLETE', 1, -188)], { month: '2026-11' });   // RTO in November: −188 settlement (sale reversed + fee)
  assert.equal(await stock(), 100, 'the RTO unit is back in stock');
  const nov = await monthDoc('2026-11');
  assert.equal(nov.revenue, -179.05, '−188 ÷ 1.05');
  assert.equal(nov.cogs, -100, 'the cost charged in October is given back');
  assert.equal(nov.profit, -79.05);
  assert.equal(nov.returnCharges, 19.05, 'only the fees: the 160 of sale being reversed is not a "charge"');
  // October + November together = the loss of the return fees only (−19.05)
  assert.equal(Math.round(((await monthDoc('2026-10')).profit + nov.profit) * 100) / 100, -19.05);
  // the same November file again, or the order listed again in a December file, is not counted twice
  await upload(pg, [O('777777777', 'RTO_COMPLETE', 1, -188)], { month: '2026-12' });
  assert.equal(await monthDoc('2026-12'), undefined, 'already returned earlier — nothing recorded for December');
  assert.equal(await stock(), 100);
});

test('a Meesho order listed twice (payment row + return adjustment) is ONE order, its money summed', async () => {
  await world();
  const pg = await open();
  await upload(pg, [O('888888888', 'DELIVERED', 1, 168), O('888888888', 'RTO_COMPLETE', 1, -168)]);
  const m = await monthDoc('2026-09');
  assert.deepEqual([m.soldUnits, m.returnUnits], [0, 1], 'one order, final status = return');
  assert.equal(m.revenue, 0, '168 − 168');
  assert.equal(m.profit, 0);
});

test('RTO / return stock: ticked adds every returned unit once; unticked keeps the old rule', async () => {
  for(const [addAll, expected] of [[true, 102], [false, 100]]){
    await world();
    const pg = await open();
    await upload(pg, [O('111111111', 'RTO_COMPLETE', 1, -50), O('222222222', 'RETURN', 1, -50)], { addAll });
    assert.equal(await stock(), expected, addAll ? '2 returned units back on the shelf' : 'old rule: never deducted here → no stock change');
    if(addAll){                                                       // and never twice
      await upload(pg, [O('111111111', 'RTO_COMPLETE', 1, -50), O('222222222', 'RETURN', 1, -50)], { addAll });
      assert.equal(await stock(), 102);
    }
  }
});

test('GST handling can be switched off (cash view) and the default rate is used when the file has no GST column', async () => {
  await world();
  let pg = await open();
  await upload(pg, [O('111111111', 'DELIVERED', 1, 168)], { removeGst: false });
  assert.equal((await monthDoc('2026-09')).profit, 68, '168 − 100: GST not removed');
  await world();
  pg = await open();
  const H2 = ['Sub Order No', 'Supplier SKU', 'Live Order Status', 'Quantity', 'Final Settlement Amount'];     // no GST column
  await upload(pg, [['111111111_1', 'VST-A', 'DELIVERED', 1, 168]], { header: H2 });
  assert.equal((await monthDoc('2026-09')).profit, 60, 'default 5% used: 168 ÷ 1.05 − 100');
});

test('no money column → stock still updates, profit is simply not calculated', async () => {
  await world();
  const pg = await open();
  const H3 = ['Sub Order No', 'Supplier SKU', 'Live Order Status', 'Quantity'];
  await upload(pg, [['111111111_1', 'VST-A', 'DELIVERED', 2]], { header: H3, apply: false });
  assert.match(pg.$('reconSummaryBox').textContent, /No money column was picked/);
  await pg.w.eval('applyStockUpload()'); await sleep(1500);
  assert.equal(await stock(), 98);
  assert.equal(await monthDoc('2026-09'), undefined);
  assert.match(pg.$('profitMonthsTable').textContent, /No profit recorded yet/);
});

test('Monthly Profit lists the newest month first and its months sort by date', async () => {
  await world();
  const pg = await open();
  await upload(pg, [O('111111111', 'DELIVERED', 1, 168)], { month: '2026-08' });
  await upload(pg, [O('222222222', 'DELIVERED', 1, 168)], { month: '2026-10' });
  await upload(pg, [O('333333333', 'DELIVERED', 1, 168)], { month: '2026-09' });
  const months = [...pg.$('profitMonthsTable').rows].map(r => r.cells[0].textContent.trim());
  assert.deepEqual(months, ['October 2026', 'September 2026', 'August 2026']);
  assert.match(pg.$('profitTotals').textContent, /All 3 month\(s\).*profit ₹180\.00/);
});
