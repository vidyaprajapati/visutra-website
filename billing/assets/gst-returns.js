/* VISUTRA — GST returns engine (shared by Billing, Buyer and the GST Return Tool)
   ===========================================================================
   Builds files in the formats the GST portal / GSTN Offline Tool accept:

   GSTR-1  JSON  → GST portal: Returns → GSTR-1 → Prepare Offline → Upload (JSON)
           Excel → GSTN "Returns Offline Tool" workbook layout (sheet names
                   b2b,sez,de / b2cl / b2cs / hsn(b2b) / hsn(b2c) / docs / exemp)
           Covers Tables 4 (b2b), 5 (b2cl), 7 (b2cs), 8 (nil), 12 (HSN, split
           B2B/B2C — mandatory since May-2025), 13 (documents issued),
           14 (supplies through e-commerce operators, when ECO GSTINs are given).
   GSTR-3B JSON + Excel summary (3.1, 3.2, 4 ITC, 5) for the GSTR-3B offline
           utility / to copy into the portal.
   GSTR-2B reconciliation: reads the GSTR-2B JSON (or Excel) downloaded from
           the portal and matches it with your purchase entries.

   Rules follow the current GSTR-1 JSON specification (fp = MMYYYY, dates
   DD-MM-YYYY, pos = 2-digit state code, hsn.hsn_b2b / hsn.hsn_b2c, doc_issue
   mandatory, no portal-only fields like chksum/flag). GSTN changes formats
   from time to time — the Validation panel lists anything the portal would
   reject, and the files should still be checked on the portal before filing.

   Input to the builders — one object per invoice ("doc"):
     { no, date:'YYYY-MM-DD', ctin:'' (buyer GSTIN, blank = unregistered),
       name, pos:'09', inter:true|false, rchrg:false, cancelled:false,
       etin:'' (e-commerce operator GSTIN, optional),
       items:[{ hsn, desc, unit, qty, rate, taxable, cess }] }
   =========================================================================== */
(function (global) {
  'use strict';

  const STATES = {
    '01':'Jammu and Kashmir','02':'Himachal Pradesh','03':'Punjab','04':'Chandigarh','05':'Uttarakhand','06':'Haryana',
    '07':'Delhi','08':'Rajasthan','09':'Uttar Pradesh','10':'Bihar','11':'Sikkim','12':'Arunachal Pradesh','13':'Nagaland',
    '14':'Manipur','15':'Mizoram','16':'Tripura','17':'Meghalaya','18':'Assam','19':'West Bengal','20':'Jharkhand',
    '21':'Odisha','22':'Chhattisgarh','23':'Madhya Pradesh','24':'Gujarat','26':'Dadra and Nagar Haveli and Daman and Diu',
    '27':'Maharashtra','28':'Andhra Pradesh (Old)','29':'Karnataka','30':'Goa','31':'Lakshadweep','32':'Kerala',
    '33':'Tamil Nadu','34':'Puducherry','35':'Andaman and Nicobar Islands','36':'Telangana','37':'Andhra Pradesh',
    '38':'Ladakh','97':'Other Territory'
  };
  // Units used in the app → GST UQC (code for JSON, "CODE-NAME" for Excel)
  const UQC = {
    PCS:'PIECES', NOS:'NUMBERS', KGS:'KILOGRAMS', GMS:'GRAMMES', MTR:'METERS', SET:'SETS', BOX:'BOX', PAC:'PACKS',
    PRS:'PAIRS', DOZ:'DOZENS', ROL:'ROLLS', BDL:'BUNDLES', LTR:'LITRES', SQM:'SQUARE METERS', UNT:'UNITS', BAG:'BAGS',
    CTN:'CARTONS', OTH:'OTHERS', NA:'NA'
  };
  const UNIT_ALIASES = { PC:'PCS', PIECE:'PCS', PIECES:'PCS', NO:'NOS', NUMBER:'NOS', NUMBERS:'NOS', KG:'KGS', KGS:'KGS',
    G:'GMS', GM:'GMS', GRAM:'GMS', M:'MTR', METER:'MTR', METRE:'MTR', PACK:'PAC', PACKET:'PAC', PKT:'PAC', PAIR:'PRS',
    DOZEN:'DOZ', ROLL:'ROL', BUNDLE:'BDL', LITRE:'LTR', L:'LTR', UNIT:'UNT', UNITS:'UNT', CARTON:'CTN' };
  const VALID_RATES = [0, 0.1, 0.25, 1, 1.5, 3, 5, 6, 7.5, 12, 18, 28, 40];
  const DOC_NATURE = { 1: 'Invoices for outward supply', 5: 'Revised Invoice', 4: 'Debit Note', 5.1: 'Credit Note' };

  const r2 = n => Math.round(((Number(n) || 0) + Number.EPSILON) * 100) / 100;
  const sum = (a, f) => a.reduce((s, x) => s + (Number(f(x)) || 0), 0);
  function uqcCode(unit) {
    const u = String(unit || '').trim().toUpperCase().replace(/[^A-Z]/g, '');
    const c = UQC[u] ? u : UNIT_ALIASES[u];
    return c || 'OTH';
  }
  const uqcLabel = unit => { const c = uqcCode(unit); return c + '-' + UQC[c]; };
  const stateName = code => STATES[String(code || '').padStart(2, '0')] || '';
  const posLabel = code => code ? `${String(code).padStart(2, '0')}-${stateName(code)}` : '';
  function ddmmyyyy(iso) { const [y, m, d] = String(iso || '').slice(0, 10).split('-'); return d ? `${d}-${m}-${y}` : iso; }
  const MON = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  function ddMonyyyy(iso) { const [y, m, d] = String(iso || '').slice(0, 10).split('-'); return d ? `${d}-${MON[+m - 1]}-${y}` : iso; }
  function fpOf(period) { const [y, m] = String(period).split('-'); return `${m}${y}`; } // 'YYYY-MM' → 'MMYYYY'
  const GSTIN_RE = /^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;
  function gstinOk(g) { return GSTIN_RE.test(String(g || '').trim().toUpperCase()); }
  function taxSplit(taxable, rate, inter) {
    const t = r2(taxable * rate / 100);
    return inter ? { iamt: t, camt: 0, samt: 0 } : { iamt: 0, camt: r2(t / 2), samt: r2(t - r2(t / 2)) };
  }
  const itemNum = rate => Math.round(rate * 100) + 1; // GSTN convention: 18% → 1801

  /* ======================= validation ======================= */
  function validate(docs, opts) {
    const issues = [];
    const add = (level, msg, ref) => issues.push({ level, msg, ref: ref || '' });
    if (!gstinOk(opts.gstin)) add('error', 'Your GSTIN is missing or not valid — set it in Business Profile.');
    if (!opts.stateCode) add('error', 'Your state is not set — set it in Business Profile.');
    const seenNo = {};
    docs.forEach(d => {
      if (d.cancelled) return;
      const ref = (d.noDocSeries ? 'Return ' : 'Invoice ') + d.no;
      if (d.noDocSeries) { /* netted return line — number checks don't apply */ }
      else if (!d.no) add('error', 'An invoice has no number.', ref);
      else {
        if (String(d.no).length > 16) add('error', 'Invoice number longer than 16 characters (portal limit).', ref);
        if (/[^A-Za-z0-9\/\-]/.test(String(d.no))) add('error', 'Invoice number may only contain letters, digits, "/" and "-".', ref);
        if (seenNo[d.no]) add('error', 'Invoice number used twice in this period.', ref);
        seenNo[d.no] = 1;
      }
      if (d.ctin && !gstinOk(d.ctin)) add('error', `Buyer GSTIN "${d.ctin}" is not a valid GSTIN.`, ref);
      if (!d.pos || !STATES[String(d.pos).padStart(2, '0')]) add('error', 'Place of supply (buyer state) is missing.', ref);
      (d.items || []).forEach(it => {
        const h = String(it.hsn || '').replace(/\s/g, '');
        if (!h) add('error', `"${it.desc}" has no HSN code (mandatory in Table 12).`, ref);
        else if (!/^\d{4,8}$/.test(h)) add('error', `HSN "${h}" for "${it.desc}" must be 4–8 digits.`, ref);
        else if (opts.aatoAbove5Cr && h.length < 6) add('warn', `HSN "${h}" should be 6 digits (turnover above ₹5 crore).`, ref);
        if (!VALID_RATES.includes(Number(it.rate))) add('warn', `GST rate ${it.rate}% for "${it.desc}" is not a standard GST rate.`, ref);
        if (uqcCode(it.unit) === 'OTH' && it.unit && String(it.unit).toUpperCase() !== 'OTH') add('warn', `Unit "${it.unit}" isn't a GST unit (UQC) — reported as OTH.`, ref);
      });
    });
    return issues;
  }

  /* ======================= GSTR-1 ======================= */
  function docSeries(docs) {
    // Table 13: group invoice numbers into series by their non-numeric prefix.
    const series = {};
    docs.filter(d => !d.noDocSeries).forEach(d => {
      const m = String(d.no || '').match(/^(.*?)(\d+)$/);
      const prefix = m ? m[1] : String(d.no || '');
      const n = m ? parseInt(m[2], 10) : NaN;
      if (!series[prefix]) series[prefix] = { list: [], cancel: 0 };
      series[prefix].list.push({ no: d.no, n });
      if (d.cancelled) series[prefix].cancel++;
    });
    return Object.values(series).filter(s => s.list.length).map(s => {
      const sorted = s.list.slice().sort((a, b) => (isNaN(a.n) || isNaN(b.n)) ? String(a.no).localeCompare(String(b.no)) : a.n - b.n);
      return { from: sorted[0].no, to: sorted[sorted.length - 1].no, totnum: sorted.length, cancel: s.cancel, net_issue: sorted.length - s.cancel };
    });
  }

  function buildGstr1(allDocs, opts) {
    opts = Object.assign({ b2clLimit: 100000, ecoOperators: [] }, opts || {});
    const docs = allDocs.filter(d => !d.cancelled);
    const b2bByCtin = {}, b2clByPos = {}, b2cs = {}, nil = {}, hsnB2B = {}, hsnB2C = {}, eco = {};
    const rows = { b2b: [], b2cl: [], b2cs: [], hsnB2B: [], hsnB2C: [], docs: [], exemp: [] };
    const tot = { invoices: docs.length, taxable: 0, igst: 0, cgst: 0, sgst: 0, cess: 0, value: 0 };

    docs.forEach(d => {
      const pos = String(d.pos || '').padStart(2, '0');
      const inter = !!d.inter;
      const registered = !!d.ctin;
      const items = (d.items || []).filter(it => Number(it.taxable) || Number(it.qty));
      const invVal = r2(d.value != null ? d.value : sum(items, it => it.taxable * (1 + (it.rate || 0) / 100) + (it.cess || 0)));
      tot.value += invVal;
      // group lines by rate (one itm per rate, as the portal expects)
      const byRate = {};
      items.forEach(it => {
        const rt = Number(it.rate) || 0;
        if (!byRate[rt]) byRate[rt] = { txval: 0, cess: 0 };
        byRate[rt].txval += Number(it.taxable) || 0;
        byRate[rt].cess += Number(it.cess) || 0;
      });
      const taxedRates = Object.keys(byRate).map(Number).filter(rt => rt > 0);
      const nilTxval = byRate[0] ? byRate[0].txval : 0;

      if (nilTxval) {                        // Table 8 — nil rated
        const k = (inter ? 'INTR' : 'INTRA') + (registered ? 'B2B' : 'B2C');
        nil[k] = (nil[k] || 0) + nilTxval;
      }
      if (taxedRates.length) {
        const itms = taxedRates.map(rt => {
          // the invoice's own tax (exactly as printed) when it has one rate; else per-rate
          const txval = r2(byRate[rt].txval), t = (d.tax && taxedRates.length === 1)
            ? { iamt: inter ? r2(d.tax.iamt) : 0, camt: inter ? 0 : r2(d.tax.camt), samt: inter ? 0 : r2(d.tax.samt) }
            : taxSplit(txval, rt, inter);
          tot.taxable += txval; tot.igst += t.iamt; tot.cgst += t.camt; tot.sgst += t.samt; tot.cess += byRate[rt].cess;
          return { num: itemNum(rt), itm_det: Object.assign({ txval, rt }, inter ? { iamt: t.iamt } : { camt: t.camt, samt: t.samt }, { csamt: r2(byRate[rt].cess) }) };
        });
        if (registered) {                    // Table 4
          const ctin = String(d.ctin).trim().toUpperCase();
          (b2bByCtin[ctin] = b2bByCtin[ctin] || []).push(Object.assign({
            inum: String(d.no), idt: ddmmyyyy(d.date), val: invVal, pos, rchrg: d.rchrg ? 'Y' : 'N', inv_typ: 'R', itms
          }, d.etin ? { etin: d.etin } : {}));
          taxedRates.forEach(rt => rows.b2b.push([ctin, d.name || '', String(d.no), ddMonyyyy(d.date), invVal, posLabel(pos), d.rchrg ? 'Y' : 'N', '', 'Regular B2B', d.etin || '', rt, r2(byRate[rt].txval), r2(byRate[rt].cess)]));
        } else if (inter && invVal > opts.b2clLimit) {   // Table 5
          (b2clByPos[pos] = b2clByPos[pos] || []).push(Object.assign({
            inum: String(d.no), idt: ddmmyyyy(d.date), val: invVal,
            itms: itms.map(x => ({ num: x.num, itm_det: { txval: x.itm_det.txval, rt: x.itm_det.rt, iamt: x.itm_det.iamt || 0, csamt: x.itm_det.csamt } }))
          }, d.etin ? { etin: d.etin } : {}));
          taxedRates.forEach(rt => rows.b2cl.push([String(d.no), ddMonyyyy(d.date), invVal, posLabel(pos), '', rt, r2(byRate[rt].txval), r2(byRate[rt].cess), d.etin || '']));
        } else {                             // Table 7
          taxedRates.forEach(rt => {
            const k = [inter ? 'INTER' : 'INTRA', pos, rt, d.etin || ''].join('|');
            if (!b2cs[k]) b2cs[k] = { sply_ty: inter ? 'INTER' : 'INTRA', pos, rt, txval: 0, csamt: 0, etin: d.etin || '' };
            b2cs[k].txval += byRate[rt].txval; b2cs[k].csamt += byRate[rt].cess;
          });
        }
      }
      // Table 12 — HSN summary, split by buyer type
      items.forEach(it => {
        const hsn = String(it.hsn || '').replace(/\s/g, ''), rt = Number(it.rate) || 0, uqc = uqcCode(it.unit);
        const map = registered ? hsnB2B : hsnB2C, k = [hsn, uqc, rt].join('|');
        if (!map[k]) map[k] = { hsn_sc: hsn, desc: String(it.desc || '').slice(0, 30), uqc, qty: 0, rt, txval: 0, iamt: 0, camt: 0, samt: 0, csamt: 0, val: 0 };
        const t = taxSplit(Number(it.taxable) || 0, rt, inter);
        const h = map[k];
        h.qty += /^99/.test(hsn) ? 0 : (Number(it.qty) || 0);
        h.txval += Number(it.taxable) || 0; h.iamt += t.iamt; h.camt += t.camt; h.samt += t.samt; h.csamt += Number(it.cess) || 0;
        h.val += (Number(it.taxable) || 0) + t.iamt + t.camt + t.samt + (Number(it.cess) || 0);
      });
      // Table 14 — supplies through an e-commerce operator collecting TCS (u/s 52)
      if (d.etin) {
        if (!eco[d.etin]) eco[d.etin] = { etin: d.etin, suppval: 0, igst: 0, cgst: 0, sgst: 0, cess: 0 };
        items.forEach(it => {
          const t = taxSplit(Number(it.taxable) || 0, Number(it.rate) || 0, inter);
          eco[d.etin].suppval += Number(it.taxable) || 0; eco[d.etin].igst += t.iamt; eco[d.etin].cgst += t.camt; eco[d.etin].sgst += t.samt; eco[d.etin].cess += Number(it.cess) || 0;
        });
      }
    });

    // ---------- assemble JSON ----------
    // Lines that net to zero (a sale fully returned in the same period) are left out.
    const b2csArr = Object.values(b2cs).filter(x => r2(x.txval) !== 0).map(x => {
      const t = taxSplit(x.txval, x.rt, x.sply_ty === 'INTER');
      rows.b2cs.push([x.etin ? 'E' : 'OE', posLabel(x.pos), '', x.rt, r2(x.txval), r2(x.csamt), x.etin]);
      return Object.assign({ sply_ty: x.sply_ty, pos: x.pos, typ: x.etin ? 'E' : 'OE' }, x.etin ? { etin: x.etin } : {},
        { txval: r2(x.txval), rt: x.rt }, x.sply_ty === 'INTER' ? { iamt: t.iamt } : { camt: t.camt, samt: t.samt }, { csamt: r2(x.csamt) });
    });
    const hsnOut = (map, sheetRows) => Object.values(map).filter(h => r2(h.txval) !== 0 || r2(h.qty) !== 0).map((h, i) => {
      sheetRows.push([h.hsn_sc, h.desc, h.uqc + '-' + UQC[h.uqc], r2(h.qty), r2(h.val), h.rt, r2(h.txval), r2(h.iamt), r2(h.camt), r2(h.samt), r2(h.csamt)]);
      return { hsn_sc: h.hsn_sc, num: i + 1, desc: h.desc, uqc: h.uqc, qty: r2(h.qty), rt: h.rt, txval: r2(h.txval), iamt: r2(h.iamt), camt: r2(h.camt), samt: r2(h.samt), csamt: r2(h.csamt) };
    });
    const hsn_b2b = hsnOut(hsnB2B, rows.hsnB2B), hsn_b2c = hsnOut(hsnB2C, rows.hsnB2C);
    const series = docSeries(allDocs);
    series.forEach(s => rows.docs.push([DOC_NATURE[1], s.from, s.to, s.totnum, s.cancel]));
    const nilKeys = ['INTRB2B', 'INTRAB2B', 'INTRB2C', 'INTRAB2C'];
    const nilLabels = { INTRB2B: 'Inter-State supplies to registered persons', INTRAB2B: 'Intra-State supplies to registered persons',
      INTRB2C: 'Inter-State supplies to unregistered persons', INTRAB2C: 'Intra-State supplies to unregistered persons' };
    nilKeys.forEach(k => rows.exemp.push([nilLabels[k], r2(nil[k] || 0), 0, 0]));

    const json = { gstin: String(opts.gstin || '').trim().toUpperCase(), fp: fpOf(opts.period), version: 'GST3.2.3', hash: 'hash' };
    const b2bArr = Object.keys(b2bByCtin).map(ctin => ({ ctin, inv: b2bByCtin[ctin] }));
    if (b2bArr.length) json.b2b = b2bArr;
    const b2clArr = Object.keys(b2clByPos).map(pos => ({ pos, inv: b2clByPos[pos] }));
    if (b2clArr.length) json.b2cl = b2clArr;
    if (b2csArr.length) json.b2cs = b2csArr;
    if (Object.keys(nil).length) json.nil = { inv: nilKeys.filter(k => nil[k]).map(k => ({ sply_ty: k, expt_amt: 0, nil_amt: r2(nil[k]), ngsup_amt: 0 })) };
    json.hsn = { hsn_b2b };
    if (hsn_b2c.length) json.hsn.hsn_b2c = hsn_b2c;
    json.doc_issue = { doc_det: series.length ? [{ doc_num: 1, docs: series.map((s, i) => Object.assign({ num: i + 1 }, s)) }] : [] };
    const ecoArr = Object.values(eco).filter(e => e.suppval);
    if (ecoArr.length) json.supeco = { clttx: ecoArr.map(e => ({ etin: e.etin, suppval: r2(e.suppval), igst: r2(e.igst), cgst: r2(e.cgst), sgst: r2(e.sgst), cess: r2(e.cess) })) };

    Object.keys(tot).forEach(k => { if (k !== 'invoices') tot[k] = r2(tot[k]); });
    return {
      json, rows, totals: tot,
      counts: { b2b: sum(b2bArr, x => x.inv.length), b2cl: sum(b2clArr, x => x.inv.length), b2cs: b2csArr.length, hsnB2B: hsn_b2b.length, hsnB2C: hsn_b2c.length, docs: series.length, eco: ecoArr.length },
      issues: validate(allDocs, opts)
    };
  }

  /* Offline-tool style workbook: summary block in rows 1-3, headers in row 4. */
  function sheetWithSummary(XLSX, title, summaryHeads, summaryVals, headers, data) {
    const pad = a => { const r = a.slice(); while (r.length < headers.length) r.push(''); return r; };
    return XLSX.utils.aoa_to_sheet([pad([title]), pad(summaryHeads), pad(summaryVals), headers].concat(data));
  }
  function gstr1Workbook(XLSX, res) {
    const wb = XLSX.utils.book_new(), R = res.rows;
    const colSum = (rows, i) => r2(sum(rows, r => r[i]));
    const uniq = (rows, i) => new Set(rows.map(r => r[i])).size;
    XLSX.utils.book_append_sheet(wb, sheetWithSummary(XLSX, 'Summary For B2B, SEZ, DE (4A, 4B, 6B, 6C)',
      ['No. of Recipients', '', 'No. of Invoices', '', 'Total Invoice Value', '', '', '', '', '', '', 'Total Taxable Value', 'Total Cess'],
      [uniq(R.b2b, 0), '', uniq(R.b2b, 2), '', r2(sum([...new Map(R.b2b.map(r => [r[2], r[4]])).values()], v => v)), '', '', '', '', '', '', colSum(R.b2b, 11), colSum(R.b2b, 12)],
      ['GSTIN/UIN of Recipient', 'Receiver Name', 'Invoice Number', 'Invoice date', 'Invoice Value', 'Place Of Supply', 'Reverse Charge', 'Applicable % of Tax Rate', 'Invoice Type', 'E-Commerce GSTIN', 'Rate', 'Taxable Value', 'Cess Amount'], R.b2b), 'b2b,sez,de');
    XLSX.utils.book_append_sheet(wb, sheetWithSummary(XLSX, 'Summary For B2CL(5)',
      ['No. of Invoices', '', 'Total Inv Value', '', '', '', 'Total Taxable Value', 'Total Cess', ''],
      [uniq(R.b2cl, 0), '', r2(sum([...new Map(R.b2cl.map(r => [r[0], r[2]])).values()], v => v)), '', '', '', colSum(R.b2cl, 6), colSum(R.b2cl, 7), ''],
      ['Invoice Number', 'Invoice date', 'Invoice Value', 'Place Of Supply', 'Applicable % of Tax Rate', 'Rate', 'Taxable Value', 'Cess Amount', 'E-Commerce GSTIN'], R.b2cl), 'b2cl');
    if (R.cdnr && R.cdnr.length) XLSX.utils.book_append_sheet(wb, sheetWithSummary(XLSX, 'Summary For CDNR(9B)',
      ['No. of Recipients', '', 'No. of Notes', '', '', '', '', '', 'Total Note Value', '', '', 'Total Taxable Value', 'Total Cess'],
      [uniq(R.cdnr, 0), '', uniq(R.cdnr, 2), '', '', '', '', '', r2(sum([...new Map(R.cdnr.map(r => [r[2], r[8]])).values()], v => v)), '', '', colSum(R.cdnr, 11), colSum(R.cdnr, 12)],
      ['GSTIN/UIN of Recipient', 'Receiver Name', 'Note Number', 'Note Date', 'Note Type', 'Place Of Supply', 'Reverse Charge', 'Note Supply Type', 'Note Value', 'Applicable % of Tax Rate', 'Rate', 'Taxable Value', 'Cess Amount'], R.cdnr), 'cdnr');
    if (R.cdnur && R.cdnur.length) XLSX.utils.book_append_sheet(wb, sheetWithSummary(XLSX, 'Summary For CDNUR(9B)',
      ['', 'No. of Notes', '', '', '', 'Total Note Value', '', '', 'Total Taxable Value', 'Total Cess'], ['', uniq(R.cdnur, 1), '', '', '', colSum(R.cdnur, 5), '', '', colSum(R.cdnur, 8), colSum(R.cdnur, 9)],
      ['UR Type', 'Note Number', 'Note Date', 'Note Type', 'Place Of Supply', 'Note Value', 'Applicable % of Tax Rate', 'Rate', 'Taxable Value', 'Cess Amount'], R.cdnur), 'cdnur');
    XLSX.utils.book_append_sheet(wb, sheetWithSummary(XLSX, 'Summary For B2CS(7)',
      ['', '', '', '', 'Total Taxable Value', 'Total Cess', ''], ['', '', '', '', colSum(R.b2cs, 4), colSum(R.b2cs, 5), ''],
      ['Type', 'Place Of Supply', 'Applicable % of Tax Rate', 'Rate', 'Taxable Value', 'Cess Amount', 'E-Commerce GSTIN'], R.b2cs), 'b2cs');
    const hsnHead = ['HSN', 'Description', 'UQC', 'Total Quantity', 'Total Value', 'Rate', 'Taxable Value', 'Integrated Tax Amount', 'Central Tax Amount', 'State/UT Tax Amount', 'Cess Amount'];
    [['hsn(b2b)', R.hsnB2B, 'Summary For HSN(12) - B2B'], ['hsn(b2c)', R.hsnB2C, 'Summary For HSN(12) - B2C']].forEach(([name, rows, title]) =>
      XLSX.utils.book_append_sheet(wb, sheetWithSummary(XLSX, title,
        ['No. of HSN', '', '', '', 'Total Value', '', 'Total Taxable Value', 'Total Integrated Tax', 'Total Central Tax', 'Total State/UT Tax', 'Total Cess'],
        [rows.length, '', '', '', colSum(rows, 4), '', colSum(rows, 6), colSum(rows, 7), colSum(rows, 8), colSum(rows, 9), colSum(rows, 10)], hsnHead, rows), name));
    XLSX.utils.book_append_sheet(wb, sheetWithSummary(XLSX, 'Summary of documents issued during the tax period (13)',
      ['', '', '', 'Total Number', 'Total Cancelled'], ['', '', '', sum(R.docs, r => r[3]), sum(R.docs, r => r[4])],
      ['Nature of Document', 'Sr. No. From', 'Sr. No. To', 'Total Number', 'Cancelled'], R.docs), 'docs');
    XLSX.utils.book_append_sheet(wb, sheetWithSummary(XLSX, 'Summary For Nil rated, exempted and non GST outward supplies (8)',
      ['', 'Total Nil Rated Supplies', 'Total Exempted Supplies', 'Total Non-GST Supplies'], ['', colSum(R.exemp, 1), 0, 0],
      ['Description', 'Nil Rated Supplies', 'Exempted(other than nil rated/non GST supply)', 'Non-GST Supplies'], R.exemp), 'exemp');
    if (res.issues && res.issues.length) {
      XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['Level', 'Problem', 'Where']].concat(res.issues.map(i => [i.level.toUpperCase(), i.msg, i.ref]))), 'CHECK-BEFORE-FILING');
    }
    return wb;
  }

  /* ======================= GSTR-3B ======================= */
  // purchases: [{ date, gstin (supplier), inter, rchrg, items:[{rate, taxable, cess}], itcEligible:true }]
  function buildGstr3b(salesDocs, purchases, opts) {
    const docs = salesDocs.filter(d => !d.cancelled);
    const z = () => ({ txval: 0, iamt: 0, camt: 0, samt: 0, csamt: 0 });
    const osup = z(), nilExmp = { txval: 0 }, rcm = z(), unreg = {};
    docs.forEach(d => (d.items || []).forEach(it => {
      const rt = Number(it.rate) || 0, tx = Number(it.taxable) || 0;
      if (!rt) { nilExmp.txval += tx; return; }
      const t = taxSplit(tx, rt, !!d.inter), bucket = d.rchrg ? null : osup;
      if (bucket) { bucket.txval += tx; bucket.iamt += t.iamt; bucket.camt += t.camt; bucket.samt += t.samt; bucket.csamt += Number(it.cess) || 0; }
      if (d.inter && !d.ctin) {           // 3.2 inter-state supplies to unregistered persons
        const p = String(d.pos).padStart(2, '0');
        if (!unreg[p]) unreg[p] = { pos: p, txval: 0, iamt: 0 };
        unreg[p].txval += tx; unreg[p].iamt += t.iamt;
      }
    }));
    const itc = z(), inelig = z(), inwardExempt = { inter: 0, intra: 0 };
    let itcCount = 0, noItcCount = 0;
    (purchases || []).forEach(p => (p.items || []).forEach(it => {
      const rt = Number(it.rate) || 0, tx = Number(it.taxable) || 0;
      if (!rt) { inwardExempt[p.inter ? 'inter' : 'intra'] += tx; return; }
      const t = taxSplit(tx, rt, !!p.inter);
      const target = (p.gstin && p.itcEligible !== false) ? itc : inelig;
      if (target === itc) itcCount++; else noItcCount++;
      target.iamt += t.iamt; target.camt += t.camt; target.samt += t.samt; target.csamt += Number(it.cess) || 0;
      if (p.rchrg) { rcm.txval += tx; rcm.iamt += t.iamt; rcm.camt += t.camt; rcm.samt += t.samt; }
    }));
    const R = o => { const x = {}; Object.keys(o).forEach(k => { x[k] = typeof o[k] === 'number' ? r2(o[k]) : o[k]; }); return x; };
    const tax = o => ({ iamt: r2(o.iamt), camt: r2(o.camt), samt: r2(o.samt), csamt: r2(o.csamt) });
    const json = {
      gstin: String(opts.gstin || '').trim().toUpperCase(),
      ret_period: fpOf(opts.period),
      sup_details: {
        osup_det: R(osup),
        osup_zero: { txval: 0, iamt: 0, csamt: 0 },
        osup_nil_exmp: { txval: r2(nilExmp.txval) },
        isup_rev: R(rcm),
        osup_nongst: { txval: 0 }
      },
      inter_sup: {
        unreg_details: Object.values(unreg).map(u => ({ pos: u.pos, txval: r2(u.txval), iamt: r2(u.iamt) })),
        comp_details: [], uin_details: []
      },
      itc_elg: {
        itc_avl: [
          Object.assign({ ty: 'IMPG' }, tax(z())), Object.assign({ ty: 'IMPS' }, tax(z())),
          Object.assign({ ty: 'ISRC' }, tax(rcm)), Object.assign({ ty: 'ISD' }, tax(z())),
          Object.assign({ ty: 'OTH' }, tax({ iamt: itc.iamt - rcm.iamt, camt: itc.camt - rcm.camt, samt: itc.samt - rcm.samt, csamt: itc.csamt }))
        ],
        itc_rev: [Object.assign({ ty: 'RUL' }, tax(z())), Object.assign({ ty: 'OTH' }, tax(z()))],
        itc_net: tax(itc),
        itc_inelg: [Object.assign({ ty: 'RUL' }, tax(z())), Object.assign({ ty: 'OTH' }, tax(inelig))]
      },
      inward_sup: { isup_details: [{ ty: 'GST', inter: r2(inwardExempt.inter), intra: r2(inwardExempt.intra) }, { ty: 'NONGST', inter: 0, intra: 0 }] }
    };
    const liability = { igst: r2(osup.iamt + rcm.iamt), cgst: r2(osup.camt + rcm.camt), sgst: r2(osup.samt + rcm.samt), cess: r2(osup.csamt) };
    const credit = { igst: r2(itc.iamt), cgst: r2(itc.camt), sgst: r2(itc.samt), cess: r2(itc.csamt) };
    return { json, liability, credit, itcCount, noItcCount, inelig: tax(inelig), unregCount: Object.keys(unreg).length };
  }
  function gstr3bWorkbook(XLSX, res, opts) {
    const j = res.json, s = j.sup_details, e = j.itc_elg;
    const row = (label, o) => [label, o.txval != null ? o.txval : '', o.iamt || 0, o.camt || 0, o.samt || 0, o.csamt || 0];
    const aoa = [
      [`GSTR-3B summary — GSTIN ${j.gstin} — period ${opts.periodLabel || j.ret_period}`], [],
      ['3.1 Outward and reverse-charge inward supplies', 'Taxable value', 'Integrated tax', 'Central tax', 'State/UT tax', 'Cess'],
      row('(a) Outward taxable supplies (other than zero/nil rated, exempted)', s.osup_det),
      row('(b) Outward taxable supplies (zero rated)', s.osup_zero),
      row('(c) Other outward supplies (nil rated, exempted)', s.osup_nil_exmp),
      row('(d) Inward supplies (liable to reverse charge)', s.isup_rev),
      row('(e) Non-GST outward supplies', s.osup_nongst), [],
      ['3.2 Inter-state supplies to unregistered persons', 'Place of supply', 'Taxable value', 'Integrated tax'],
      ...j.inter_sup.unreg_details.map(u => ['', `${u.pos}-${stateName(u.pos)}`, u.txval, u.iamt]), [],
      ['4. Eligible ITC', '', 'Integrated tax', 'Central tax', 'State/UT tax', 'Cess'],
      ...e.itc_avl.map(x => [{ IMPG: '(A)(1) Import of goods', IMPS: '(A)(2) Import of services', ISRC: '(A)(3) Inward supplies liable to reverse charge', ISD: '(A)(4) Inward supplies from ISD', OTH: '(A)(5) All other ITC' }[x.ty], '', x.iamt, x.camt, x.samt, x.csamt]),
      ['(C) Net ITC available', '', e.itc_net.iamt, e.itc_net.camt, e.itc_net.samt, e.itc_net.csamt],
      ['(D)(2) Ineligible ITC — others (purchases without supplier GSTIN)', '', e.itc_inelg[1].iamt, e.itc_inelg[1].camt, e.itc_inelg[1].samt, e.itc_inelg[1].csamt], [],
      ['5. Exempt, nil-rated and non-GST inward supplies', '', 'Inter-state', 'Intra-state'],
      ['From a supplier under composition / exempt / nil rated', '', j.inward_sup.isup_details[0].inter, j.inward_sup.isup_details[0].intra], [],
      ['Tax payable (liability − ITC, before cash/credit set-off)', '', 'Integrated tax', 'Central tax', 'State/UT tax', 'Cess'],
      ['Liability', '', res.liability.igst, res.liability.cgst, res.liability.sgst, res.liability.cess],
      ['ITC available', '', res.credit.igst, res.credit.cgst, res.credit.sgst, res.credit.cess],
      ['Approx. net payable (IGST credit used first as per rules)', '', ...netPayable(res)], [],
      ['Note: ITC shown is from your purchase entries. Claim only ITC that appears in your GSTR-2B — use the GSTR-2B Reconciliation to check.']
    ];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), 'GSTR-3B');
    return wb;
  }
  // Rule 88A order: IGST credit → IGST, then CGST, then SGST; CGST credit → CGST then IGST; SGST → SGST then IGST.
  function netPayable(res) {
    let L = Object.assign({}, res.liability), C = Object.assign({}, res.credit);
    const use = (from, to) => { const u = Math.min(C[from], L[to]); C[from] -= u; L[to] -= u; };
    use('igst', 'igst'); use('igst', 'cgst'); use('igst', 'sgst');
    use('cgst', 'cgst'); use('cgst', 'igst');
    use('sgst', 'sgst'); use('sgst', 'igst');
    const cess = Math.max(0, L.cess - C.cess);
    return [r2(L.igst), r2(L.cgst), r2(L.sgst), r2(cess)];
  }

  /* ======================= GSTR-2B reconciliation ======================= */
  // "TC/0045", "tc-45" and "TC45" are the same invoice: drop separators and leading zeros in every number.
  const normInv = s => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '').replace(/\d+/g, m => String(parseInt(m, 10)));
  function iso(dt) {
    const s = String(dt || '').trim();
    let m = s.match(/^(\d{2})[-\/](\d{2})[-\/](\d{4})$/); if (m) return `${m[3]}-${m[2]}-${m[1]}`;
    m = s.match(/^(\d{2})-([A-Za-z]{3})-(\d{4})$/); if (m) return `${m[3]}-${String(MON.indexOf(m[2][0].toUpperCase() + m[2].slice(1, 3).toLowerCase()) + 1).padStart(2, '0')}-${m[1]}`;
    if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
    return s;
  }
  // GSTR-2B JSON as downloaded from the portal → flat list
  function parse2bJson(obj) {
    const d = (obj && obj.data) || obj || {};
    const docdata = d.docdata || d;
    const out = [];
    (docdata.b2b || []).forEach(s => (s.inv || []).forEach(inv => out.push({
      ctin: String(s.ctin || '').toUpperCase(), name: s.trdnm || '', no: inv.inum, date: iso(inv.dt), value: +inv.val || 0,
      taxable: +inv.txval || 0, igst: +inv.igst || 0, cgst: +inv.cgst || 0, sgst: +inv.sgst || 0, cess: +inv.cess || 0,
      rchrg: inv.rev === 'Y', itcAvailable: inv.itcavl !== 'N', type: 'Invoice', period: s.supprd || ''
    })));
    (docdata.cdnr || []).forEach(s => (s.nt || []).forEach(nt => {
      const sign = nt.typ === 'C' ? -1 : 1;
      out.push({ ctin: String(s.ctin || '').toUpperCase(), name: s.trdnm || '', no: nt.ntnum, date: iso(nt.dt), value: sign * (+nt.val || 0),
        taxable: sign * (+nt.txval || 0), igst: sign * (+nt.igst || 0), cgst: sign * (+nt.cgst || 0), sgst: sign * (+nt.sgst || 0), cess: sign * (+nt.cess || 0),
        rchrg: nt.rev === 'Y', itcAvailable: nt.itcavl !== 'N', type: nt.typ === 'C' ? 'Credit note' : 'Debit note', period: s.supprd || '' });
    }));
    return out;
  }
  // GSTR-2B Excel (B2B sheet) → flat list. Finds the header row by its labels.
  function parse2bWorkbook(XLSX, wb) {
    const name = wb.SheetNames.find(n => /^b2b$/i.test(n.trim())) || wb.SheetNames.find(n => /b2b/i.test(n) && !/cdn|amend|isd/i.test(n));
    if (!name) return [];
    const rows = XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, defval: '' });
    const has = (r, re) => (r || []).some(c => re.test(String(c)));
    const hi = rows.findIndex((r, i) => has(r, /gstin of supplier/i) && (has(r, /invoice number/i) || has(rows[i + 1], /invoice number/i)));
    if (hi < 0) return [];
    // headers may span two rows (e.g. "Invoice details" over "Invoice number")
    const heads = rows[hi].map((c, i) => (String(c) + ' ' + String((rows[hi + 1] || [])[i] || '')).trim().toLowerCase());
    const col = re => heads.findIndex(h => re.test(h));
    const c = { ctin: col(/gstin of supplier/), name: col(/trade|legal name/), no: col(/invoice number/), date: col(/invoice date/),
      value: col(/invoice value/), taxable: col(/taxable value/), igst: col(/integrated tax/), cgst: col(/central tax/),
      sgst: col(/state\/?ut tax/), cess: col(/cess/), rchrg: col(/reverse charge/), itc: col(/itc availability/) };
    const start = /invoice number/i.test(String((rows[hi + 1] || []).join(' '))) ? hi + 2 : hi + 1;
    return rows.slice(start).filter(r => r[c.ctin] && r[c.no]).map(r => ({
      ctin: String(r[c.ctin]).trim().toUpperCase(), name: c.name >= 0 ? r[c.name] : '', no: String(r[c.no]).trim(),
      date: iso(r[c.date]), value: +r[c.value] || 0, taxable: +r[c.taxable] || 0, igst: +r[c.igst] || 0, cgst: +r[c.cgst] || 0,
      sgst: +r[c.sgst] || 0, cess: c.cess >= 0 ? (+r[c.cess] || 0) : 0, rchrg: /^y/i.test(String(r[c.rchrg] || '')),
      itcAvailable: c.itc < 0 || !/^n/i.test(String(r[c.itc] || '')), type: 'Invoice'
    }));
  }
  // books: [{ id, ctin, name, no, date, taxable, tax }]
  function reconcile(books, twoB, tolerance) {
    tolerance = tolerance == null ? 1 : tolerance;
    const res = [], used = new Set();
    const tax2b = x => r2(x.igst + x.cgst + x.sgst);
    books.forEach(b => {
      const ctin = String(b.ctin || '').toUpperCase();
      let idx = twoB.findIndex((x, i) => !used.has(i) && x.ctin === ctin && b.no && normInv(x.no) === normInv(b.no));
      let how = 'invoice no.';
      if (idx < 0 && ctin) {            // fallback: same supplier, same taxable value, within 7 days
        idx = twoB.findIndex((x, i) => !used.has(i) && x.ctin === ctin && Math.abs(x.taxable - b.taxable) <= tolerance &&
          Math.abs(new Date(x.date) - new Date(b.date)) <= 7 * 864e5);
        how = 'amount + date';
      }
      if (idx < 0) { res.push({ status: ctin ? 'missing-in-2b' : 'no-gstin', book: b, twoB: null }); return; }
      used.add(idx);
      const x = twoB[idx];
      const diff = r2(Math.abs(x.taxable - b.taxable)) > tolerance || r2(Math.abs(tax2b(x) - b.tax)) > tolerance;
      res.push({ status: diff ? 'mismatch' : 'matched', how, book: b, twoB: x });
    });
    twoB.forEach((x, i) => { if (!used.has(i)) res.push({ status: 'missing-in-books', book: null, twoB: x }); });
    const summary = { matched: 0, mismatch: 0, 'missing-in-2b': 0, 'missing-in-books': 0, 'no-gstin': 0, itcClaimable: 0 };
    res.forEach(r => { summary[r.status]++; if ((r.status === 'matched' || r.status === 'mismatch') && r.twoB.itcAvailable) summary.itcClaimable += tax2b(r.twoB); });
    summary.itcClaimable = r2(summary.itcClaimable);
    return { rows: res, summary };
  }

  /* ======================= Amazon "GST Ready-to-File" report =======================
     Amazon now gives ONE Excel per period (no CSVs) laid out like the GSTN
     offline template: sheets B2B · B2B CN (cdnr) · B2CL CN (cdnur) · B2C Large ·
     B2C Small (already summed per state, net of credit notes) · HSN Summary.
     parseReadyWorkbook() reads it; mergeReadyReport() adds it to a GSTR-1
     built from the other sources (Flipkart / Meesho / Billing). */
  function isReadyWorkbook(wb) {
    const names = wb.SheetNames.map(n => n.toLowerCase());
    return names.includes('b2c small') && names.some(n => n.startsWith('hsn')) && names.includes('b2b');
  }
  function parseReadyWorkbook(XLSX, wb, fileName) {
    const num = v => { const n = parseFloat(String(v == null ? '' : v).replace(/[₹,\s]/g, '')); return isFinite(n) ? n : 0; };
    const posOf = v => { const m = String(v || '').match(/^\s*(\d{1,2})/); return m ? m[1].padStart(2, '0') : ''; };
    const dateOf = v => {
      if (typeof v === 'number') return new Date(Math.round((v - 25569) * 864e5)).toISOString().slice(0, 10);
      const s = String(v || '').trim();
      let m = s.match(/^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/);
      if (m) return `${m[3]}-${String(MON.findIndex(x => x.toLowerCase() === m[2].toLowerCase()) + 1).padStart(2, '0')}-${m[1].padStart(2, '0')}`;
      m = s.match(/^(\d{1,2})[\/-](\d{1,2})[\/-](\d{4})$/);
      if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
      return s.slice(0, 10);
    };
    const sheet = name => {
      const sn = wb.SheetNames.find(n => n.toLowerCase().trim() === name);
      if (!sn) return [];
      const rows = XLSX.utils.sheet_to_json(fixSheetRange(XLSX, wb.Sheets[sn]), { header: 1, defval: '' });
      const hi = rows.findIndex((r, i) => i >= 2 && r.filter(c => String(c).trim()).length >= 3 && /[a-z]/i.test(String(r[0] || r[1])) && !/^summary/i.test(String(r[0])) && !/^no\. of/i.test(String(r[0] || r[1])));
      return hi < 0 ? [] : rows.slice(hi + 1).filter(r => r.some(c => String(c).trim() !== ''));
    };
    let gstin = '';
    const g = wb.SheetNames.find(n => n.toLowerCase() === 'gstin');
    if (g) { const rows = XLSX.utils.sheet_to_json(wb.Sheets[g], { header: 1, defval: '' }); const hit = rows.flat().find(c => GSTIN_RE.test(String(c).trim())); gstin = hit ? String(hit).trim() : ''; }
    const r = {
      gstin, fileName: fileName || '',
      b2b: sheet('b2b').map(c => ({ ctin: String(c[0]).trim().toUpperCase(), name: c[1], inum: String(c[2]).trim(), idt: dateOf(c[3]), val: num(c[4]), pos: posOf(c[5]), rchrg: String(c[6]).toUpperCase() === 'Y', etin: String(c[9] || '').trim(), rt: num(c[10]), txval: num(c[11]), cess: num(c[12]) })).filter(x => x.ctin && x.inum),
      cdnr: sheet('b2b cn (cdnr)').map(c => ({ ctin: String(c[0]).trim().toUpperCase(), name: c[1], ntnum: String(c[2]).trim(), ntdt: dateOf(c[3]), ntty: String(c[4]).trim().toUpperCase() === 'D' ? 'D' : 'C', pos: posOf(c[5]), rchrg: String(c[6]).toUpperCase() === 'Y', val: num(c[8]), rt: num(c[10]), txval: num(c[11]), cess: num(c[12]), origInv: String(c[13] || ''), origDate: dateOf(c[14]), reason: String(c[15] || '') })).filter(x => x.ctin && x.ntnum),
      cdnur: sheet('b2cl cn (cdnur)').map(c => ({ typ: String(c[0]).trim() || 'B2CL', ntnum: String(c[1]).trim(), ntdt: dateOf(c[2]), ntty: String(c[3]).trim().toUpperCase() === 'D' ? 'D' : 'C', pos: posOf(c[4]), val: num(c[5]), rt: num(c[7]), txval: num(c[8]), cess: num(c[9]) })).filter(x => x.ntnum),
      b2cl: sheet('b2c large').map(c => ({ inum: String(c[0]).trim(), idt: dateOf(c[1]), val: num(c[2]), pos: posOf(c[3]), rt: num(c[5]), txval: num(c[6]), cess: num(c[7]), etin: String(c[8] || '').trim() })).filter(x => x.inum),
      b2cs: sheet('b2c small').map(c => ({ typ: String(c[0]).trim(), pos: posOf(c[1]), rt: num(c[3]), txval: num(c[4]), cess: num(c[5]), etin: String(c[6] || '').trim() })).filter(x => x.pos),
      hsn: sheet(wb.SheetNames.find(n => /^hsn/i.test(n)).toLowerCase().trim()).map(c => ({ hsn: String(c[0]).trim(), desc: String(c[1] || ''), uqc: String(c[2] || 'OTH').trim().toUpperCase().split('-')[0], qty: num(c[3]), rt: num(c[4]), val: num(c[5]), txval: num(c[6]), iamt: num(c[7]), camt: num(c[8]), samt: num(c[9]), cess: num(c[10]) })).filter(x => x.hsn)
    };
    // period: from the file name ("…JULY-SEPTEMBER-2026…") or the latest date in it
    const MONTHS = ['JANUARY','FEBRUARY','MARCH','APRIL','MAY','JUNE','JULY','AUGUST','SEPTEMBER','OCTOBER','NOVEMBER','DECEMBER'];
    const fm = String(fileName || '').toUpperCase().match(/([A-Z]+)-(?:([A-Z]+)-)?(\d{4})/);
    if (fm && MONTHS.includes(fm[1])) {
      const last = MONTHS.indexOf(fm[2] && MONTHS.includes(fm[2]) ? fm[2] : fm[1]) + 1;
      r.period = `${fm[3]}-${String(last).padStart(2, '0')}`;
      r.periodFirst = `${fm[3]}-${String(MONTHS.indexOf(fm[1]) + 1).padStart(2, '0')}`;
    } else {
      const dates = [...r.b2b.map(x => x.idt), ...r.cdnr.map(x => x.ntdt), ...r.b2cl.map(x => x.idt)].filter(Boolean).sort();
      r.period = dates.length ? dates[dates.length - 1].slice(0, 7) : '';
    }
    return r;
  }

  /* ======================= Flipkart "Report for GSTR-1 and GSTR-8" =======================
     Sheets named by GSTR-1 section: 5B (B2CL) · 7(A)(2) (intra-state B2C,
     net of returns) · 7(B)(2) (inter-state B2C per state, ISO codes like
     IN-KA) · 13 (invoice series) · 12 (HSN) · GSTR-8 section 3 (Flipkart's
     GSTIN + net value, i.e. Table 14) · 10A/10B (amendments). Parsed into the
     same shape as the Amazon report so mergeReadyReport() handles both. */
  const ISO_TO_GST = { JK:'01', HP:'02', PB:'03', CH:'04', UT:'05', UK:'05', HR:'06', DL:'07', RJ:'08', UP:'09', BR:'10', SK:'11', AR:'12', NL:'13',
    MN:'14', MZ:'15', TR:'16', ML:'17', AS:'18', WB:'19', JH:'20', OR:'21', OD:'21', CT:'22', CG:'22', MP:'23', GJ:'24', DN:'26', DD:'26', DH:'26',
    MH:'27', KA:'29', GA:'30', LD:'31', KL:'32', TN:'33', PY:'34', AN:'35', TS:'36', TG:'36', AP:'37', LA:'38' };
  function stateCodeOf(code, name) {
    const iso = String(code || '').toUpperCase().replace(/^IN-/, '').trim();
    if (ISO_TO_GST[iso]) return ISO_TO_GST[iso];
    if (/^\d{1,2}$/.test(iso)) return iso.padStart(2, '0');
    const n = String(name || '').toLowerCase().replace(/[^a-z]/g, '');
    const hit = Object.keys(STATES).find(k => STATES[k].toLowerCase().replace(/[^a-z]/g, '') === n
      || (n === 'odisha' && k === '21') || (n === 'telangana' && k === '36') || (n === 'andhrapradesh' && k === '37'));
    return hit || '';
  }
  /* Some marketplace files declare a wrong sheet size (Flipkart's say "A1:N1"
     even with data below), and SheetJS only reads the declared range —
     re-measure each sheet from the cells actually present. */
  function fixSheetRange(XLSX, ws) {
    if (!ws) return ws;
    let maxR = 0, maxC = 0, any = false;
    Object.keys(ws).forEach(k => {
      if (k[0] === '!') return;
      const a = XLSX.utils.decode_cell(k);
      if (a.r > maxR) maxR = a.r; if (a.c > maxC) maxC = a.c; any = true;
    });
    if (any) ws['!ref'] = XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: maxR, c: maxC } });
    return ws;
  }
  function isFlipkartGstWorkbook(wb) {
    const names = wb.SheetNames.map(n => n.toLowerCase());
    return names.some(n => n.startsWith('section 7(b)(2)')) && names.some(n => n.startsWith('section 12'));
  }
  function parseFlipkartGstWorkbook(XLSX, wb, fileName) {
    const num = v => { const n = parseFloat(String(v == null ? '' : v).replace(/[₹,\s]/g, '')); return isFinite(n) ? n : 0; };
    const rowsOf = prefix => {
      const sn = wb.SheetNames.find(n => n.toLowerCase().startsWith(prefix));
      if (!sn) return [];
      return XLSX.utils.sheet_to_json(fixSheetRange(XLSX, wb.Sheets[sn]), { header: 1, defval: '' }).slice(1).filter(r => r.some(c => String(c).trim() !== ''));
    };
    const dateOf = v => {
      if (typeof v === 'number') return new Date(Math.round((v - 25569) * 864e5)).toISOString().slice(0, 10);
      const s = String(v || '').trim(); let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/); if (m) return m[0];
      m = s.match(/^(\d{1,2})[\/-](\d{1,2})[\/-](\d{4})/); return m ? `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}` : s;
    };
    const gstr8 = rowsOf('section 3 in gstr-8');
    const etin = gstr8.length ? String(gstr8[0][2] || '').trim().toUpperCase() : '';
    const gstin = String((gstr8[0] || rowsOf('section 12')[0] || rowsOf('section 7(b)(2)')[0] || [''])[0] || '').trim().toUpperCase();
    const r = { source: 'Flipkart', fileName: fileName || '', gstin, period: '', b2b: [], cdnr: [], cdnur: [], b2cl: [], b2cs: [], hsn: [], docs: [], amendments: 0 };
    // 5B — B2C Large (inter-state, per invoice)
    rowsOf('section 5b').forEach(c => r.b2cl.push({ inum: String(c[2]).trim(), idt: dateOf(c[3]), val: num(c[4]), pos: stateCodeOf('', c[1]), rt: num(c[5]), txval: num(c[6]), cess: num(c[9]), etin, tax: { iamt: r2(num(c[7])), camt: 0, samt: 0 } }));
    // 7(A)(2) — intra-state B2C (aggregate taxable is already net of returns); pos = own state
    rowsOf('section 7(a)(2)').forEach(c => r.b2cs.push({ typ: 'E', pos: String(gstin).slice(0, 2), rt: r2(num(c[4]) + num(c[6])), txval: r2(num(c[3])), cess: num(c[9]), etin, intra: true, tax: { iamt: 0, camt: r2(num(c[5])), samt: r2(num(c[7])) } }));
    // 7(B)(2) — inter-state B2C per delivered state
    rowsOf('section 7(b)(2)').forEach(c => r.b2cs.push({ typ: 'E', pos: stateCodeOf(c[9], c[8]), stateName: String(c[8] || ''), rt: num(c[4]), txval: r2(num(c[3])), cess: num(c[7]), etin, tax: { iamt: r2(num(c[5])), camt: 0, samt: 0 } }));
    // 12 — HSN (rate isn't given: worked out from tax ÷ taxable, snapped to a GST rate)
    rowsOf('section 12').forEach(c => {
      const txval = num(c[4]), tax = num(c[5]) + num(c[6]) + num(c[7]);
      const raw = txval ? tax / txval * 100 : 0;
      const rt = VALID_RATES.reduce((a, b) => Math.abs(b - raw) < Math.abs(a - raw) ? b : a, 0);
      r.hsn.push({ hsn: String(c[1]).trim(), desc: '', uqc: 'NOS', qty: num(c[2]), rt, rawRate: raw, val: num(c[3]), txval, iamt: num(c[5]), camt: num(c[6]), samt: num(c[7]), cess: num(c[8]) });
    });
    // 13 — documents issued
    rowsOf('section 13').forEach(c => { if (String(c[1]).trim()) r.docs.push({ from: String(c[1]).trim(), to: String(c[2]).trim(), totnum: num(c[3]), cancel: num(c[4]), net_issue: num(c[5]) }); });
    r.amendments = rowsOf('section 10a').length + rowsOf('section 10b').length;
    r.gstr8 = gstr8.length ? { etin, net: num(gstr8[0][5]), tcs: r2(num(gstr8[0][7]) + num(gstr8[0][8]) + num(gstr8[0][9])) } : null;
    return r;
  }

  // Add one or more parsed Amazon / Flipkart reports to a buildGstr1() result (in place).
  function mergeReadyReport(res, readyList, opts) {
    const J = res.json, R = res.rows, seller = String(opts.stateCode || '').padStart(2, '0');
    const iss = res.issues, warn = (m, ref) => iss.push({ level: 'warn', msg: m, ref: ref || '' });
    const itm = (rt, txval, cess, inter) => { const t = taxSplit(txval, rt, inter); return { num: itemNum(rt), itm_det: Object.assign({ txval: r2(txval), rt }, inter ? { iamt: t.iamt } : { camt: t.camt, samt: t.samt }, { csamt: r2(cess) }) }; };
    const eco = {};
    const addEco = (etin, txval, rt, inter, cess, sign, given) => {
      if (!etin) return;
      const t = given || taxSplit(txval, rt, inter); const e = eco[etin] = eco[etin] || { etin, suppval: 0, igst: 0, cgst: 0, sgst: 0, cess: 0 };
      e.suppval += sign * txval; e.igst += sign * t.iamt; e.cgst += sign * t.camt; e.sgst += sign * t.samt; e.cess += sign * cess;
    };
    readyList.forEach(rd => {
      const src = rd.source || 'Amazon';
      if (opts.gstin && rd.gstin && rd.gstin !== String(opts.gstin).toUpperCase()) warn(`${src} report "${rd.fileName}" is for GSTIN ${rd.gstin}, not ${opts.gstin}.`);
      rd.b2cs.filter(x => !x.pos).forEach(x => iss.push({ level: 'error', msg: `${src}: state "${x.stateName || '?'}" could not be matched to a GST state code.`, ref: rd.fileName }));
      // B2B — group rate lines into invoices
      const b2b = {};
      rd.b2b.forEach(x => {
        const k = x.ctin + '|' + x.inum;
        if (!b2b[k]) b2b[k] = { ctin: x.ctin, inv: { inum: x.inum.slice(0, 16), idt: ddmmyyyy(x.idt), val: r2(x.val), pos: x.pos, rchrg: x.rchrg ? 'Y' : 'N', inv_typ: 'R', itms: [] }, etin: x.etin };
        if (x.etin) b2b[k].inv.etin = x.etin;
        b2b[k].inv.itms.push(itm(x.rt, x.txval, x.cess, x.pos !== seller));
        R.b2b.push([x.ctin, x.name || '', x.inum, ddMonyyyy(x.idt), r2(x.val), posLabel(x.pos), x.rchrg ? 'Y' : 'N', '', 'Regular B2B', x.etin || '', x.rt, r2(x.txval), r2(x.cess)]);
        addEco(x.etin, x.txval, x.rt, x.pos !== seller, x.cess, 1);
        if (!gstinOk(x.ctin)) iss.push({ level: 'error', msg: `Buyer GSTIN "${x.ctin}" in Amazon's B2B sheet is not valid.`, ref: x.inum });
      });
      Object.values(b2b).forEach(({ ctin, inv }) => {
        J.b2b = J.b2b || []; let c = J.b2b.find(e => e.ctin === ctin);
        if (!c) J.b2b.push(c = { ctin, inv: [] });
        c.inv.push(inv);
      });
      // B2CL — by place of supply
      rd.b2cl.forEach(x => {
        J.b2cl = J.b2cl || []; let p = J.b2cl.find(e => e.pos === x.pos); if (!p) J.b2cl.push(p = { pos: x.pos, inv: [] });
        let inv = p.inv.find(i => i.inum === x.inum);
        if (!inv) p.inv.push(inv = Object.assign({ inum: x.inum.slice(0, 16), idt: ddmmyyyy(x.idt), val: r2(x.val), itms: [] }, x.etin ? { etin: x.etin } : {}));
        inv.itms.push({ num: itemNum(x.rt), itm_det: { txval: r2(x.txval), rt: x.rt, iamt: x.tax ? x.tax.iamt : taxSplit(x.txval, x.rt, true).iamt, csamt: r2(x.cess) } });
        R.b2cl.push([x.inum, ddMonyyyy(x.idt), r2(x.val), posLabel(x.pos), '', x.rt, r2(x.txval), r2(x.cess), x.etin || '']);
        addEco(x.etin, x.txval, x.rt, true, x.cess, 1, x.tax);
      });
      // B2CS — already summed and net of credit notes; merge with other sources
      rd.b2cs.forEach(x => {
        if (!x.pos || r2(x.txval) === 0) return;   // fully returned / unmatched — nothing to report
        const inter = x.pos !== seller, t = x.tax || taxSplit(x.txval, x.rt, inter);   // the report's own tax amounts when given
        J.b2cs = J.b2cs || [];
        let e = J.b2cs.find(z => z.pos === x.pos && z.rt === x.rt && (z.etin || '') === (x.etin || '') && z.sply_ty === (inter ? 'INTER' : 'INTRA'));
        if (!e) J.b2cs.push(e = Object.assign({ sply_ty: inter ? 'INTER' : 'INTRA', pos: x.pos, typ: x.etin ? 'E' : 'OE' }, x.etin ? { etin: x.etin } : {}, { txval: 0, rt: x.rt }, inter ? { iamt: 0 } : { camt: 0, samt: 0 }, { csamt: 0 }));
        e.txval = r2(e.txval + x.txval); e.csamt = r2(e.csamt + x.cess);
        if (inter) e.iamt = r2(e.iamt + t.iamt); else { e.camt = r2(e.camt + t.camt); e.samt = r2(e.samt + t.samt); }
        R.b2cs.push([x.etin ? 'E' : 'OE', posLabel(x.pos), '', x.rt, r2(x.txval), r2(x.cess), x.etin || '']);
        addEco(x.etin, x.txval, x.rt, inter, x.cess, 1, x.tax);
      });
      // CDNR (registered buyers) and CDNUR (B2CL) credit / debit notes
      rd.cdnr.forEach(x => {
        J.cdnr = J.cdnr || []; let c = J.cdnr.find(e => e.ctin === x.ctin); if (!c) J.cdnr.push(c = { ctin: x.ctin, nt: [] });
        let nt = c.nt.find(n => n.nt_num === x.ntnum);
        if (!nt) c.nt.push(nt = { ntty: x.ntty, nt_num: x.ntnum.slice(0, 16), nt_dt: ddmmyyyy(x.ntdt), val: r2(x.val), pos: x.pos, rchrg: x.rchrg ? 'Y' : 'N', inv_typ: 'R', itms: [] });
        nt.itms.push(itm(x.rt, x.txval, x.cess, x.pos !== seller));
        (R.cdnr = R.cdnr || []).push([x.ctin, x.name || '', x.ntnum, ddMonyyyy(x.ntdt), x.ntty, posLabel(x.pos), x.rchrg ? 'Y' : 'N', 'Regular B2B', r2(x.val), '', x.rt, r2(x.txval), r2(x.cess)]);
        addEco((rd.b2b.find(b => b.inum === x.origInv) || rd.b2b[0] || {}).etin, x.txval, x.rt, x.pos !== seller, x.cess, x.ntty === 'C' ? -1 : 1);
      });
      rd.cdnur.forEach(x => {
        J.cdnur = J.cdnur || [];
        let nt = J.cdnur.find(n => n.nt_num === x.ntnum);
        if (!nt) J.cdnur.push(nt = { typ: x.typ === 'EXPWP' || x.typ === 'EXPWOP' ? x.typ : 'B2CL', ntty: x.ntty, nt_num: x.ntnum.slice(0, 16), nt_dt: ddmmyyyy(x.ntdt), val: r2(x.val), pos: x.pos, itms: [] });
        nt.itms.push({ num: itemNum(x.rt), itm_det: { txval: r2(x.txval), rt: x.rt, iamt: taxSplit(x.txval, x.rt, true).iamt, csamt: r2(x.cess) } });
        (R.cdnur = R.cdnur || []).push([nt.typ, x.ntnum, ddMonyyyy(x.ntdt), x.ntty, posLabel(x.pos), r2(x.val), '', x.rt, r2(x.txval), r2(x.cess)]);
      });
      // HSN — Amazon gives one combined summary; the portal needs B2B and B2C
      // apart. The B2B invoices' net value (minus credit notes to them) goes to
      // HSN-B2B under the main HSN; the rest stays in HSN-B2C.
      const b2bNet = {};   // rate → { txval, iamt, camt, samt, cess, n }
      rd.b2b.forEach(x => { const t = taxSplit(x.txval, x.rt, x.pos !== seller), e = b2bNet[x.rt] = b2bNet[x.rt] || { txval: 0, iamt: 0, camt: 0, samt: 0, cess: 0 }; e.txval += x.txval; e.iamt += t.iamt; e.camt += t.camt; e.samt += t.samt; e.cess += x.cess; });
      rd.cdnr.forEach(x => { const sg = x.ntty === 'C' ? -1 : 1, t = taxSplit(x.txval, x.rt, x.pos !== seller), e = b2bNet[x.rt] = b2bNet[x.rt] || { txval: 0, iamt: 0, camt: 0, samt: 0, cess: 0 }; e.txval += sg * x.txval; e.iamt += sg * t.iamt; e.camt += sg * t.camt; e.samt += sg * t.samt; e.cess += sg * x.cess; });
      const addHsn = (arrName, h) => {
        J.hsn = J.hsn || { hsn_b2b: [] }; const arr = J.hsn[arrName] = J.hsn[arrName] || [];
        let e = arr.find(z => z.hsn_sc === h.hsn_sc && z.uqc === h.uqc && z.rt === h.rt);
        if (!e) arr.push(e = { hsn_sc: h.hsn_sc, num: arr.length + 1, desc: h.desc, uqc: h.uqc, qty: 0, rt: h.rt, txval: 0, iamt: 0, camt: 0, samt: 0, csamt: 0 });
        ['qty', 'txval', 'iamt', 'camt', 'samt', 'csamt'].forEach(k => { e[k] = r2(e[k] + (h[k] || 0)); });
        (arrName === 'hsn_b2b' ? R.hsnB2B : R.hsnB2C).push([h.hsn_sc, h.desc, h.uqc + '-' + (UQC[h.uqc] || 'OTHERS'), r2(h.qty), r2(h.txval + h.iamt + h.camt + h.samt + h.csamt), h.rt, r2(h.txval), r2(h.iamt), r2(h.camt), r2(h.samt), r2(h.csamt)]);
      };
      const hsnByRate = {};
      rd.hsn.forEach(h => { (hsnByRate[h.rt] = hsnByRate[h.rt] || []).push(Object.assign({}, h)); });
      Object.keys(hsnByRate).forEach(rtKey => {
        const rt = Number(rtKey), list = hsnByRate[rtKey].sort((a, b) => b.txval - a.txval), main = list[0], b = b2bNet[rt];
        list.forEach(h => {
          let share = 0;
          if (h === main && b && b.txval > 0) share = Math.min(1, b.txval / (h.txval || 1));
          const b2bPart = share ? { txval: Math.min(b.txval, h.txval), iamt: b.iamt, camt: b.camt, samt: b.samt, csamt: b.cess, qty: Math.round(h.qty * share) } : null;
          const uqc = UQC[h.uqc] ? h.uqc : uqcCode(h.uqc);
          if (b2bPart) addHsn('hsn_b2b', Object.assign({ hsn_sc: h.hsn, desc: h.desc, uqc, rt }, b2bPart));
          const rest = { hsn_sc: h.hsn, desc: h.desc, uqc, rt, qty: h.qty - (b2bPart ? b2bPart.qty : 0), txval: h.txval - (b2bPart ? b2bPart.txval : 0),
            iamt: h.iamt - (b2bPart ? b2bPart.iamt : 0), camt: h.camt - (b2bPart ? b2bPart.camt : 0), samt: h.samt - (b2bPart ? b2bPart.samt : 0), csamt: h.cess - (b2bPart ? b2bPart.csamt : 0) };
          if (r2(rest.txval) !== 0 || r2(rest.qty) !== 0) addHsn('hsn_b2c', rest);
        });
        if (b && b.txval > 0) warn(`${src}'s HSN summary isn't split B2B/B2C — the B2B invoices' net value (₹${r2(b.txval)}) was put under HSN ${main.hsn} (B2B) and the rest under B2C. Check this matches your products.`);
      });
      if ([...rd.b2b, ...rd.b2cs, ...rd.hsn].length && [...rd.b2b, ...rd.b2cs, ...rd.hsn].every(x => !x.rt)) {
        warn(`Every line in ${src}'s report is at 0% GST. HSN ${rd.hsn.map(h => h.hsn).join(', ')} is normally taxable (e.g. 63049291 = 5%). Confirm the tax code on your Amazon listings with your CA before filing — the file is built exactly as Amazon reports it.`);
      }
      if (rd.docs && rd.docs.length) {            // Table 13 straight from the report (Flipkart)
        J.doc_issue = J.doc_issue || { doc_det: [] };
        let d1 = J.doc_issue.doc_det.find(d => d.doc_num === 1);
        if (!d1) J.doc_issue.doc_det.push(d1 = { doc_num: 1, docs: [] });
        rd.docs.forEach(d => { d1.docs.push({ num: d1.docs.length + 1, from: d.from.slice(0, 16), to: d.to.slice(0, 16), totnum: d.totnum, cancel: d.cancel, net_issue: d.net_issue }); R.docs.push(['Invoices for outward supply', d.from, d.to, d.totnum, d.cancel]); });
        res.counts.docs = d1.docs.length;
      } else {
        warn(`${src}'s report has no "Documents issued" (Table 13) data — add your ${src} invoice and credit-note number ranges on the portal${src === 'Amazon' ? ' (Amazon Seller Central → Reports → Tax Document Library / MTR)' : ''}.`);
      }
      (rd.hsn || []).filter(h => h.rawRate != null && Math.abs(h.rawRate - h.rt) > 0.2).forEach(h => warn(`${src} HSN ${h.hsn}: tax works out to ${r2(h.rawRate)}%, reported as ${h.rt}% — check if it mixes several GST rates.`));
      if (rd.amendments) warn(`${src}'s report has ${rd.amendments} amendment line(s) for earlier periods (Section 10A/10B) — enter them on the portal under B2CS amendments; they are not in this file.`);
      if (rd.gstr8) {
        const via = rd.b2cs.reduce((a, x) => a + x.txval, 0) + rd.b2cl.reduce((a, x) => a + x.txval, 0);
        if (rd.gstr8.tcs) warn(`${src} collected TCS of ₹${rd.gstr8.tcs} on these sales — accept it on the GST portal (Returns → TCS and TDS credit received) so it reaches your cash ledger and reduces the tax you pay.`);
        if (Math.abs(via - rd.gstr8.net) > 1) warn(`${src}: sales in the B2C sheets (₹${r2(via)}) don't match ${src}'s GSTR-8 net value (₹${r2(rd.gstr8.net)}) — check the report.`);
      }
      if (!rd.period && rd.source === 'Flipkart') warn(`${src}'s report doesn't say which month it covers — make sure the Return period you chose (${opts.period || 'not set'}) is the month you downloaded it for.`);
      if (opts.period && rd.period && opts.period !== rd.period) warn(`${src} report "${rd.fileName}" is for the period ending ${rd.period}, but you chose ${opts.period}.`);
    });
    // Table 14 — supplies through Amazon (net of credit notes)
    const ecoArr = Object.values(eco).filter(e => r2(e.suppval));
    if (ecoArr.length) {
      J.supeco = J.supeco || { clttx: [] };
      ecoArr.forEach(e => {
        let c = J.supeco.clttx.find(z => z.etin === e.etin);
        if (!c) J.supeco.clttx.push(c = { etin: e.etin, suppval: 0, igst: 0, cgst: 0, sgst: 0, cess: 0 });
        ['suppval', 'igst', 'cgst', 'sgst', 'cess'].forEach(k => { c[k] = r2(c[k] + e[k]); });
      });
    }
    if (J.hsn) Object.keys(J.hsn).forEach(k => J.hsn[k].forEach((h, i) => { h.num = i + 1; }));
    // refresh counts / totals
    res.counts.b2b = (J.b2b || []).reduce((a, x) => a + x.inv.length, 0);
    res.counts.b2cl = (J.b2cl || []).reduce((a, x) => a + x.inv.length, 0);
    res.counts.b2cs = (J.b2cs || []).length;
    res.counts.cdnr = (J.cdnr || []).reduce((a, x) => a + x.nt.length, 0);
    res.counts.cdnur = (J.cdnur || []).length;
    res.counts.hsnB2B = ((J.hsn || {}).hsn_b2b || []).length; res.counts.hsnB2C = ((J.hsn || {}).hsn_b2c || []).length;
    const tot = { taxable: 0, igst: 0, cgst: 0, sgst: 0, cess: 0 };
    const addT = (d, sg) => { tot.taxable += sg * (d.txval || 0); tot.igst += sg * (d.iamt || 0); tot.cgst += sg * (d.camt || 0); tot.sgst += sg * (d.samt || 0); tot.cess += sg * (d.csamt || 0); };
    (J.b2b || []).forEach(c => c.inv.forEach(i => i.itms.forEach(t => addT(t.itm_det, 1))));
    (J.b2cl || []).forEach(c => c.inv.forEach(i => i.itms.forEach(t => addT(t.itm_det, 1))));
    (J.b2cs || []).forEach(x => addT(x, 1));
    (J.cdnr || []).forEach(c => c.nt.forEach(n => n.itms.forEach(t => addT(t.itm_det, n.ntty === 'C' ? -1 : 1))));
    (J.cdnur || []).forEach(n => n.itms.forEach(t => addT(t.itm_det, n.ntty === 'C' ? -1 : 1)));
    Object.keys(tot).forEach(k => { res.totals[k] = r2(tot[k]); });
    return res;
  }

  /* GSTR-3B Table 3.1(a), 3.1(c) and 3.2 from a finished GSTR-1 JSON — so the
     marketplace tool's combined data (Amazon + Flipkart + Meesho + Billing)
     gives the sales side of GSTR-3B too. ITC (Table 4) comes from purchases. */
  function gstr3bFromGstr1(J) {
    const o = { txval: 0, iamt: 0, camt: 0, samt: 0, csamt: 0 }, unreg = {}, add = (d, sg) => { o.txval += sg * (d.txval || 0); o.iamt += sg * (d.iamt || 0); o.camt += sg * (d.camt || 0); o.samt += sg * (d.samt || 0); o.csamt += sg * (d.csamt || 0); };
    const addUnreg = (pos, d, sg) => { const u = unreg[pos] = unreg[pos] || { pos, txval: 0, iamt: 0 }; u.txval += sg * (d.txval || 0); u.iamt += sg * (d.iamt || 0); };
    (J.b2b || []).forEach(c => c.inv.forEach(i => i.itms.forEach(t => add(t.itm_det, 1))));
    (J.b2cl || []).forEach(c => c.inv.forEach(i => i.itms.forEach(t => { add(t.itm_det, 1); addUnreg(c.pos, t.itm_det, 1); })));
    (J.b2cs || []).forEach(x => { add(x, 1); if (x.sply_ty === 'INTER') addUnreg(x.pos, x, 1); });
    (J.cdnr || []).forEach(c => c.nt.forEach(n => n.itms.forEach(t => add(t.itm_det, n.ntty === 'C' ? -1 : 1))));
    (J.cdnur || []).forEach(n => n.itms.forEach(t => { add(t.itm_det, n.ntty === 'C' ? -1 : 1); if (n.pos) addUnreg(n.pos, t.itm_det, n.ntty === 'C' ? -1 : 1); }));
    const nil = ((J.nil || {}).inv || []).reduce((a, x) => a + (x.nil_amt || 0) + (x.expt_amt || 0), 0);
    const R = x => { const y = {}; Object.keys(x).forEach(k => { y[k] = typeof x[k] === 'number' ? r2(x[k]) : x[k]; }); return y; };
    return {
      gstin: J.gstin, ret_period: J.fp,
      sup_details: { osup_det: R(o), osup_zero: { txval: 0, iamt: 0, csamt: 0 }, osup_nil_exmp: { txval: r2(nil) }, isup_rev: { txval: 0, iamt: 0, camt: 0, samt: 0, csamt: 0 }, osup_nongst: { txval: 0 } },
      inter_sup: { unreg_details: Object.values(unreg).filter(u => r2(u.txval) !== 0).map(R), comp_details: [], uin_details: [] }
    };
  }

  function downloadJson(obj, fileName) {
    const blob = new Blob([JSON.stringify(obj)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = fileName;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  }

  global.VTGst = {
    STATES, UQC, VALID_RATES, stateName, posLabel, uqcCode, uqcLabel, ddmmyyyy, ddMonyyyy, fpOf, gstinOk, taxSplit, r2,
    validate, buildGstr1, gstr1Workbook, buildGstr3b, gstr3bWorkbook, netPayable,
    parse2bJson, parse2bWorkbook, reconcile, downloadJson, isReadyWorkbook, parseReadyWorkbook, mergeReadyReport,
    isFlipkartGstWorkbook, parseFlipkartGstWorkbook, stateCodeOf, gstr3bFromGstr1
  };
})(typeof window !== 'undefined' ? window : globalThis);
