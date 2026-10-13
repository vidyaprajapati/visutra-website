const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), path = require('path');
const { seed, read, list, reset, pool, makeClient } = require('./lib/fakesb');
const { loadPage, sleep, closeAll, A } = require('./lib/sbload');
const { validate } = require('./lib/gstr1-schema');
after(async () => { closeAll(); await pool.end(); });
const FX = path.join(__dirname, 'fixtures', 'q2-2026');
const U = 'users/' + A.uid;
const file = name => { const b = fs.readFileSync(path.join(FX, name)); return { name, arrayBuffer: async () => b.buffer.slice(b.byteOffset, b.byteOffset + b.length) }; };
const plain = x => JSON.parse(JSON.stringify(x));
const ts = d => ({ __ts: d + 'T10:00:00.000Z' });

async function world() {
  await reset();
  await seed(U, { businessName: 'Visu trader', gstin: '09BVHPP4321G1ZJ', stateCode: '09', profileComplete: true, roles: { seller: true } });
  await seed(U + '/products/p1', { name: 'WM Cover', hsn: '63079090', unit: 'PCS', gstRate: 5, stock: 10 });
  await seed(U + '/invoices/i1', { createdAt: ts('2026-08-10'), invoiceNo: 'VT/101', date: '2026-08-10', sameState: false, grandTotal: 1050, igst: 50, cgst: 0, sgst: 0,
    customer: { name: 'Delhi Traders', gstin: '07AAACR5055K1Z3', stateCode: '07' }, items: [{ productId: 'p1', name: 'WM Cover', unit: 'PCS', qty: 2, gstRate: 5, taxable: 1000 }] });
  await seed(U + '/invoices/i2', { createdAt: ts('2026-09-05'), invoiceNo: 'VT/102', date: '2026-09-05', sameState: true, grandTotal: 315, igst: 0, cgst: 7.5, sgst: 7.5,
    customer: { name: 'Walk-in', gstin: '', stateCode: '09' }, items: [{ productId: 'p1', name: 'WM Cover', unit: 'PCS', qty: 1, gstRate: 5, taxable: 300 }] });
  await seed(U + '/invoices/i3', { createdAt: ts('2026-06-30'), invoiceNo: 'VT/100', date: '2026-06-30', sameState: true, grandTotal: 105, cgst: 2.5, sgst: 2.5,
    customer: { name: 'June', stateCode: '09' }, items: [{ productId: 'p1', name: 'WM Cover', qty: 1, gstRate: 5, taxable: 100 }] });
  await seed(U + '/suppliers/s1', { name: 'Textile Co', gstin: '09AABCT1234F1Z5' });
  await seed(U + '/purchases/pu1', { supplierId: 's1', date: '2026-08-02', items: [{ name: 'Fabric', gstRate: 5, taxable: 20000 }] });
  await seed(U + '/buyerSuppliers/bs1', { name: 'Mumbai Mills', gstin: '27AAACR5055K1Z7' });
  await seed(U + '/buyerPurchases/bp1', { supplierId: 'bs1', date: '2026-09-03', items: [{ name: 'Zips', gstRate: 18, taxable: 1000 }] });
}
function open() {
  const pg = loadPage('tools/gst-seller.html', A, { query: '#profile', before: w => { w.JSZip = require('jszip'); w.TextDecoder = require('util').TextDecoder; w.confirm = () => true; w.print = () => {}; } });
  pg.saved = []; return pg;
}
async function selectQ2(w, gstin) { w.D.type = 'quarterly'; w.D.pkey = 'Q2'; w.D.fy = 2026; await w.selectGstin(gstin); await sleep(150); }

test('Billing invoices in the same GSTR-1, GSTR-3B with ITC, and the filed lock', async () => {
  await world();
  const pg = open(); await sleep(1200); const { w, $ } = pg;
  w.VTGst.downloadJson = o => pg.saved.push(plain(o));
  await selectQ2(w, '09BVHPP4321G1ZJ');
  // a marketplace month
  w.openPlatform('FLIPKART'); w.GS.modal.month = '2026-07'; w.renderPlatformModal();
  Object.defineProperty($('mFile_sales'), 'files', { value: [file('july 26.xlsx')], configurable: true }); await w.uploadPlatform(); w.gsCloseModal();
  // Billing card
  w.gsGo('import'); assert.match($('iBody').textContent, /VISUTRA Billing/);
  w.openPlatform('BILLING'); assert.match($('gsMbox').textContent, /one file/);
  await w.loadBilling(); await sleep(100);
  assert.match($('gsMbox').textContent, /Loaded:\s*2 invoice\(s\) · B2B ₹1,000\.00 · B2C ₹300\.00/, 'June invoice left out');
  w.gsCloseModal(); w.gsGo('manage');
  assert.match($('mBody').textContent, /VISUTRA Billing/);
  // one GSTR-1
  w.gsGo('report'); w.downloadJson(); const J = pg.saved.pop();
  assert.ok(validate(J), JSON.stringify(validate.errors));
  assert.equal(J.b2b[0].ctin, '07AAACR5055K1Z3'); assert.equal(J.b2b[0].inv[0].inum, 'VT/101');
  const fkUp = 527.88 + 0; // (Flipkart July UP value is checked loosely below)
  const up = J.b2cs.find(x => x.pos === '09');
  assert.ok(up && up.txval > 300, 'Billing UP sale merged into the UP B2CS row (with Flipkart UP)');
  assert.ok(J.doc_issue.doc_det[0].docs.some(d => d.from === 'VT/101' && d.to === 'VT/102' && d.totnum === 2), 'Billing series in Table 13');
  assert.ok(J.doc_issue.doc_det[0].docs.some(d => /^LWAB4JO/.test(d.from)), 'and Flipkart\'s');
  // the JSON download marks Billing months GENERATED (like Billing)
  await sleep(200); assert.equal((await read(U + '/gstPeriods/2026-08')).status, 'GENERATED');
  // GSTR-3B
  w.gsGo('gstr3b'); await sleep(600);
  const r3 = w.gstr3bRes();
  assert.equal(r3.json.ret_period, '092026');
  assert.equal(r3.json.sup_details.osup_det.txval, Math.round((J.b2b[0].inv[0].itms[0].itm_det.txval + J.b2cs.reduce((a, x) => a + x.txval, 0)) * 100) / 100, '3.1(a) = GSTR-1 B2B + B2CS');
  assert.deepEqual(plain(r3.json.itc_elg.itc_net), { iamt: 180, camt: 500, samt: 500, csamt: 0 }, 'UP supplier → CGST/SGST, Maharashtra → IGST');
  assert.match($('bBody').textContent, /Billing → Purchase Entry \(1 purchase/); assert.match($('bBody').textContent, /Buyer → Purchase Entry \(1 purchase/);
  w.setItc('buyer', false); await sleep(150);
  assert.equal(w.gstr3bRes().json.itc_elg.itc_net.iamt, 0, 'Buyer purchases can be left out');
  w.download3bJson(); assert.equal(pg.saved.pop().ret_period, '092026');
  // Mark as filed → locked (and Billing months FILED)
  w.gsGo('report'); await w.markFiled(); await sleep(200);
  assert.match($('rBody').textContent, /Filed on .* this return is locked/);
  assert.equal((await read(U + '/gstPeriods/2026-07')).status, 'FILED');
  const del = await makeClient(() => A).rpc('vt_commit', { ops: [{ op: 'update', path: U + '/invoices/i1', data: { deleted: true } }], pre: [] });
  assert.match(del.error.message, /VT_LOCKED/, 'Billing invoice of a filed month can\'t be deleted');
  let alerted = 0; w.alert = () => { alerted++; };
  w.openPlatform('FLIPKART'); await w.uploadPlatform(); w.gsCloseModal(); w.deleteCard('FLIPKART'); await w.saveEditor();
  assert.equal(alerted, 3, 'upload, delete and edit blocked while filed');
  assert.ok(await read(U + '/gstImports/09BVHPP4321G1ZJ_FLIPKART_2026-07_sales'), 'nothing removed');
  // unlock needs UNLOCK
  w.prompt = () => 'unlock please'; await w.unlockReturn(); assert.ok(w.GS.ret.filed, 'wrong word → still locked');
  w.prompt = () => 'UNLOCK'; await w.unlockReturn(); await sleep(150); assert.equal(w.GS.ret.filed, undefined);
  assert.equal((await read(U + '/gstPeriods/2026-07')).status, 'FILED', 'Billing months stay FILED (permanent, as in Billing)');
});

test('Billing invoices are offered only for the account\'s own GSTIN', async () => {
  await world();
  const pg = open(); await sleep(1200); const { w, $ } = pg;
  await selectQ2(w, '27AAACR5055K1Z7');
  w.openPlatform('BILLING');
  assert.match($('gsMbox').textContent, /belong to your account's GSTIN 09BVHPP4321G1ZJ/);
  assert.doesNotMatch($('gsMbox').textContent, /Load invoices/);
});
