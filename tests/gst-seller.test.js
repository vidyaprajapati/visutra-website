const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), path = require('path');
const XLSX = require('xlsx');
const { seed, read, list, reset, pool } = require('./lib/fakesb');
const { loadPage, sleep, closeAll, A } = require('./lib/sbload');
const { validate } = require('./lib/gstr1-schema');
after(async () => { closeAll(); await pool.end(); });
const FX = path.join(__dirname, 'fixtures', 'q2-2026');
const REF = JSON.parse(fs.readFileSync(path.join(FX, 'reference-gsttool-gstr1.json'), 'utf8'));
const U = 'users/' + A.uid;
const file = (name, buf) => { const b = buf || fs.readFileSync(path.join(FX, name)); return { name, arrayBuffer: async () => b.buffer.slice(b.byteOffset, b.byteOffset + b.length) }; };
const plain = x => JSON.parse(JSON.stringify(x));
function open() {
  const saved = [];
  const pg = loadPage('tools/gst-seller.html', A, { query: '#profile', before: w => { w.JSZip = require('jszip'); w.TextDecoder = require('util').TextDecoder; w.confirm = () => true; w.print = () => {}; } });
  pg.saved = saved;
  return pg;
}
async function upload(w, $, card, month, files) {
  w.openPlatform(card); w.GS.modal.month = month; w.renderPlatformModal();
  Object.entries(files).forEach(([slot, name]) => Object.defineProperty($('mFile_' + slot), 'files', { value: [file(name)], configurable: true }));
  await w.uploadPlatform(); await sleep(50);
}
const num = t => parseFloat(String(t).replace(/[₹,\s]/g, ''));

test('GST Online Seller: profile → import (real Q2) → manage → TCS → GSTR-1, saved in the account', async () => {
  await reset();
  await seed(U, { businessName: 'Visu trader', gstin: '09BVHPP4321G1ZJ', stateCode: '09', profileComplete: true, roles: { seller: true } });
  let pg = open(); await sleep(1200); let { w, $ } = pg;
  w.VTGst.downloadJson = o => pg.saved.push(plain(o));
  // ---- GST profile
  $('pGstin').value = '09BVHPP4321G1ZB'; $('pSelectBtn').click(); await sleep(100);
  assert.match($('pErr').textContent, /valid 15-character GSTIN/, 'wrong check digit refused');
  w.document.querySelector('#pType button[data-v="quarterly"]').click();
  $('pPeriod').value = 'Q2'; $('pPeriod').dispatchEvent(new w.Event('change'));
  $('pYear').value = '2026'; $('pYear').dispatchEvent(new w.Event('change'));
  $('pGstin').value = '09BVHPP4321G1ZJ'; await w.selectGstin($('pGstin').value); await sleep(200);
  assert.match($('pSelected').textContent, /09BVHPP4321G1ZJ\s*Uttar Pradesh · Period 09-2026 · Quarterly/);
  assert.ok(await read(U + '/gstProfiles/09BVHPP4321G1ZJ'), 'GSTIN saved');
  assert.match($('pSaved').textContent, /09BVHPP4321G1ZJ/); assert.match($('pSlots').textContent, /1\/11 slots/);
  assert.deepEqual(plain(w.gsMonths()), ['2026-07', '2026-08', '2026-09']);
  // ---- Import data
  w.gsGo('import');
  assert.match($('iBody').textContent, /Meesho.*Amazon.*Amazon B2B.*Flipkart.*Myntra.*Coming soon.*Snapdeal/);
  for (const [m, n, nm, M] of [['2026-07', 7, 'july', 'July'], ['2026-08', 8, 'aug', 'August'], ['2026-09', 9, 'sep', 'September']]) {
    await upload(w, $, 'MEESHO', m, { sales: `gst_2592706_${n}_2026.zip`, returns: `gst_2592706_${n}_2026.zip`, invoices: `Tax_invoice_details ${nm}.xlsx` });
    assert.doesNotMatch($('mMsg').textContent, /Still to upload|⚠/, $('mMsg').textContent);
    await upload(w, $, 'AMAZON', m, { mtr: `b2cReport_${M}_2026.zip` });
    await upload(w, $, 'AMAZON_B2B', m, { mtr: `b2bReport_${M}_2026.zip` });
    await upload(w, $, 'FLIPKART', m, { sales: `${nm} 26.xlsx` });
  }
  w.gsCloseModal();
  assert.match($('iStats').textContent, /Imported\s*12\s*Period\s*Sep 2026/);
  assert.equal(w.document.querySelectorAll('.pf.done').length, 4, 'four cards IMPORTED');
  assert.equal((await list(U + '/gstImports/')).length, 3 * 3 + 3 + 3 + 3, 'each file saved (compact)');
  // ---- Manage data: monthly figures like the gsttool screenshots
  w.gsGo('manage');
  const rowsOf = name => [...w.document.querySelectorAll('#mBody .tblc')].find(t => t.querySelector('h4').textContent === name).querySelectorAll('tbody tr');
  const cells = tr => [...tr.children].map(td => td.textContent.trim());
  const me = rowsOf('Meesho'), az = rowsOf('Amazon'), fk = rowsOf('Flipkart');
  [[me[0], 2, 499286.18], [me[1], 2, 346477.35], [me[2], 2, 210871.42], [az[0], 4, 27138], [az[1], 4, 13802], [az[2], 4, 18761], [fk[0], 2, 6121.26], [fk[1], 2, 4526.93], [fk[2], 2, 8062.28]]
    .forEach(([tr, i, v]) => assert.ok(Math.abs(num(cells(tr)[i]) - v) <= 0.10,   /* gsttool rounds a few paise differently */ `${cells(tr)[0]}: ${cells(tr)[i]} vs ${v}`));
  assert.match($('mBody').textContent, /Platforms\s*3/);
  w.showRecords('AMAZON', '2026-07', 'nil'); assert.match($('gsMbox').textContent, /Place of supply.*Maharashtra/); w.gsCloseModal();
  // ---- TCS reconcile: typed value + portal file
  w.gsGo('tcs');
  w.prompt = () => '6121.26'; await w.editPortal('FLIPKART', '2026-07'); await sleep(100);
  w.prompt = () => '6000'; await w.editPortal('FLIPKART', '2026-08'); await sleep(100);
  const ws = XLSX.utils.aoa_to_sheet([['TCS credit received'], [], ['GSTIN of E-Commerce Operator', 'Trade Name', 'Tax Period', 'Gross Value', 'Net Amount Liable for TCS', 'IGST'],
    ['09AARCM9332R1CM', 'Meesho', '072026', 0, 499286.18, 0], ['09AARCM9332R1CM', 'Meesho', '082026', 0, 346477.35, 0]]);
  const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, 'TCS'); const buf = Buffer.from(XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }));
  Object.defineProperty($('tFile'), 'files', { value: [file('tcs.xlsx', buf)], configurable: true });
  await w.uploadPortalTcs(); await sleep(100);
  const t = $('tBody').textContent.replace(/\s+/g, ' ');
  assert.match(t, /Read 2 row\(s\)/); assert.match(t, /Mismatched\s*1/, 'Flipkart August differs');
  assert.ok(t.includes('✓ matched'));
  // ---- GSTR-1 report
  w.gsGo('report');
  assert.match($('rBody').textContent, /7 - B2CS \(Others\).*8 - Nil Rated.*12 - HSN Summary.*13 - Documents Issued.*14 - Supplies via E-Commerce Operators/);
  assert.match($('rBody').textContent, /Return of September - 2026/);
  w.downloadJson(); const J = pg.saved.pop();
  assert.ok(validate(J), JSON.stringify(validate.errors));
  assert.equal(J.fp, '092026'); assert.equal(J.b2cs.length, REF.b2cs.length);
  assert.deepEqual(J.nil.inv, REF.nil.inv);
  const docs = d => d.doc_det.map(x => [x.doc_num, x.docs.map(y => [y.from, y.to, y.totnum])]);
  assert.deepEqual(docs(J.doc_issue), docs(REF.doc_issue));
  REF.supeco.clttx.forEach(e => { const o = J.supeco.clttx.find(x => x.etin === e.etin); assert.ok(o && Math.abs(o.suppval - e.suppval) <= 0.25, e.etin); });
  // edit a B2CS row, then reset
  w.openEditor('b2cs'); w.EDIT_ROWS[0].txval = 1000; w.EDIT_ROWS[0].tax = 50;
  w.document.querySelector('#gsMbox input[data-r="0"][data-k="txval"]').value = '1000';
  w.document.querySelector('#gsMbox input[data-r="0"][data-k="tax"]').value = '50';
  await w.saveEditor(); await sleep(150);
  assert.match($('rBody').textContent, /B2CS \(Others\)edited/);
  w.downloadJson(); const J2 = pg.saved.pop();
  assert.deepEqual([J2.b2cs[0].txval, J2.b2cs[0].iamt], [1000, 50]);
  assert.ok((await read(U + '/gstReturns/09BVHPP4321G1ZJ_092026')).edits.b2cs, 'edit saved in the account');
  w.EDIT_KEY = 'b2cs'; await w.resetEditor(); await sleep(150);
  w.downloadJson(); assert.equal(pg.saved.pop().b2cs[0].txval, J.b2cs[0].txval, 'reset → imported value again');
  // B2C HSN switch
  await w.toggleB2cHsn(); await sleep(100); w.downloadJson(); assert.equal(pg.saved.pop().hsn.hsn_b2c, undefined);
  await w.toggleB2cHsn(); await sleep(100);
  // ---- reopen: saved GSTIN + imports come back from the account
  closeAll(); pg = open(); await sleep(1200); ({ w, $ } = pg);
  assert.match($('pSaved').textContent, /09BVHPP4321G1ZJ/);
  w.D.type = 'quarterly'; w.D.pkey = 'Q2'; w.D.fy = 2026; await w.pickSaved('09BVHPP4321G1ZJ'); await sleep(300);
  w.D.type = 'quarterly'; w.D.pkey = 'Q2'; w.D.fy = 2026; await w.selectGstin('09BVHPP4321G1ZJ'); await sleep(300);
  w.gsGo('manage');
  assert.match($('mBody').textContent.replace(/\s+/g, ' '), /July\s*—\s*4,99,286\.27/);
});
