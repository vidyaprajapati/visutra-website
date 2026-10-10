const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { seed, read, list, reset, pool } = require('./lib/fakesb');
const { loadPage, sleep, closeAll, A, B, read: readSrc } = require('./lib/sbload');
after(async () => { closeAll(); await pool.end(); });
const SB = 'users/' + B.uid;
async function world(){
  await reset();
  await seed('users/' + A.uid, { businessName: 'VISUTRA', profileComplete: true, roles: { seller: true } });
  await seed(SB, { businessName: 'Visu trader', gstin: '09AAACR5055K1Z5', stateCode: '09', state: 'Uttar Pradesh', profileComplete: true, roles: { buyer: true } });
  await seed(`sellerLinks/${A.uid}_${B.uid}`, { sellerUid: A.uid, buyerUid: B.uid, status: 'ACTIVE' });
  await seed(SB + '/buyerSkuMappings/bm1', { status: 'ACTIVE', productName: 'WM Cover', sellerId: A.uid, sellerName: 'VISUTRA', productId: 'p1', sellerProductName: 'Washing Machine Cover', sellerSku: 'VST-WM', meeshoSku: 'VST-A', stock: -3 });
  const draft = (id, date, hash, qty) => seed(SB + '/labelOrderDrafts/' + id, { date, sellerId: A.uid, sellerName: 'VISUTRA', pageHashes: [hash],
    itemsByProduct: { p1: { productName: 'Washing Machine Cover', sellerSku: 'VST-WM', mappingId: 'bm1', qty, breakdown: { amazon: 0, meesho: qty, flipkart: 0 } } } });
  await draft('2026-01-15_' + A.uid, '2026-01-15', 'h-jan15', 3);
  await draft('2026-01-16_' + A.uid, '2026-01-16', 'h-jan16', 2);
}

test('Unsent label orders from earlier days stay on screen until sent or discarded; reminder on every page', async () => {
  await world();
  const pg = loadPage('billing/buyer/label-order.html', B, { hook: 'window.__maps=()=>mappingsCache;', before: w => { w.confirm = () => true; w.emailjs = { init(){}, send: async () => ({}) }; w.pdfjsLib = { GlobalWorkerOptions: {}, getDocument: () => ({ promise: Promise.resolve({ numPages: 0 }) }) }; } }); await sleep(1500);
  const txt = pg.$('summaryBySeller').textContent.replace(/\s+/g, ' ');
  assert.match(txt, /VISUTRA · labels of 15 Jan 2026/); assert.match(txt, /VISUTRA · labels of 16 Jan 2026/);
  assert.match(txt, /not sent yet — from an earlier day/);
  // the 🔔 reminder (user-menu.js) on any buyer page
  const other = loadPage('billing/buyer/stock.html', B); await sleep(1200);
  other.w.eval(readSrc('billing/assets/user-menu.js')); await other.w.vtLoadApprovalBar(B, '../');
  assert.match(other.$('vtApprovalBar').textContent, /2 label order\(s\) not sent yet \(from 2026-01-15, 2026-01-16\)/);
  // re-uploading a page that's already in an old unsent draft adds nothing (no double stock)
  const again = await pg.w.mergeItemIntoDraft(pg.w.__maps()[0], { pageHash: 'h-jan15', marketplace: 'MEESHO', sku: 'VST-A', qty: 3 });
  assert.equal(again, false);
  // send the 15 Jan draft
  await pg.w.eval(`placeAutoOrder('2026-01-15_${A.uid}')`); await sleep(700);
  const ord = (await list('marketplaceOrders/'))[0].data;
  assert.deepEqual([ord.status, ord.orderType, ord.labelsDate, ord.items[0].qty], ['PENDING', 'LABEL_AUTO', '2026-01-15', 3]);
  assert.match(ord.note, /Labels dispatched on 15 Jan 2026/);
  assert.equal(await read(SB + '/labelOrderDrafts/2026-01-15_' + A.uid), undefined, 'draft cleared once sent');
  assert.ok(await read(SB + '/processedLabels/h-jan15'));
  // discard the 16 Jan draft
  await pg.w.eval(`discardDraft('2026-01-16_${A.uid}')`); await sleep(400);
  assert.equal(await read(SB + '/labelOrderDrafts/2026-01-16_' + A.uid), undefined);
  assert.equal((await read(SB + '/processedLabels/h-jan16')).discarded, true, 'its pages won\'t come back on re-upload');
  assert.equal((await list('marketplaceOrders/')).length, 1, 'no order for the discarded draft');
  assert.equal(pg.w.localDayKey(new Date(2026, 9, 8, 1, 0)), '2026-10-08', 'day changes at local midnight (1 AM IST is still 8 Oct)');
});
