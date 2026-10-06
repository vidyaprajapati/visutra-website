const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { seed, read, list, reset, pool, makeClient } = require('./lib/fakesb');
const { loadPage, sleep, closeAll, A, B, C, read: readSrc } = require('./lib/sbload');
// The 🔔 approvals bar lives in user-menu.js (the page loader skips that file) — load it and draw the bar.
async function bar(page, who){ page.w.eval(readSrc('billing/assets/user-menu.js')); await page.w.vtLoadApprovalBar(who, ''); return page.$('vtApprovalBar'); }
after(async () => { closeAll(); await pool.end(); });
const SA = 'users/' + A.uid, SB = 'users/' + B.uid;

async function world(){
  await reset();
  await seed(SA, { businessName: 'VISUTRA', gstin: '09BVHPP4321G1ZJ', stateCode: '09', profileComplete: true, roles: { seller: true } });
  await seed(SB, { businessName: 'Shop', fullName: 'Buyer', profileComplete: true, roles: { buyer: true } });
  await seed(`sellerLinks/${A.uid}_${B.uid}`, { sellerUid: A.uid, buyerUid: B.uid, status: 'ACTIVE' });
  await seed(SA + '/customers/c1', { name: 'Shop', linkedBuyerUid: B.uid, linkStatus: 'ACTIVE' });
  await seed(SA + '/products/p1', { name: 'WM Cover', stock: 8 });
  await seed(SB + '/buyerSkuMappings/bm1', { status: 'ACTIVE', productName: 'WM Cover', stock: 5, linkType: 'SELLER', sellerId: A.uid, productId: 'p1' });
  await seed(SB + '/buyerSuppliers/s1', { name: 'VISUTRA', sellerUid: A.uid });
}
const opts = { prompt: () => 'wrong rate', before: w => { w.prompt = () => 'wrong rate'; } };

test('Invoice deletion needs the buyer\'s approval, then goes on BOTH sides (linked customer and order invoices)', async () => {
  await world();
  await seed(SA + '/invoices/i1', { createdAt: { __ts: '2026-09-02T10:00:00.000Z' }, invoiceNo: 'VT/001', date: '2026-09-02', customerId: 'c1', customer: { name: 'Shop' }, grandTotal: 630, items: [{ productId: 'p1', name: 'WM Cover', qty: 2 }] });
  // (saving i1 for the linked customer created the buyer's purchase automatically: stock 5 → 7)
  assert.equal((await read(SB + '/buyerSkuMappings/bm1')).stock, 7);
  await seed(SA + '/invoices/i2', { createdAt: { __ts: '2026-09-03T10:00:00.000Z' }, invoiceNo: 'VT/002', date: '2026-09-03', sourceOrderId: 'o1', customer: { name: 'Shop' }, grandTotal: 945, items: [{ productId: 'p1', name: 'WM Cover', qty: 3 }] });
  await seed('marketplaceOrders/o1', { buyerUid: B.uid, sellerUid: A.uid, status: 'ACCEPTED', buyerPurchaseId: 'bp2', orderNumber: 'ORD-1' });
  await seed(SB + '/buyerPurchases/bp2', { date: '2026-09-03', items: [{ name: 'WM Cover', qty: 3, linkedSkuMappingId: 'bm1' }] });
  const seller = loadPage('billing/app.html', A, opts); await sleep(1800);
  await seller.w.eval("activateView('invoices')"); await seller.w.eval('loadInvoices()'); await sleep(300);
  await seller.w.eval("deleteInvoice('i1')"); await seller.w.eval("deleteInvoice('i2')"); await sleep(300);
  assert.notEqual((await read(SA + '/invoices/i1')).deleted, true, 'not deleted before approval');
  const reqs = (await list('invoiceDeleteRequests/')).map(r => r.data);
  assert.equal(reqs.length, 2); assert.ok(reqs.every(r => r.status === 'PENDING' && r.buyerUid === B.uid));
  // the buyer is told on every page
  const other = loadPage('billing/buyer/stock.html', B); await sleep(1500);
  assert.match((await bar(other, B)).textContent, /2 invoice deletion request/);
  // buyer accepts both
  const buyer = loadPage('billing/buyer/dashboard.html', B); await sleep(1500);
  const ids = (await list('invoiceDeleteRequests/')).map(r => r.path.split('/')[1]);
  for(const id of ids){ await buyer.w.eval(`respondToDeleteRequest('${id}', true)`); await sleep(300); }
  assert.equal((await read(SA + '/invoices/i1')).deleted, true); assert.equal((await read(SA + '/invoices/i2')).deleted, true);
  assert.equal((await read(SA + '/products/p1')).stock, 13, 'seller stock back: 8 + 2 + 3');
  assert.equal((await list(SB + '/buyerPurchases/')).length, 0, 'both purchases gone');
  assert.equal((await read(SB + '/buyerSkuMappings/bm1')).stock, 2, 'buyer stock back: 7 − 2 (invoice) − 3 (order)');
  assert.ok((await list('invoiceDeleteRequests/')).every(r => r.data.status === 'COMPLETED'));
});

test('Rejected or GST-filed: nothing is deleted anywhere', async () => {
  await world();
  await seed(SA + '/invoices/i1', { invoiceNo: 'VT/001', customerId: 'c1', items: [{ productId: 'p1', qty: 2 }] });
  await seed(SA + '/invoices/i3', { invoiceNo: 'VT/003', customerId: 'c1', items: [{ productId: 'p1', qty: 1 }] });
  // the purchase created automatically for i3 is filed on the buyer's side
  await pool.query("update docs set data = data || '{\"gstFiled\": true}' where data->>'invoiceId' = 'i3'");
  await seed('invoiceDeleteRequests/r1', { sellerUid: A.uid, buyerUid: B.uid, invoiceId: 'i1', status: 'PENDING' });
  await seed('invoiceDeleteRequests/r3', { sellerUid: A.uid, buyerUid: B.uid, invoiceId: 'i3', status: 'PENDING' });
  const asB = makeClient(() => B);
  assert.ok(!(await asB.rpc('vt_commit', { ops: [{ op: 'update', path: 'invoiceDeleteRequests/r1', data: { status: 'REJECTED' } }] })).error);
  const filed = await asB.rpc('vt_commit', { ops: [{ op: 'update', path: 'invoiceDeleteRequests/r3', data: { status: 'ACCEPTED' } }] });
  assert.match(filed.error.message, /already filed/);
  assert.notEqual((await read(SA + '/invoices/i1')).deleted, true); assert.notEqual((await read(SA + '/invoices/i3')).deleted, true);
  assert.equal((await list(SB + '/buyerPurchases/')).filter(r => r.data.invoiceId === 'i3').length, 1, 'filed purchase still there'); assert.equal((await read('invoiceDeleteRequests/r3')).status, 'PENDING', 'the failed approval changed nothing');
  assert.equal((await read(SA + '/products/p1')).stock, 8);
});

test('Payments: confirm → both sides at once; deletion only after the other side approves (either direction); cancel', async () => {
  await world();
  const pay = loadPage('billing/buyer/payment-entry.html', B, opts); await sleep(1500);
  const recordPayment = async amt => { pay.$('payEntrySupplier').value = 's1'; pay.$('payEntryAmount').value = String(amt); pay.$('payEntryDate').value = '2026-09-10'; await pay.w.eval('savePaymentEntry()'); await sleep(300); };
  await recordPayment(5000); await recordPayment(2000); await recordPayment(700);
  const seller = loadPage('billing/app.html', A, opts); await sleep(1800);
  assert.match((await bar(seller, A)).textContent, /3 payment\(s\) from buyers to confirm/);
  const conf = (await list('paymentConfirmations/')).map(r => ({ id: r.path.split('/')[1], ...r.data }));
  const byAmt = a => conf.find(c => c.amount === a);
  await seller.w.eval(`respondToPaymentConfirmation('${byAmt(5000).id}', true)`); await seller.w.eval(`respondToPaymentConfirmation('${byAmt(2000).id}', true)`); await sleep(400);
  const receipts = (await list(SA + '/receipts/')).map(r => ({ id: r.path.split('/').pop(), ...r.data }));
  assert.equal(receipts.length, 2); assert.ok(receipts.every(r => r.sourceConfirmationId && r.linkedBuyerUid === B.uid && r.customerId === 'c1'));
  const pays = async () => (await list(SB + '/buyerPayments/')).map(r => ({ id: r.path.split('/').pop(), ...r.data }));
  const p5 = (await pays()).find(p => p.amount === 5000), p2 = (await pays()).find(p => p.amount === 2000);
  assert.equal(p5.status, 'CONFIRMED', 'buyer side confirmed immediately'); assert.ok(p5.receiptId);
  // buyer cancels the 700 still waiting
  await pay.w.eval('loadPayments()'); await sleep(200);
  const p7 = (await pays()).find(p => p.amount === 700);
  await pay.w.eval(`cancelPayment('${p7.id}')`); await sleep(300);
  assert.ok(!(await pays()).some(p => p.amount === 700), 'cancelled pending payment removed');
  // buyer asks to delete the 5000 → seller approves → gone on both sides
  await pay.w.eval(`requestPaymentDeletion('${p5.id}')`); await sleep(300);
  assert.equal((await pays()).find(p => p.id === p5.id).deleted, undefined, 'stays until approved');
  await seller.w.eval('loadPaymentDeleteRequests()'); await sleep(200);
  const del = (await list('paymentDeleteRequests/'))[0];
  await seller.w.eval(`respondToPaymentDelete('${del.path.split('/')[1]}', true)`); await sleep(400);
  assert.equal((await pays()).find(p => p.id === p5.id).deleted, true);
  assert.equal((await read(SA + '/receipts/' + p5.receiptId)).deleted, true);
  // seller asks to delete the 2000 receipt → buyer approves → gone on both sides
  await seller.w.eval('loadReceipts()'); await sleep(300);
  await seller.w.eval(`deleteReceipt('${p2.receiptId}')`); await sleep(300);
  assert.notEqual((await read(SA + '/receipts/' + p2.receiptId)).deleted, true, 'stays until approved');
  const dash = loadPage('billing/buyer/dashboard.html', B); await sleep(1500);
  const sreq = (await list('paymentDeleteRequests/')).find(r => r.data.requestedBy === 'seller');
  await dash.w.eval(`respondToPayDelete('${sreq.path.split('/')[1]}', true)`); await sleep(400);
  assert.equal((await read(SA + '/receipts/' + p2.receiptId)).deleted, true);
  assert.equal((await pays()).find(p => p.id === p2.id).deleted, true);
});

test('Only the other party can approve; nobody else', async () => {
  await world();
  await seed('invoiceDeleteRequests/r1', { sellerUid: A.uid, buyerUid: B.uid, invoiceId: 'x', status: 'PENDING' });
  await seed('paymentDeleteRequests/d1', { requestedBy: 'buyer', buyerUid: B.uid, sellerUid: A.uid, buyerPaymentId: 'x', status: 'PENDING' });
  const upd = (who, path) => makeClient(() => who).rpc('vt_commit', { ops: [{ op: 'update', path, data: { status: 'ACCEPTED' } }] });
  assert.ok((await upd(A, 'invoiceDeleteRequests/r1')).error, 'seller cannot approve own invoice request');
  assert.ok((await upd(B, 'paymentDeleteRequests/d1')).error, 'buyer cannot approve own payment request');
  assert.ok((await upd(C, 'paymentDeleteRequests/d1')).error, 'stranger cannot approve');
  assert.ok((await makeClient(() => C).rpc('vt_commit', { ops: [{ op: 'set', path: 'paymentDeleteRequests/d2', data: { requestedBy: 'buyer', buyerUid: B.uid, sellerUid: A.uid, status: 'PENDING' } }] })).error, 'stranger cannot file requests for others');
});

test('Buyer can ask to delete a seller\'s invoice; seller approves → both sides; results notified both ways', async () => {
  await world();
  await seed(SA + '/invoices/i4', { createdAt: { __ts: '2026-09-04T10:00:00.000Z' }, invoiceNo: 'VT/004', date: '2026-09-04', sourceOrderId: 'o4', customer: { name: 'Shop' }, grandTotal: 630, items: [{ productId: 'p1', name: 'WM Cover', qty: 2 }] });
  await seed('marketplaceOrders/o4', { buyerUid: B.uid, sellerUid: A.uid, sellerName: 'VISUTRA', status: 'ACCEPTED', buyerPurchaseId: 'bp4', orderNumber: 'ORD-4', invoiceId: 'i4' });
  await seed(SB + '/buyerPurchases/bp4', { supplierId: 's1', supplierName: 'VISUTRA', orderId: 'o4', invoiceId: 'i4', invoiceNo: 'VT/004', autoCreatedFromOrder: true, date: '2026-09-04', grandTotal: 630,
    items: [{ name: 'WM Cover', qty: 2, linkedSkuMappingId: 'bm1' }] });
  const gst = loadPage('billing/buyer/purchases-gstr.html', B, opts); await sleep(1500);
  assert.match(gst.w.purchaseDeleteCell({ id: 'bp4' }), /Request deletion/, 'buyer sees Request deletion, not Delete');
  await gst.w.eval("deletePurchase('bp4')"); await sleep(400);        // the old Delete path is redirected to a request
  assert.ok(await read(SB + '/buyerPurchases/bp4'), 'nothing deleted on one side');
  const req = (await list('invoiceDeleteRequests/'))[0];
  assert.deepEqual([req.data.requestedBy, req.data.sellerUid, req.data.status, req.data.purchaseId], ['buyer', A.uid, 'PENDING', 'bp4']);
  // the seller is told, and approves
  const seller = loadPage('billing/app.html', A, opts); await sleep(1800);
  assert.match((await bar(seller, A)).textContent, /1 invoice deletion request\(s\) from buyers/);
  await seller.w.eval(`respondToBuyerInvoiceDelete('${req.path.split('/')[1]}', true)`); await sleep(500);
  assert.equal((await read(SA + '/invoices/i4')).deleted, true);
  assert.equal((await read(SA + '/products/p1')).stock, 10, 'seller stock back');
  assert.equal(await read(SB + '/buyerPurchases/bp4'), undefined);
  assert.equal((await read(SB + '/buyerSkuMappings/bm1')).stock, 3, 'buyer stock back');
  // the buyer is told the result, and can dismiss it
  const dash = loadPage('billing/buyer/dashboard.html', B); await sleep(1500);
  const b1 = await bar(dash, B);
  assert.match(b1.textContent, /✅ VISUTRA approved — invoice VT\/004 deleted from both accounts/);
  await dash.w.vtDismissNote(b1.querySelector('[data-note]')); await sleep(400);  // (test browser doesn't run inline onclick)
  assert.ok(!dash.$('vtApprovalBar'), 'dismissed → bar gone');
  assert.ok((await list(SB + '/notifications/')).every(n => n.data.read === true));
});

test('Rejections and payment confirmations are notified to the person who asked', async () => {
  await world();
  await seed('invoiceDeleteRequests/r5', { requestedBy: 'seller', sellerUid: A.uid, sellerName: 'VISUTRA', buyerUid: B.uid, buyerName: 'Shop', invoiceId: 'i5', invoiceNo: 'VT/005', status: 'PENDING' });
  assert.ok(!(await makeClient(() => B).rpc('vt_commit', { ops: [{ op: 'update', path: 'invoiceDeleteRequests/r5', data: { status: 'REJECTED' } }] })).error);
  const sellerNotes = (await list(SA + '/notifications/')).map(n => n.data.text);
  assert.ok(sellerNotes.some(t => /❌ Shop rejected your request to delete invoice VT\/005/.test(t)), sellerNotes.join(' | '));
  await seed(SB + '/buyerPayments/bp9', { status: 'PENDING_SELLER_CONFIRMATION', amount: 1500, date: '2026-09-12' });
  await seed('paymentConfirmations/pc9', { buyerUid: B.uid, buyerName: 'Shop', sellerUid: A.uid, buyerPaymentId: 'bp9', amount: 1500, date: '2026-09-12', status: 'PENDING' });
  assert.ok(!(await makeClient(() => A).rpc('vt_commit', { ops: [{ op: 'update', path: 'paymentConfirmations/pc9', data: { status: 'APPROVED', customerId: 'c1', customerName: 'Shop' } }] })).error);
  const buyerNotes = (await list(SB + '/notifications/')).map(n => n.data.text);
  assert.ok(buyerNotes.some(t => /✅ VISUTRA confirmed your payment of ₹1500/.test(t)), buyerNotes.join(' | '));
  assert.equal((await read(SB + '/buyerPayments/bp9')).status, 'CONFIRMED');
});
