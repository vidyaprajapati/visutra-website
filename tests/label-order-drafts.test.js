const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { seed, read, list, reset, pool } = require('./lib/fakesb');
const { loadPage, sleep, closeAll, A, B, read: readSrc } = require('./lib/sbload');
after(async () => { closeAll(); await pool.end(); });
const SB = 'users/' + B.uid;
const MAP = { id: 'bm1', sellerId: A.uid, sellerName: 'VISUTRA', productId: 'p1', sellerProductName: 'Washing Machine Cover', productName: 'WM Cover', sellerSku: 'VST-WM' };
async function world(){
  await reset();
  await seed('users/' + A.uid, { businessName: 'VISUTRA', profileComplete: true, roles: { seller: true } });
  await seed(SB, { businessName: 'Visu trader', gstin: '09AAACR5055K1Z5', stateCode: '09', state: 'Uttar Pradesh', profileComplete: true, roles: { buyer: true } });
  await seed(`sellerLinks/${A.uid}_${B.uid}`, { sellerUid: A.uid, buyerUid: B.uid, status: 'ACTIVE' });
  await seed(SB + '/buyerSkuMappings/bm1', { status: 'ACTIVE', productName: 'WM Cover', sellerId: A.uid, sellerName: 'VISUTRA', productId: 'p1', sellerProductName: 'Washing Machine Cover', sellerSku: 'VST-WM', meeshoSku: 'VST-A', stock: -3 });
  // two old per-day pieces (the way it used to be stored)
  const piece = (id, date, hash, qty) => seed(SB + '/labelOrderDrafts/' + id, { date, sellerId: A.uid, sellerName: 'VISUTRA', pageHashes: [hash],
    itemsByProduct: { p1: { productName: 'Washing Machine Cover', sellerSku: 'VST-WM', mappingId: 'bm1', qty, breakdown: { amazon: 0, meesho: qty, flipkart: 0 } } } });
  await piece('2026-01-15_' + A.uid, '2026-01-15', 'h-jan15', 3);
  await piece('2026-01-16_' + A.uid, '2026-01-16', 'h-jan16', 2);
}
const pageOpts = { hook: 'window.__maps=()=>mappingsCache;', before: w => { w.confirm = () => true; w.emailjs = { init(){}, send: async () => ({}) }; w.pdfjsLib = { GlobalWorkerOptions: {}, getDocument: () => ({ promise: Promise.resolve({ numPages: 0 }) }) }; } };

test('ONE consolidated pending label order per seller (any day, any marketplace, Cropper or this page)', async () => {
  await world();
  const pg = loadPage('billing/buyer/label-order.html', B, pageOpts); await sleep(1500);
  // old pieces merged into one
  const drafts = await list(SB + '/labelOrderDrafts/');
  assert.deepEqual(drafts.map(d => d.path.split('/').pop()), ['pending_' + A.uid], 'one pending order, old pieces removed');
  const d = drafts[0].data;
  assert.deepEqual([d.itemsByProduct.p1.qty, d.itemsByProduct.p1.breakdown.meesho, d.dates, d.firstDate, d.lastDate], [5, 5, ['2026-01-15', '2026-01-16'], '2026-01-15', '2026-01-16']);
  assert.deepEqual(d.pageHashes.sort(), ['h-jan15', 'h-jan16']);
  const txt = pg.$('summaryBySeller').textContent.replace(/\s+/g, ' ');
  assert.match(txt, /VISUTRA · all pending labels · printed 15 Jan 2026 – 16 Jan 2026 \(2 days\)/);
  assert.equal((txt.match(/Send Order to VISUTRA/g) || []).length, 1, 'one block, one send button');
  // 🔔 reminder on other pages
  const other = loadPage('billing/buyer/stock.html', B); await sleep(1200);
  other.w.eval(readSrc('billing/assets/user-menu.js')); await other.w.vtLoadApprovalBar(B, '../');
  assert.match(other.$('vtApprovalBar').textContent, /1 label order\(s\) not sent yet \(from 2026-01-15\)/);
  // a label printed today (Amazon) on this page → same order; same page again → ignored
  assert.equal(await pg.w.mergeItemIntoDraft(pg.w.__maps()[0], { pageHash: 'h-today-1', marketplace: 'AMAZON', sku: 'X', qty: 1 }), true);
  assert.equal(await pg.w.mergeItemIntoDraft(pg.w.__maps()[0], { pageHash: 'h-jan15', marketplace: 'MEESHO', sku: 'VST-A', qty: 3 }), false, 'already in the pending order');
  // the Label Cropper adds into the SAME order and shows it with "Review & send"
  const cr = loadPage('tools/label-cropper.html', B, { before: w => { w.pdfjsLib = { GlobalWorkerOptions: {}, getDocument: () => ({ promise: Promise.resolve({ numPages: 0 }) }) }; } }); await sleep(1500);
  await cr.w.mergeItemIntoDraft(MAP, { pageHash: 'h-cropper-1', marketplace: 'FLIPKART', sku: 'Y', qty: 2 });
  await cr.w.loadTodayDrafts(); await sleep(100);
  assert.match(cr.$('vlcOrderSummaryBySeller').textContent, /all pending labels/);
  assert.match(cr.$('vlcOrderSummaryBySeller').innerHTML, /href="\.\.\/billing\/buyer\/label-order\.html"[^>]*>Review &amp; send order to VISUTRA/);
  const one = (await list(SB + '/labelOrderDrafts/'));
  assert.equal(one.length, 1);
  const p1 = one[0].data.itemsByProduct.p1;
  assert.deepEqual([p1.qty, p1.breakdown.meesho, p1.breakdown.amazon, p1.breakdown.flipkart], [8, 5, 1, 2], 'Meesho + Amazon + Flipkart in one order');
  assert.equal(one[0].data.firstDate, '2026-01-15');
  // send it (from the Label-Based Auto Order page — stock-aware)
  await pg.w.loadDrafts(); await sleep(100);
  await pg.w.eval(`placeAutoOrder('pending_${A.uid}')`); await sleep(700);
  const orders = await list('marketplaceOrders/');
  assert.equal(orders.length, 1, 'one order');
  const o = orders[0].data;
  assert.equal(o.orderType, 'LABEL_AUTO'); assert.equal(o.labelsFrom, '2026-01-15');
  assert.match(o.note, /^Labels dispatched 15 Jan 2026 – /);
  assert.equal((await list(SB + '/labelOrderDrafts/')).length, 0, 'pending order cleared once sent');
  for (const h of ['h-jan15', 'h-jan16', 'h-today-1', 'h-cropper-1']) assert.ok(await read(SB + '/processedLabels/' + h), h + ' marked processed');
});

test('Discard the consolidated pending order', async () => {
  await world();
  const pg = loadPage('billing/buyer/label-order.html', B, pageOpts); await sleep(1500);
  await pg.w.eval(`discardDraft('pending_${A.uid}')`); await sleep(300);
  assert.equal((await list(SB + '/labelOrderDrafts/')).length, 0);
  assert.equal((await read(SB + '/processedLabels/h-jan16')).discarded, true);
  assert.equal((await list('marketplaceOrders/')).length, 0);
  assert.equal(pg.w.localDayKey(new Date(2026, 9, 8, 1, 0)), '2026-10-08', 'day changes at local midnight');
});
