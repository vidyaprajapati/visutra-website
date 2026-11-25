// Business expenses (packing, labels …): entry page, and net profit on both profit views.
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { seed, read, list, reset, pool } = require('./lib/fakesb');
const { loadPage, sleep, closeAll, A, B } = require('./lib/sbload');
const EXP = require('../billing/assets/expenses-tools.js');
after(async () => { closeAll(); await pool.end(); });
const cells = tr => [...tr.cells].map(c => c.textContent.trim());

test('unit: amount = qty × rate, GST claimed is not a cost, unclaimed GST is', () => {
  const a = EXP.makeEntry({ date: '2026-11-05', category: 'Packing material', item: 'Poly bags', qty: 500, rate: 1.2, gstPct: 18, side: 'buyer' });
  assert.deepEqual([a.amount, a.gst, a.claimGst, EXP.costOf(a), a.month, a.side], [600, 108, true, 600, '2026-11', 'buyer']);
  const b = EXP.makeEntry({ date: '2026-11-06', category: 'Labels & label paper', item: 'Roll', amount: 300, gstPct: 18, claimGst: false });
  assert.deepEqual([b.amount, b.gst, EXP.costOf(b), b.side], [300, 54, 354, 'seller']);
  assert.deepEqual(EXP.problems(EXP.makeEntry({})), ['Pick the date.', 'Enter the amount (or quantity × rate).', 'Say what it was for (e.g. "4×6 label roll, 500 pcs").']);
  const rows = EXP.netRows([{ month: '2026-11', profit: 5000 }, { month: '2026-10', profit: -100 }], EXP.monthTotals([a, b], 'buyer'));
  assert.deepEqual(rows, [{ month: '2026-11', gross: 5000, expenses: 600, net: 4400 }, { month: '2026-10', gross: -100, expenses: 0, net: -100 }]);
  assert.deepEqual(EXP.netRows([], EXP.monthTotals([b], 'seller')), [{ month: '2026-11', gross: 0, expenses: 354, net: -354 }], 'expenses with no sales = a loss');
});

test('page: add, edit, delete an expense; summary by month and category; sides stay separate', async () => {
  await reset();
  const U = 'users/' + A.uid;
  await seed(U, { businessName: 'VISUTRA', stateCode: '09', profileComplete: true });
  const pg = loadPage('billing/expenses.html', A, { query: '?side=seller', before: w => { w.confirm = () => true; } });
  await sleep(1800);
  const fill = (id, v) => { pg.$(id).value = v; };
  // incomplete → refused, nothing saved
  await pg.w.eval('exSave')(); await sleep(200);
  assert.match(pg.$('exMsg').textContent, /Pick|Enter the amount|Say what/);
  assert.equal((await list(U + '/businessExpenses/')).length, 0);
  fill('exDate', '2026-11-05'); fill('exCat', 'Packing material'); fill('exItem', 'Poly bags'); fill('exVendor', 'Raj Packers'); fill('exQty', '500'); fill('exRate', '1.2'); fill('exGst', '18');
  pg.w.eval('exPreview')();
  assert.match(pg.$('exTotal').textContent, /₹600\.00.*₹108\.00.*₹600\.00/);
  await pg.w.eval('exSave')(); await sleep(600);
  let docs = await list(U + '/businessExpenses/');
  assert.equal(docs.length, 1);
  assert.deepEqual([docs[0].data.amount, docs[0].data.gst, docs[0].data.side, docs[0].data.month, docs[0].data.vendor], [600, 108, 'seller', '2026-11', 'Raj Packers']);
  // second entry: labels, GST not claimed → cost 354
  fill('exCat', 'Labels & label paper'); fill('exItem', '4x6 label roll'); fill('exQty', '1'); fill('exRate', ''); fill('exAmount', '300'); fill('exGst', '18'); pg.$('exClaim').checked = false;
  await pg.w.eval('exSave')(); await sleep(600);
  const sum = [...pg.$('exSumBody').rows].map(cells);
  assert.deepEqual(sum[0].slice(-1), ['₹954.00'], 'monthly total = 600 + 354');
  assert.match(pg.$('exListTotal').textContent, /2 entries.*₹954\.00/);
  // edit the first one → amount 700
  const id1 = (await list(U + '/businessExpenses/')).find(d => d.data.item === 'Poly bags').path.split('/').pop();
  pg.w.eval('exEdit')(id1); fill('exRate', '1.4'); await pg.w.eval('exSave')(); await sleep(600);
  assert.equal((await read(U + '/businessExpenses/' + id1)).amount, 700);
  assert.equal((await list(U + '/businessExpenses/')).length, 2, 'edit does not duplicate');
  // buyer side shows none of the seller-side entries
  pg.w.eval('exSetSide')('buyer');
  assert.match(pg.$('exListTotal').textContent, /0 entries/);
  // delete
  pg.w.eval('exSetSide')('seller'); await pg.w.eval('exDelete')(id1); await sleep(500);
  assert.equal((await list(U + '/businessExpenses/')).length, 1);
});

test('another user cannot read or change my expenses', async () => {
  await reset();
  await seed('users/' + A.uid, { businessName: 'A' });
  await seed('users/' + A.uid + '/businessExpenses/e1', { date: '2026-11-01', month: '2026-11', side: 'seller', category: 'Other', item: 'x', amount: 10, gst: 0 });
  const w = require('./lib/sbload').loadCore(B);
  const snap = await w.db.collection('users').doc(A.uid).collection('businessExpenses').get();
  assert.equal(snap.docs.length, 0);
});

test('Buyer Stock → Monthly Profit shows net profit after expenses (buyer-side only)', async () => {
  await reset();
  const U = 'users/' + B.uid;
  await seed(U, { businessName: 'Visu trader', stateCode: '09', profileComplete: true, roles: { buyer: true } });
  await seed(U + '/buyerMonthlyProfit/2026-09', { month: '2026-09', soldUnits: 10, returnUnits: 0, revenue: 2000, cogs: 1000, profit: 1000, margin: 50, returnCharges: 0, byState: {}, byProduct: {} });
  await seed(U + '/businessExpenses/e1', { date: '2026-09-04', month: '2026-09', side: 'buyer', category: 'Packing material', item: 'bags', amount: 250, gst: 0, qty: 1 });
  await seed(U + '/businessExpenses/e2', { date: '2026-09-05', month: '2026-09', side: 'seller', category: 'Other', item: 'seller-side only', amount: 999, gst: 0, qty: 1 });
  await seed(U + '/businessExpenses/e3', { date: '2026-10-05', month: '2026-10', side: 'buyer', category: 'Labels & label paper', item: 'labels', amount: 100, gst: 18, claimGst: false, qty: 1 });
  const pg = loadPage('billing/buyer/stock.html', B, { prompt: () => '' });
  await sleep(2500);
  const rows = [...pg.$('profitNetBox').querySelectorAll('tbody tr')].map(cells);
  assert.deepEqual(rows, [['October 2026', '₹0.00', '₹118.00', '−₹118.00'], ['September 2026', '₹1,000.00', '₹250.00', '₹750.00']]);
  assert.match(pg.$('profitNetBox').textContent, /net ₹632\.00/);
});

test('Seller Profit & Graphs shows net profit after expenses (seller-side only)', async () => {
  await reset();
  const U = 'users/' + A.uid, P1 = 'prodP1aaaa';
  await seed(U, { businessName: 'VISUTRA', gstin: '09BVHPP4321G1ZJ', stateCode: '09', state: 'Uttar Pradesh', profileComplete: true });
  await seed(U + '/products/' + P1, { name: 'Cover', sku: 'VST-A', unit: 'PCS', price: 150, gstRate: 5, stock: 50, active: true, costPrice: 100 });
  await seed(U + '/invoices/invoice0001', { invoiceNo: 'invoice0001', date: '2026-03-15', customer: { name: 'Raj', state: 'Uttar Pradesh', stateCode: '09' }, items: [{ productId: P1, name: 'Cover', qty: 10, taxable: 1500 }] });
  await seed(U + '/businessExpenses/e1', { date: '2026-03-02', month: '2026-03', side: 'seller', category: 'Packing material', item: 'bags', amount: 200, gst: 0, qty: 1 });
  await seed(U + '/businessExpenses/e2', { date: '2026-03-03', month: '2026-03', side: 'buyer', category: 'Other', item: 'buyer side', amount: 999, gst: 0, qty: 1 });
  const pg = loadPage('billing/app.html', A, { before: w => { w.confirm = () => true; w.emailjs = { init() {}, send: async () => ({}) }; } });
  await sleep(2200); pg.w.activateView('profit'); await sleep(2200);
  const rows = [...pg.$('spNetBox').querySelectorAll('tbody tr')].map(cells);
  assert.deepEqual(rows, [['March 2026', '₹500.00', '₹200.00', '₹300.00']]);   // gross 1500 − 10×100 = 500
});
