const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { seed, read, list, reset, pool, makeClient } = require('./lib/fakesb');
const { loadPage, loadCore, mkPdf, sleep, closeAll, A, B, C } = require('./lib/sbload');
after(async () => { closeAll(); await pool.end(); });

const fs = require('fs'); const { JSDOM } = require('jsdom'); const { R } = require('./lib/sbload'); const XLSX = require('xlsx');
test('Excel button exports what the table shows (numbers, dropdowns, no buttons, no hidden rows)', async () => {
  const html = `<div class="card"><h2>SKU Mappings <span class="badge">2</span></h2><table><thead><tr><th>Product</th><th>Stock</th><th>Value</th><th>Status</th><th></th></tr></thead><tbody>
    <tr><td><b>WM Cover</b></td><td>1,234</td><td>₹43,050.50</td><td><select><option value="">—</option><option value="a" selected>Active</option></select></td><td><button>Edit</button></td></tr>
    <tr><td>TV Cover</td><td>−3</td><td>₹0</td><td>Inactive</td><td><button>Edit</button></td></tr>
    <tr class="hidden"><td>Hidden</td><td>9</td><td>₹9</td><td>x</td><td></td></tr></tbody></table></div>
    <div class="card"><h2>Line items</h2><table class="line-items"><tbody><tr><td><input value="1"></td></tr></tbody></table></div>`;
  const w = new JSDOM(html, { runScripts: 'outside-only' }).window; let saved = null;
  w.XLSX = Object.assign({}, XLSX, { writeFile: (wb, name) => { saved = { name, aoa: XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1 }) }; } });
  w.eval(fs.readFileSync(R + 'billing/assets/vt-excel.js', 'utf8'));
  await sleep(30);
  const btns = w.document.querySelectorAll('.vt-xl-btn');
  assert.equal(btns.length, 1, 'line-item entry grid gets no button');
  btns[0].click(); await sleep(50);
  assert.match(saved.name, /^VISUTRA - SKU Mappings - \d{4}-\d{2}-\d{2}\.xlsx$/);
  assert.deepEqual(saved.aoa, [['Product', 'Stock', 'Value', 'Status'], ['WM Cover', 1234, 43050.5, 'Active'], ['TV Cover', -3, 0, 'Inactive']]);
  w.close();
});
test('Stock Analysis numbers', () => {
  const w = new JSDOM('<div id="box"></div>', { runScripts: 'outside-only' }).window;
  w.eval(fs.readFileSync(R + 'billing/assets/stock-charts.js', 'utf8'));
  const day = n => { const d = new Date(); d.setHours(12); d.setDate(d.getDate() - n); return d.toISOString().slice(0, 10); };
  const items = [{ id: 'a', name: '9kg', stock: 20, reorderLevel: 10, price: 349 }, { id: 'c', name: 'TV', stock: 0, reorderLevel: 5, price: 199 }];
  const mv = []; for(let i = 0; i < 30; i++) mv.push({ id: 'a', type: 'sale-out', qty: -4, date: day(i) });
  mv.push({ id: 'a', type: 'undo-print', qty: 6, date: day(1) }, { id: 'a', type: 'sale-out', qty: -999, date: day(80) });
  const r = w.VTStockCharts.analyse(items, mv, 30);
  assert.equal(r.kpi.sold, 114, 'undone print subtracted, 80-day-old sale excluded');
  assert.equal(r.kpi.value, 6980);
  assert.equal(r.rows.find(x => x.id === 'a').status, 'low');
  assert.equal(r.rows.find(x => x.id === 'c').status, 'out');
  w.close();
});
