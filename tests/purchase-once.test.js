const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), path = require('path');
const { seed, read, list, reset, pool } = require('./lib/fakesb');
const { loadPage, sleep, closeAll, A, B, read: readSrc } = require('./lib/sbload');
after(async () => { closeAll(); await pool.end(); });
const SB = 'users/' + B.uid;
async function world(){
  await reset();
  await seed(SB, { businessName: 'Visu trader', profileComplete: true, roles: { buyer: true } });
  await seed(`sellerLinks/${A.uid}_${B.uid}`, { sellerUid: A.uid, buyerUid: B.uid, status: 'ACTIVE' });
  // 0 in stock → 49 labels printed → −49
  await seed(SB + '/buyerSkuMappings/bm1', { status: 'ACTIVE', productName: 'Washing Machine Cover', sellerId: A.uid, productId: 'p1', stock: -49 });
  await seed('marketplaceOrders/o1', { buyerUid: B.uid, sellerUid: A.uid, sellerName: 'VISUTRA', status: 'ACCEPTED', orderType: 'LABEL_AUTO', orderNumber: 'VIS-ORD-1',
    invoiceId: 'i1', invoiceNo: 'VT/01', invoiceDate: '2026-10-09', invoiceSummary: { subtotal: 14700, cgst: 367.5, sgst: 367.5, grandTotal: 15435 },
    items: [{ productId: 'p1', productName: 'Washing Machine Cover', qty: 49, rate: 300, gstRate: 5, taxable: 14700 }] });
}
const withMenu = pg => { pg.w.eval(readSrc('billing/assets/user-menu.js')); return pg; };

test('Seller accepts a label order: buyer stock −49 → 0, even when several pages record it at the same moment', async () => {
  await world();
  const pages = [withMenu(loadPage('billing/buyer/my-orders.html', B)), withMenu(loadPage('billing/buyer/dashboard.html', B)), withMenu(loadPage('billing/buyer/stock.html', B))];
  await sleep(1500);
  const order = { id: 'o1', ...(await read('marketplaceOrders/o1')) };
  // three at once (My Orders' live update + Dashboard + the background check on another page)
  const results = await Promise.all(pages.map(pg => pg.w.vtEnsureBuyerPurchaseForOrder(B.uid, order, null).catch(e => ({ err: e.message }))));
  await sleep(500);
  const purchases = await list(SB + '/buyerPurchases/');
  assert.equal(purchases.length, 1, 'exactly one purchase for the order');
  assert.equal(purchases[0].path.split('/').pop(), 'ord-o1');
  assert.equal((await read(SB + '/buyerSkuMappings/bm1')).stock, 0, '−49 + 49 = 0 (not 49)');
  const mv = (await list(SB + '/buyerStockMovements/')).map(r => r.data);
  assert.deepEqual(mv.map(m => [m.type, m.qty, m.date]), [['purchase-in', 49, '2026-10-09']]);
  assert.equal((await read('marketplaceOrders/o1')).buyerPurchaseId, 'ord-o1');
  // (My Orders' own live update may already have done it on load — then none of the three does; never more than one)
  assert.ok(results.filter(r => r && r.created).length <= 1, 'never more than one did the work');
  // the pages' own functions delegate to the same once-only one
  await pages[0].w.eval('ensureBuyerPurchaseForOrder')({ ...order });
  await pages[1].w.eval('ensureBuyerPurchaseForOrder')({ ...order });
  assert.equal((await read(SB + '/buyerSkuMappings/bm1')).stock, 0); assert.equal((await list(SB + '/buyerPurchases/')).length, 1);
});

test('One-time clean-up: an order already counted twice (stock 49) is corrected to 0', async () => {
  await world();
  await pool.query("update docs set data = jsonb_set(data, '{stock}', '49') where path = $1", [SB + '/buyerSkuMappings/bm1']);
  await pool.query("update docs set data = data || '{\"buyerPurchaseId\":\"keep\"}' where path = 'marketplaceOrders/o1'");
  const pur = { autoCreatedFromOrder: true, orderId: 'o1', orderNumber: 'VIS-ORD-1', date: '2026-10-09', items: [{ name: 'Washing Machine Cover', qty: 49, linkedSkuMappingId: 'bm1' }] };
  await seed(SB + '/buyerPurchases/keep', pur);
  await seed(SB + '/buyerPurchases/dup', pur);
  await pool.query(fs.readFileSync(path.join(__dirname, '..', 'supabase', 'schema.sql'), 'utf8'));
  assert.equal(await read(SB + '/buyerPurchases/dup'), undefined, 'duplicate removed');
  assert.ok(await read(SB + '/buyerPurchases/keep'), 'the real one stays');
  assert.equal((await read(SB + '/buyerSkuMappings/bm1')).stock, 0, '49 → 0');
  const note = (await list(SB + '/buyerStockMovements/')).map(r => r.data).find(m => m.type === 'adjustment');
  assert.match(note.note, /Removed duplicate purchase of order VIS-ORD-1/);
});
