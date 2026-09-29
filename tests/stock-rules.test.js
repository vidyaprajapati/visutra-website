const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { seed, read, list, reset, pool, makeClient } = require('./lib/fakesb');
const { loadPage, loadCore, mkPdf, sleep, closeAll, A, B, C } = require('./lib/sbload');
after(async () => { closeAll(); await pool.end(); });

test('two Amazon orders of the same SKU are two different shipments', async () => {
  const w = loadCore(A);
  const k1 = w.labelKey('AMAZON', 'led-clr-55', 'Order Number: 404-1111111-1111111');
  const k2 = w.labelKey('AMAZON', 'led-clr-55', 'Order Number: 404-2222222-2222222');
  assert.notEqual(k1, k2);
});

test('the same label printed on five devices at the same moment deducts ONCE', async () => {
  await reset();
  await seed(`users/${A.uid}/products/p1`, { name: 'WM Cover', stock: 10 });
  const devices = [1, 2, 3, 4, 5].map(() => loadCore(A));
  const item = { key: 'L_MEESHO_111111111_1_vst-a', marketplace: 'MEESHO', sku: 'VST-A', qty: 1 };
  const product = { id: 'p1', name: 'WM Cover' };
  const results = await Promise.all(devices.map(w => w.VLS.sellerProductOnce(A.uid, item, product, 'test')));
  assert.deepEqual(results.sort(), ['already', 'already', 'already', 'already', 'deducted'], 'five devices at once → exactly one deduction');
  assert.equal((await read(`users/${A.uid}/products/p1`)).stock, 9);
  assert.equal((await list(`users/${A.uid}/stockMovements/`)).length, 1, 'exactly one movement logged');
});

test('reconciliation status rules: DELIVERED/EXCHANGED sold, CANCELLED zero, else returned', async () => {
  const w = loadCore(A);
  const k = s => w.VLS.reconStatusKind(s);
  assert.equal(k('DELIVERED'), 'sold'); assert.equal(k('DOOR_STEP_EXCHANGED'), 'sold');
  assert.equal(k('CANCELLED'), 'cancel'); assert.equal(k('RTO_COMPLETE'), 'return');
  assert.equal(k('RTO_DELIVERED'), 'return', 'RTO_DELIVERED means it came back');
  assert.equal(k(''), null);
});

test('"All platforms" SKUs match every marketplace; clashes are blocked', async () => {
  const w = loadCore(A);
  const Am = { id: 'A', productName: '9kg', status: 'ACTIVE', allSku: 'VST-9', meeshoSku: 'MEE-ONLY' };
  const Bm = { id: 'B', productName: '6kg', status: 'ACTIVE', meeshoSku: 'SAME' };
  const Cm = { id: 'C', productName: 'Fridge', status: 'ACTIVE', flipkartSku: 'SAME' };
  for(const mk of ['AMAZON', 'MEESHO', 'FLIPKART']) assert.ok(w.mappingMatchesSku(Am, mk, 'vst-9'));
  assert.ok(!w.mappingMatchesSku(Am, 'FLIPKART', 'MEE-ONLY'));
  assert.ok(w.mappingMatchesSku(Bm, 'MEESHO', 'SAME') && w.mappingMatchesSku(Cm, 'FLIPKART', 'SAME'), 'same code, different products per platform');
  assert.equal(w.skuClashes([Am, Bm, Cm], 'flipkartSku', 'VST-9', 'B').length, 1);
  assert.equal(w.skuClashes([Am, Bm, Cm], 'allSku', 'SAME', 'X').length, 2);
  assert.equal(w.skuClashes([Am, Bm, Cm], 'amazonSku', 'SAME', 'X').length, 0);
});
