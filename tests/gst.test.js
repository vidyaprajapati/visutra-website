const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { seed, read, list, reset, pool, makeClient } = require('./lib/fakesb');
const { loadPage, loadCore, mkPdf, sleep, closeAll, A, B, C } = require('./lib/sbload');
after(async () => { closeAll(); await pool.end(); });

const XLSX = require('xlsx');
const { validate } = require('./lib/gstr1-schema');
const { R } = require('./lib/sbload');
require(R + 'billing/assets/gst-returns.js'); const G = globalThis.VTGst;
const WM = { hsn: '63079090', desc: 'Washing Machine Cover', unit: 'PCS' };
const docs = [
  { no: 'VT/26/001', date: '2026-09-02', ctin: '09AAACR5055K1Z5', name: 'Retail Mart', pos: '09', inter: false, items: [{ ...WM, qty: 10, rate: 5, taxable: 3000 }, { hsn: '63049291', desc: 'Table Cover', unit: 'Nos', qty: 5, rate: 18, taxable: 1000 }] },
  { no: 'VT/26/002', date: '2026-09-05', ctin: '07AAACR5055K1Z3', name: 'Delhi Traders', pos: '07', inter: true, items: [{ ...WM, qty: 20, rate: 5, taxable: 6000 }] },
  { no: 'VT/26/003', date: '2026-09-09', ctin: '', pos: '27', inter: true, items: [{ ...WM, qty: 400, rate: 5, taxable: 120000 }] },
  { no: 'VT/26/004', date: '2026-09-10', ctin: '', pos: '09', inter: false, items: [{ ...WM, qty: 1, rate: 5, taxable: 300 }, { hsn: '4901', desc: 'Booklet', unit: 'PCS', qty: 1, rate: 0, taxable: 50 }] },
  { no: 'VT/26/005', date: '2026-09-13', cancelled: true, items: [] },
  { no: 'AMZ-001', date: '2026-09-14', ctin: '', pos: '24', inter: true, etin: '24AAICA3918J1ZE', items: [{ ...WM, qty: 1, rate: 5, taxable: 320 }] }
];

test('GSTR-1 JSON matches the portal format and every table is right', () => {
  const r = G.buildGstr1(docs, { gstin: '09BVHPP4321G1ZJ', period: '2026-09', stateCode: '09' });
  assert.ok(validate(r.json), JSON.stringify(validate.errors));
  assert.equal(r.json.fp, '092026');
  const intra = r.json.b2b.find(x => x.ctin === '09AAACR5055K1Z5').inv[0];
  assert.deepEqual(intra.itms.find(i => i.itm_det.rt === 5).itm_det, { txval: 3000, rt: 5, camt: 75, samt: 75, csamt: 0 });
  assert.equal(r.json.b2b.find(x => x.ctin === '07AAACR5055K1Z3').inv[0].itms[0].itm_det.iamt, 300);
  assert.equal(r.json.b2cl[0].pos, '27');
  assert.ok(r.json.nil.inv.find(n => n.sply_ty === 'INTRAB2C' && n.nil_amt === 50));
  assert.ok(r.json.hsn.hsn_b2b.length && r.json.hsn.hsn_b2c.length, 'HSN split B2B / B2C');
  const vt = r.json.doc_issue.doc_det[0].docs.find(d => d.from === 'VT/26/001');
  assert.deepEqual([vt.totnum, vt.cancel, vt.net_issue], [5, 1, 4]);
  assert.equal(r.json.supeco.clttx[0].etin, '24AAICA3918J1ZE');
  assert.equal(r.issues.length, 0);
});

test('GSTR-1 validation catches what the portal would reject', () => {
  const r = G.buildGstr1([{ no: 'VERY-LONG-INVOICE-NO-123', date: '2026-09-01', ctin: '09ABC', pos: '', items: [{ desc: 'X', unit: 'PCS', qty: 1, rate: 13, taxable: 10 }] }], { gstin: '', period: '2026-09' });
  const msgs = r.issues.map(i => i.msg).join(' | ');
  for(const re of [/GSTIN is missing/, /16 characters/, /not a valid GSTIN/, /Place of supply/, /no HSN/, /13%/]) assert.match(msgs, re);
});

test('GSTR-3B: liability, ITC and set-off', () => {
  const purchases = [
    { gstin: '09AABCT1234F1Z5', inter: false, items: [{ rate: 5, taxable: 20000 }] },
    { gstin: '27AABCT1234F1Z1', inter: true, items: [{ rate: 18, taxable: 5000 }] },
    { gstin: '', inter: false, items: [{ rate: 5, taxable: 1000 }] }
  ];
  const b = G.buildGstr3b(docs, purchases, { gstin: '09BVHPP4321G1ZJ', period: '2026-09' });
  assert.equal(b.json.ret_period, '092026');
  assert.deepEqual(b.json.itc_elg.itc_net, { iamt: 900, camt: 500, samt: 500, csamt: 0 });
  assert.deepEqual(b.json.itc_elg.itc_inelg[1], { ty: 'OTH', iamt: 0, camt: 25, samt: 25, csamt: 0 });
  assert.ok(b.json.inter_sup.unreg_details.find(u => u.pos === '27' && u.iamt === 6000));
});

test('GSTR-2B reconciliation matches TC/45 with TC/0045 and flags the rest', () => {
  const twoB = G.parse2bJson({ data: { docdata: { b2b: [
    { ctin: '09AABCT1234F1Z5', trdnm: 'Textile Co', inv: [{ inum: 'TC/0045', dt: '03-09-2026', val: 21000, txval: 20000, igst: 0, cgst: 500, sgst: 500, cess: 0, itcavl: 'Y' }] },
    { ctin: '06AAAAA1111A1Z9', trdnm: 'Unknown', inv: [{ inum: 'X1', dt: '10-09-2026', val: 1180, txval: 1000, igst: 180, cgst: 0, sgst: 0, cess: 0 }] }] } } });
  const rec = G.reconcile([
    { ctin: '09AABCT1234F1Z5', name: 'Textile Co', no: 'TC/45', date: '2026-09-03', taxable: 20000, tax: 1000 },
    { ctin: '09AABCT9999F1Z2', name: 'Late Filer', no: 'LF-1', date: '2026-09-09', taxable: 3000, tax: 150 }], twoB);
  assert.equal(rec.rows.find(r => r.book && r.book.no === 'TC/45').status, 'matched');
  assert.equal(rec.summary['missing-in-2b'], 1);
  assert.equal(rec.summary['missing-in-books'], 1);
  assert.equal(rec.summary.itcClaimable, 1000);
  const ws = XLSX.utils.aoa_to_sheet([['GSTR-2B'], [], ['GSTIN of supplier', 'Trade/Legal name', 'Invoice details', '', '', '', 'Place of supply', 'Supply Attract Reverse Charge', 'Taxable Value (₹)', 'Tax Amount'],
    ['', '', 'Invoice number', 'Invoice type', 'Invoice Date', 'Invoice Value(₹)', '', '', '', 'Integrated Tax(₹)', 'Central Tax(₹)', 'State/UT Tax(₹)', 'Cess(₹)'],
    ['09AABCT1234F1Z5', 'Textile Co', 'TC/0045', 'Regular', '03/09/2026', 21000, '09-Uttar Pradesh', 'No', 20000, 0, 500, 500, 0]]);
  const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, 'B2B');
  assert.equal(G.parse2bWorkbook(XLSX, wb)[0].taxable, 20000, 'portal Excel (two header rows) is read');
});

test('Billing page: GST filing files, monthly and quarterly', async () => {
  await reset();
  const U = 'users/' + A.uid;
  await seed(U, { businessName: 'VISUTRA', gstin: '09BVHPP4321G1ZJ', stateCode: '09', profileComplete: true, roles: { seller: true } });
  await seed(U + '/products/p1', { name: 'Washing Machine Cover', hsn: '63079090', unit: 'PCS', price: 300, gstRate: 5, stock: 100 });
  const inv = (id, no, date, cust, same, qty, extra) => seed(U + '/invoices/' + id, Object.assign({ invoiceNo: no, date, customer: cust, sameState: same, grandTotal: qty * 315,
    items: [{ productId: 'p1', name: 'Washing Machine Cover', hsn: '63079090', unit: 'PCS', qty, rate: 300, gstRate: 5, taxable: qty * 300 }] }, extra || {}));
  await inv('i1', 'VT/001', '2026-09-02', { name: 'Retail Mart', gstin: '09AAACR5055K1Z5', stateCode: '09' }, true, 10);
  await inv('i2', 'VT/002', '2026-09-05', { name: 'Delhi Traders', gstin: '07AAACR5055K1Z3', stateCode: '07' }, false, 20);
  await inv('i3', 'VT/003', '2026-09-08', { name: 'Cancelled', stateCode: '09' }, true, 1, { deleted: true });
  await inv('i4', 'VT/004', '2026-08-30', { name: 'August', stateCode: '09' }, true, 1);
  await seed(U + '/suppliers/s1', { name: 'Textile Co', gstin: '09AABCT1234F1Z5' });
  await seed(U + '/purchases/pu1', { supplierId: 's1', supplierName: 'Textile Co', date: '2026-09-03', invoiceNo: 'TC/0045', subtotal: 20000, gstTotal: 1000, grandTotal: 21000,
    items: [{ name: 'Fabric', qty: 100, rate: 200, gstRate: 5, taxable: 20000, gstAmt: 1000 }] });
  const saved = [];
  const { w, $ } = loadPage('billing/app.html', A); await sleep(1800);
  w.VTGst.downloadJson = (obj, name) => saved.push(JSON.parse(JSON.stringify(obj))); // plain objects (not the test browser's)
  $('gstrType').value = 'monthly'; w.eval('onFilingTypeChange()'); $('gstrMonth').value = '2026-09';
  await w.eval('generateGstr1()'); await sleep(800);
  assert.ok(!$('gstFilingCard').classList.contains('hidden'));
  w.eval('downloadGstr1Json()'); w.eval('downloadGstr3bJson()');
  assert.ok(validate(saved[0]), JSON.stringify(validate.errors));
  assert.equal(saved[0].fp, '092026');
  assert.deepEqual(saved[1].itc_elg.itc_net, { iamt: 0, camt: 500, samt: 500, csamt: 0 }, 'ITC from purchases reaches GSTR-3B');
  $('gstrType').value = 'quarterly'; w.eval('onFilingTypeChange()');
  const q = $('gstrQuarter'); q.value = [...q.options].map(o => o.value).find(v => /2/.test(v)) || q.value;
  saved.length = 0; await w.eval('generateGstr1()'); await sleep(700); w.eval('downloadGstr1Json()');
  assert.equal(saved[0].fp, '092026', 'quarterly return period = last month of the quarter');
  assert.equal(saved[0].doc_issue.doc_det[0].docs[0].totnum, 4, 'quarter includes August');
});
