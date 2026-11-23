const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { seed, reset, pool } = require('./lib/fakesb');
const { loadPage, mkPdf, sleep, closeAll, A } = require('./lib/sbload');
after(async () => { closeAll(); await pool.end(); });
const M = (courier, sku, qty, order) => `${courier} Meesho SKU Size Qty Color Order No. ${sku} Free Size ${qty} Grey ${order}`;
test('Excel download has a 2nd sheet: delivery partner → SKU → qty (with totals)', async () => {
  await reset();
  await seed('users/' + A.uid, { businessName: 'Buyer', stateCode: '09' });
  const PAGES = [M('Valmo', 'SKU-A', 1, '1_1'), M('Shadowfax', 'SKU-A', 2, '2_1'), M('Valmo', 'SKU-A', 1, '3_1'), M('Valmo', 'SKU-B', 1, '4_1'), M('Delhivery', 'SKU-B', 1, '5_1')];
  const { w, $ } = loadPage('tools/label-cropper.html', A, { query: '?role=buyer', before: w => {
    w.pdfjsLib = { GlobalWorkerOptions: {}, getDocument: () => ({ promise: Promise.resolve({ numPages: PAGES.length, getPage: async i => ({ getTextContent: async () => ({ items: [{ str: PAGES[i - 1] }] }), getViewport: () => ({ width: 100, height: 100 }), render: () => ({ promise: Promise.resolve() }) }) }) }) };
  } });
  await sleep(500);
  w.document.querySelector('.vlc-plat[data-p="meesho"]').click(); await sleep(20);
  await w.eval('handleFile')({ type: 'application/pdf', name: 'm.pdf', arrayBuffer: async () => (await mkPdf(5)).buffer }); await sleep(400);
  const table = w.document.getElementById('vlcSkuSummaryTable').closest('table');
  assert.equal(table.dataset.excelName, 'Detected SKUs');
  const sheets = table.__vtExtraSheets();
  assert.equal(sheets[0].name, 'By delivery partner');
  assert.deepEqual(JSON.parse(JSON.stringify(sheets[0].aoa)), [
    ['Delivery Partner', 'Marketplace', 'SKU', 'Total Qty', 'Pages'],
    ['Delhivery', 'MEESHO', 'SKU-B', 1, '5'], ['Total — Delhivery', '', '', 1, ''],
    ['Shadowfax', 'MEESHO', 'SKU-A', 2, '2'], ['Total — Shadowfax', '', '', 2, ''],
    ['Valmo', 'MEESHO', 'SKU-A', 2, '1, 3'], ['Valmo', 'MEESHO', 'SKU-B', 1, '4'], ['Total — Valmo', '', '', 3, ''],
    ['GRAND TOTAL', '', '', 6, '']]);
});
