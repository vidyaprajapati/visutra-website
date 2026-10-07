const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), path = require('path');
const XLSX = require('xlsx');
const { seed, read, list, reset, pool, makeClient } = require('./lib/fakesb');
const { loadPage, sleep, closeAll, A, B, C, R, read: readSrc } = require('./lib/sbload');
require(R + 'billing/assets/gst-returns.js'); const G = globalThis.VTGst;
after(async () => { closeAll(); await pool.end(); });
const SA = 'users/' + A.uid, SB = 'users/' + B.uid;
async function world(){
  await reset();
  await seed(SA, { businessName: 'VISUTRA', gstin: '09BVHPP4321G1ZJ', stateCode: '09', state: 'Uttar Pradesh', address: 'Muradnagar', profileComplete: true, roles: { seller: true } });
  await seed(SB, { businessName: 'Delhi Shop', gstin: '07AAACR5055K1Z3', stateCode: '07', state: 'Delhi', address: 'Karol Bagh', profileComplete: true, roles: { buyer: true } });
  await seed(`sellerLinks/${A.uid}_${B.uid}`, { sellerUid: A.uid, buyerUid: B.uid, status: 'ACTIVE' });
}

test('Linked partners get each other\'s GSTIN (strangers don\'t); seller\'s customer and buyer\'s supplier are filled in', async () => {
  await world();
  const prof = (await makeClient(() => A).rpc('vt_party_profile', { p_uid: B.uid })).data;
  assert.deepEqual([prof.gstin, prof.stateCode, prof.businessName], ['07AAACR5055K1Z3', '07', 'Delhi Shop']);
  assert.equal((await makeClient(() => C).rpc('vt_party_profile', { p_uid: B.uid })).data, null, 'a stranger gets nothing');
  // seller: a linked customer saved without GSTIN/state is completed when Billing loads
  await seed(SA + '/customers/c1', { name: 'Delhi Shop', linkedBuyerUid: B.uid, linkStatus: 'ACTIVE', gstin: '', stateCode: '' });
  loadPage('billing/app.html', A); await sleep(2000);
  const c1 = await read(SA + '/customers/c1');
  assert.deepEqual([c1.gstin, c1.stateCode, c1.state], ['07AAACR5055K1Z3', '07', 'Delhi'], 'invoices to them now go to B2B with the right state');
  // buyer: supplier record for the seller gets the seller's GSTIN (new and older records)
  await seed(SB + '/buyerSuppliers/old', { name: 'VISUTRA', sellerUid: A.uid, gstin: '' });
  await seed(SB + '/buyerPurchases/p1', { supplierId: 'old', supplierName: 'VISUTRA', date: '2026-09-05', invoiceNo: 'VT/01', subtotal: 1000, gstTotal: 50, items: [{ name: 'Cover', qty: 2, gstRate: 5, taxable: 1000, gstAmt: 50 }] });
  const pg = loadPage('billing/buyer/purchases-gstr.html', B); pg.w.eval(readSrc('billing/assets/user-menu.js')); await sleep(1300);
  pg.$('gMonth').value = '2026-09'; await pg.w.eval('generateReport()'); await sleep(900);
  assert.equal((await read(SB + '/buyerSuppliers/old')).gstin, '09BVHPP4321G1ZJ', 'older supplier record filled in');
  assert.match(pg.$('itcKpis').textContent, /Eligible ITC — IGST₹50\.00/, 'the purchase now counts for ITC (Delhi buyer ← UP seller = IGST)');
  const id = await pg.w.vtEnsureSupplierForSeller(B.uid, A.uid, 'VISUTRA');
  assert.equal(id, 'old', 'existing record reused');
});

test('GSTR-1 reports tax exactly as on the invoice (no 1-paisa differences in the buyer\'s GSTR-2B)', () => {
  const doc = { no: 'VT/01', date: '2026-09-02', ctin: '09AAACR5055K1Z5', pos: '09', inter: false, items: [{ hsn: '63079090', desc: 'Cover', unit: 'PCS', qty: 1, rate: 5, taxable: 333.33 }] };
  const plain = G.buildGstr1([doc], { gstin: '09BVHPP4321G1ZJ', stateCode: '09', period: '2026-09' }).json.b2b[0].inv[0].itms[0].itm_det;
  const exact = G.buildGstr1([Object.assign({}, doc, { tax: { iamt: 0, camt: 8.333325, samt: 8.333325 } })], { gstin: '09BVHPP4321G1ZJ', stateCode: '09', period: '2026-09' }).json.b2b[0].inv[0].itms[0].itm_det;
  assert.deepEqual([plain.camt, plain.samt], [8.34, 8.33], '(re-computed: 16.67 split unevenly)');
  assert.deepEqual([exact.camt, exact.samt], [8.33, 8.33], 'as printed on the invoice');
});

test('Billing warns about past invoices issued to a GST-registered linked buyer without their GSTIN', async () => {
  await world();
  await seed(SA + '/customers/c1', { name: 'Delhi Shop', linkedBuyerUid: B.uid, gstin: '07AAACR5055K1Z3', stateCode: '07' });
  await seed(SA + '/products/p1', { name: 'Cover', hsn: '63079090', unit: 'PCS', gstRate: 5, stock: 10 });
  await seed(SA + '/invoices/i1', { createdAt: { __ts: '2026-09-03T10:00:00.000Z' }, invoiceNo: 'VT/011', date: '2026-09-03', customerId: 'c1', sameState: false, grandTotal: 315, igst: 15,
    customer: { name: 'Delhi Shop', gstin: '', stateCode: '07' }, items: [{ productId: 'p1', name: 'Cover', hsn: '63079090', unit: 'PCS', qty: 1, rate: 300, gstRate: 5, taxable: 300 }] });
  const { w, $ } = loadPage('billing/app.html', A); await sleep(1800);
  $('gstrType').value = 'monthly'; w.eval('onFilingTypeChange()'); $('gstrMonth').value = '2026-09';
  await w.eval('generateGstr1()'); await sleep(800);
  assert.match($('gstCheckBox').textContent, /Invoice VT\/011 was issued to Delhi Shop without their GSTIN \(07AAACR5055K1Z3\)/);
});

test('GSTR-3B sales part (3.1 / 3.2) from Amazon + Flipkart reports; TCS reminder', () => {
  const amz = G.parseReadyWorkbook(XLSX, XLSX.readFile(path.join(__dirname, 'fixtures', 'amazon-gstr1-ready-JULY-SEPTEMBER-2026.xlsx')), 'GSTR1-JULY-SEPTEMBER-2026-X.xlsx');
  const fk = G.parseFlipkartGstWorkbook(XLSX, XLSX.readFile(path.join(__dirname, 'fixtures', 'flipkart-gstr1-gstr8-report.xlsx')), 'fk.xlsx');
  const res = G.buildGstr1([], { gstin: '09BVHPP4321G1ZJ', stateCode: '09', period: '2026-09' });
  G.mergeReadyReport(res, [amz, fk], { gstin: '09BVHPP4321G1ZJ', stateCode: '09', period: '2026-09' });
  const g3 = G.gstr3bFromGstr1(res.json);
  assert.equal(g3.ret_period, '092026');
  assert.equal(g3.sup_details.osup_det.txval, 64227.93, 'Amazon 59,701 + Flipkart 4,526.93 (net of returns)');
  assert.equal(g3.sup_details.osup_det.iamt, 199.97); assert.equal(g3.sup_details.osup_det.camt, 13.2);
  assert.ok(g3.inter_sup.unreg_details.find(u => u.pos === '29'), 'Karnataka in 3.2');
  assert.ok(res.issues.some(i => /collected TCS of ₹22\.64/.test(i.msg)), res.issues.map(i => i.msg).join(' | '));
});
