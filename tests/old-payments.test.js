// "Old Payment Data" → Monthly Profit only (never stock) + graphs + return charges + state-wise data.
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { seed, read, list, reset, pool } = require('./lib/fakesb');
const { loadPage, sleep, closeAll, B } = require('./lib/sbload');
after(async () => { closeAll(); await pool.end(); });
const U = 'users/' + B.uid;
const HOOK = 'window.__setOld=v=>{oldSheets=v;};window.__det=h=>detectSheetFormat(h);window.__setSheets=v=>{stockUploadSheets=v;};window.__agg=()=>stockAggregation;';
// Meesho "Order Payments" style sheet
const PH = ['Sub Order No', 'Order Date', 'Supplier SKU', 'Live Order Status', 'Product GST %', 'Quantity', 'Final Settlement Amount', 'Payment Date'];
// Meesho "Orders" report (no money, has the customer's state)
const OH = ['Reason for Credit Entry', 'Sub Order No', 'Order Date', 'Customer State', 'SKU', 'Quantity'];
const P = (id, date, status, qty, settle, pay = '') => [id + '_1', date, 'VST-A', status, 5, qty, settle, pay];

async function world(){
  await reset();
  await seed(U, { businessName: 'Visu trader', gstin: '09AAACR5055K1Z5', stateCode: '09', profileComplete: true, roles: { buyer: true } });
  await seed(U + '/buyerSkuMappings/bm1', { status: 'ACTIVE', productName: 'Washing Machine Cover', meeshoSku: 'VST-A', stock: 100, linkType: 'OWN', sellerId: B.uid, productId: 'own_bm1', costPrice: 100 });
}
const open = async () => { const pg = loadPage('billing/buyer/stock.html', B, { hook: HOOK, prompt: () => '' }); await sleep(1500); return pg; };
const sheet = (headers, rows, name = 'S') => ({ fileName: name + '.xlsx', sheetName: name, headers, rows, detected: null });
// feed sheets in as if "Read Files" had run, then Next → preview (→ apply)
async function old(pg, sheets, { basis = 'order', removeGst = true, fallback = '', apply = true } = {}){
  sheets.forEach(s => { s.detected = pg.w.__det(s.headers); });
  pg.w.__setOld(sheets); pg.w.eval('renderOldMapUI()');
  pg.$('oldBasis').value = basis; pg.$('oldRemoveGst').checked = removeGst; pg.$('oldFallback').value = fallback;
  await pg.w.eval('prepareOld()'); await sleep(900);
  if(apply){ await pg.w.eval('applyOld()'); await sleep(2200); }
}
const month = m => read(U + '/buyerMonthlyProfit/' + m);
const PAY = () => sheet(PH, [
  P('111111111', '2026-03-02', 'DELIVERED', 1, 168, '2026-03-10'), P('111111111', '2026-03-02', 'RTO_COMPLETE', 1, -188, '2026-04-02'),   // sold, then returned: nets −20
  P('222222222', '2026-03-05', 'DELIVERED', 2, 336, '2026-03-12'),
  P('333333333', '2026-04-01', 'CANCELLED', 1, 0),
  P('444444444', '2026-04-03', 'LOST', 1, 100, '2026-04-20'),
  P('666666666', '2026-04-09', 'DELIVERED', 1, 168, '2026-04-18')], 'payments');
const ORD = () => sheet(OH, [['DELIVERED', '111111111_1', '2026-03-02', 'UTTAR PRADESH', 'VST-A', 1], ['DELIVERED', '222222222_1', '2026-03-05', 'Maharashtra', 'VST-A', 2], ['LOST', '444444444_1', '2026-04-03', 'karnataka', 'VST-A', 1]], 'orders');

test('old payment data: each order lands in ITS OWN month, with return charges and state — and the stock is untouched', async () => {
  await world();
  const pg = await open();
  await old(pg, [PAY(), ORD()]);
  const mar = await month('2026-03'), apr = await month('2026-04');
  // March: B2 sold 2 (rev 320, cost 200 → +120); A1 sold-then-returned nets −20 → rev −19.05, no cost → −19.05
  assert.deepEqual([mar.soldUnits, mar.returnUnits, mar.revenue, mar.cogs, mar.profit, mar.returnCharges], [2, 1, 300.95, 200, 100.95, 19.05]);
  // April: D4 LOST = sold (rev 95.24, cost 100 → −4.76) + F6 sold (rev 160, cost 100 → +60)
  assert.deepEqual([apr.soldUnits, apr.returnUnits, apr.revenue, apr.cogs, apr.profit, apr.returnCharges], [2, 0, 255.24, 200, 55.24, 0]);
  // state-wise (states came from the Orders report; F6 had none)
  assert.equal(mar.byState['Uttar Pradesh'].returnUnits, 1); assert.equal(mar.byState['Uttar Pradesh'].returnCharges, 19.05);
  assert.equal(mar.byState.Maharashtra.soldUnits, 2); assert.equal(mar.byState.Maharashtra.profit, 120);
  assert.equal(apr.byState.Karnataka.profit, -4.76); assert.equal(apr.byState.Unknown.profit, 60);
  // …and NOTHING about stock: not the figure, not a movement, not a reconciliation marker
  assert.equal((await read(U + '/buyerSkuMappings/bm1')).stock, 100);
  for (const c of ['buyerStockMovements', 'buyerProcessedLabels', 'buyerReturnedLabels']) assert.equal((await list(U + '/' + c + '/')).length, 0, c + ' untouched');
  assert.match(pg.$('oldMsg').textContent, /Added to Monthly Profit: 4 order\(s\) in 2 month\(s\).*Your stock was not changed/);
  // it shows in Monthly Profit
  const rows = [...pg.$('profitMonthsTable').rows].map(r => [...r.cells].map(c => c.textContent.trim()));
  assert.deepEqual(rows[0], ['April 2026', '2', '0', '₹0.00', '₹255.24', '₹200.00', '₹55.24', '21.6%']);
  assert.deepEqual(rows[1], ['March 2026', '2', '1', '₹19.05', '₹300.95', '₹200.00', '₹100.95', '33.5%']);
});

test('uploading the same old files again changes nothing', async () => {
  await world();
  const pg = await open();
  await old(pg, [PAY(), ORD()]);
  const m1 = await month('2026-03'), n1 = (await list(U + '/buyerProfitOrders/')).length;
  await old(pg, [PAY(), ORD()]);
  const m2 = await month('2026-03');
  assert.equal(m2.profit, m1.profit); assert.equal(m2.soldUnits, m1.soldUnits); assert.equal((await list(U + '/buyerProfitOrders/')).length, n1);
  assert.match(pg.$('oldMsg').textContent, /already counted before/);
});

test('payment-date basis puts the return in the refund month; undated rows use the fallback month', async () => {
  await world();
  const pg = await open();
  await old(pg, [PAY()], { basis: 'pay' });
  assert.equal((await month('2026-04')).returnUnits, 1, 'A1 (returned 2 Apr) is counted in April');
  assert.deepEqual([(await month('2026-03')).soldUnits, (await month('2026-03')).returnUnits], [2, 0]);
  await world();
  const pg2 = await open();
  await old(pg2, [sheet(PH, [P('999999999', '', 'DELIVERED', 1, 168)], 'undated')], { fallback: '2025-12' });
  assert.equal((await month('2025-12')).profit, 60, 'no date → the month you picked');
});

test('without a fallback month, undated orders are flagged and left out (never put in a random month)', async () => {
  await world();
  const pg = await open();
  await old(pg, [sheet(PH, [P('999999999', '', 'DELIVERED', 1, 168)], 'undated')], { apply: false });
  assert.match(pg.$('oldPreviewBox').textContent, /1 order\(s\) have no date/);
  assert.equal((await list(U + '/buyerMonthlyProfit/')).length, 0);
});

test('an Orders report uploaded LATER fills the state into orders saved without one', async () => {
  await world();
  const pg = await open();
  await old(pg, [PAY()]);                                                      // payments only → every state "Unknown"
  assert.deepEqual(Object.keys((await month('2026-03')).byState), ['Unknown']);
  const pg2 = await open();
  await old(pg2, [ORD()]);                                                     // the Orders report, no money in it
  const mar = await month('2026-03'), apr = await month('2026-04');
  assert.deepEqual(Object.keys(mar.byState).sort(), ['Maharashtra', 'Uttar Pradesh']);
  assert.equal(mar.byState.Maharashtra.profit, 120);
  assert.deepEqual(Object.keys(apr.byState).sort(), ['Karnataka', 'Unknown'], 'F6 is not in the Orders report → still Unknown');
  assert.equal(mar.profit, 100.95, 'profit itself is unchanged');
});

test('the same order in old data and in Monthly Inventory Reconciliation: stock follows reconciliation, profit counted ONCE', async () => {
  await world();
  const pg = await open();
  await old(pg, [sheet(PH, [P('777777777', '2026-03-05', 'DELIVERED', 1, 168)], 'p')]);
  assert.equal((await month('2026-03')).profit, 60);
  // now the monthly reconciliation upload lists the same order
  pg.$('stockPeriod').value = '2026-03';
  const H = ['Sub Order No', 'Order Date', 'Supplier SKU', 'Live Order Status', 'Product GST %', 'Quantity', 'Final Settlement Amount'];
  pg.w.__setSheets([{ fileName: 'm.xlsx', sheetName: 'S', headers: H, rows: [['777777777_1', '2026-03-05', 'VST-A', 'DELIVERED', 5, 1, 168]], detected: pg.w.__det(H) }]);
  pg.w.eval('renderStockColumnMapUI()');
  await pg.w.eval('aggregateStockUpload()'); await sleep(700);
  await pg.w.eval('applyStockUpload()'); await sleep(1800);
  assert.equal((await read(U + '/buyerSkuMappings/bm1')).stock, 99, 'reconciliation still deducts the sale');
  assert.equal((await month('2026-03')).profit, 60, 'profit not counted twice');
  assert.equal((await month('2026-03')).soldUnits, 1);
});

test('graphs: monthly selling / profit / returns, state-wise selling / profit / returns, product profit, state table, month range', async () => {
  await world();
  const pg = await open();
  await old(pg, [PAY(), ORD()]);
  const $ = id => pg.$(id).innerHTML;
  // monthly
  assert.match($('chMonthlySales'), /Mar 2026 — Units sold: 2/); assert.match($('chMonthlySales'), /Mar 2026 — Returned \/ RTO units: 1/); assert.match($('chMonthlySales'), /Apr 2026 — Units sold: 2/);
  assert.match($('chMonthlyMoney'), /Mar 2026 — Profit: ₹101/); assert.match($('chMonthlyMoney'), /Apr 2026 — Revenue \(ex-GST\): ₹255/);
  assert.match($('chMonthlyReturns'), /Mar 2026 — Returned \/ RTO units: 1/);
  assert.match($('chMonthlyCharges'), /Mar 2026 — Return charges: ₹19/);
  // state-wise
  assert.match($('chStateSales'), /Maharashtra: 2 · ₹320/); assert.match($('chStateSales'), /Unknown: 1/);
  assert.match($('chStateProfit'), /Maharashtra: ₹120/); assert.match($('chStateProfit'), /Karnataka: −₹5/); assert.match($('chStateProfit'), /fill="#DC2626"/, 'a loss is red');
  assert.match($('chStateReturns'), /Uttar Pradesh: 1 · 100% of orders · ₹19/);
  assert.match($('chProductProfit'), /Washing Machine Cover: ₹156/);
  const states = [...pg.$('profitStatesTable').rows].map(r => [...r.cells].map(c => c.textContent.trim()));
  assert.deepEqual(states.find(r => r[0] === 'Uttar Pradesh'), ['Uttar Pradesh', '0', '1', '100%', '₹19.05', '−₹19.05', '−₹19.05', '0%']);
  assert.match(pg.$('stateHint').textContent, /1 unit\(s\) have no customer state yet/);
  // range: only April
  pg.$('profitFrom').value = '2026-04'; pg.w.renderProfitCharts();
  assert.ok(!/Mar 2026/.test($('chMonthlySales')), 'March is outside the range'); assert.match($('chMonthlySales'), /Apr 2026 — Units sold: 2/);
  assert.ok(!states.length || ![...pg.$('profitStatesTable').rows].some(r => r.cells[0].textContent.trim() === 'Maharashtra'), 'states follow the range');
});

test('empty state: no data yet shows a friendly message, not a broken chart', async () => {
  await world();
  const pg = await open();
  assert.match(pg.$('chMonthlySales').innerHTML, /No data in this period yet/);
  assert.match(pg.$('chStateSales').innerHTML, /No data in this period yet/);
  assert.match(pg.$('profitStatesTable').textContent, /No data in this period yet/);
});
