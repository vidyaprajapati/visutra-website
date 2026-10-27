// "Latest entry first" + "Sort by" on every list of entered data. Real pages, real database
// (the entry time is the database's own created_at, set when the record was first saved).
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { seed, reset, pool } = require('./lib/fakesb');
const { loadPage, sleep, closeAll, A, B } = require('./lib/sbload');
after(async () => { closeAll(); await pool.end(); });
const U = 'users/' + A.uid;
const pageOpts = { before: w => { w.confirm = () => true; w.emailjs = { init(){}, send: async () => ({}) }; } };
const T = h => `2026-10-2${h < 10 ? '0' : ''}T${String(10 + h).padStart(2, '0')}:00:00Z`;   // entry times: later h = entered later
async function put(path, data, entryHour){
  await seed(path, data);
  await pool.query('update public.docs set created_at = $2 where path = $1', [path, T(entryHour)]);
}
const col = (pg, id, i) => [...pg.$(id).rows].filter(r => r.cells.length > 1).map(r => r.cells[i].textContent.replace(/\s+/g, ' ').trim());
const choose = (pg, id, text) => {
  const sel = pg.$(id)._vtSort.select;
  const opt = [...sel.options].find(o => o.textContent === text);
  assert.ok(opt, `option "${text}" in [${[...sel.options].map(o => o.textContent).join(' | ')}]`);
  sel.value = opt.value; sel.dispatchEvent(new pg.w.Event('change'));
};
const optionsOf = (pg, id) => [...pg.$(id)._vtSort.select.options].map(o => o.textContent);

async function world(){
  await reset();
  await seed(U, { email: A.email, businessName: 'VISUTRA', gstin: '09BVHPP4321G1ZJ', stateCode: '09', profileComplete: true });
  // suppliers: the page lists them A→Z by name; entered in the order Zeta, Alpha, Mid
  await put(U + '/suppliers/supplier0001', { name: 'Zeta Traders', legalName: 'Zeta Traders', phone: '111' }, 1);
  await put(U + '/suppliers/supplier0002', { name: 'Alpha Co', legalName: 'Alpha Co', phone: '222' }, 2);
  await put(U + '/suppliers/supplier0003', { name: 'Mid Co', legalName: 'Mid Co', phone: '333' }, 3);
  // purchases: p2 has the newest DATE but was entered FIRST; p3 was entered last (back-dated)
  const pur = (sid, sname, date, total) => ({ supplierId: sid, supplierName: sname, date, grandTotal: total, items: [{ name: 'Cloth', qty: 1, unit: 'MTR', rate: total, gstRate: 0, total }] });
  await put(U + '/purchases/purchase0002', pur('supplier0001', 'Zeta Traders', '2026-10-20', 500), 4);
  await put(U + '/purchases/purchase0001', pur('supplier0001', 'Zeta Traders', '2026-10-01', 100), 5);
  await put(U + '/purchases/purchase0003', pur('supplier0002', 'Alpha Co', '2026-10-05', 900), 6);
  await put(U + '/payments/payment00001', { supplierId: 'supplier0001', supplierName: 'Zeta Traders', date: '2026-10-02', amount: 50, mode: 'UPI' }, 7);
  await put(U + '/payments/payment00002', { supplierId: 'supplier0001', supplierName: 'Zeta Traders', date: '2026-10-28', amount: 75, mode: 'bank' }, 8);
}
const open = async () => { const pg = loadPage('billing/app.html', A, pageOpts); await sleep(2000); return pg; };

test('a list opens with the LATEST ENTRY on top (not alphabetical / not by date)', async () => {
  await world();
  const pg = await open();
  assert.deepEqual(col(pg, 'suppliersTable', 1), ['Mid Co', 'Alpha Co', 'Zeta Traders'], 'entered last → shown first');
  await pg.w.loadPurchases(); await sleep(300);
  assert.deepEqual(col(pg, 'purchasesTable', 4), ['₹900.00', '₹100.00', '₹500.00'], 'by entry time: p3, p1, p2 — the back-dated one entered last is on top');
  await pg.w.loadPayments(); await sleep(300);
  assert.deepEqual(col(pg, 'paymentsEntryTable', 2), ['₹75.00', '₹50.00']);
});

test('"Sort by" is above every list, and every column / date / latest / oldest works', async () => {
  await world();
  const pg = await open();
  assert.deepEqual(optionsOf(pg, 'suppliersTable').slice(0, 2), ['Latest first', 'Oldest first']);
  assert.ok(optionsOf(pg, 'suppliersTable').includes('Name: A → Z'));
  choose(pg, 'suppliersTable', 'Name: A → Z');
  assert.deepEqual(col(pg, 'suppliersTable', 1), ['Alpha Co', 'Mid Co', 'Zeta Traders']);
  choose(pg, 'suppliersTable', 'Name: Z → A');
  assert.deepEqual(col(pg, 'suppliersTable', 1), ['Zeta Traders', 'Mid Co', 'Alpha Co']);
  choose(pg, 'suppliersTable', 'Oldest first');
  assert.deepEqual(col(pg, 'suppliersTable', 1), ['Zeta Traders', 'Alpha Co', 'Mid Co']);
  choose(pg, 'suppliersTable', 'Latest first');
  assert.deepEqual(col(pg, 'suppliersTable', 1), ['Mid Co', 'Alpha Co', 'Zeta Traders']);
  await pg.w.loadPurchases(); await sleep(300);
  assert.ok(optionsOf(pg, 'purchasesTable').includes('Date: newest first'));
  assert.ok(optionsOf(pg, 'purchasesTable').includes('Total (incl. GST): high → low'));
  choose(pg, 'purchasesTable', 'Date: newest first');
  assert.deepEqual(col(pg, 'purchasesTable', 0), ['2026-10-20', '2026-10-05', '2026-10-01']);
  choose(pg, 'purchasesTable', 'Total (incl. GST): high → low');
  assert.deepEqual(col(pg, 'purchasesTable', 4), ['₹900.00', '₹500.00', '₹100.00']);
  choose(pg, 'purchasesTable', 'Total (incl. GST): low → high');
  assert.deepEqual(col(pg, 'purchasesTable', 4), ['₹100.00', '₹500.00', '₹900.00']);
});

test('the chosen order survives the list redrawing itself, and a new entry lands on top', async () => {
  await world();
  const pg = await open();
  choose(pg, 'suppliersTable', 'Name: A → Z');
  await pg.w.loadSuppliers(); await sleep(300);                      // redraw
  assert.deepEqual(col(pg, 'suppliersTable', 1), ['Alpha Co', 'Mid Co', 'Zeta Traders'], 'still A → Z after a redraw');
  choose(pg, 'suppliersTable', 'Latest first');
  pg.$('sName').value = 'Brand New Supplier';
  await pg.w.saveSupplier(); await sleep(900);
  assert.equal(col(pg, 'suppliersTable', 1)[0], 'Brand New Supplier', 'what I just entered is the first row');
});

test('a ledger (running balance) opens newest DATE first, each row keeps its own balance', async () => {
  await world();
  const pg = await open();
  await pg.w.loadPurchases(); await pg.w.loadPayments(); await sleep(300);
  pg.w.eval("goToSupplierDashboard('supplier0001')"); await sleep(500);
  assert.deepEqual(col(pg, 'dashTable', 0), ['2026-10-28', '2026-10-20', '2026-10-02', '2026-10-01'], 'newest first');
  assert.deepEqual(col(pg, 'dashTable', 6), ['₹475.00', '₹550.00', '₹50.00', '₹100.00'].map((v, i) => ['₹475.00', '₹550.00', '₹50.00', '₹100.00'][i]), 'balances: 100 → 50 → 550 → 475, read newest-first');
  choose(pg, 'dashTable', 'Date: oldest first');
  assert.deepEqual(col(pg, 'dashTable', 0), ['2026-10-01', '2026-10-02', '2026-10-20', '2026-10-28']);
});

test('empty lists keep their "no records" row, and entry forms / reports are left alone', async () => {
  await world(); await reset();
  await seed(U, { email: A.email, businessName: 'VISUTRA', gstin: '09BVHPP4321G1ZJ', stateCode: '09', profileComplete: true });
  const pg = await open();
  assert.match(pg.$('suppliersTable').textContent, /No suppliers yet/);
  for (const id of ['lineItemsTable', 'purchaseLineItemsTable', 'gstrB2bTable', 'monthlyStockReportTable', 'reorderTable'])
    assert.equal(!!pg.$(id)._vtSort, false, id + ' has no sort box');
});

test('Order Receive (seller) and My Orders (buyer) open newest entry first and sort by order value', async () => {
  await world();
  await seed(U + '/products/prod0000001', { name: 'WM Cover', price: 100, gstRate: 0, stock: 99, active: true, buyerVisibility: true, unit: 'PCS' });
  const ord = (id, no, qty, hour) => put('marketplaceOrders/' + id, { orderNumber: no, orderType: 'PRODUCT_SELECT', buyerUid: B.uid, buyerEmail: B.email, sellerUid: A.uid, sellerName: 'VISUTRA',
    buyerBusiness: { businessName: 'Visu trader' }, items: [{ productId: 'prod0000001', productName: 'WM Cover', qty }], status: 'PENDING' }, hour);
  await ord('order0000001', 'ORD-FIRST', 50, 1); await ord('order0000002', 'ORD-SECOND', 5, 2); await ord('order0000003', 'ORD-THIRD', 20, 3);
  await seed(`sellerLinks/${A.uid}_${B.uid}`, { sellerUid: A.uid, buyerUid: B.uid, status: 'ACTIVE' });
  await seed('users/' + B.uid, { email: B.email, businessName: 'Visu trader', profileComplete: true });
  const sp = loadPage('billing/seller/order-receive.html', A, pageOpts); await sleep(2000);
  const orderNos = pg => col(pg, 'ordersTable', 0).map(t => /ORD-\w+/.exec(t)[0]);
  assert.deepEqual(orderNos(sp), ['ORD-THIRD', 'ORD-SECOND', 'ORD-FIRST']);
  choose(sp, 'ordersTable', 'Order value: high → low');
  assert.deepEqual(orderNos(sp), ['ORD-FIRST', 'ORD-THIRD', 'ORD-SECOND'], '₹5,000 > ₹2,000 > ₹500');
  const bp = loadPage('billing/buyer/my-orders.html', B, pageOpts); await sleep(2200);
  assert.deepEqual(orderNos(bp), ['ORD-THIRD', 'ORD-SECOND', 'ORD-FIRST']);
  choose(bp, 'ordersTable', 'Order value: low → high');
  assert.deepEqual(orderNos(bp), ['ORD-SECOND', 'ORD-THIRD', 'ORD-FIRST']);
});

test('supplier dashboard: ledger newest date first with a Sort by on ledger, purchases and payments', async () => {
  await world();
  await seed('users/' + A.uid + '/suppliers/supplier0009', { name: 'Raj Fabrics', email: 'raj@fabrics.com' });
  const RAJ = { uid: '11111111-0000-0000-0000-000000000001', email: 'raj@fabrics.com' };
  const pur = (date, total) => ({ supplierId: 'supplier0009', date, invoiceNo: 'I-' + date, grandTotal: total, items: [] });
  await put(U + '/purchases/purchase0091', pur('2026-10-01', 1000), 1); await put(U + '/purchases/purchase0092', pur('2026-10-15', 500), 2);
  await put(U + '/payments/payment00091', { supplierId: 'supplier0009', date: '2026-10-10', amount: 300, mode: 'UPI' }, 3);
  const pg = loadPage('billing/supplier/dashboard.html', RAJ, pageOpts); await sleep(2000);
  const tables = [...pg.w.document.querySelectorAll('table[data-vt-sort]')];
  assert.equal(tables.length, 3);
  assert.ok(tables.every(t => t.tBodies[0]._vtSort), 'every table has a Sort by');
  const dates = t => [...t.tBodies[0].rows].map(r => r.cells[0].textContent.trim());
  assert.deepEqual(dates(tables[0]), ['15-10-2026', '10-10-2026', '01-10-2026'], 'ledger: newest first');
  assert.deepEqual([...tables[0].tBodies[0].rows].map(r => r.cells[5].textContent.trim()), ['₹1,200.00', '₹700.00', '₹1,000.00'], 'running balance kept per row');
  assert.deepEqual(dates(tables[1]), ['15-10-2026', '01-10-2026'], 'purchases newest first');
  const sel = tables[1].tBodies[0]._vtSort.select;
  sel.value = [...sel.options].find(o => o.textContent === 'Total: low → high').value; sel.dispatchEvent(new pg.w.Event('change'));
  assert.deepEqual(dates(tables[1]), ['15-10-2026', '01-10-2026'], '500 then 1000');
});
