const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { seed, read, reset, pool } = require('./lib/fakesb');
const { loadPage, mkPdf, sleep, closeAll, A } = require('./lib/sbload');
after(async () => { closeAll(); await pool.end(); });
const U = 'users/' + A.uid;
let PAGES = [];
async function setup(){
  await reset();
  await seed(U, { businessName: 'VISUTRA', stateCode: '09' });
  await seed(U + '/products/p1', { name: 'WM Cover', stock: 20 });
  await seed(U + '/skuMappings/m1', { rawKey: 'VST-WA-FA30', productId: 'p1', productName: 'WM Cover' });
  await seed(U + '/buyerPackagingSizes/fkBag', { name: 'Flipkart 10x12', stock: 40, active: true });
  await seed(U + '/buyerPackagingSizes/meBag', { name: 'Meesho 8x10', stock: 30, active: true });
  await seed(U + '/buyerLabelSizes/paper_4x6', { name: '4 × 6 in', paperKey: '4x6', stock: 67, active: true });
  await seed(U + '/buyerLabelSizes/paper_3x5', { name: '3 × 5 in', paperKey: '3x5', stock: 50, active: true });
  await seed(U + '/buyerProductPackaging/' + A.uid + '_p1', { sellerUid: A.uid, productId: 'p1', productName: 'WM Cover', packagingSizeId: 'fkBag', labelSizeId: 'paper_4x6' });
  const pg = loadPage('tools/label-cropper.html', A, { query: '?role=seller', before: w => {
    w.pdfjsLib = { GlobalWorkerOptions: {}, getDocument: ({ data }) => ({ promise: (data && data.length < 50) ? Promise.reject(new Error('Invalid PDF structure'))
      : Promise.resolve({ numPages: PAGES.length, getPage: async i => ({ getTextContent: async () => ({ items: [{ str: PAGES[i - 1] }] }), getViewport: () => ({ width: 100, height: 141 }), render: () => ({ promise: Promise.resolve(), cancel(){} }) }) }) }) };
  } });
  await sleep(600);
  return pg;
}
const meeshoPage = (sku, order) => `Valmo Meesho SKU Size Qty Color Order No. ${sku} Free Size 1 Grey ${order}`;
const pdfFile = async (n, name, type) => ({ type: type === undefined ? 'application/pdf' : type, name, arrayBuffer: async () => (await mkPdf(n)).buffer });

test('Packing / label size per platform: a Meesho change does not touch Flipkart', async () => {
  const { w, $ } = await setup();
  w.document.querySelector('.vlc-plat[data-p="meesho"]').click(); await sleep(20); $('vlcOutSize').value = 'native';
  PAGES = [meeshoPage('VST-WA-FA30', '111111111_1')];
  await w.eval('handleFile')(await pdfFile(1, 'meesho.pdf')); await sleep(400);
  assert.match($('vlcSellerStockTable').textContent, /default · change = MEESHO only/);
  await w.eval(`saveSellerSizeAssign('p1','packagingSizeId','meBag','MEESHO')`); await sleep(300);
  const doc = await read(U + '/buyerProductPackaging/' + A.uid + '_p1');
  assert.equal(doc.byPlatform.MEESHO.packagingSizeId, 'meBag');
  assert.equal(doc.packagingSizeId, 'fkBag', 'default (other platforms) unchanged');
  assert.equal(w.packagingForItem({ marketplace: 'MEESHO', sku: 'VST-WA-FA30' }, 'seller').packagingSizeId, 'meBag');
  assert.equal(w.packagingForItem({ marketplace: 'FLIPKART', sku: 'VST-WA-FA30' }, 'seller').packagingSizeId, 'fkBag');
  assert.match($('vlcSellerStockTable').textContent, /for MEESHO only/);
  await w.eval('processPdf')(); await sleep(400);
  assert.equal((await read(U + '/buyerPackagingSizes/meBag')).stock, 29, 'Meesho label used the Meesho bag');
  assert.equal((await read(U + '/buyerPackagingSizes/fkBag')).stock, 40, 'Flipkart bag untouched');
});

test('Printing on 3×5 paper deducts 3×5 label stock and shows it in the label column', async () => {
  const { w, $ } = await setup();
  w.document.querySelector('.vlc-plat[data-p="meesho"]').click(); await sleep(20);
  $('vlcOutSize').value = '3x5'; $('vlcOutSize').dispatchEvent(new w.Event('change'));
  PAGES = [meeshoPage('VST-WA-FA30', '222222222_1')];
  await w.eval('handleFile')(await pdfFile(1, 'meesho.pdf')); await sleep(400);
  assert.match($('vlcSellerStockTable').textContent, /🖨 3 × 5 in/);
  await w.eval('processPdf')(); await sleep(400);
  assert.equal((await read(U + '/buyerLabelSizes/paper_3x5')).stock, 49);
  assert.equal((await read(U + '/buyerLabelSizes/paper_4x6')).stock, 67, 'product\'s 4×6 not used');
});

test('Uploads: same file again works, untyped PDFs accepted, broken PDF explained', async () => {
  const { w, $ } = await setup();
  w.document.querySelector('.vlc-plat[data-p="meesho"]').click(); await sleep(20);
  PAGES = [meeshoPage('VST-WA-FA30', '333333333_1')];
  let calls = 0; const real = w.eval('handleFile'); w.eval('window.__count=0');
  const input = $('vlcFile'); const f = await pdfFile(1, 'same.pdf');
  Object.defineProperty(input, 'files', { value: [f], configurable: true });
  input.dispatchEvent(new w.Event('change')); await sleep(300);
  assert.equal(input.value, '', 'selection cleared so the same file can be chosen again');
  assert.equal($('vlcFilename').textContent, 'same.pdf');
  // a PDF without a file-type tag (WhatsApp / some apps)
  await w.eval('handleFile')(await pdfFile(1, 'from-whatsapp.pdf', '')); await sleep(300);
  assert.equal($('vlcFilename').textContent, 'from-whatsapp.pdf', 'accepted');
  // a broken file: clear message, download stays off
  await w.eval('handleFile')({ type: 'application/pdf', name: 'broken.pdf', arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer }); await sleep(300);
  assert.match($('vlcStatus').textContent, /Could not read "broken.pdf": Invalid PDF structure/);
  assert.equal($('vlcProcessBtn').disabled, true);
});
