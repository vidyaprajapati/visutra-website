const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), path = require('path');
const XLSX = require('xlsx'), JSZip = require('jszip');
const { seed, read, list, reset, pool } = require('./lib/fakesb');
const { loadPage, sleep, closeAll, A } = require('./lib/sbload');
after(async () => { closeAll(); await pool.end(); });
const FX = path.join(__dirname, 'fixtures', 'q2-2026');
const U = 'users/' + A.uid;
const asFile = (name, b) => ({ name, arrayBuffer: async () => b.buffer.slice(b.byteOffset, b.byteOffset + b.length) });
const fx = name => asFile(name, fs.readFileSync(path.join(FX, name)));
const fromZip = async (zipName, inner, as) => { const z = await JSZip.loadAsync(fs.readFileSync(path.join(FX, zipName))); return asFile(as || inner, Buffer.from(await z.file(inner).async('uint8array'))); };

async function open(gstin, pkey) {
  await reset();
  await seed(U, { businessName: 'Visu trader', gstin: '09BVHPP4321G1ZJ', stateCode: '09', profileComplete: true, roles: { seller: true } });
  const beeps = { n: 0 };
  const pg = loadPage('tools/gst-seller.html', A, { query: '#import', before: w => {
    w.JSZip = JSZip; w.TextDecoder = require('util').TextDecoder; w.confirm = () => true;
    w.AudioContext = function () { beeps.n++; return { createOscillator: () => ({ connect() {}, start() {}, stop() {}, frequency: {} }), createGain: () => ({ connect() {}, gain: {} }), destination: {}, close() {} }; };
  } });
  await sleep(1200);
  pg.w.D.type = 'quarterly'; pg.w.D.pkey = pkey || 'Q2'; pg.w.D.fy = 2026; await pg.w.selectGstin(gstin || '09BVHPP4321G1ZJ'); await sleep(150);
  pg.w.gsGo('import');
  return Object.assign(pg, { beeps });
}
async function put(pg, card, month, files) {
  const { w, $ } = pg;
  w.openPlatform(card); w.GS.modal.month = month; w.renderPlatformModal();
  for (const [slot, f] of Object.entries(files)) Object.defineProperty($('mFile_' + slot), 'files', { value: [await f], configurable: true });
  await w.uploadPlatform(); await sleep(60);
  return ($('mAlarm').textContent || '').replace(/\s+/g, ' ');
}
const saved = async () => (await list(U + '/gstImports/')).map(r => r.path.split('/').pop());

test('Upload alarms: wrong file, wrong platform, wrong month (with move), wrong period, wrong GSTIN, same file twice, empty, swapped', async () => {
  const pg = await open(); const { w } = pg;
  // correct file → saved, no alarm
  let a = await put(pg, 'MEESHO', '2026-07', { sales: fx('gst_2592706_7_2026.zip') });
  assert.equal(a, ''); assert.deepEqual(await saved(), ['09BVHPP4321G1ZJ_MEESHO_2026-07_sales']); assert.equal(pg.beeps.n, 0);
  // returns file in the sales slot
  a = await put(pg, 'MEESHO', '2026-07', { sales: fromZip('gst_2592706_7_2026.zip', 'tcs_sales_return.xlsx') });
  assert.match(a, /NOT uploaded.*Wrong file: this is Meesho tcs_sales_return\.xlsx, but this slot needs Meesho tcs_sales\.xlsx — put it in the tcs_sales_return\.xlsx slot/);
  assert.equal(pg.beeps.n, 1, 'alarm beeps');
  // Flipkart file in a Meesho slot
  a = await put(pg, 'MEESHO', '2026-07', { invoices: fx('july 26.xlsx') });
  assert.match(a, /this is Flipkart Sales Report.*use the Flipkart card/);
  // Amazon B2B report in the Amazon (B2C) card, and the Ready-to-File Excel
  a = await put(pg, 'AMAZON', '2026-07', { mtr: fx('b2bReport_July_2026.zip') });
  assert.match(a, /has no MTR_B2C File inside/, 'B2B zip has no B2C file');
  a = await put(pg, 'AMAZON', '2026-07', { mtr: (async () => { const z = await JSZip.loadAsync(fs.readFileSync(path.join(FX, 'b2bReport_July_2026.zip'))); const n = Object.keys(z.files).find(x => /\.csv$/.test(x)); return asFile('report.csv', Buffer.from(await z.file(n).async('uint8array'))); })() });
  assert.match(a, /this is Amazon MTR B2B report.*use the Amazon B2B card/);
  a = await put(pg, 'AMAZON', '2026-07', { mtr: asFile('ready.xlsx', fs.readFileSync(path.join(__dirname, 'fixtures', 'amazon-gstr1-ready-JULY-SEPTEMBER-2026.xlsx'))) });
  assert.match(a, /GST Ready-to-File/);
  // August file on the July tab → alarm with "Upload into August"
  a = await put(pg, 'FLIPKART', '2026-07', { sales: fx('aug 26.xlsx') });
  assert.match(a, /Wrong month: this file is for August 2026, but you are on the July tab.*Upload into August/);
  assert.ok(!(await saved()).some(x => /FLIPKART/.test(x)), 'nothing saved');
  await w.moveUpload(0); await sleep(60);
  assert.ok((await saved()).includes('09BVHPP4321G1ZJ_FLIPKART_2026-08_sales'), 'moved into August');
  assert.equal(w.GS.modal.month, '2026-08'); assert.match(pg.$('mAlarm').textContent, /Uploaded: Sales Report → August/);
  // same file again on another tab → wrong month + same file twice
  a = await put(pg, 'FLIPKART', '2026-09', { sales: fx('aug 26.xlsx') });
  assert.match(a, /Same file twice: this exact file is already uploaded as Flipkart · Sales Report for August/);
  // empty file (headers only)
  const ws = XLSX.utils.aoa_to_sheet([['identifier', 'gstin', 'total_taxable_sale_value', 'end_customer_state_new', 'month_number', 'financial_year']]);
  const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, 'Sheet1');
  a = await put(pg, 'MEESHO', '2026-09', { sales: asFile('tcs_sales.xlsx', Buffer.from(XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }))) });
  assert.match(a, /no data rows/);
  // renamed + swapped Meesho files → warning
  a = await put(pg, 'MEESHO', '2026-08', { sales: fromZip('gst_2592706_8_2026.zip', 'tcs_sales_return.xlsx', 'b.xlsx'), returns: fromZip('gst_2592706_8_2026.zip', 'tcs_sales.xlsx', 'a.xlsx') });
  assert.match(a, /tcs_sales_return has more rows \(\d+\) than tcs_sales \(\d+\) — are the two files swapped\?/);
});

test('Wrong period and wrong GSTIN', async () => {
  let pg = await open('09BVHPP4321G1ZJ', 'Q3');
  let a = await put(pg, 'FLIPKART', '2026-10', { sales: fx('july 26.xlsx') });
  assert.match(a, /Wrong period: this file is for July 2026 — not part of this return \(Oct–Nov–Dec 2026\)/);
  assert.equal((await list(U + '/gstImports/')).length, 0);
  closeAll();
  pg = await open('27AAACR5055K1Z7', 'Q2');
  a = await put(pg, 'FLIPKART', '2026-07', { sales: fx('july 26.xlsx') });
  assert.match(a, /Wrong GSTIN: this file belongs to 09BVHPP4321G1ZJ, but you are filing for 27AAACR5055K1Z7/);
  a = await put(pg, 'MEESHO', '2026-07', { sales: fx('gst_2592706_7_2026.zip') });
  assert.match(a, /Wrong GSTIN/);
  // TCS report for a month outside the return
  pg.w.gsGo('tcs');
  const ws = XLSX.utils.aoa_to_sheet([['GSTIN of E-Commerce Operator', 'Tax Period', 'Net Amount Liable for TCS'], ['27AARCM9332R1CR', '062026', 1000]]);
  const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, 'TCS');
  Object.defineProperty(pg.$('tFile'), 'files', { value: [asFile('tcs.xlsx', Buffer.from(XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' })))], configurable: true });
  await pg.w.uploadPortalTcs(); await sleep(60);
  assert.match(pg.$('tMsg').textContent, /Wrong period: this TCS report is for Jun 2026 — not Jul 2026, Aug 2026, Sep 2026\. Nothing was added/);
});
