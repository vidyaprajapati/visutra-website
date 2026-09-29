const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { seed, read, list, reset, pool, makeClient } = require('./lib/fakesb');
const { loadPage, loadCore, mkPdf, sleep, closeAll, A, B, C } = require('./lib/sbload');
after(async () => { closeAll(); await pool.end(); });

const commit = (who, ops, pre) => makeClient(() => who).rpc('vt_commit', { ops, pre: pre || [] });
const denied = r => !!r.error;

test('each user reaches only their own data', async () => {
  await reset();
  assert.ok(!denied(await commit(A, [{ op: 'set', path: `users/${A.uid}/products/p1`, data: { name: 'WM Cover', stock: 10 } }])));
  const bRead = await makeClient(() => B).from('docs').select('path,data,version').eq('col', `users/${A.uid}/products`);
  assert.equal(bRead.data.length, 0, 'B must not read A\'s products');
  assert.ok(denied(await commit(B, [{ op: 'set', path: `users/${A.uid}/products/hack`, data: { x: 1 } }])), 'B must not write into A\'s data');
});

test('a batch is all-or-nothing', async () => {
  await reset();
  const r = await commit(A, [{ op: 'set', path: `users/${A.uid}/products/p2`, data: { x: 1 } }, { op: 'update', path: `users/${A.uid}/products/missing`, data: { x: 1 } }]);
  assert.ok(denied(r));
  assert.equal(await read(`users/${A.uid}/products/p2`), undefined, 'the good half must not be saved');
});

test('transactions detect a change made in between (conflict)', async () => {
  await reset();
  await seed(`users/${A.uid}/products/p1`, { stock: 5 });
  const r = await commit(A, [{ op: 'update', path: `users/${A.uid}/products/p1`, data: { stock: 4 } }], [{ path: `users/${A.uid}/products/p1`, version: 99 }]);
  assert.match(r.error.message, /VT_CONFLICT/);
});

test('seller/buyer sharing follows the rules', async () => {
  await reset();
  await seed(`users/${A.uid}/products/sp1`, { name: 'Visible', active: true, buyerVisibility: true });
  await seed(`users/${A.uid}/products/sp2`, { name: 'Hidden', active: true, buyerVisibility: false });
  assert.ok(!denied(await commit(A, [{ op: 'set', path: `sellerLinks/${A.uid}_${B.uid}`, data: { sellerUid: A.uid, buyerUid: B.uid, status: 'ACTIVE' } }])));
  assert.ok(denied(await commit(C, [{ op: 'set', path: `sellerLinks/${A.uid}_${C.uid}`, data: { sellerUid: A.uid, buyerUid: C.uid, status: 'ACTIVE' } }])), 'nobody can link themselves to a seller');
  const seen = await makeClient(() => B).from('docs').select('path,data,version').eq('col', `users/${A.uid}/products`);
  assert.deepEqual(seen.data.map(r => r.data.name), ['Visible'], 'linked buyer sees only visible products');
  const cSeen = await makeClient(() => C).from('docs').select('path,data,version').eq('col', `users/${A.uid}/products`);
  assert.equal(cSeen.data.length, 0);
  assert.ok(!denied(await commit(B, [{ op: 'set', path: 'marketplaceOrders/o1', data: { buyerUid: B.uid, sellerUid: A.uid, status: 'PENDING' } }])));
  assert.ok(denied(await commit(C, [{ op: 'set', path: 'marketplaceOrders/o2', data: { buyerUid: C.uid, sellerUid: A.uid, status: 'PENDING' } }])), 'unlinked buyer cannot order');
  assert.ok(denied(await commit(B, [{ op: 'update', path: 'marketplaceOrders/o1', data: { status: 'ACCEPTED' } }])), 'buyer cannot accept own order');
  assert.ok(!denied(await commit(A, [{ op: 'update', path: 'marketplaceOrders/o1', data: { status: 'ACCEPTED' } }])));
  assert.ok(denied(await commit(A, [{ op: 'delete', path: 'marketplaceOrders/o1' }])), 'orders cannot be deleted');
});

test('look-up-only collections: one document yes, listing no', async () => {
  await reset();
  assert.ok(!denied(await commit(A, [{ op: 'set', path: 'public_invoices/inv1', data: { sellerUid: A.uid, total: 500 } }])));
  assert.ok(!denied(await commit(A, [{ op: 'set', path: 'usernames/visutra', data: { uid: A.uid, email: A.email } }])));
  const anon = makeClient(() => null);
  assert.equal((await anon.rpc('vt_get_public', { p_path: 'public_invoices/inv1' })).data.data.total, 500);
  assert.equal((await anon.rpc('vt_get_public', { p_path: 'usernames/visutra' })).data.data.email, A.email);
  assert.ok((await anon.from('docs').select('path,data,version').eq('col', 'public_invoices')).error, 'visitors cannot list invoices');
  assert.ok(denied(await commit(B, [{ op: 'set', path: 'usernames/visutra', data: { uid: B.uid } }])), 'usernames cannot be taken over');
  assert.ok((await anon.rpc('vt_commit', { ops: [{ op: 'set', path: 'usernames/x', data: {} }], pre: [] })).error, 'visitors cannot save anything');
});
