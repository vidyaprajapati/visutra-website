/* VISUTRA — GST Online Seller
   GST Profile → Import Data (per platform, per month) → Manage Data →
   TCS Reconcile → GSTR1 Report. All calculations use the shared engine
   (billing/assets/gst-returns.js). Saved in the signed-in account:
     users/<uid>/gstProfiles/<gstin>                         saved GSTINs
     users/<uid>/gstImports/<gstin>_<card>_<month>_<slot>   each imported file (compact)
     users/<uid>/gstReturns/<gstin>_<MMYYYY>                 edits, portal TCS values, ECO GSTINs
*/
var D = { type: 'quarterly', pkey: '', fy: 0 };   // the profile form (applied on "Select GSTIN")
var GS = { uid: null, gstin: '', type: 'quarterly', pkey: '', fy: 0, saved: [], parts: {}, ret: null, sec: 'profile', filter: 'all', search: '', modal: null };
var QUARTERS = [
  { k: 'Q1', label: 'April-June', m: [4, 5, 6] }, { k: 'Q2', label: 'July-September', m: [7, 8, 9] },
  { k: 'Q3', label: 'October-December', m: [10, 11, 12] }, { k: 'Q4', label: 'January-March', m: [1, 2, 3] }];
var FY_MONTHS = [4, 5, 6, 7, 8, 9, 10, 11, 12, 1, 2, 3];
var MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
var PF = {
  MEESHO: { name: 'Meesho', site: 'meesho.com · GST reports (TCS sales)', badge: 'B2C', eco: 'MEESHO', bg: '#E8467C', letter: 'm',
    path: 'Meesho Panel → Payments → Download GST Reports',
    slots: [
      { key: 'sales', label: 'tcs_sales.xlsx', zip: /tcs_sales(?!_return)[^\/]*\.xlsx$/i, need: 'total_taxable_sale_value' },
      { key: 'returns', label: 'tcs_sales_return.xlsx', zip: /tcs_sales_return[^\/]*\.xlsx$/i, need: 'total_taxable_sale_value' },
      { key: 'invoices', label: 'Tax_invoice_details.xlsx', zip: /tax_invoice_details[^\/]*\.xlsx$/i, need: 'Invoice No.', before: 'Download Path: (Meesho Panel → Payments → Tax Invoice).', after: 'Unzip the file and upload only the Excel (Tax_invoice_details.xlsx) file — or upload the .zip as downloaded.' }] },
  AMAZON: { name: 'Amazon', site: 'amazon.in · B2C merchant tax report', badge: 'B2C', eco: 'AMAZON', bg: '#131921', letter: 'a',
    path: 'Finance (Reports) → Manage Taxes → GST Reporting → GST Monthly Reports → Download Report → Select Merchant Tax Report (MTR) → select (B2C) → Select Year and Month → Download Report.',
    slots: [{ key: 'mtr', label: 'MTR_B2C File', zip: /MTR_B2C[^\/]*\.csv$/i, need: 'Transaction Type' }] },
  AMAZON_B2B: { name: 'Amazon B2B', site: 'amazon.in · B2B merchant tax report', badge: 'B2B', eco: 'AMAZON', bg: '#131921', letter: 'a',
    path: 'Finance (Reports) → Manage Taxes → GST Reporting → GST Monthly Reports → Download Report → Select Merchant Tax Report (MTR) → select (B2B) → Select Year and Month → Download Report.',
    slots: [{ key: 'mtr', label: 'MTR_B2B File', zip: /MTR_B2B[^\/]*\.csv$/i, need: 'Transaction Type' },
            { key: 'stock', label: 'MTR_STOCK_TRANSFER File', zip: /STOCK[^\/]*\.csv$/i, optional: true, before: 'If the stock is transferred to FBA and stock transfer file is available.' }] },
  FLIPKART: { name: 'Flipkart', site: 'flipkart.com · Sales / Tax report', badge: 'B2C / B2B', eco: 'FLIPKART', bg: '#2874F0', letter: 'f',
    path: 'Flipkart Portal → Report → Reports Center → Request New Report → Tax Reports → Sales report',
    slots: [{ key: 'sales', label: 'Sales Report', zip: /\.xlsx$/i, need: 'Sales Report' }] },
  MYNTRA: { name: 'Myntra', badge: 'B2C', bg: '#FF3F6C', letter: 'M', soon: true },
  SNAPDEAL: { name: 'Snapdeal', badge: 'B2C', bg: '#E40046', letter: 's', soon: true }
};
var GROUPS = [{ eco: 'MEESHO', cards: ['MEESHO'] }, { eco: 'AMAZON', cards: ['AMAZON', 'AMAZON_B2B'] }, { eco: 'FLIPKART', cards: ['FLIPKART'] }];

/* ---------------- helpers ---------------- */
function $(id) { return document.getElementById(id); }
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
function inr(n) { return (Math.round((Number(n) || 0) * 100) / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
function r2(n) { return Math.round((Number(n) || 0) * 100 + (n >= 0 ? 1e-9 : -1e-9)) / 100; }
function ym(y, m) { return y + '-' + String(m).padStart(2, '0'); }
function monthName(m) { return MONTH_NAMES[parseInt(m.slice(5, 7), 10) - 1]; }
function monthShort(m) { return monthName(m).slice(0, 3) + ' ' + m.slice(0, 4); }
function nowIso() { return new Date().toISOString(); }
function col(name) { return db.collection('users').doc(GS.uid).collection(name); }
function sellerState() { return GS.gstin.slice(0, 2); }
function currentFy() { var d = new Date(); return d.getMonth() >= 3 ? d.getFullYear() : d.getFullYear() - 1; }
function gsMonths() {
  if (!GS.pkey || !GS.fy) return [];
  if (GS.type === 'monthly') { var m = parseInt(GS.pkey, 10); return [ym(m >= 4 ? GS.fy : GS.fy + 1, m)]; }
  var q = QUARTERS.filter(function (x) { return x.k === GS.pkey; })[0];
  return q ? q.m.map(function (m) { return ym(m >= 4 ? GS.fy : GS.fy + 1, m); }) : [];
}
function gsFpMonth() { var ms = gsMonths(); return ms[ms.length - 1] || ''; }
function gsFp() { var m = gsFpMonth(); return m ? m.slice(5, 7) + m.slice(0, 4) : ''; }
// default = the latest period that has ended (last month / last quarter)
function defaultPeriod(type) {
  var d = new Date(); d.setDate(1); d.setMonth(d.getMonth() - 1);
  var m = d.getMonth() + 1, fy = m >= 4 ? d.getFullYear() : d.getFullYear() - 1;
  if (type === 'monthly') return { pkey: String(m), fy: fy };
  var q = QUARTERS.filter(function (x) { return x.m.indexOf(m) >= 0; })[0];
  if (q.m[2] !== m) { // quarter not finished → previous quarter
    var i = QUARTERS.indexOf(q); var prev = QUARTERS[(i + 3) % 4];
    return { pkey: prev.k, fy: prev.k === 'Q4' ? fy - 1 : fy };   // Jan–Mar belongs to the previous FY
  }
  return { pkey: q.k, fy: fy };
}

/* ---------------- navigation ---------------- */
function gsGo(sec) {
  GS.sec = sec;
  if (location.hash !== '#' + sec) history.replaceState(null, '', '#' + sec);
  document.querySelectorAll('.gs-sec').forEach(function (s) { s.classList.toggle('on', s.id === 'sec-' + sec); });
  document.querySelectorAll('#gsNav button').forEach(function (b) { b.classList.toggle('on', b.dataset.sec === sec); });
  ({ profile: renderProfile, import: renderImport, manage: renderManage, tcs: renderTcs, report: renderReport })[sec]();
  window.scrollTo && window.scrollTo(0, 0);
}
document.querySelectorAll('#gsNav button').forEach(function (b) { b.addEventListener('click', function () { gsGo(b.dataset.sec); }); });

/* ---------------- data ---------------- */
function loadSaved() {
  return col('gstProfiles').get().then(function (snap) {
    GS.saved = snap.docs.map(function (d) { return Object.assign({ id: d.id }, d.data()); })
      .sort(function (a, b) { return String(b.lastUsed || '').localeCompare(String(a.lastUsed || '')); });
  });
}
function loadParts() {
  GS.parts = {};
  if (!GS.gstin) return Promise.resolve();
  return col('gstImports').where('gstin', '==', GS.gstin).get().then(function (snap) {
    snap.docs.forEach(function (d) { var x = d.data(); GS.parts[x.card + '|' + x.month + '|' + x.slot] = Object.assign({ id: d.id }, x); });
  });
}
function retId() { return GS.gstin + '_' + gsFp(); }
function loadRet() {
  GS.ret = { edits: {}, portal: {}, eco: {}, b2cHsn: true };
  if (!GS.gstin || !gsFp()) return Promise.resolve();
  return col('gstReturns').doc(retId()).get().then(function (s) {
    if (s.exists) GS.ret = Object.assign(GS.ret, s.data());
    GS.ret.edits = GS.ret.edits || {}; GS.ret.portal = GS.ret.portal || {}; GS.ret.eco = GS.ret.eco || {};
    if (GS.ret.b2cHsn === undefined) GS.ret.b2cHsn = true;
  });
}
function saveRet() {
  return col('gstReturns').doc(retId()).set({ gstin: GS.gstin, fp: gsFp(), edits: GS.ret.edits, portal: GS.ret.portal, eco: GS.ret.eco, b2cHsn: GS.ret.b2cHsn, updatedAt: nowIso() });
}
function rememberSelection() {
  try { sessionStorage.setItem('gsSel', JSON.stringify({ gstin: GS.gstin, type: GS.type, pkey: GS.pkey, fy: GS.fy })); } catch (e) {}
}
function ecoGstinFor(eco) { return (GS.ret && GS.ret.eco[eco]) || VTGst.ecoGstin(eco, sellerState() || '09'); }

// one card & month: its saved file parts merged (lines, document series, B2B lists)
function cardMonth(card, month) {
  var parts = Object.keys(GS.parts).filter(function (k) { return k.indexOf(card + '|' + month + '|') === 0; }).map(function (k) { return GS.parts[k]; });
  if (!parts.length) return null;
  var eco = PF[card].eco, etin = ecoGstinFor(eco);
  var out = { card: card, platform: eco, month: month, etin: etin, lines: [], docSeries: { inv: [], cn: [], dn: [] }, b2b: [], cdnr: [], info: { unknownStates: [], exemptCode: 0, months: [] }, files: [], stock: false };
  var series = { inv: [], cn: [], dn: [] };
  parts.forEach(function (p) {
    var e = p.entry || {};
    (e.lines || []).forEach(function (l) { out.lines.push(Object.assign({}, l, { etin: GS.ret && GS.ret.eco[eco] ? etin : (l.etin || etin) })); });
    ['inv', 'cn', 'dn'].forEach(function (k) { series[k].push((e.docSeries || {})[k] || []); });
    out.b2b = out.b2b.concat(e.b2b || []); out.cdnr = out.cdnr.concat(e.cdnr || []);
    var inf = e.info || {};
    out.info.unknownStates = out.info.unknownStates.concat(inf.unknownStates || []);
    out.info.exemptCode += inf.exemptCode || 0;
    if (inf.months && inf.months.length && !out.info.months.length) out.info.months = inf.months;
    out.files.push({ slot: p.slot, file: p.file, rows: p.rows });
    if (p.slot === 'stock') out.stock = true;
  });
  ['inv', 'cn', 'dn'].forEach(function (k) { out.docSeries[k] = VTGst.joinSeries(series[k]); });
  return out;
}
// one platform group (Amazon = B2C + B2B) & month
function groupMonth(g, month) {
  var parts = g.cards.map(function (c) { return cardMonth(c, month); }).filter(Boolean);
  if (!parts.length) return null;
  var e = { platform: g.eco, month: month, etin: parts[0].etin, lines: [], docSeries: { inv: [], cn: [], dn: [] }, b2b: [], cdnr: [], info: { unknownStates: [], exemptCode: 0, months: parts[0].info.months }, stock: false };
  var series = { inv: [], cn: [], dn: [] };
  parts.forEach(function (p) {
    e.lines = e.lines.concat(p.lines); e.b2b = e.b2b.concat(p.b2b); e.cdnr = e.cdnr.concat(p.cdnr);
    ['inv', 'cn', 'dn'].forEach(function (k) { series[k].push(p.docSeries[k]); });
    e.info.unknownStates = e.info.unknownStates.concat(p.info.unknownStates); e.info.exemptCode += p.info.exemptCode; e.stock = e.stock || p.stock;
  });
  ['inv', 'cn', 'dn'].forEach(function (k) { e.docSeries[k] = VTGst.joinSeries(series[k]); });
  return e;
}
function allEntries() {
  var out = [];
  GROUPS.forEach(function (g) { gsMonths().forEach(function (m) { var e = groupMonth(g, m); if (e) out.push(e); }); });
  return out;
}
function cardImported(card) { return gsMonths().some(function (m) { return !!cardMonth(card, m); }); }
function importedCount() { var n = 0; Object.keys(PF).forEach(function (c) { if (!PF[c].soon) gsMonths().forEach(function (m) { if (cardMonth(c, m)) n++; }); }); return n; }

/* ---------------- GST PROFILE ---------------- */
function fillPeriodSelects() {
  var ps = $('pPeriod'), ys = $('pYear'), def = defaultPeriod(D.type);
  var opts = D.type === 'monthly'
    ? FY_MONTHS.map(function (m) { return { v: String(m), t: MONTH_NAMES[m - 1] }; })
    : QUARTERS.map(function (q) { return { v: q.k, t: q.label }; });
  ps.innerHTML = '<option value="">' + (D.type === 'monthly' ? 'Month' : 'Quarter') + '</option>' + opts.map(function (o) {
    return '<option value="' + o.v + '"' + (o.v === D.pkey ? ' selected' : '') + '>' + o.t + (o.v === def.pkey ? ' (Return ' + (D.type === 'monthly' ? 'Month' : 'Period') + ')' : '') + '</option>';
  }).join('');
  var fy = currentFy();
  ys.innerHTML = [fy - 2, fy - 1, fy, fy + 1].map(function (y) {
    return '<option value="' + y + '"' + (y === D.fy ? ' selected' : '') + '>' + y + '-' + String(y + 1).slice(2) + (y === def.fy ? ' (Return Year)' : '') + '</option>';
  }).join('');
  document.querySelectorAll('#pType button').forEach(function (b) { b.classList.toggle('on', b.dataset.v === D.type); });
}
document.querySelectorAll('#pType button').forEach(function (b) {
  b.addEventListener('click', function () {
    D.type = b.dataset.v; var d = defaultPeriod(D.type); D.pkey = d.pkey; D.fy = d.fy; fillPeriodSelects();
  });
});
$('pPeriod').addEventListener('change', function () { D.pkey = this.value; });
$('pYear').addEventListener('change', function () { D.fy = parseInt(this.value, 10); });
$('pSelectBtn').addEventListener('click', function () { selectGstin($('pGstin').value); });

function selectGstin(raw, fromSaved) {
  var g = String(raw || '').trim().toUpperCase();
  $('pErr').textContent = '';
  if (!VTGst.gstinValid(g)) { $('pErr').textContent = 'Enter a valid 15-character GSTIN (the last character is a check digit — check for typing mistakes).'; return Promise.resolve(false); }
  if (!D.pkey) { $('pErr').textContent = 'Choose the period.'; return Promise.resolve(false); }
  GS.gstin = g; GS.type = D.type; GS.pkey = D.pkey; GS.fy = D.fy; $('pGstin').value = g;
  var existing = GS.saved.filter(function (s) { return s.gstin === g; })[0];
  var data = { gstin: g, state: VTGst.stateName(g.slice(0, 2)), type: GS.type, lastUsed: nowIso() };
  if (!existing) data.addedAt = nowIso();
  rememberSelection();
  return col('gstProfiles').doc(g).set(data, { merge: true })
    .then(loadSaved).then(loadParts).then(loadRet)
    .then(function () { renderProfile(); return true; })
    .catch(function (e) { $('pErr').textContent = 'Could not save: ' + e.message; return false; });
}
function renderProfile() {
  fillPeriodSelects();
  if (GS.gstin && !$('pGstin').value) $('pGstin').value = GS.gstin;
  var ms = gsMonths();
  $('pSelected').innerHTML = GS.gstin && ms.length ? '<div class="gs-selected"><div style="flex:1"><h4><i class="bi bi-patch-check-fill"></i> ' + esc(GS.gstin) + '</h4>' +
    '<p>' + esc(VTGst.stateName(sellerState())) + ' · Period ' + gsFpMonth().slice(5, 7) + '-' + gsFpMonth().slice(0, 4) + ' · ' + (GS.type === 'monthly' ? 'Monthly' : 'Quarterly') + '</p></div>' +
    '<button class="btn btn-blue" style="height:52px;font-size:17px" onclick="gsGo(\'import\')"><i class="bi bi-file-earmark-arrow-up"></i> Import data</button></div>' : '';
  var n = GS.saved.length, max = 11;
  $('pSlots').innerHTML = '<b>' + n + '</b>/' + max + ' slots <i class="bi bi-question-circle" title="GSTINs you have filed for. Remove one to free a slot."></i><div class="bar"><b style="width:' + Math.min(100, n / max * 100) + '%"></b></div><span style="color:#6B7280">' + n + ' in use · ' + Math.max(0, max - n) + ' available</span>';
  $('pSaved').innerHTML = GS.saved.length ? GS.saved.map(function (s) {
    return '<div class="gs-sv"><h5>' + esc(s.gstin) + '</h5><small>Added ' + fmtDate(s.addedAt) + ' · Last used ' + fmtDate(s.lastUsed) + (s.label ? ' · ' + esc(s.label) : '') + '</small>' +
      '<div class="row"><button class="btn btn-blue" onclick="pickSaved(\'' + esc(s.gstin) + '\')"><i class="bi bi-check2"></i> Select</button>' +
      '<button class="btn btn-amber-o" title="Settings" onclick="savedSettings(\'' + esc(s.gstin) + '\')"><i class="bi bi-gear"></i></button></div></div>';
  }).join('') : '<p style="color:#6B7280;margin:0">No saved GSTINs yet — enter one above and click <b>Select GSTIN</b>.</p>';
}
function fmtDate(iso) { if (!iso) return '—'; var d = new Date(iso); return String(d.getDate()).padStart(2, '0') + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + d.getFullYear(); }
function pickSaved(g) {
  var s = GS.saved.filter(function (x) { return x.gstin === g; })[0];
  if (s && s.type && s.type !== D.type) { D.type = s.type; var d = defaultPeriod(D.type); D.pkey = d.pkey; D.fy = d.fy; }
  $('pGstin').value = g;
  selectGstin(g, true);
}
function savedSettings(g) {
  var s = GS.saved.filter(function (x) { return x.gstin === g; })[0] || {};
  openModal('<div class="gs-mh"><div><h4>' + esc(g) + '</h4><div class="sub">' + esc(s.state || '') + '</div></div><button class="x" onclick="gsCloseModal()">✕</button></div>' +
    '<div class="gs-mb"><label class="gs-lbl">Name (optional)</label><div class="gs-in" style="height:48px"><input id="svLabel" value="' + esc(s.label || '') + '" placeholder="e.g. Visu trader — UP" style="padding-left:14px"></div>' +
    '<p style="color:#6B7280;font-size:14px;margin-top:16px">Removing the GSTIN frees its slot. Its imported data stays in your account and comes back if you add the GSTIN again.</p></div>' +
    '<div class="gs-mf"><button class="btn btn-danger-o" onclick="removeSaved(\'' + esc(g) + '\')"><i class="bi bi-trash"></i> Remove</button><span style="flex:1"></span>' +
    '<button class="btn btn-ghost" onclick="gsCloseModal()">Cancel</button><button class="btn btn-blue" onclick="saveLabel(\'' + esc(g) + '\')">Save</button></div>', true);
}
function saveLabel(g) { col('gstProfiles').doc(g).set({ label: $('svLabel').value.trim() }, { merge: true }).then(loadSaved).then(function () { gsCloseModal(); renderProfile(); }); }
function removeSaved(g) {
  if (!confirm('Remove ' + g + ' from saved GSTINs?')) return;
  col('gstProfiles').doc(g).delete().then(loadSaved).then(function () {
    if (GS.gstin === g) { GS.gstin = ''; GS.parts = {}; $('pGstin').value = ''; rememberSelection(); }
    gsCloseModal(); renderProfile();
  });
}

/* ---------------- IMPORT DATA ---------------- */
function stepper(n) {
  var st = ['Select GSTIN', 'Import data', 'Generate GSTR-1'];
  return '<div class="gs-steps">' + st.map(function (t, i) {
    var cls = i + 1 === n ? 'on' : (i + 1 < n ? 'done' : '');
    return (i ? '<span class="ln"></span>' : '') + '<span class="' + cls + '"><i class="bi ' + (i + 1 < n ? 'bi-check-circle-fill' : (i + 1 === n ? 'bi-record-circle' : 'bi-circle')) + '"></i> ' + (i + 1) + '. ' + t + '</span>';
  }).join('') + '</div>';
}
function noGstinBlock() {
  return '<div class="gs-panel" style="background:#fff">' + stepper(1) + '<div class="gs-empty"><div class="ic"><i class="bi bi-shop-window"></i></div><h4>No GSTIN selected</h4><p>Please select the GST number you\'re filing for.</p>' +
    '<button class="btn btn-blue" style="height:60px;font-size:19px;padding:0 34px" onclick="gsGo(\'profile\')"><i class="bi bi-check2"></i> Select GSTIN</button></div>' +
    '<div class="gs-help">Need Help ? <a href="gst-return-tool.html#how">Read the Guide <i class="bi bi-file-earmark-text"></i></a></div></div>';
}
function renderImport() {
  if (!GS.gstin || !gsMonths().length) { $('iStats').innerHTML = ''; $('iBody').innerHTML = noGstinBlock(); return; }
  $('iStats').innerHTML = '<div class="gs-stat"><small>Imported</small><b style="color:var(--blue-2)">' + importedCount() + '</b></div><div class="gs-stat"><small>Period</small><b>' + monthShort(gsFpMonth()) + '</b></div>';
  var q = GS.search.toLowerCase();
  var cards = Object.keys(PF).filter(function (k) {
    var d = PF[k], done = !d.soon && cardImported(k);
    if (q && d.name.toLowerCase().indexOf(q) < 0) return false;
    if (GS.filter === 'imported') return done;
    if (GS.filter === 'pending') return !done && !d.soon;
    return true;
  });
  $('iBody').innerHTML = stepper(importedCount() ? 2 : 2) +
    '<div class="gs-tools"><div class="gs-search"><i class="bi bi-search"></i><input id="iSearch" placeholder="Search for a platform..." value="' + esc(GS.search) + '"></div>' +
    ['all', 'imported', 'pending'].map(function (f) { return '<button class="chip' + (GS.filter === f ? ' on' : '') + '" onclick="GS.filter=\'' + f + '\';renderImport()">' + f.charAt(0).toUpperCase() + f.slice(1) + '</button>'; }).join('') + '</div>' +
    '<div class="gs-warn"><i class="bi bi-exclamation-triangle-fill"></i> Avoid importing an edited file to prevent errors.</div>' +
    '<div class="gs-sep">FAMOUS PLATFORMS</div><div class="gs-pf">' + cards.map(function (k) {
      var d = PF[k], done = !d.soon && cardImported(k);
      return '<div class="pf' + (done ? ' done' : '') + (d.soon ? ' soon' : '') + '"><span class="tick"><i class="bi bi-check-lg"></i></span>' +
        '<div class="logo"><b style="background:' + d.bg + '">' + d.letter + '</b></div><h5>' + d.name + '</h5><span class="bd">' + d.badge + '</span>' +
        '<div class="acts">' + (d.soon ? '<button class="btn btn-ghost main" disabled>Coming soon</button>'
          : done ? '<button class="btn btn-green main" onclick="openPlatform(\'' + k + '\')"><i class="bi bi-check-circle"></i> IMPORTED</button><button class="btn btn-danger-o" title="Remove this platform\'s data for the period" onclick="deleteCard(\'' + k + '\')"><i class="bi bi-trash3"></i></button>'
          : '<button class="btn btn-blue main" onclick="openPlatform(\'' + k + '\')"><i class="bi bi-cloud-arrow-up"></i> Import data</button>') + '</div></div>';
    }).join('') + '</div>' +
    (importedCount() ? '<div style="text-align:center;margin-top:28px"><button class="btn btn-blue" style="height:56px;font-size:18px;padding:0 30px" onclick="gsGo(\'manage\')">Review imported data <i class="bi bi-arrow-right"></i></button></div>' : '');
  var si = $('iSearch'); si.addEventListener('input', function () { GS.search = si.value; var pos = si.selectionStart; renderImport(); var n = $('iSearch'); n.focus(); n.setSelectionRange(pos, pos); });
}
function deleteCard(card) {
  var ms = gsMonths();
  if (!confirm('Remove all ' + PF[card].name + ' data for ' + ms.map(monthName).join(', ') + '?')) return;
  var keys = Object.keys(GS.parts).filter(function (k) { var p = k.split('|'); return p[0] === card && ms.indexOf(p[1]) >= 0; });
  Promise.all(keys.map(function (k) { return col('gstImports').doc(GS.parts[k].id).delete().then(function () { delete GS.parts[k]; }); })).then(renderImport);
}

/* ----- platform window ----- */
function openPlatform(card) {
  var ms = gsMonths();
  GS.modal = { card: card, month: (GS.modal && GS.modal.card === card && ms.indexOf(GS.modal.month) >= 0) ? GS.modal.month : ms[0] };
  renderPlatformModal();
}
function renderPlatformModal() {
  var card = GS.modal.card, m = GS.modal.month, d = PF[card], ms = gsMonths(), cm = cardMonth(card, m);
  var have = {}; (cm ? cm.files : []).forEach(function (f) { have[f.slot] = f; });
  var h = '<div class="gs-mh"><div class="pf" style="all:unset"><b style="width:52px;height:52px;border-radius:12px;display:flex;align-items:center;justify-content:center;font:800 26px Inter;color:#fff;background:' + d.bg + '">' + d.letter + '</b></div>' +
    '<div><h4>' + d.name + ' <span class="bd" style="font-size:12px;background:#3B82F6;color:#fff;border-radius:6px;padding:2px 8px;vertical-align:middle">' + d.badge + '</span></h4><div class="sub">' + d.site + '</div></div><button class="x" onclick="gsCloseModal()">✕</button></div><div class="gs-mb">';
  h += '<div class="mtabs">' + ms.map(function (x) { return '<button class="' + (x === m ? 'on' : '') + '" onclick="GS.modal.month=\'' + x + '\';renderPlatformModal()">' + monthName(x) + ' Data' + (cardMonth(card, x) ? ' <span class="ok">✓</span>' : '') + '</button>'; }).join('') + '</div>';
  h += '<div class="m-lbl">Download path</div><div class="m-path"><i class="bi bi-download"></i> ' + d.path + '</div>';
  h += '<div class="m-eco"><span title="The marketplace\'s TCS GSTIN in your state — used in Table 14">' + d.name.replace(' B2B', '') + ' ECO GSTIN <i class="bi bi-question-circle"></i></span><input id="mEco" maxlength="15" value="' + esc(ecoGstinFor(d.eco)) + '"></div>';
  h += '<div class="m-lbl" style="margin-top:20px">Upload files: <em>(' + monthName(m).toUpperCase() + '-' + m.slice(0, 4) + ')</em></div>';
  d.slots.forEach(function (sl) {
    if (sl.before) h += '<div class="m-note">' + sl.before + '</div>';
    h += '<div class="m-slot' + (have[sl.key] ? ' done' : '') + '"><div class="nm">' + sl.label + (sl.optional ? ' <span style="font-weight:400;color:#64748B">(optional)</span>' : '') + '</div><input type="file" id="mFile_' + sl.key + '" accept=".xlsx,.xls,.csv,.zip"></div>';
    if (have[sl.key]) h += '<div class="m-ok"><i class="bi bi-check-circle-fill"></i> ' + esc(have[sl.key].file) + ' · ' + have[sl.key].rows + ' rows</div>';
    if (sl.after) h += '<div class="m-note">' + sl.after + '</div>';
  });
  h += '<button class="btn btn-blue" style="height:54px;font-size:18px;padding:0 30px;margin-top:8px" onclick="uploadPlatform()">Upload</button>' +
    (cm ? ' <button class="btn btn-danger-o" style="margin-top:8px" onclick="deleteMonth(\'' + card + '\',\'' + m + '\', true)"><i class="bi bi-trash3"></i> Remove ' + monthName(m) + ' data</button>' : '');
  h += '<div class="m-sum" id="mMsg"' + (cm ? '' : ' style="display:none"') + '>' + (cm ? monthSummary(cm) : '') + '</div></div>';
  h += '<div class="gs-mf"><button class="btn btn-ghost" style="background:#64748B;color:#fff;border:0" onclick="gsCloseModal()">Close</button></div>';
  openModal(h);
  $('mEco').addEventListener('change', function () {
    var v = this.value.trim().toUpperCase();
    if (v && !VTGst.gstinValid(v)) { alert('That ECO GSTIN is not valid — check it.'); this.value = ecoGstinFor(d.eco); return; }
    GS.ret.eco[d.eco] = v || undefined; if (!v) delete GS.ret.eco[d.eco]; saveRet();
  });
}
function monthSummary(cm) {
  var tx = 0, tax = 0; cm.lines.forEach(function (l) { tx += l.txval; tax += l.iamt + l.camt + l.samt; });
  var cnt = function (k) { return cm.docSeries[k].reduce(function (a, s) { return a + s.totnum; }, 0); };
  var miss = PF[cm.card].slots.filter(function (sl) { return !sl.optional && !cm.files.some(function (f) { return f.slot === sl.key; }); }).map(function (sl) { return sl.label; });
  return '<b>' + monthName(cm.month) + ':</b> net taxable <b>₹' + inr(tx) + '</b> · tax ₹' + inr(tax) + ' · invoices ' + cnt('inv') + ', credit notes ' + cnt('cn') + (cnt('dn') ? ', debit notes ' + cnt('dn') : '') +
    (cm.info.months.length && cm.info.months[0].slice(-2) !== cm.month.slice(-2) ? '<br><span class="m-err">⚠ This file is mostly for ' + monthName(cm.info.months[0]) + ', not ' + monthName(cm.month) + ' — check the month tab.</span>' : '') +
    (cm.info.unknownStates.length ? '<br><span class="m-err">⚠ State(s) not recognised: ' + esc(cm.info.unknownStates.join(', ')) + '</span>' : '') +
    (miss.length ? '<br><span style="color:#B45309">Still to upload: ' + miss.join(', ') + '</span>' : '');
}
function loadJsZip() {
  if (window.JSZip) return Promise.resolve();
  return new Promise(function (ok, bad) { var s = document.createElement('script'); s.src = 'https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js'; s.onload = ok; s.onerror = function () { bad(new Error('Could not load the zip reader — unzip and upload the Excel / CSV.')); }; document.head.appendChild(s); });
}
function readWorkbook(file, slot) {
  var decode = function (b) { return new TextDecoder().decode(b); };
  if (/\.zip$/i.test(file.name)) {
    return loadJsZip().then(function () { return file.arrayBuffer(); }).then(function (b) { return JSZip.loadAsync(b); }).then(function (zip) {
      var names = Object.keys(zip.files).filter(function (n) { return !zip.files[n].dir && slot.zip.test(n); });
      if (!names.length) throw new Error('"' + file.name + '" has no ' + slot.label + ' inside.');
      return zip.files[names[0]].async('arraybuffer').then(function (b) { return { wb: /\.csv$/i.test(names[0]) ? XLSX.read(decode(b), { type: 'string', raw: true }) : XLSX.read(b, { type: 'array' }), name: file.name + ' › ' + names[0].split('/').pop() }; });
    });
  }
  return file.arrayBuffer().then(function (b) { return { wb: /\.csv$/i.test(file.name) ? XLSX.read(decode(b), { type: 'string', raw: true }) : XLSX.read(b, { type: 'array' }), name: file.name }; });
}
function sheetRows(wb, like) {
  var n = like ? wb.SheetNames.filter(function (x) { return x.toLowerCase().indexOf(like) >= 0; })[0] : null;
  return VTGst.rowsToObjects(XLSX, wb.Sheets[n || wb.SheetNames[0]]);
}
function uploadPlatform() {
  var card = GS.modal.card, m = GS.modal.month, d = PF[card], o = { sellerState: sellerState(), etin: ecoGstinFor(d.eco) }, jobs = [], errors = [];
  d.slots.forEach(function (sl) {
    var inp = $('mFile_' + sl.key); if (!inp || !inp.files.length) return;
    jobs.push(readWorkbook(inp.files[0], sl).then(function (got) {
      var parsed, rows;
      if (card === 'FLIPKART') {
        if (!got.wb.SheetNames.some(function (x) { return /sales report/i.test(x); })) throw new Error(got.name + ': no "Sales Report" sheet — download Reports Center → Tax Reports → Sales report.');
        var sr = sheetRows(got.wb, 'sales report'), cb = got.wb.SheetNames.some(function (x) { return /cash back/i.test(x); }) ? sheetRows(got.wb, 'cash back') : [];
        rows = sr.length + cb.length; parsed = VTGst.parseFlipkart(sr, cb, o);
      } else {
        var r = sheetRows(got.wb, card === 'MEESHO' && sl.key === 'invoices' ? 'invoice' : null); rows = r.length;
        if (sl.need && r.length && !Object.keys(r[0]).some(function (k) { return k.trim().toLowerCase() === sl.need.toLowerCase(); }))
          throw new Error(got.name + ' doesn\'t look like ' + sl.label + ' (column "' + sl.need + '" not found).');
        if (card === 'MEESHO') parsed = sl.key === 'sales' ? VTGst.parseMeesho(r, [], [], o) : sl.key === 'returns' ? VTGst.parseMeesho([], r, [], o) : VTGst.parseMeesho([], [], r, o);
        else if (sl.key === 'stock') parsed = { lines: [], docs: { inv: [], cn: [], dn: [] }, info: { stock: true } };
        else parsed = VTGst.parseAmazonMtr(r, card === 'AMAZON_B2B' ? 'B2B' : 'B2C', o);
      }
      var entry = VTGst.compactEntry(Object.assign({ platform: d.eco, month: m, etin: o.etin }, parsed));
      var id = GS.gstin + '_' + card + '_' + m + '_' + sl.key;
      var doc = { gstin: GS.gstin, card: card, month: m, slot: sl.key, file: got.name, rows: rows, entry: entry, importedAt: nowIso() };
      return col('gstImports').doc(id).set(doc).then(function () { GS.parts[card + '|' + m + '|' + sl.key] = Object.assign({ id: id }, doc); });
    }).catch(function (e) { errors.push(e.message || String(e)); }));
  });
  var msg = $('mMsg');
  if (!jobs.length) { msg.style.display = ''; msg.innerHTML = '<span class="m-err">Choose at least one file to upload.</span>'; return Promise.resolve(); }
  msg.style.display = ''; msg.textContent = 'Reading…';
  return Promise.all(jobs).then(function () {
    renderPlatformModal();
    var cm = cardMonth(card, m), mm = $('mMsg');
    if (errors.length) { mm.style.display = ''; mm.innerHTML = '<span class="m-err">' + errors.map(esc).join('<br>') + '</span>' + (cm ? '<br>' + monthSummary(cm) : ''); }
    if (GS.sec === 'import') renderImport();
  });
}
function deleteMonth(card, m, fromModal) {
  if (!confirm('Remove ' + PF[card].name + ' data for ' + monthName(m) + '?')) return;
  var keys = Object.keys(GS.parts).filter(function (k) { return k.indexOf(card + '|' + m + '|') === 0; });
  return Promise.all(keys.map(function (k) { return col('gstImports').doc(GS.parts[k].id).delete().then(function () { delete GS.parts[k]; }); }))
    .then(function () { if (fromModal) renderPlatformModal(); gsGo(GS.sec); });
}

/* ---------------- MANAGE DATA ---------------- */
function lineStats(lines, cdnr) {
  var s = { b2b: 0, b2c: 0, nil: 0, hsn: 0, tax: 0, cdnr: 0 };
  lines.forEach(function (l) {
    s.hsn += l.txval; s.tax += l.iamt + l.camt + l.samt;
    if (!l.rt) s.nil += l.txval; else if (l.registered) s.b2b += l.txval; else s.b2c += l.txval;
  });
  (cdnr || []).forEach(function (x) { s.cdnr += x.txval; });
  return s;
}
function needGstin(boxId) { if (GS.gstin && gsMonths().length) return false; $(boxId).innerHTML = noGstinBlock(); return true; }
function renderManage() {
  if (needGstin('mBody')) return;
  var groups = GROUPS.map(function (g) { return { g: g, rows: gsMonths().map(function (m) { return { m: m, e: groupMonth(g, m) }; }) }; }).filter(function (x) { return x.rows.some(function (r) { return r.e; }); });
  var all = allEntries(), tot = lineStats([].concat.apply([], all.map(function (e) { return e.lines; })));
  var h = '<div class="kpis">' +
    kpi('bi-shop', '#EAF1FE', '#2F6FED', 'Platforms', groups.length) + kpi('bi-currency-rupee', '#E7F8F1', '#0E9F77', 'Taxable sale', '₹' + inr(tot.hsn), '#0E9F77') +
    kpi('bi-receipt', '#FFF4E5', '#D97706', 'Total tax', '₹' + inr(tot.tax)) + kpi('bi-file-earmark-text', '#E6F7FA', '#0891B2', 'Invoice value', '₹' + inr(tot.hsn + tot.tax)) + '</div>';
  if (!groups.length) h += '<div class="gs-empty"><div class="ic"><i class="bi bi-cloud-arrow-up"></i></div><h4>Nothing imported yet</h4><p>Import your marketplace files first.</p><button class="btn btn-blue" onclick="gsGo(\'import\')">Go to Import Data</button></div>';
  groups.forEach(function (x) {
    var d = PF[x.g.cards[0]], gl = [].concat.apply([], x.rows.filter(function (r) { return r.e; }).map(function (r) { return r.e.lines; }));
    h += '<div class="tblc"><div class="tblc-h"><span class="lg" style="background:' + d.bg + '">' + d.letter + '</span><h4>' + d.name + '</h4>' + (x.g.eco !== 'AMAZON' ? '<span class="bd" style="font-size:13px;font-weight:700;background:#DCFCE7;color:#166534;border-radius:8px;padding:3px 10px">' + d.badge.replace(' / B2B', '') + '</span>' : '') +
      '<span class="sp"></span><span class="tx">Taxable: <b>₹' + inr(lineStats(gl).hsn) + '</b></span></div>' +
      '<table class="gt"><thead><tr><th>Month</th><th>B2B Sales</th><th>B2C Sales</th><th>CDNR</th><th>Nil Rated</th><th>HSN</th><th style="text-align:center">Actions</th></tr></thead><tbody>' +
      x.rows.map(function (r) {
        if (!r.e) return '<tr><td><b>' + monthName(r.m) + '</b></td><td colspan="5" class="dash" style="text-align:center">not imported</td><td></td></tr>';
        var s = lineStats(r.e.lines, r.e.cdnr), cell = function (v, kind) { return Math.abs(v) < 0.005 ? '<td class="dash">—</td>' : '<td class="lnk" onclick="showRecords(\'' + x.g.eco + '\',\'' + r.m + '\',\'' + kind + '\')">' + inr(v) + '</td>'; };
        return '<tr><td><b>' + monthName(r.m) + '</b></td>' + cell(s.b2b, 'b2b') + cell(s.b2c, 'b2c') + cell(s.cdnr, 'cdnr') + cell(s.nil, 'nil') + cell(s.hsn, 'hsn') +
          '<td style="text-align:center"><button class="btn btn-danger-o" title="Remove this month" onclick="deleteGroupMonth(\'' + x.g.eco + '\',\'' + r.m + '\')"><i class="bi bi-trash3"></i></button></td></tr>';
      }).join('') + '</tbody></table></div>';
  });
  $('mBody').innerHTML = h;
}
function kpi(icon, bg, fg, label, value, vcolor) {
  return '<div class="kpi"><span class="ic" style="background:' + bg + ';color:' + fg + '"><i class="bi ' + icon + '"></i></span><div><small>' + label + '</small><b' + (vcolor ? ' style="color:' + vcolor + '"' : '') + '>' + value + '</b></div></div>';
}
function deleteGroupMonth(eco, m) {
  var g = GROUPS.filter(function (x) { return x.eco === eco; })[0];
  if (!confirm('Remove ' + PF[g.cards[0]].name + ' data for ' + monthName(m) + '?')) return;
  var keys = Object.keys(GS.parts).filter(function (k) { var p = k.split('|'); return g.cards.indexOf(p[0]) >= 0 && p[1] === m; });
  Promise.all(keys.map(function (k) { return col('gstImports').doc(GS.parts[k].id).delete().then(function () { delete GS.parts[k]; }); })).then(renderManage);
}
function showRecords(eco, m, kind) {
  var g = GROUPS.filter(function (x) { return x.eco === eco; })[0], e = groupMonth(g, m), title = { b2b: 'B2B sales', b2c: 'B2C sales', nil: 'Nil rated', hsn: 'All sales (HSN)', cdnr: 'Credit notes to registered buyers' }[kind];
  var rows;
  if (kind === 'cdnr') rows = e.cdnr.map(function (x) { return [x.num, x.ctin, x.rt + '%', inr(x.txval), inr(x.tax)]; });
  else {
    var by = {};
    e.lines.filter(function (l) { return kind === 'hsn' || (kind === 'nil' ? !l.rt : (l.rt && (kind === 'b2b') === !!l.registered)); }).forEach(function (l) {
      var k = l.pos + '|' + l.rt + '|' + l.hsn; var r = by[k] = by[k] || { pos: l.pos, rt: l.rt, hsn: l.hsn, qty: 0, tx: 0, ig: 0, cg: 0, sg: 0 };
      r.qty += l.qty; r.tx += l.txval; r.ig += l.iamt; r.cg += l.camt; r.sg += l.samt;
    });
    rows = Object.values(by).sort(function (a, b) { return a.pos.localeCompare(b.pos) || a.rt - b.rt; }).map(function (r) {
      return [r.pos + ' - ' + VTGst.stateName(r.pos), r.hsn || '—', r.rt + '%', r2(r.qty), inr(r.tx), inr(r.ig), inr(r.cg), inr(r.sg)];
    });
  }
  var head = kind === 'cdnr' ? ['Note no.', 'Buyer GSTIN', 'Rate', 'Taxable', 'Tax'] : ['Place of supply', 'HSN', 'Rate', 'Qty', 'Taxable', 'IGST', 'CGST', 'SGST'];
  openModal('<div class="gs-mh"><div><h4>' + PF[g.cards[0]].name + ' · ' + monthName(m) + '</h4><div class="sub">' + title + ' — summed per state, rate and HSN</div></div><button class="x" onclick="gsCloseModal()">✕</button></div>' +
    '<div class="gs-mb"><table class="gt"><thead><tr>' + head.map(function (x) { return '<th>' + x + '</th>'; }).join('') + '</tr></thead><tbody>' +
    rows.map(function (r) { return '<tr>' + r.map(function (c) { return '<td>' + esc(c) + '</td>'; }).join('') + '</tr>'; }).join('') + '</tbody></table>' +
    '<p style="color:#6B7280;font-size:13.5px;margin-top:12px">To correct a figure, use <b>GSTR1 Report → View / Edit</b> (the imported files are never changed).</p></div>' +
    '<div class="gs-mf"><button class="btn btn-ghost" onclick="gsCloseModal()">Close</button></div>');
}

/* ---------------- TCS RECONCILE ---------------- */
function toolTcsValue(eco, m) {
  var g = GROUPS.filter(function (x) { return x.eco === eco; })[0], e = groupMonth(g, m);
  return e ? e.lines.reduce(function (a, l) { return a + (l.rt ? l.txval : 0); }, 0) : 0;
}
function renderTcs() {
  if (needGstin('tBody')) return;
  var ms = gsMonths(), groups = GROUPS.filter(function (g) { return ms.some(function (m) { return groupMonth(g, m); }); });
  var toolTot = 0, portTot = 0, mism = 0;
  groups.forEach(function (g) { ms.forEach(function (m) {
    var t = toolTcsValue(g.eco, m), p = (GS.ret.portal[g.eco] || {})[m];
    toolTot += t; if (p != null) { portTot += p; if (Math.abs(t - p) > 1) mism++; }
  }); });
  var h = '<div class="gs-panel" style="display:flex;gap:18px;align-items:center;border-style:dashed;margin-bottom:22px"><span class="kpi" style="border:0;padding:0"><span class="ic" style="background:#EAF1FE;color:#2F6FED"><i class="bi bi-cloud-arrow-up"></i></span></span>' +
    '<div style="flex:1"><h4 style="margin:0 0 4px;font-size:20px;color:#4B5563">Upload GST portal TCS report</h4><div style="color:#6B7280;margin-bottom:10px">Services → Returns → TDS and TCS credit received → Select period → Preview draft (Excel / ZIP)</div>' +
    '<div style="display:flex;max-width:620px"><input type="file" id="tFile" accept=".xlsx,.xls,.csv,.zip" style="flex:1;border:1px solid #DDE2EA;border-radius:10px 0 0 10px;padding:10px"><button class="btn btn-blue" style="border-radius:0 10px 10px 0" onclick="uploadPortalTcs()">Upload</button></div>' +
    '<div id="tMsg" style="margin-top:8px;font-size:14px"></div></div></div>';
  h += '<div class="kpis">' + kpi('bi-shop', '#EAF1FE', '#2F6FED', 'Platforms', groups.length) + kpi('bi-calculator', '#EEF2FF', '#4F46E5', 'Tool total', '₹' + inr(toolTot)) +
    kpi('bi-bank', '#F1F5F9', '#475569', 'Portal total', '₹' + inr(portTot)) + kpi('bi-exclamation-diamond', mism ? '#FFE4E6' : '#E7F8F1', mism ? '#E11D48' : '#0E9F77', 'Mismatched', mism, mism ? '#E11D48' : '#0E9F77') + '</div>';
  groups.forEach(function (g) {
    var d = PF[g.cards[0]];
    h += '<div class="tblc"><div class="tblc-h"><span class="lg" style="background:' + d.bg + '">' + d.letter + '</span><h4 style="color:#1F2937">' + d.name + '</h4><span class="sp"></span><span class="tx" style="font-family:ui-monospace,monospace;font-size:13px">' + esc(ecoGstinFor(g.eco)) + '</span></div>' +
      '<table class="gt"><thead><tr><th>Month</th><th>GST tool report</th><th>GST portal report</th><th>Difference</th></tr></thead><tbody>' +
      ms.map(function (m) {
        var t = toolTcsValue(g.eco, m), p = (GS.ret.portal[g.eco] || {})[m], df = p == null ? null : r2(t - p);
        return '<tr><td><b>' + monthName(m) + '</b></td><td style="color:var(--blue)">₹' + inr(t) + '</td>' +
          '<td class="lnk" title="Click to type the portal value" onclick="editPortal(\'' + g.eco + '\',\'' + m + '\')">' + (p == null ? '<span style="color:#9CA3AF">enter / upload</span>' : '₹' + inr(p)) + '</td>' +
          '<td>' + (df == null ? '<span class="dash">—</span>' : Math.abs(df) <= 1 ? '<span class="diff-ok">✓ matched</span>' : '<span class="diff-bad">₹' + inr(df) + '</span>') + '</td></tr>';
      }).join('') + '</tbody></table></div>';
  });
  if (!groups.length) h += '<p style="color:#6B7280">Import your marketplace files first.</p>';
  h += '<p style="color:#6B7280;font-size:13.5px">The portal shows what each marketplace reported in its GSTR-8 (net value of taxable supplies). A difference usually means a month\'s file is missing or a different month was uploaded. Amazon sales invoiced at 0% (tax code A_GEN_EXEMPT) carry no TCS, so they show ₹0.</p>';
  $('tBody').innerHTML = h;
}
function editPortal(eco, m) {
  var cur = (GS.ret.portal[eco] || {})[m];
  var v = prompt('GST portal value (net value of supplies) for ' + PF[GROUPS.filter(function (g) { return g.eco === eco; })[0].cards[0]].name + ', ' + monthName(m) + ':', cur == null ? '' : cur);
  if (v === null) return;
  GS.ret.portal[eco] = GS.ret.portal[eco] || {};
  if (String(v).trim() === '') delete GS.ret.portal[eco][m]; else GS.ret.portal[eco][m] = r2(parseFloat(String(v).replace(/[₹,\s]/g, '')) || 0);
  saveRet().then(renderTcs);
}
// GST portal "TDS and TCS credit received" export → { ECO: { 'YYYY-MM': net value } }
function parsePortalTcs(wb) {
  var out = {}, found = 0, ms = gsMonths();
  var pans = {}; Object.keys(VTGst.ECO).forEach(function (k) { pans[VTGst.ECO[k].pan] = k; });
  var MON = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
  var toMonth = function (v) {
    var s = String(v == null ? '' : v).trim().toLowerCase(); var mm;
    if ((mm = s.match(/^(\d{2})(\d{4})$/))) return mm[2] + '-' + mm[1];
    if ((mm = s.match(/^(\d{4})-(\d{2})/))) return mm[1] + '-' + mm[2];
    if ((mm = s.match(/([a-z]{3})[a-z]*[\s\-\/']*(\d{2,4})/))) { var i = MON.indexOf(mm[1]); var y = mm[2].length === 2 ? '20' + mm[2] : mm[2]; if (i >= 0) return y + '-' + String(i + 1).padStart(2, '0'); }
    return '';
  };
  wb.SheetNames.forEach(function (sn) {
    var rows = XLSX.utils.sheet_to_json(wb.Sheets[sn], { header: 1, defval: '' });
    var hi = rows.findIndex(function (r) { var t = r.join(' ').toLowerCase(); return /gstin/.test(t) && /(net|taxable|value|amount)/.test(t); });
    if (hi < 0) return;
    var hdr = rows[hi].map(function (c) { return String(c).toLowerCase(); });
    var gi = hdr.findIndex(function (c) { return /gstin/.test(c); });
    var pi = hdr.findIndex(function (c) { return /(period|month)/.test(c); });
    var vi = hdr.findIndex(function (c) { return /net.*(value|amount)|amount liable|taxable/.test(c); });
    if (vi < 0) vi = hdr.findIndex(function (c) { return /value/.test(c); });
    if (gi < 0 || vi < 0) return;
    rows.slice(hi + 1).forEach(function (r) {
      var g = String(r[gi] || '').trim().toUpperCase(); if (g.length !== 15) return;
      var eco = pans[g.slice(2, 12)]; if (!eco) return;
      var m = pi >= 0 ? toMonth(r[pi]) : (ms.length === 1 ? ms[0] : '');
      if (!m) return;
      var v = parseFloat(String(r[vi]).replace(/[₹,\s]/g, '')) || 0;
      out[eco] = out[eco] || {}; out[eco][m] = r2((out[eco][m] || 0) + v); found++;
    });
  });
  return { values: out, found: found };
}
function uploadPortalTcs() {
  var inp = $('tFile'); if (!inp.files.length) { $('tMsg').innerHTML = '<span class="m-err">Choose the file first.</span>'; return Promise.resolve(); }
  return readWorkbook(inp.files[0], { zip: /\.(xlsx|xls|csv)$/i, label: 'Excel' }).then(function (got) {
    var res = parsePortalTcs(got.wb);
    if (!res.found) { $('tMsg').innerHTML = '<span class="m-err">No marketplace rows found in this file. Click a value in the table to type it instead.</span>'; return; }
    Object.keys(res.values).forEach(function (eco) { GS.ret.portal[eco] = Object.assign(GS.ret.portal[eco] || {}, res.values[eco]); });
    return saveRet().then(function () { renderTcs(); $('tMsg').innerHTML = '<span style="color:#065F46">✓ Read ' + res.found + ' row(s) from ' + esc(got.name) + '.</span>'; });
  }).catch(function (e) { $('tMsg').innerHTML = '<span class="m-err">' + esc(e.message) + '</span>'; });
}

/* ---------------- GSTR1 REPORT ---------------- */
var UQC_DESC = { PCS: 'PIECES', NOS: 'NUMBERS', SET: 'SETS', KGS: 'KILOGRAMS', MTR: 'METERS', BOX: 'BOX', PAC: 'PACKS', OTH: 'OTHERS' };
function gsBuild() {
  var st = sellerState(), res = VTGst.buildGstr1([], { gstin: GS.gstin, stateCode: st, period: gsFpMonth() });
  var entries = allEntries();
  if (entries.length) VTGst.mergePlatformData(res, entries, { stateCode: st, uqc: 'PCS' });
  if (entries.some(function (e) { return e.stock; })) res.issues.push({ level: 'warn', msg: 'Amazon stock-transfer (FBA) file received — stock moved to another state is a supply to your own GSTIN there (B2B). It is not added automatically: add it as a B2B invoice.' });
  var J = res.json, E = GS.ret.edits || {}, R = res.rows;
  if (E.b2cs) {
    J.b2cs = E.b2cs.map(function (x) {
      var inter = x.pos !== st, tax = r2(x.tax);
      return Object.assign({ sply_ty: inter ? 'INTER' : 'INTRA', rt: Number(x.rt), typ: 'OE', pos: x.pos, txval: r2(x.txval) }, inter ? { iamt: tax } : { camt: r2(tax / 2), samt: r2(tax - r2(tax / 2)) }, { csamt: 0 });
    }).filter(function (x) { return x.pos && x.txval; });
    R.b2cs = J.b2cs.map(function (x) { return ['OE', x.pos + '-' + VTGst.stateName(x.pos), '', x.rt, x.txval, 0, '']; });
  }
  ['hsn_b2b', 'hsn_b2c'].forEach(function (k) {
    if (!E[k]) return;
    J.hsn = J.hsn || {}; J.hsn[k] = E[k].filter(function (h) { return h.hsn_sc; }).map(function (h, i) {
      return { num: i + 1, hsn_sc: String(h.hsn_sc), uqc: h.uqc || 'PCS', qty: r2(h.qty), rt: Number(h.rt), txval: r2(h.txval), iamt: r2(h.iamt), samt: r2(h.samt), camt: r2(h.camt), csamt: 0 };
    });
  });
  if (J.hsn) {
    R.hsnB2B = (J.hsn.hsn_b2b || []).map(hsnRow); R.hsnB2C = (J.hsn.hsn_b2c || []).map(hsnRow);
  }
  if (!GS.ret.b2cHsn && J.hsn) { delete J.hsn.hsn_b2c; R.hsnB2C = []; }
  if (E.docs) {
    J.doc_issue = { doc_det: [] }; R.docs = [];
    [[1, 'Invoices for outward supply'], [5, 'Credit Note'], [4, 'Debit Note']].forEach(function (t) {
      var rows = E.docs.filter(function (x) { return Number(x.doc_num) === t[0] && x.from; });
      if (!rows.length) return;
      J.doc_issue.doc_det.push({ doc_num: t[0], doc_typ: t[1], docs: rows.map(function (x, i) { var tn = parseInt(x.totnum, 10) || 0, c = parseInt(x.cancel, 10) || 0; return { num: i + 1, from: x.from, to: x.to, totnum: tn, cancel: c, net_issue: tn - c }; }) });
      rows.forEach(function (x) { R.docs.push([t[1], x.from, x.to, parseInt(x.totnum, 10) || 0, parseInt(x.cancel, 10) || 0]); });
    });
  }
  if (E.supeco) J.supeco = { clttx: E.supeco.map(function (x) { return { etin: x.etin, suppval: r2(x.suppval), igst: r2(x.igst), cgst: r2(x.cgst), sgst: r2(x.sgst), cess: 0, flag: 'N' }; }) };
  return res;
}
function hsnRow(h) { return [h.hsn_sc, '', h.uqc + '-' + (UQC_DESC[h.uqc] || 'OTHERS'), h.qty, r2(h.txval + h.iamt + h.camt + h.samt), h.rt, h.txval, h.iamt, h.camt, h.samt, 0]; }
function sumRow(list, f) { return list.reduce(function (a, x) { return a + (Number(f(x)) || 0); }, 0); }
function renderReport() {
  if (needGstin('rBody')) return;
  var res = gsBuild(), J = res.json, E = GS.ret.edits || {};
  var ed = function (k) { return E[k] ? '<span class="edited">edited</span>' : ''; };
  var sumTable = function (list) {
    var tx = sumRow(list, function (x) { return x.txval; }), ig = sumRow(list, function (x) { return x.iamt; }), cg = sumRow(list, function (x) { return x.camt; }), sg = sumRow(list, function (x) { return x.samt; });
    return '<table class="gt"><thead><tr><th style="text-align:center">Records</th><th>Taxable (₹)</th><th>IGST (₹)</th><th>CGST (₹)</th><th>SGST (₹)</th><th>Invoice (₹)</th></tr></thead><tbody><tr><td style="text-align:center">' + list.length + '</td><td style="color:#0E9F77">' + inr(tx) + '</td><td>' + inr(ig) + '</td><td>' + inr(cg) + '</td><td>' + inr(sg) + '</td><td>' + inr(tx + ig + cg + sg) + '</td></tr></tbody></table>';
  };
  var card = function (num, icon, bg, fg, title, sub, body, editKey, extra) {
    return '<div class="sumc"><div class="sumc-h"><span class="ic" style="background:' + bg + ';color:' + fg + '"><i class="bi ' + icon + '"></i></span><div><h4>' + num + ' - ' + title + (editKey ? ed(editKey) : '') + '</h4><p>' + sub + '</p></div><span class="sp"></span>' +
      (extra || '') + (editKey ? '<button class="btn btn-ghost no-print" onclick="openEditor(\'' + editKey + '\')"><i class="bi bi-eye"></i> View / Edit</button>' : '') + '</div>' + body + '</div>';
  };
  var errs = res.issues.filter(function (i) { return i.level === 'error'; });
  var h = res.issues.length ? '<div class="issues warn"><b>Check before filing: ' + errs.length + ' error(s), ' + (res.issues.length - errs.length) + ' warning(s)</b><ul>' + res.issues.map(function (i) { return '<li>' + esc(i.msg) + '</li>'; }).join('') + '</ul></div>' : '<div class="issues ok"><b>✓ No problems found.</b></div>';
  if ((J.b2b || []).length) {
    var items = []; J.b2b.forEach(function (c) { c.inv.forEach(function (i) { i.itms.forEach(function (t) { items.push(t.itm_det); }); }); });
    h += card('4', 'bi-building', '#EEF2FF', '#4F46E5', 'B2B Invoices', 'Sales to GST-registered buyers', sumTable(items));
  }
  if ((J.cdnr || []).length) {
    var nts = []; J.cdnr.forEach(function (c) { c.nt.forEach(function (n) { n.itms.forEach(function (t) { nts.push(t.itm_det); }); }); });
    h += card('9B', 'bi-arrow-counterclockwise', '#FFE4E6', '#E11D48', 'Credit / Debit Notes (registered)', 'Returns from GST-registered buyers', sumTable(nts));
  }
  h += card('7', 'bi-people', '#E7F8F1', '#0E9F77', 'B2CS (Others)', 'Everyday sales to consumers (no GST number)', sumTable(J.b2cs || []), 'b2cs');
  var nil = (J.nil && J.nil.inv) || [];
  var NIL_LABEL = { INTRB2B: 'Inter-State supplies to registered persons', INTRAB2B: 'Intra-State supplies to registered persons', INTRB2C: 'Inter-State supplies to unregistered persons', INTRAB2C: 'Intra-State supplies to unregistered persons' };
  h += card('8', 'bi-slash-circle', '#F1F5F9', '#475569', 'Nil Rated / Exempt / Non-GST', 'Sales where no GST is charged',
    '<table class="gt"><thead><tr><th>Supply type</th><th>Nil rated</th><th>Exempted</th><th>Non-GST</th></tr></thead><tbody>' +
    (nil.length ? nil.map(function (x) { return '<tr><td>' + NIL_LABEL[x.sply_ty] + '</td><td>' + inr(x.nil_amt) + '</td><td>' + inr(x.expt_amt) + '</td><td>' + inr(x.ngsup_amt) + '</td></tr>'; }).join('') : '<tr><td colspan="4" class="dash" style="text-align:center">none</td></tr>') + '</tbody></table>');
  var hs = [].concat((J.hsn && J.hsn.hsn_b2b) || [], (J.hsn && J.hsn.hsn_b2c) || []);
  h += card('12', 'bi-box', '#E6F7FA', '#0891B2', 'HSN Summary', 'Your sales grouped by product code and rate', sumTable(hs), 'hsn_b2c',
    '<button class="btn btn-ghost no-print" style="margin-right:8px" onclick="openEditor(\'hsn_b2b\')">B2B rows' + ed('hsn_b2b') + '</button>');
  var docs = []; ((J.doc_issue && J.doc_issue.doc_det) || []).forEach(function (d) { docs = docs.concat(d.docs); });
  var dt = sumRow(docs, function (x) { return x.totnum; }), dc = sumRow(docs, function (x) { return x.cancel; });
  h += card('13', 'bi-file-earmark-text', '#EEF2FF', '#4F46E5', 'Documents Issued', 'Invoice / note number ranges issued',
    '<table class="gt"><thead><tr><th style="text-align:center">Records</th><th style="text-align:center">Total documents</th><th style="text-align:center">Cancelled</th><th>Net issued</th></tr></thead><tbody><tr><td style="text-align:center">' + docs.length + '</td><td style="text-align:center;color:#0E9F77">' + dt + '</td><td style="text-align:center">' + dc + '</td><td>' + (dt - dc) + '</td></tr></tbody></table>', 'docs');
  var eco = (J.supeco && J.supeco.clttx) || [], ecoName = function (g) { var k = Object.keys(VTGst.ECO).filter(function (k) { return VTGst.ECO[k].pan === String(g).slice(2, 12); })[0]; return k ? VTGst.ECO[k].name : 'Other'; };
  h += card('14', 'bi-shop', '#FFF4E5', '#D97706', 'Supplies via E-Commerce Operators (u/s 52)' + ed('supeco'), 'Sales collected through e-commerce portals',
    '<table class="gt"><thead><tr><th>Portal</th><th>GSTIN of ecommerce (not your GSTIN)</th><th>Net value of supplies (₹)</th><th>Integrated tax (₹)</th><th>Central tax (₹)</th><th>State/UT tax (₹)</th><th class="no-print"></th></tr></thead><tbody>' +
    (eco.length ? eco.map(function (x, i) { return '<tr><td>' + ecoName(x.etin) + '</td><td style="font-family:ui-monospace,monospace">' + esc(x.etin) + '</td><td>' + inr(x.suppval) + '</td><td>' + inr(x.igst) + '</td><td>' + inr(x.cgst) + '</td><td>' + inr(x.sgst) + '</td><td class="no-print"><button class="btn btn-ghost" style="padding:8px 10px" onclick="openEditor(\'supeco\',' + i + ')"><i class="bi bi-pencil-fill"></i></button></td></tr>'; }).join('') : '<tr><td colspan="7" class="dash" style="text-align:center">none</td></tr>') + '</tbody></table>');
  h += '<div class="sumc" style="padding:22px 26px"><div style="display:flex;gap:18px;align-items:center"><button class="toggle' + (GS.ret.b2cHsn ? ' on' : '') + ' no-print" onclick="toggleB2cHsn()" aria-label="B2C HSN"></button>' +
    '<div><div style="font-size:21px;color:#4B5563">B2C HSN <i class="bi bi-question-circle" title="Table 12 B2C tab: HSN-wise summary of sales to consumers."></i></div><div style="color:#6B7280">Mandatory if turnover exceeds ₹5 crore. Turn off only if your CA advises — the portal\'s Table 12 B2C tab expects it for most sellers.</div></div></div>' +
    '<hr style="border:0;border-top:1px solid var(--line);margin:20px 0"><h3 style="text-align:center;color:var(--blue);margin:0 0 6px;font-size:26px">Return of ' + monthName(gsFpMonth()) + ' - ' + gsFpMonth().slice(0, 4) + '</h3>' +
    '<div class="dl no-print"><button class="btn btn-blue" onclick="downloadExcel()"><i class="bi bi-file-earmark-excel-fill"></i><span>GSTR1<br>Excel Download</span></button>' +
    '<button class="btn btn-blue" onclick="downloadJson()"><i class="bi bi-filetype-json"></i><span>GSTR1<br>Json Download</span></button>' +
    '<button class="btn rep" onclick="window.print()"><i class="bi bi-file-earmark-bar-graph"></i><span>Report<br>(PDF)</span></button></div></div>';
  $('rBody').innerHTML = h;
}
function toggleB2cHsn() { GS.ret.b2cHsn = !GS.ret.b2cHsn; saveRet().then(renderReport); }
function fileTag() { return GS.gstin + '_' + (GS.type === 'quarterly' ? 'quarterly_' : 'monthly_') + gsFp(); }
function downloadJson() {
  var res = gsBuild(), errs = res.issues.filter(function (i) { return i.level === 'error'; }).length;
  if (errs && !confirm(errs + ' problem(s) could make the GST portal reject this file. Download anyway?')) return;
  VTGst.downloadJson(res.json, 'GSTR1_returns_' + fileTag() + '.json');
}
function downloadExcel() { var res = gsBuild(); XLSX.writeFile(VTGst.gstr1Workbook(XLSX, res), 'GSTR1_' + fileTag() + '.xlsx'); }

/* ----- View / Edit (manual corrections, saved per GSTIN & period) ----- */
var EDITORS = {
  b2cs: { title: '7 - B2CS (Others)', cols: [['pos', 'State code'], ['rt', 'Rate %'], ['txval', 'Taxable (₹)'], ['tax', 'Tax (₹)']],
    from: function (J) { return (J.b2cs || []).map(function (x) { return { pos: x.pos, rt: x.rt, txval: x.txval, tax: r2((x.iamt || 0) + (x.camt || 0) + (x.samt || 0)) }; }); },
    blank: { pos: '', rt: 5, txval: 0, tax: 0 } },
  hsn_b2c: { title: '12 - HSN Summary (B2C)', cols: [['hsn_sc', 'HSN'], ['uqc', 'UQC'], ['qty', 'Qty'], ['rt', 'Rate %'], ['txval', 'Taxable'], ['iamt', 'IGST'], ['camt', 'CGST'], ['samt', 'SGST']],
    from: function (J) { return ((J.hsn || {}).hsn_b2c || []).map(function (h) { return Object.assign({}, h); }); }, blank: { hsn_sc: '', uqc: 'PCS', qty: 0, rt: 5, txval: 0, iamt: 0, camt: 0, samt: 0 } },
  hsn_b2b: { title: '12 - HSN Summary (B2B)', cols: [['hsn_sc', 'HSN'], ['uqc', 'UQC'], ['qty', 'Qty'], ['rt', 'Rate %'], ['txval', 'Taxable'], ['iamt', 'IGST'], ['camt', 'CGST'], ['samt', 'SGST']],
    from: function (J) { return ((J.hsn || {}).hsn_b2b || []).map(function (h) { return Object.assign({}, h); }); }, blank: { hsn_sc: '', uqc: 'PCS', qty: 0, rt: 5, txval: 0, iamt: 0, camt: 0, samt: 0 } },
  docs: { title: '13 - Documents Issued', cols: [['doc_num', 'Type (1 inv / 5 CN / 4 DN)'], ['from', 'From'], ['to', 'To'], ['totnum', 'Total'], ['cancel', 'Cancelled']],
    from: function (J) { var out = []; ((J.doc_issue || {}).doc_det || []).forEach(function (d) { d.docs.forEach(function (x) { out.push({ doc_num: d.doc_num, from: x.from, to: x.to, totnum: x.totnum, cancel: x.cancel }); }); }); return out; },
    blank: { doc_num: 1, from: '', to: '', totnum: 0, cancel: 0 } },
  supeco: { title: '14 - Supplies via E-Commerce Operators', cols: [['etin', 'ECO GSTIN'], ['suppval', 'Net value'], ['igst', 'IGST'], ['cgst', 'CGST'], ['sgst', 'SGST']],
    from: function (J) { return ((J.supeco || {}).clttx || []).map(function (x) { return Object.assign({}, x); }); }, blank: { etin: '', suppval: 0, igst: 0, cgst: 0, sgst: 0 } }
};
var EDIT_ROWS = null, EDIT_KEY = null;
function openEditor(key, focusRow, addBlank) {
  var ed = EDITORS[key], res = gsBuild();
  EDIT_KEY = key; EDIT_ROWS = GS.ret.edits[key] ? JSON.parse(JSON.stringify(GS.ret.edits[key])) : ed.from(res.json);
  if (key === 'hsn_b2c' && !GS.ret.edits[key] && !GS.ret.b2cHsn) EDIT_ROWS = [];
  if (addBlank) EDIT_ROWS.push(Object.assign({}, ed.blank));
  drawEditor(focusRow);
}
function drawEditor(focusRow) {
  var ed = EDITORS[EDIT_KEY];
  openModal('<div class="gs-mh"><div><h4>' + ed.title + '</h4><div class="sub">Changes are saved for ' + esc(GS.gstin) + ' · ' + monthShort(gsFpMonth()) + '. The imported files are never changed.</div></div><button class="x" onclick="gsCloseModal()">✕</button></div>' +
    '<div class="gs-mb"><table class="ed"><thead><tr>' + ed.cols.map(function (c) { return '<th>' + c[1] + '</th>'; }).join('') + '<th></th></tr></thead><tbody>' +
    EDIT_ROWS.map(function (r, i) {
      return '<tr' + (i === focusRow ? ' style="background:#FFFBEB"' : '') + '>' + ed.cols.map(function (c) { return '<td><input data-r="' + i + '" data-k="' + c[0] + '" value="' + esc(r[c[0]] == null ? '' : r[c[0]]) + '"></td>'; }).join('') +
        '<td><button class="btn btn-danger-o" style="padding:6px 10px" onclick="EDIT_ROWS.splice(' + i + ',1);drawEditor()"><i class="bi bi-trash3"></i></button></td></tr>';
    }).join('') + '</tbody></table>' +
    '<button class="btn btn-ghost" style="margin-top:10px" onclick="collectEditor();EDIT_ROWS.push(Object.assign({},EDITORS[EDIT_KEY].blank));drawEditor(EDIT_ROWS.length-1)"><i class="bi bi-plus-lg"></i> Add row</button></div>' +
    '<div class="gs-mf">' + (GS.ret.edits[EDIT_KEY] ? '<button class="btn btn-danger-o" onclick="resetEditor()">Reset to imported data</button><span style="flex:1"></span>' : '') +
    '<button class="btn btn-ghost" onclick="gsCloseModal()">Cancel</button><button class="btn btn-blue" onclick="saveEditor()">Save changes</button></div>');
  document.querySelectorAll('#gsMbox input[data-r]').forEach(function (inp) { inp.addEventListener('change', collectEditor); });
}
function collectEditor() {
  document.querySelectorAll('#gsMbox input[data-r]').forEach(function (inp) {
    var r = EDIT_ROWS[+inp.dataset.r], k = inp.dataset.k, v = inp.value.trim();
    r[k] = /^(pos|hsn_sc|uqc|from|to|etin)$/.test(k) ? v.toUpperCase().replace(/^(\d)$/, '0$1') : (parseFloat(v.replace(/[₹,\s]/g, '')) || 0);
  });
}
function saveEditor() {
  collectEditor();
  if (EDIT_KEY === 'b2cs' && EDIT_ROWS.some(function (r) { return !/^\d{2}$/.test(String(r.pos)); })) { alert('State codes must be 2 digits (e.g. 09 for Uttar Pradesh).'); return; }
  if (EDIT_KEY === 'supeco' && EDIT_ROWS.some(function (r) { return !VTGst.gstinValid(r.etin); })) { alert('An ECO GSTIN is not valid — check it.'); return; }
  GS.ret.edits[EDIT_KEY] = EDIT_ROWS;
  saveRet().then(function () { gsCloseModal(); renderReport(); });
}
function resetEditor() {
  if (!confirm('Discard your changes to this section and use the imported data again?')) return;
  delete GS.ret.edits[EDIT_KEY]; saveRet().then(function () { gsCloseModal(); renderReport(); });
}
function gsToggleAdd(e) { e.stopPropagation(); $('addMenu').classList.toggle('on'); }
document.addEventListener('click', function () { var m = $('addMenu'); if (m) m.classList.remove('on'); });
function gsAddEntry(key) { $('addMenu').classList.remove('on'); if (!GS.gstin) { gsGo('profile'); return; } openEditor(key, undefined, true); drawEditor(EDIT_ROWS.length - 1); }

/* ---------------- modal ---------------- */
function openModal(html, small) { var b = $('gsMbox'); b.className = 'gs-mbox' + (small ? ' sm' : ''); b.innerHTML = html; $('gsModal').classList.add('on'); }
function gsCloseModal() { $('gsModal').classList.remove('on'); if (GS.sec === 'import') renderImport(); }

/* ---------------- start ---------------- */
(function init() {
  var d = defaultPeriod(GS.type); GS.pkey = d.pkey; GS.fy = d.fy;
  try { var s = JSON.parse(sessionStorage.getItem('gsSel') || 'null'); if (s && s.gstin) { GS.gstin = s.gstin; GS.type = s.type || GS.type; GS.pkey = s.pkey || GS.pkey; GS.fy = s.fy || GS.fy; } } catch (e) {}
  D.type = GS.type; D.pkey = GS.pkey; D.fy = GS.fy;
  fillPeriodSelects();
  var start = (location.hash || '#profile').slice(1);
  firebase.auth().onAuthStateChanged(function (user) {
    if (!user) return;
    GS.uid = user.uid;
    loadSaved().then(function () {
      if (!GS.gstin) return;
      $('pGstin').value = GS.gstin;
      return loadParts().then(loadRet);
    }).then(function () { gsGo(['profile', 'import', 'manage', 'tcs', 'report'].indexOf(start) >= 0 ? start : 'profile'); });
  });
  gsGo('profile');
})();
