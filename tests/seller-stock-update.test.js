const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'); const { JSDOM } = require('jsdom'); const XLSX = require('xlsx');
const { seed, read, list, reset, pool } = require('./lib/fakesb');
const { loadPage, sleep, closeAll, A, R } = require('./lib/sbload');
after(async () => { closeAll(); await pool.end(); });
const U = 'users/' + A.uid;
async function world(){
  await reset();
  await seed(U, { businessName: 'VISUTRA', gstin: '09BVHPP4321G1ZJ', stateCode: '09', profileComplete: true, roles: { seller: true } });
  await seed(U + '/products/fg', { name: 'WM Cover 7kg', unit: 'PCS', stock: 5, price: 300, gstRate: 5 });
  await seed(U + '/products/fab', { name: 'Fabric roll (m)', unit: 'MTR', stock: 100, price: 0, gstRate: 5 });
}
async function openStock(){ const pg = loadPage('billing/app.html', A, { before: w => { w.confirm = () => true; } }); await sleep(1800); pg.w.eval("activateView('stock')"); await sleep(300); return pg; }
function fill(w, $, sel, rowIdx, productId, qty){
  const tr = $(sel).querySelectorAll('tr')[rowIdx];
  tr.querySelector('.su-prod').value = productId; tr.querySelector('.su-qty').value = String(qty);
  w.eval('updateStockUpdatePreview()');
}

test('Production: finished goods up, materials down, dated; Undo reverses the whole update', async () => {
  await world();
  const { w, $ } = await openStock();
  assert.ok($('stockUpdateCard'), 'Update Stock card on the Stock page');
  w.eval("setStockUpdateMode('production')"); $('suDate').value = '2026-09-15'; $('suNote').value = 'Batch 14';
  fill(w, $, 'suRows', 0, 'fg', 20);
  $('suUseMaterials').checked = true; w.eval('renderStockUpdateMaterials()'); fill(w, $, 'suMatRows', 0, 'fab', 10);
  assert.match($('suPreview').textContent, /WM Cover 7kg \+20 → 25.*Fabric roll \(m\) -10 → 90/);
  await w.eval('applyStockUpdate()'); await sleep(500);
  assert.equal((await read(U + '/products/fg')).stock, 25); assert.equal((await read(U + '/products/fab')).stock, 90);
  const mv = (await list(U + '/stockMovements/')).map(r => r.data);
  assert.deepEqual(mv.map(m => [m.type, m.qty, m.date]).sort(), [['production', 20, '2026-09-15'], ['production-use', -10, '2026-09-15']]);
  assert.equal(new Set(mv.map(m => m.batchId)).size, 1, 'one update id');
  // monthly report: September stock in includes the production
  $('stockReportMonth').value = '2026-09'; await w.eval('renderMonthlyStockReport()'); await sleep(300);
  assert.match($('monthlyStockReportTable').textContent.replace(/\s+/g, ' '), /WM Cover 7kg\s*5\s*\+?20\s*0\s*25/);
  // undo
  await sleep(300);
  assert.match($('suRecent').textContent, /Produced/);
  await w.eval(`undoStockUpdate('${mv[0].batchId}')`); await sleep(500);
  assert.equal((await read(U + '/products/fg')).stock, 5); assert.equal((await read(U + '/products/fab')).stock, 100);
  assert.ok((await list(U + '/stockMovements/')).filter(r => r.data.type !== 'undo').every(r => r.data.undone === true));
});

test('Stock out and physical count', async () => {
  await world();
  const { w, $ } = await openStock();
  w.eval("setStockUpdateMode('out')"); $('suReason').value = 'Damaged / defective'; fill(w, $, 'suRows', 0, 'fab', 3);
  await w.eval('applyStockUpdate()'); await sleep(400);
  assert.equal((await read(U + '/products/fab')).stock, 97);
  w.eval("setStockUpdateMode('count')"); fill(w, $, 'suRows', 0, 'fg', 12);   // record says 5, counted 12
  assert.match($('suPreview').textContent, /WM Cover 7kg \+7 → 12/);
  await w.eval('applyStockUpdate()'); await sleep(400);
  assert.equal((await read(U + '/products/fg')).stock, 12);
  const cnt = (await list(U + '/stockMovements/')).map(r => r.data).find(m => m.type === 'count');
  assert.match(cnt.note, /counted 12 \(was 5\)/);
  w.eval("setStockUpdateMode('count')"); fill(w, $, 'suRows', 0, 'fg', 12);
  await w.eval('applyStockUpdate()'); await sleep(300);
  assert.match($('suMsg').textContent, /already match/);
});

test('＋ View all: long tables show 10 rows; editable tables and Total rows never hidden; Excel has every row', async () => {
  const rows = n => Array.from({ length: n }, (_, i) => `<tr><td>P${i + 1}</td><td>${i + 1}</td></tr>`).join('');
  const html = `<div class="card"><table id="t1"><thead><tr><th>Product</th><th>Qty</th></tr></thead><tbody>${rows(15)}<tr><td>Total</td><td>120</td></tr></tbody></table></div>
    <div class="card"><table id="t2"><thead><tr><th>SKU</th><th>Map</th></tr></thead><tbody>${Array.from({ length: 15 }, (_, i) => `<tr><td>S${i}</td><td><select><option>x</option></select></td></tr>`).join('')}</tbody></table></div>
    <div class="card"><table id="t3"><thead><tr><th>A</th></tr></thead><tbody>${rows(11)}</tbody></table></div>`;
  const w = new JSDOM(html, { runScripts: 'outside-only', pretendToBeVisual: true }).window; let saved = null;
  w.XLSX = Object.assign({}, XLSX, { writeFile: wb => { saved = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1 }); } });
  w.eval(fs.readFileSync(R + 'billing/assets/vt-excel.js', 'utf8')); await sleep(120);
  const t1 = w.document.getElementById('t1'), hidden = () => t1.querySelectorAll('tr.vt-more-row').length;
  assert.equal(hidden(), 5, '15 rows → 10 shown');
  assert.ok(![...t1.querySelectorAll('tr.vt-more-row')].some(r => /Total/.test(r.textContent)), 'Total row stays visible');
  const btn = w.document.querySelector('.vt-more-btn');
  assert.match(btn.textContent, /＋ View all 15 rows/);
  btn.click(); await sleep(60);
  assert.equal(hidden(), 0); assert.match(w.document.querySelector('.vt-more-btn').textContent, /− Show first 10/);
  btn.click(); await sleep(60); assert.equal(hidden(), 5);
  // rows re-drawn by the page: an opened table stays open
  btn.click(); await sleep(60);
  t1.tBodies[0].innerHTML = rows(18); await sleep(120);
  assert.equal(hidden(), 0, 'still open after refresh'); assert.match(w.document.querySelector('.vt-more-btn').textContent, /Show first 10/);
  btn.click(); await sleep(60);
  w.document.querySelector('.vt-xl-btn').click(); await sleep(120);
  assert.equal(saved.length, 19, 'Excel: header + all 18 rows, even while collapsed');
  assert.equal(w.document.getElementById('t2').querySelectorAll('tr.vt-more-row').length, 0, 'editable table never collapsed');
  assert.equal(w.document.getElementById('t3').querySelectorAll('tr.vt-more-row').length, 0, '11–12 rows: not worth collapsing');
  w.close();
});
