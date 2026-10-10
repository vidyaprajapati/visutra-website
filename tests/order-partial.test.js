const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { seed, read, list, reset, pool, makeClient } = require('./lib/fakesb');
const { loadPage, sleep, closeAll, A, B, C } = require('./lib/sbload');
after(async () => { closeAll(); await pool.end(); });
const SA = 'users/' + A.uid;

async function world(){
  await reset();
  await seed(SA, { businessName: 'VISUTRA', gstin: '09BVHPP4321G1ZJ', stateCode: '09', state: 'Uttar Pradesh', profileComplete: true, roles: { seller: true } });
  await seed('users/' + B.uid, { businessName: 'Visu trader', profileComplete: true, roles: { buyer: true } });
  await seed(`sellerLinks/${A.uid}_${B.uid}`, { sellerUid: A.uid, buyerUid: B.uid, status: 'ACTIVE' });
  await seed(SA + '/products/bed', { name: 'Bedsheet 72x95', price: 400, gstRate: 5, hsn: '6304', unit: 'PCS', stock: 10, active: true });
  await seed(SA + '/products/wm', { name: 'Washing Machine Cover', price: 300, gstRate: 5, hsn: '6307', unit: 'PCS', stock: 50, active: true });
  await seed(SA + '/products/led', { name: '50 inch LED Cover', price: 250, gstRate: 5, hsn: '6307', unit: 'PCS', stock: -158, active: true });
  await seed('marketplaceOrders/o1', { buyerUid: B.uid, sellerUid: A.uid, buyerEmail: 'b@x.in', sellerName: 'VISUTRA', status: 'PENDING', orderType: 'LABEL_AUTO', orderNumber: 'VIS-ORD-20261008-UGZJZJ',
    buyerBusiness: { businessName: 'Visu trader', gstin: '09AAACR5055K1Z5', stateCode: '09', state: 'Uttar Pradesh' }, createdAt: { __ts: '2026-10-08T10:00:00.000Z' },
    items: [{ productId: 'bed', productName: 'Bedsheet 72x95', qty: 2 }, { productId: 'wm', productName: 'Washing Machine Cover', qty: 30 }, { productId: 'led', productName: '50 inch LED Cover', qty: 8 }] });
}
const stock = async id => (await read(SA + '/products/' + id)).stock;

test('Tick the items to accept: invoice + stock for those only; the rest becomes a new pending order', async () => {
  await world();
  const { w, $ } = loadPage('billing/seller/order-receive.html', A, { before: w => { w.confirm = () => true; w.emailjs = { init(){}, send: async () => ({}) }; } }); await sleep(1800);
  const boxes = [...w.document.querySelectorAll('.oi-chk[data-order="o1"]')];
  assert.equal(boxes.length, 3);
  assert.deepEqual(boxes.map(b => b.checked), [true, true, false], 'short-stock LED cover starts unticked');
  assert.match($('order-row-o1').textContent, /stock -158 — short by 166/);
  assert.equal($('oi-count-o1').textContent, '2');
  // Select all on / off
  w.toggleAllOrderItems('o1', true); assert.equal($('oi-count-o1').textContent, '3');
  w.toggleAllOrderItems('o1', false); assert.equal($('oi-count-o1').textContent, '0'); assert.equal($('oi-accept-o1').disabled, true);
  boxes[0].checked = true; boxes[1].checked = true; w.onOrderItemTick('o1');
  assert.equal(w.document.querySelector('.oi-all-chk[data-order="o1"]').indeterminate, true);
  await w.eval("acceptOrder('o1')"); await sleep(800);
  // stock only for the ticked items
  assert.deepEqual([await stock('bed'), await stock('wm'), await stock('led')], [8, 20, -158]);
  const o1 = await read('marketplaceOrders/o1');
  assert.equal(o1.status, 'ACCEPTED');
  assert.deepEqual(o1.items.map(i => [i.productName, i.qty]), [['Bedsheet 72x95', 2], ['Washing Machine Cover', 30]]);
  assert.equal(o1.originalItems.length, 3);
  const inv = (await list(SA + '/invoices/'))[0].data;
  assert.equal(inv.items.length, 2); assert.equal(inv.subtotal, 2 * 400 + 30 * 300);
  // the rest: new pending order, visible to the buyer
  const rest = await read('marketplaceOrders/' + o1.splitInto);
  assert.deepEqual([rest.status, rest.orderNumber, rest.splitFromOrderId, rest.items.length, rest.items[0].productName], ['PENDING', 'VIS-ORD-20261008-UGZJZJ-P2', 'o1', 1, '50 inch LED Cover']);
  const seen = await makeClient(() => B).from('docs').select('path,data,version').eq('path', 'marketplaceOrders/' + o1.splitInto);
  assert.equal(seen.data.length, 1, 'buyer sees the remaining order');
  assert.match($('pageMsg').textContent, /pending as order VIS-ORD-20261008-UGZJZJ-P2/);
  // stock arrives → the remaining order can be accepted later
  await pool.query("update docs set data = jsonb_set(data, '{stock}', '20') where path = $1", [SA + '/products/led']);
  const pg2 = loadPage('billing/seller/order-receive.html', A, { before: w => { w.confirm = () => true; w.emailjs = { init(){}, send: async () => ({}) }; } }); await sleep(1800);
  assert.equal(pg2.$('oi-count-' + o1.splitInto).textContent, '1');
  await pg2.w.eval(`acceptOrder('${o1.splitInto}')`); await sleep(700);
  assert.equal((await read('marketplaceOrders/' + o1.splitInto)).status, 'ACCEPTED');
  assert.equal(await stock('led'), 12);
});

test('A seller cannot create a pending order out of nothing (only the remainder of their own order to that buyer)', async () => {
  await world();
  const mk = (who, data) => makeClient(() => who).rpc('vt_commit', { ops: [{ op: 'set', path: 'marketplaceOrders/x' + Math.random().toString(36).slice(2, 7), data }], pre: [] });
  const base = { buyerUid: B.uid, sellerUid: A.uid, status: 'PENDING', items: [] };
  assert.ok((await mk(A, base)).error, 'no splitFromOrderId → refused');
  assert.ok((await mk(A, { ...base, splitFromOrderId: 'nope' })).error, 'unknown parent → refused');
  assert.ok(!(await mk(A, { ...base, splitFromOrderId: 'o1' })).error, 'remainder of a real order → allowed');
  assert.ok((await mk(C, { ...base, sellerUid: C.uid, splitFromOrderId: 'o1' })).error, 'someone else → refused');
});
