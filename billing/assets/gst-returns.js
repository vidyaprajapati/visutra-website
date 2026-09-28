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
          const txval = r2(byRate[rt].txval), t = taxSplit(txval, rt, inter);
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
    parse2bJson, parse2bWorkbook, reconcile, downloadJson
  };
})(typeof window !== 'undefined' ? window : globalThis);
