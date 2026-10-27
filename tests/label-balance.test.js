// "Balance to Order" must count orders already sent but not yet accepted (in transit),
// otherwise the same shortfall is ordered twice, the seller accepts both, stock ends up too high,
// and the NEXT order comes out far too small (262 labels printed → only 8 ordered).
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { seed, read, list, reset, pool } = require('./lib/fakesb');
const { loadPage, sleep, closeAll, A, B } = require('./lib/sbload');
after(async () => { closeAll(); await pool.end(); });
const U = 'users/' + A.uid, SB = 'users/' + B.uid;
const pageOpts = { before: w => { w.confirm = () => true; w.prompt = () => null; w.emailjs = { init(){}, send: async () => ({}) }; w.pdfjsLib = { GlobalWorkerOptions: {}, getDocument: () => ({ promise: Promise.resolve({ numPages: 0 }) }) }; } };
const orders = async () => (await list('marketplaceOrders/')).map(r => ({ id: r.path.split('/').pop(), ...r.data }));

async function world(stock){
  await reset();
  await seed(U, { email: A.email, businessName: 'VISUTRA', gstin: '09BVHPP4321G1ZJ', stateCode: '09', profileComplete: true });
  await seed(SB, { email: B.email, businessName: 'Visu trader', gstin: '09AAACR5055K1Z5', stateCode: '09', state: 'Uttar Pradesh', profileComplete: true });
  await seed(`sellerLinks/${A.uid}_${B.uid}`, { sellerUid: A.uid, buyerUid: B.uid, status: 'ACTIVE', sellerName: 'VISUTRA', sellerEmail: A.email });
  await seed(U + '/products/wm00000001', { name: 'Washing Machine Cover', sku: 'VST-WM', unit: 'PCS', price: 200, gstRate: 5, stock: 5000, active: true, buyerVisibility: true });
  await setStock(stock);
}
const setStock = s => seed(SB + '/buyerSkuMappings/bm1', { status: 'ACTIVE', productName: 'WM Cover', sellerId: A.uid, sellerName: 'VISUTRA', productId: 'wm00000001', sellerProductName: 'Washing Machine Cover', sellerSku: 'VST-WM', meeshoSku: 'VST-A', stock: s });
const draft = (qty, hash, date) => seed(SB + '/labelOrderDrafts/pending_' + A.uid, { date, firstDate: date, lastDate: date, dates: [date], sellerId: A.uid, sellerName: 'VISUTRA', pageHashes: [hash],
  itemsByProduct: { wm00000001: { productName: 'Washing Machine Cover', sellerSku: 'VST-WM', mappingId: 'bm1', qty, breakdown: { amazon: 0, meesho: qty, flipkart: 0 } } } });
async function send(){
  const pg = loadPage('billing/buyer/label-order.html', B, pageOpts); await sleep(1700);
  await pg.w.loadDrafts(); await sleep(250);
  await pg.w.eval(`placeAutoOrder('pending_${A.uid}')`); await sleep(1000);
  return pg;
}
const qtyOf = o => o.items.find(i => i.productId === 'wm00000001').qty;

test('a shortfall already ordered (seller has not accepted yet) is NOT ordered again', async () => {
  await world(-254);                                 // 254 labels dispatched → stock −254
  await draft(254, 'h-day1', '2026-10-25');
  await send();
  let os = await orders();
  assert.equal(os.length, 1); assert.equal(qtyOf(os[0]), 254, 'first order = the shortfall');
  // two days later, 8 more labels; the seller has still not accepted → stock is −262, 254 of it is already on order
  await setStock(-262);
  await draft(8, 'h-day3', '2026-10-27');
  const pg = await send();
  os = await orders();
  assert.equal(os.length, 1, 'merged into the one pending order');
  assert.equal(qtyOf(os[0]), 262, '254 already ordered + only the 8 NEW units (was 254 + 262 = 516)');
});

test('when the seller accepts, stock lands on zero — not +254 too high', async () => {
  await world(-254);
  await draft(254, 'h-day1', '2026-10-25'); await send();
  await setStock(-262); await draft(8, 'h-day3', '2026-10-27'); await send();
  const o = (await orders())[0];
  // seller accepts the (single) order → buyer purchase + stock-in, exactly as in the app
  await pool.query("update public.docs set data = data || $2::jsonb where path = $1", ['marketplaceOrders/' + o.id, JSON.stringify({ status: 'ACCEPTED', invoiceId: 'inv1', invoiceNo: '26-27/0001', invoiceDate: '2026-10-27',
    invoiceSummary: { subtotal: 52400, cgst: 0, sgst: 0, igst: 2620, grandTotal: 55020 }, items: o.items.map(i => ({ productId: i.productId, productName: i.productName, qty: i.qty, rate: 200, gstRate: 5, taxable: i.qty * 200, gstAmt: i.qty * 10, total: i.qty * 210 })) })]);   // accepted exactly as ordered
  const um = loadPage('billing/buyer/my-orders.html', B, { ...pageOpts, hook: require('./lib/sbload').read('billing/assets/user-menu.js') }); await sleep(2500);
  assert.equal((await read(SB + '/buyerSkuMappings/bm1')).stock, 0, 'stock was −262, the accepted order brought exactly 262');
});

test('the table shows what is already on order, and the order is only the new need', async () => {
  await world(-262);
  await seed('marketplaceOrders/ord00000001', { orderNumber: 'VIS-ORD-1', orderType: 'LABEL_AUTO', buyerUid: B.uid, buyerEmail: B.email, sellerUid: A.uid, sellerName: 'VISUTRA', status: 'PENDING',
    buyerBusiness: { businessName: 'Visu trader' }, items: [{ productId: 'wm00000001', productName: 'Washing Machine Cover', qty: 254 }] });
  await draft(8, 'h-day3', '2026-10-27');
  const pg = loadPage('billing/buyer/label-order.html', B, pageOpts); await sleep(2200);
  const t = pg.$('summaryBySeller').textContent.replace(/\s+/g, ' ');
  assert.match(t, /On order/);                         // new column
  const row = [...pg.$('summaryBySeller').querySelectorAll('tbody tr')][0].cells;
  assert.deepEqual([...row].map(c => c.textContent.replace(/\s+/g, ' ').trim()).slice(3, 7).map(x => x.replace(/ ✎.*/, '')), ['8', '-262', '254', '8']);
  assert.match(t, /Order cost: ₹1,680\.00/, '8 × 200 + 5%');
});

test('stock that is wrong can be corrected right on the page (logged), and the balance follows', async () => {
  await world(-8);                                    // the inflated figure from the screenshot (true value: −256)
  await draft(262, 'h-1', '2026-10-27');
  const pg = loadPage('billing/buyer/label-order.html', B, { ...pageOpts, before: w => { pageOpts.before(w); w.prompt = () => '-256'; } }); await sleep(2200);
  const cells = () => [...pg.$('summaryBySeller').querySelectorAll('tbody tr')][0].cells;
  assert.equal(cells()[6].textContent.trim(), '8', 'with the inflated stock only 8 would be ordered');
  await pg.w.eval("fixStock('bm1')"); await sleep(900);
  assert.equal((await read(SB + '/buyerSkuMappings/bm1')).stock, -256);
  const mv = (await list(SB + '/buyerStockMovements/')).map(r => r.data);
  assert.equal(mv.length, 1); assert.equal(mv[0].type, 'manual-adjust'); assert.equal(mv[0].qty, -248);
  assert.equal(cells()[6].textContent.trim(), '256', 'order is now 256');
});

const hitsOf = n => Array.from({ length: n }, (_, i) => ({ marketplace: 'MEESHO', sku: 'VST-A', qty: 1, key: 'lbl' + String(i).padStart(4, '0'), packKey: 'pck' + i, pageHash: 'lbl' + String(i).padStart(4, '0') }));
const rowCells = pg => [...pg.$('summaryBySeller').querySelectorAll('tbody tr')][0].cells;
const num = c => c.textContent.replace(/\s+/g, ' ').trim().replace(/ ✎.*/, '');
const accept = async o => {
  await pool.query("update public.docs set data = data || $2::jsonb where path = $1", ['marketplaceOrders/' + o.id, JSON.stringify({ status: 'ACCEPTED', invoiceId: 'inv1', invoiceNo: '26-27/0009', invoiceDate: '2026-10-27',
    invoiceSummary: { subtotal: 1, cgst: 0, sgst: 0, igst: 0, grandTotal: 1 }, items: o.items.map(i => ({ productId: i.productId, productName: i.productName, qty: i.qty, rate: 200, gstRate: 5, taxable: i.qty * 200, gstAmt: i.qty * 10, total: i.qty * 210 })) })]);
  loadPage('billing/buyer/my-orders.html', B, { ...pageOpts, hook: require('./lib/sbload').read('billing/assets/user-menu.js') });
  await sleep(2500);
};

// the three rules, end to end: labels → stock deduction → draft → order → seller accepts → stock
for (const [before, after, order] of [[10, -90, 90], [-10, -110, 110], [0, -100, 100]]) {
  test(`stock ${before} + 100 labels → Stock Now ${after} → order ${order} → stock 0 once accepted`, async () => {
    await world(before);
    const pg = loadPage('billing/buyer/label-order.html', B, pageOpts); await sleep(1800);
    await pg.w.processHits(hitsOf(100), 1); await sleep(300);
    assert.equal((await read(SB + '/buyerSkuMappings/bm1')).stock, after, 'stock after the 100 labels');
    const d = await read(SB + '/labelOrderDrafts/pending_' + A.uid);
    assert.equal(d.itemsByProduct.wm00000001.qty, 100, '100 labels printed');
    const c = rowCells(pg);
    assert.deepEqual([num(c[3]), num(c[4]), num(c[6])], ['100', String(after), String(order)], 'labels / Stock Now / Balance to Order');
    await pg.w.eval(`placeAutoOrder('pending_${A.uid}')`); await sleep(1100);
    const os = await orders(); assert.equal(os.length, 1); assert.equal(qtyOf(os[0]), order, 'order placed');
    await accept(os[0]);
    assert.equal((await read(SB + '/buyerSkuMappings/bm1')).stock, 0, 'zero after the seller accepts');
  });
}

test('stock that already covers the labels: nothing is ordered (stock 150 + 100 labels → 50 left)', async () => {
  await world(150);
  const pg = loadPage('billing/buyer/label-order.html', B, pageOpts); await sleep(1800);
  await pg.w.processHits(hitsOf(100), 1); await sleep(300);
  assert.equal((await read(SB + '/buyerSkuMappings/bm1')).stock, 50);
  assert.equal(num(rowCells(pg)[6]).replace(/\D.*/, ''), '0');
  await pg.w.eval(`placeAutoOrder('pending_${A.uid}')`); await sleep(900);
  assert.equal((await orders()).length, 0, 'no order');
  assert.equal((await read(SB + '/buyerSkuMappings/bm1')).stock, 50, 'stock untouched');
});

test('a label upload that stopped half-way is repaired by uploading the same file again (stock + draft never out of step)', async () => {
  await world(10);
  // what a crash used to leave behind: all 100 labels in the draft, but the stock never came off
  await seed(SB + '/labelOrderDrafts/pending_' + A.uid, { date: '2026-10-27', firstDate: '2026-10-27', lastDate: '2026-10-27', dates: ['2026-10-27'], sellerId: A.uid, sellerName: 'VISUTRA',
    pageHashes: hitsOf(100).map(h => h.pageHash), itemsByProduct: { wm00000001: { productName: 'Washing Machine Cover', sellerSku: 'VST-WM', mappingId: 'bm1', qty: 100, breakdown: { amazon: 0, meesho: 100, flipkart: 0 } } } });
  const pg = loadPage('billing/buyer/label-order.html', B, pageOpts); await sleep(1800);
  assert.equal(num(rowCells(pg)[6]).replace(/\D.*/, ''), '0', 'before the repair the order would wrongly be 0');
  await pg.w.processHits(hitsOf(100), 1); await sleep(300);
  assert.equal((await read(SB + '/buyerSkuMappings/bm1')).stock, -90, 'stock now taken off');
  assert.equal((await read(SB + '/labelOrderDrafts/pending_' + A.uid)).itemsByProduct.wm00000001.qty, 100, 'draft not doubled');
  assert.match(pg.$('uploadMsg').textContent, /100 were already in the summary but their stock had not been deducted/);
  assert.equal(num(rowCells(pg)[6]), '90');
  await pg.w.processHits(hitsOf(100), 1); await sleep(300);          // a third time changes nothing
  assert.equal((await read(SB + '/buyerSkuMappings/bm1')).stock, -90);
  assert.equal((await read(SB + '/labelOrderDrafts/pending_' + A.uid)).itemsByProduct.wm00000001.qty, 100);
});
