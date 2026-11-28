const test = require('node:test'), assert = require('node:assert');
const fs = require('fs'), path = require('path');
const { JSDOM } = require('jsdom');
function load(){
  const dom = new JSDOM('<p id="purchaseMsg"></p>', { runScripts: 'outside-only', url: 'https://visutra.in/billing/app.html' });
  dom.window.eval(fs.readFileSync(path.join(__dirname, '..', 'statement-share.js'), 'utf8'));
  return dom.window;
}
test('rows merge by date with running balance', () => {
  const w = load();
  const r = w.vtStatement.buildRows(
    [{ date: '2026-11-02', grandTotal: 1000, invoiceNo: 'A1', items: [{ name: 'Cover', qty: 5 }] }, { date: '2026-11-10', grandTotal: 500, items: [] }],
    [{ date: '2026-11-05', amount: 400, mode: 'UPI' }]);
  assert.deepStrictEqual(Array.from(r.rows.map(x => x.balance)), [1000, 600, 1100]);
  assert.strictEqual(r.totalPurchase, 1500); assert.strictEqual(r.totalPaid, 400); assert.strictEqual(r.balance, 1100);
});
test('phone numbers normalised for WhatsApp', () => {
  const w = load();
  assert.strictEqual(w.vtStatement.phoneDigits('98765 43210'), '919876543210');
  assert.strictEqual(w.vtStatement.phoneDigits('+91-98765-43210'), '919876543210');
  assert.strictEqual(w.vtStatement.phoneDigits('09876543210'), '919876543210');
  assert.strictEqual(w.vtStatement.phoneDigits('123'), '');
});
test('offer shows card with balance, escapes name, warns without phone', () => {
  const w = load();
  w.vtStatement.offer({ ownerName: 'Me', party: { name: '<b>X</b>', phone: '' }, purchases: [{ date: '2026-11-02', grandTotal: 1000, items: [] }], payments: [] });
  const box = w.document.getElementById('vtStmtBox');
  assert.ok(box); assert.ok(!box.querySelector('span b b')); assert.match(box.textContent, /1,000\.00/); assert.match(box.textContent, /No phone saved/);
  assert.ok(w.document.getElementById('vtStmtWa'));
});
