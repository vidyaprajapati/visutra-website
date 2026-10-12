const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), path = require('path');
const { seed, reset, pool } = require('./lib/fakesb');
const { loadPage, sleep, closeAll, A } = require('./lib/sbload');
const { validate } = require('./lib/gstr1-schema');
after(async () => { closeAll(); await pool.end(); });
const FX = path.join(__dirname, 'fixtures', 'q2-2026');
const REF = JSON.parse(fs.readFileSync(path.join(FX, 'reference-gsttool-gstr1.json'), 'utf8'));
// a file as the browser gives it to the page (name + bytes)
const file = name => { const b = fs.readFileSync(path.join(FX, name)); return { name, arrayBuffer: async () => b.buffer.slice(b.byteOffset, b.byteOffset + b.length) }; };

async function openTool(){
  await reset();
  await seed('users/' + A.uid, { businessName: 'Visu trader', gstin: '09BVHPP4321G1ZJ', stateCode: '09', profileComplete: true, roles: { seller: true } });
  const saved = [];
  const pg = loadPage('tools/gst-return-tool.html', A, { before: w => { w.confirm = () => true; w.JSZip = require('jszip'); w.TextDecoder = require('util').TextDecoder; } });
  await sleep(700);
  pg.w.VTGst.downloadJson = o => saved.push(JSON.parse(JSON.stringify(o)));
  const $ = pg.$;
  $('gstin').value = '09BVHPP4321G1ZJ';
  $('gstFY').value = '2026'; pg.w.onGstFYChange && pg.w.onGstFYChange();
  $('gstFilingType').value = 'quarterly'; pg.w.onGstFilingTypeChange();
  $('gstQuarter').value = [...$('gstQuarter').options].find(o => /Jul/.test(o.textContent)).value; pg.w.onGstPeriodPicked();
  pg.w.pfRenderGrid();
  return { ...pg, saved };
}
async function upload(pg, pf, month, files){
  pg.w.pfOpen(pf); pg.w.pfTab(month); await sleep(30);
  Object.entries(files).forEach(([slot, name]) => Object.defineProperty(pg.$('pfFile_' + slot), 'files', { value: [file(name)], configurable: true }));
  pg.w.pfUpload(); await sleep(700);
  return pg.$('pfMsg').textContent.replace(/\s+/g, ' ');
}

test('Platform import (real Q2 data, files as downloaded) → GSTR-1 matching the gsttool reference', async () => {
  const pg = await openTool(); const { w, $ } = pg;
  assert.deepEqual(JSON.parse(JSON.stringify(w.pfMonths())), ['2026-07', '2026-08', '2026-09'], 'quarter → three month tabs');
  assert.match($('pfGrid').textContent, /Meesho.*Amazon.*Amazon B2B.*Flipkart/);
  // Meesho: GST report .zip into both tcs slots (the right file is taken from inside), invoice details Excel
  for (const [m, n, nm] of [['2026-07', 7, 'july'], ['2026-08', 8, 'aug'], ['2026-09', 9, 'sep']]) {
    const msg = await upload(pg, 'MEESHO', m, { sales: `gst_2592706_${n}_2026.zip`, returns: `gst_2592706_${n}_2026.zip`, invoices: `Tax_invoice_details ${nm}.xlsx` });
    assert.doesNotMatch(msg, /Still to upload|not recognised|⚠/, msg);
  }
  assert.equal(w.document.getElementById('pfEcoInput').value, '09AARCM9332R1CM', 'Meesho TCS GSTIN for UP');
  for (const [m, M] of [['2026-07', 'July'], ['2026-08', 'August'], ['2026-09', 'September']]) {
    await upload(pg, 'AMAZON', m, { mtr: `b2cReport_${M}_2026.zip` });
    await upload(pg, 'AMAZON_B2B', m, { mtr: `b2bReport_${M}_2026.zip` });
  }
  assert.equal(w.document.getElementById('pfEcoInput').value, '09AAICA3918J1CR');
  for (const [m, nm] of [['2026-07', 'july'], ['2026-08', 'aug'], ['2026-09', 'sep']]) await upload(pg, 'FLIPKART', m, { sales: `${nm} 26.xlsx` });
  assert.equal(w.document.getElementById('pfEcoInput').value, '09AACCF0683K1CQ', 'Flipkart TCS GSTIN (C), not its regular GSTIN');
  w.pfClose();
  assert.match($('pfGrid').textContent, /Jul ✓ · Aug ✓ · Sep ✓/);
  // generate + download
  $('generateBtn').disabled = false; $('generateBtn').click(); await sleep(600);
  $('downloadJsonBtn').click(); await sleep(200);
  const J = pg.saved[0];
  assert.ok(validate(J), JSON.stringify(validate.errors));
  assert.equal(J.fp, '092026');
  // B2CS: same 32 rows; every row within ₹0.05, totals within ₹0.25 (rounding)
  assert.equal(J.b2cs.length, REF.b2cs.length);
  REF.b2cs.forEach(b => {
    const o = J.b2cs.find(x => x.pos === b.pos && x.rt === b.rt && x.sply_ty === b.sply_ty);
    assert.ok(o, 'row ' + b.pos + ' ' + b.rt); assert.ok(Math.abs(o.txval - b.txval) <= 0.05, `${b.pos}: ${o.txval} vs ${b.txval}`);
    assert.equal(o.typ, 'OE'); assert.equal(o.etin, undefined);
  });
  const tot = (a, k) => a.reduce((s, x) => s + (x[k] || 0), 0);
  assert.ok(Math.abs(tot(J.b2cs, 'txval') - tot(REF.b2cs, 'txval')) < 0.25); assert.ok(Math.abs(tot(J.b2cs, 'iamt') - tot(REF.b2cs, 'iamt')) < 0.25);
  // Table 8 nil (Amazon's A_GEN_EXEMPT sales) and Table 13 documents: identical
  assert.deepEqual(J.nil.inv, REF.nil.inv);
  const docs = d => d.doc_det.map(x => [x.doc_num, x.docs.map(y => [y.from, y.to, y.totnum])]);
  assert.deepEqual(docs(J.doc_issue), docs(REF.doc_issue));
  // HSN: same codes / rates / quantities; values within ₹0.25
  ['hsn_b2b', 'hsn_b2c'].forEach(k => REF.hsn[k].forEach(h => {
    const o = J.hsn[k].find(x => x.hsn_sc === h.hsn_sc && x.rt === h.rt);
    assert.ok(o, k + ' ' + h.hsn_sc + ' ' + h.rt); assert.equal(o.qty, h.qty); assert.ok(Math.abs(o.txval - h.txval) <= 0.25);
  }));
  // Table 14: the three marketplaces' TCS GSTINs; values within ₹0.25
  REF.supeco.clttx.forEach(e => {
    const o = J.supeco.clttx.find(x => x.etin === e.etin);
    assert.ok(o, e.etin); assert.ok(Math.abs(o.suppval - e.suppval) <= 0.25 && Math.abs(o.igst - e.igst) <= 0.25);
  });
  assert.match($('gstToolChecks').textContent, /A_GEN_EXEMPT/, 'the Amazon tax-code warning is shown');
});

test('Wrong file in a slot is refused with a clear message', async () => {
  const pg = await openTool();
  const msg = await upload(pg, 'MEESHO', '2026-07', { sales: 'july 26.xlsx' });
  assert.match(msg, /doesn't look like tcs_sales\.xlsx/);
  const msg2 = await upload(pg, 'AMAZON', '2026-07', { mtr: 'gst_2592706_7_2026.zip' });
  assert.match(msg2, /has no MTR_B2C File inside/);
});
