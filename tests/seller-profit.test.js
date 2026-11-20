// SELLER profit: buys from suppliers → sells to buyers (invoices) + sells on e-commerce (payment files).
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { seed, read, list, reset, pool } = require('./lib/fakesb');
const { loadPage, sleep, closeAll, A } = require('./lib/sbload');
after(async () => { closeAll(); await pool.end(); });
const U = 'users/' + A.uid;
const opts = { before: w => { w.confirm = () => true; w.emailjs = { init(){}, send: async () => ({}) }; w.pdfjsLib = { GlobalWorkerOptions: {}, getDocument: () => ({ promise: Promise.resolve({ numPages: 0 }) }) }; },
  hook: 'window.__setSheets=v=>{spSheets=v;};window.__det=h=>detectSheetFormat(h);' };
const P1 = 'prodP1aaaa', P2 = 'prodP2aaaa';
const PH = ['Sub Order No', 'Order Date', 'Supplier SKU', 'Live Order Status', 'Product GST %', 'Quantity', 'Final Settlement Amount', 'Payment Date'];
const OH = ['Reason for Credit Entry', 'Sub Order No', 'Order Date', 'Customer State', 'SKU', 'Quantity'];
const pay = (id, date, status, qty, settle, payDate = '') => [id + '_1', date, 'VST-A', status, 5, qty, settle, payDate];
const cells = tr => [...tr.cells].map(c => c.textContent.trim());
const rowFor = (pg, tbody, first) => [...pg.$(tbody).rows].map(cells).find(r => r[0] === first);

async function world(){
  await reset();
  await seed(U, { businessName: 'VISUTRA', gstin: '09BVHPP4321G1ZJ', stateCode: '09', state: 'Uttar Pradesh', profileComplete: true });
  await seed(U + '/products/' + P1, { name: 'Washing Machine Cover', sku: 'VST-A', unit: 'PCS', price: 150, gstRate: 5, stock: 500, active: true });
  await seed(U + '/products/' + P2, { name: 'Fridge Top', sku: 'VST-F', unit: 'PCS', price: 100, gstRate: 12, stock: 50, active: true });
  // what you paid your supplier: Jan 100 @ 80, Mar 100 @ 100 (+ 10 fridge tops @ 50)  → average 90 from March
  await seed(U + '/purchases/purchase0001', { supplierId: 's1', supplierName: 'Supplier', date: '2026-01-10', items: [{ linkedProductId: P1, qty: 100, rate: 80, taxable: 8000 }] });
  await seed(U + '/purchases/purchase0002', { supplierId: 's1', supplierName: 'Supplier', date: '2026-03-05', items: [{ linkedProductId: P1, qty: 100, rate: 100, taxable: 10000 }, { linkedProductId: P2, qty: 10, rate: 50, taxable: 500 }] });
  // sales to buyers
  const inv = (id, date, customer, items, extra) => seed(U + '/invoices/' + id, { invoiceNo: id, date, customer, items, ...extra });
  const UP = { name: 'Raj Traders', state: 'Uttar Pradesh', stateCode: '09' }, MH = { name: 'Mumbai Mart', stateCode: '27' };
  await inv('invoice0001', '2026-02-10', UP, [{ productId: P1, name: 'Washing Machine Cover', qty: 10, taxable: 1500 }]);
  await inv('invoice0002', '2026-03-15', MH, [{ productId: P1, name: 'Washing Machine Cover', qty: 5, taxable: 750 }, { productId: P2, name: 'Fridge Top', qty: 2, taxable: 200 }]);
  await inv('invoice0003', '2026-03-20', UP, [{ productId: P1, name: 'Washing Machine Cover', qty: 1, taxable: 150 }]);
  await inv('invoice0004', '2026-03-21', UP, [{ productId: P1, name: 'Washing Machine Cover', qty: 99, taxable: 99999 }], { deleted: true });
  await inv('invoice0005', '2026-03-22', UP, [{ productId: null, name: 'Freight', qty: 1, taxable: 100 }]);
}
const open = async () => { const pg = loadPage('billing/app.html', A, opts); await sleep(2200); pg.w.activateView('profit'); await sleep(1800); return pg; };
const sheet = (headers, rows, name) => ({ fileName: name + '.xlsx', sheetName: name, headers, rows, detected: null });
async function upload(pg, sheets, o = {}){
  sheets.forEach(s => { s.detected = pg.w.__det(s.headers); });
  pg.w.__setSheets(sheets); pg.w.eval('spRenderMap()');
  pg.$('spBasis').value = o.basis || 'order'; pg.$('spFallback').value = o.fallback || '';
  await pg.w.eval('spPrepare()'); await sleep(900);
  if(o.apply !== false){ await pg.w.eval('spApply()'); await sleep(2600); }
}
const PAY = () => sheet(PH, [pay('111111111', '2026-03-02', 'DELIVERED', 1, 168, '2026-03-10'), pay('111111111', '2026-03-02', 'RTO_COMPLETE', 1, -188, '2026-04-02'),
  pay('222222222', '2026-03-05', 'DELIVERED', 2, 336, '2026-03-12'), pay('333333333', '2026-04-01', 'CANCELLED', 1, 0),
  pay('444444444', '2026-04-03', 'LOST', 1, 100, '2026-04-20'), pay('666666666', '2026-04-09', 'DELIVERED', 1, 168, '2026-04-18')], 'payments');
const ORD = () => sheet(OH, [['DELIVERED', '111111111_1', '2026-03-02', 'UTTAR PRADESH', 'VST-A', 1], ['DELIVERED', '222222222_1', '2026-03-05', 'Maharashtra', 'VST-A', 2], ['LOST', '444444444_1', '2026-04-03', 'karnataka', 'VST-A', 1]], 'orders');

test('sales to buyers: profit straight from invoices against supplier-purchase cost, by month (cancelled invoice left out)', async () => {
  await world();
  const pg = await open();
  assert.deepEqual(rowFor(pg, 'spMonthsTable', 'February 2026'), ['February 2026', '10', '₹700.00', '0', '0', '₹0.00', '₹0.00', '₹1,500.00', '₹700.00', '46.7%'], '10 × (150 − 80)');
  assert.deepEqual(rowFor(pg, 'spMonthsTable', 'March 2026'), ['March 2026', '9', '₹560.00', '0', '0', '₹0.00', '₹0.00', '₹1,200.00', '₹560.00', '46.7%'], 'cost is the average at each invoice date; the cancelled invoice is ignored');
  assert.match(pg.$('spCostWarn').textContent, /1 unit\(s\) on your invoices have no cost yet \(Freight\)/);
  assert.match(pg.$('spTotals').textContent, /profit ₹1,260\.00 \(sales to buyers ₹1,260\.00 \+ e-commerce ₹0\.00\)/);
});

test('product costs: purchase average by default, a typed cost overrides it, clearing it goes back', async () => {
  await world();
  const pg = await open();
  assert.deepEqual(rowFor(pg, 'spCostTable', 'Washing Machine Cover').slice(0, 6), ['Washing Machine Cover', '₹150.00', '', 'your purchases', '₹60.00', '40%'], '(8000 + 10000) ÷ 200 = 90');
  assert.equal([...pg.$('spCostTable').rows].find(r => r.cells[0].textContent.includes('Fridge')).querySelector('input').value, '50');
  await pg.w.spSaveCost(P1, '70'); await sleep(500);
  assert.equal((await read(U + '/products/' + P1)).costPrice, 70);
  assert.equal(rowFor(pg, 'spMonthsTable', 'February 2026')[2], '₹800.00', '10 × (150 − 70)');
  assert.equal(rowFor(pg, 'spCostTable', 'Washing Machine Cover')[3], 'typed by you');
  await pg.w.spSaveCost(P1, ''); await sleep(500);
  assert.equal(rowFor(pg, 'spMonthsTable', 'February 2026')[2], '₹700.00', 'back to the purchase average');
});

test('e-commerce: payment files → profit by month with return charges and state; both streams add up; stock untouched', async () => {
  await world();
  const pg = await open();
  await upload(pg, [PAY(), ORD()]);
  const mar = await read(U + '/sellerMonthlyProfit/2026-03'), apr = await read(U + '/sellerMonthlyProfit/2026-04');
  // March: B2 sold 2 (rev 320, cost 2 × 90 = 180 → 140) + A1 sold-then-returned (net −20 → −19.05, no cost) ; April: LOST (95.24 − 90) + F6 (160 − 90)
  assert.deepEqual([mar.soldUnits, mar.returnUnits, mar.revenue, mar.cogs, mar.profit, mar.returnCharges], [2, 1, 300.95, 180, 120.95, 19.05]);
  assert.deepEqual([apr.soldUnits, apr.revenue, apr.cogs, apr.profit], [2, 255.24, 180, 75.24]);
  // the combined month table
  assert.deepEqual(rowFor(pg, 'spMonthsTable', 'March 2026'), ['March 2026', '9', '₹560.00', '2', '1', '₹19.05', '₹120.95', '₹1,500.95', '₹680.95', '45.4%']);
  assert.deepEqual(rowFor(pg, 'spMonthsTable', 'April 2026'), ['April 2026', '0', '₹0.00', '2', '0', '₹0.00', '₹75.24', '₹255.24', '₹75.24', '29.5%']);
  // stock and reconciliation markers are NOT touched
  assert.equal((await read(U + '/products/' + P1)).stock, 500);
  for (const c of ['stockMovements', 'processedSellerLabels', 'sellerReturnedLabels']) assert.equal((await list(U + '/' + c + '/')).length, 0, c + ' untouched');
  assert.match(pg.$('spUploadMsg').textContent, /Added to Profit: 4 e-commerce order\(s\) in 2 month\(s\).*Your stock was not changed/);
  // the SKU matched on the product's own SKU needed no mapping
  assert.equal((await list(U + '/skuMappings/')).length, 0);
});

test('state-wise: invoices (customer state) and e-commerce (customer state column) land in the same states, with return rate and charges', async () => {
  await world();
  const pg = await open();
  await upload(pg, [PAY(), ORD()]);
  // Maharashtra: invoices 5×150 − 5×90 + 2 fridge (200 − 100) = 400, e-commerce B2 140 → 540 on 9 units
  assert.deepEqual(rowFor(pg, 'spStatesTable', 'Maharashtra'), ['Maharashtra', '9', '0', '0%', '₹0.00', '₹1,270.00', '₹540.00', '42.5%']);
  // Uttar Pradesh: invoices 10+1+1 units, e-commerce A1 returned (charge 19.05)
  assert.deepEqual(rowFor(pg, 'spStatesTable', 'Uttar Pradesh'), ['Uttar Pradesh', '12', '1', '7.7%', '₹19.05', '₹1,730.95', '₹840.95', '48.6%']);
  assert.deepEqual(rowFor(pg, 'spStatesTable', 'Karnataka').slice(0, 3), ['Karnataka', '1', '0']);
  assert.match(pg.$('spChStateSales').innerHTML, /Maharashtra: 9/); assert.match(pg.$('spChStateProfit').innerHTML, /Maharashtra: ₹540/);
  assert.match(pg.$('spChStateReturns').innerHTML, /Uttar Pradesh: 1 · 7\.7% of orders · ₹19/);
});

test('graphs: monthly selling / money / returns / charges, profit by source, product and buyer; the stream and month filters work', async () => {
  await world();
  const pg = await open();
  await upload(pg, [PAY(), ORD()]);
  const h = id => pg.$(id).innerHTML;
  assert.match(h('spChSales'), /Mar 2026 — Units sold: 11/); assert.match(h('spChSales'), /Mar 2026 — Returned \/ RTO units: 1/);
  assert.match(h('spChMoney'), /Mar 2026 — Profit: ₹681/);
  assert.match(h('spChStreams'), /Mar 2026 — Sales to buyers: ₹560/); assert.match(h('spChStreams'), /Mar 2026 — E-commerce: ₹121/);
  assert.match(h('spChCharges'), /Mar 2026 — Return charges: ₹19/);
  assert.match(h('spChProduct'), /Washing Machine Cover/); assert.match(h('spChBuyers'), /Raj Traders: ₹860/); assert.match(h('spChBuyers'), /Mumbai Mart: ₹400/);
  assert.deepEqual(rowFor(pg, 'spBuyersTable', 'Raj Traders'), ['Raj Traders', '12', '₹1,750.00', '₹890.00', '₹860.00', '49.1%'].map((v, i) => i === 3 ? v : v).slice(0, 6));
  // only sales to buyers
  pg.$('spStream').value = 'buyers'; pg.w.spRenderReport();
  assert.match(h('spChSales'), /Mar 2026 — Units sold: 9/); assert.ok(!/Returned \/ RTO units: [1-9]/.test(h('spChSales')));
  assert.equal(rowFor(pg, 'spStatesTable', 'Maharashtra')[6], '₹400.00');
  // only e-commerce
  pg.$('spStream').value = 'ecommerce'; pg.w.spRenderReport();
  assert.match(h('spChSales'), /Mar 2026 — Units sold: 2/); assert.match(h('spChSales'), /Mar 2026 — Returned \/ RTO units: 1/);
  assert.ok(!rowFor(pg, 'spBuyersTable', 'Raj Traders'), 'no invoice buyers in the e-commerce view');
  // month range: April only
  pg.$('spStream').value = 'all'; pg.$('spFrom').value = '2026-04'; pg.w.spRenderReport();
  assert.ok(!/Mar 2026/.test(h('spChSales'))); assert.match(h('spChSales'), /Apr 2026 — Units sold: 2/);
});

test('uploading the same e-commerce files twice counts nothing twice; an Orders report later fills states into saved orders', async () => {
  await world();
  const pg = await open();
  await upload(pg, [PAY()]);                                                   // payments only → states Unknown
  assert.equal(rowFor(pg, 'spStatesTable', 'Unknown')[1], '4', 'B2 ×2 + LOST + F6 — and the newest month (April) is in the range');
  const m1 = await read(U + '/sellerMonthlyProfit/2026-03'), n1 = (await list(U + '/sellerProfitOrders/')).length;
  await upload(pg, [PAY()]);
  assert.equal((await read(U + '/sellerMonthlyProfit/2026-03')).profit, m1.profit); assert.equal((await list(U + '/sellerProfitOrders/')).length, n1);
  assert.match(pg.$('spUploadMsg').textContent, /already counted before/);
  await upload(pg, [ORD()]);                                                   // the Orders report: states only
  assert.deepEqual(Object.keys((await read(U + '/sellerMonthlyProfit/2026-03')).byState).sort(), ['Maharashtra', 'Uttar Pradesh']);
  assert.equal(rowFor(pg, 'spStatesTable', 'Maharashtra')[1], '9');
  assert.equal((await read(U + '/sellerMonthlyProfit/2026-03')).profit, m1.profit, 'profit unchanged');
});

test('a SKU that matches no product: pick one (remembered for next time) or type a cost; undated rows are flagged, not guessed', async () => {
  await world();
  await seed(U + '/products/' + P1, { name: 'Washing Machine Cover', sku: 'OTHER-SKU', unit: 'PCS', price: 150, gstRate: 5, stock: 500, active: true });   // own SKU no longer matches
  const pg = await open();
  const s = pay('555555555', '2026-05-02', 'DELIVERED', 1, 168, '2026-05-10');
  await upload(pg, [sheet(PH, [s], 'p')], { apply: false });
  assert.match(pg.$('spPreviewBox').textContent, /not matched to a product and have no cost/);
  pg.$('spSkuMap0').value = P1; pg.w.spOnMap(0); await sleep(700);
  await pg.w.eval('spApply()'); await sleep(2600);
  assert.equal((await read(U + '/sellerMonthlyProfit/2026-05')).profit, 70, '168 ÷ 1.05 = 160 − 90');
  assert.equal((await list(U + '/skuMappings/')).filter(r => r.data.rawKey === 'vst-a').length, 1, 'the SKU is remembered');
  // undated
  await upload(pg, [sheet(PH, [pay('777777777', '', 'DELIVERED', 1, 168)], 'u')], { apply: false });
  assert.match(pg.$('spPreviewBox').textContent, /1 order\(s\) have no date/);
});

test('empty seller account: friendly empty states, no broken charts', async () => {
  await reset();
  await seed(U, { businessName: 'VISUTRA', gstin: '09BVHPP4321G1ZJ', stateCode: '09', profileComplete: true });
  const pg = await open();
  assert.match(pg.$('spMonthsTable').textContent, /No sales yet/);
  assert.match(pg.$('spChSales').innerHTML, /No data in this period yet/); assert.match(pg.$('spChStateProfit').innerHTML, /No data in this period yet/);
  assert.match(pg.$('spCostTable').textContent, /No products yet/);
});

test('Seller Monthly Inventory Reconciliation: every Return / RTO goes back to stock once, a LOST parcel never does; unticked keeps the old rule', async () => {
  for (const [addAll, expected] of [[true, 101], [false, 99]]) {
    await reset();
    await seed(U, { businessName: 'VISUTRA', gstin: '09BVHPP4321G1ZJ', stateCode: '09', profileComplete: true });
    await seed(U + '/products/' + P1, { name: 'Washing Machine Cover', sku: 'VST-A', unit: 'PCS', price: 150, gstRate: 5, stock: 100, active: true });
    const pg = loadPage('billing/app.html', A, { ...opts, hook: 'window.__setRecon=v=>{stockUploadSheets=v;};window.__agg=()=>stockAggregation;window.__det=h=>detectSheetFormat(h);' });
    await sleep(2200);
    const H = ['Sub Order No', 'SKU', 'Quantity', 'Reason for Credit Entry'];
    pg.w.__setRecon([{ fileName: 'm.xlsx', sheetName: 'S', headers: H, detected: pg.w.__det(H), rows: [['111111111_1', 'VST-A', 2, 'RTO_COMPLETE'], ['222222222_1', 'VST-A', 1, 'LOST']] }]);
    pg.w.eval('renderStockColumnMapUI()');
    pg.$('reconAddAllReturns').checked = addAll; pg.$('stockPeriod').value = '2026-09';
    await pg.w.eval('aggregateStockUpload()'); await sleep(600);
    pg.$('stockAggMap0').value = P1;
    await pg.w.eval('applyStockUpload()'); await sleep(1500);
    assert.equal((await read(U + '/products/' + P1)).stock, expected, addAll ? '100 − 1 (LOST stays gone) + 2 (RTO back on the shelf)' : '100 − 1 (old rule: the RTO was never deducted, nothing added)');
  }
});
