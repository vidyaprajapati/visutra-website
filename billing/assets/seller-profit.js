/* VISUTRA — SELLER profit page (Billing → Profit & Graphs).
   Two streams, one report:
     • SALES TO BUYERS  — worked out live from your invoices:  revenue (ex-GST) − units × cost on the invoice date.
     • E-COMMERCE       — Meesho / Flipkart payment files you upload (any month): settlement (GST out) − cost,
                          with return charges and customer state. Stored by the shared engine (label-stock-core.js,
                          side 'seller') — one record per order, never counted twice. NEVER touches stock.
   Cost per unit: your typed cost for the product, else the average of your supplier purchases up to the sale date.
   Pure calculations live in profit-tools.js (VPT). Needs billing-app.js globals: currentUser, productsCache,
   skuMappingsCache, purchasesCache, loadPurchases(), loadSkuMappings(), esc(), showMsg(). */
let spInvoices = [], spInvMonths = [], spEcomMonths = [], spTimeline = {};
let spSheets = [], spBuilt = null, spSkuRows = [], spMap = {}, spCostEdits = {};

const spEl = id => document.getElementById(id);
const spInr = n => (Number(n) < 0 ? '−' : '') + '₹' + Math.abs(Number(n) || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const spCol = n => (Number(n) < 0 ? 'color:var(--paprika-dark)' : Number(n) > 0 ? 'color:#0E7C6B' : '');
const spMonthLabel = m => new Date(m + '-01T00:00:00').toLocaleDateString('en-IN', { month: 'long', year: 'numeric' });
const spMonthShort = m => new Date(m + '-01T00:00:00').toLocaleDateString('en-IN', { month: 'short', year: 'numeric' });
const spToday = () => new Date().toISOString().slice(0, 10);

/* ---------------- open / load ---------------- */
async function sellerProfitOpen(){
  try{
    if(!purchasesCache.length) await loadPurchases();
    if(!skuMappingsCache.length) await loadSkuMappings();
    const base = db.collection('users').doc(currentUser.uid);
    const [inv, eco] = await Promise.all([base.collection('invoices').get(), base.collection('sellerMonthlyProfit').get()]);
    spInvoices = inv.docs.map(d => ({ id: d.id, ...d.data() }));
    spEcomMonths = eco.docs.map(d => ({ id: d.id, ...d.data() }));
    spTimeline = VPT.costTimeline(purchasesCache);
    spRecompute();
  }catch(err){ console.error(err); showMsg('spMsg', 'Could not load your profit data: ' + err.message, false); }
}
// cost of a product on a date: typed cost > purchase average up to that date
function spCostOf(productId, date){
  const p = productsCache.find(x => x.id === productId);
  return VPT.costAt(spTimeline, productId, date, p && p.costPrice);
}
function spRecompute(){
  spInvMonths = VPT.invoiceMonths(spInvoices, spCostOf);
  spRenderCosts();
  spRenderReport();
}

/* ---------------- 1. product costs ---------------- */
function spRenderCosts(){
  const SRC = { manual: ['typed by you', ''], purchases: ['your purchases', ''], missing: ['no purchase yet — type it', 'bad'] };
  spEl('spCostTable').innerHTML = productsCache.slice().sort((a, b) => (a.name || '').localeCompare(b.name || '')).map(p => {
    const c = spCostOf(p.id, spToday()), [lbl, cls] = SRC[c.source] || SRC.missing, price = Number(p.price) || 0, per = Math.round((price - c.cost) * 100) / 100;
    return `<tr><td><b>${esc(p.name)}</b></td><td>${spInr(price)}</td>
      <td style="white-space:nowrap"><input type="number" min="0" step="0.01" value="${c.cost || ''}" placeholder="cost" onchange="spSaveCost('${p.id}', this.value)" style="width:96px;padding:3px 6px"></td>
      <td><span class="badge ${cls}">${lbl}</span></td>
      <td style="${c.cost ? spCol(per) : ''}">${c.cost ? spInr(per) : '—'}</td><td>${c.cost && price ? Math.round(per / price * 1000) / 10 + '%' : '—'}</td></tr>`;
  }).join('') || '<tr><td colspan="6" style="color:var(--muted)">No products yet — add them under Products.</td></tr>';
}
async function spSaveCost(productId, value){
  const v = parseFloat(value), cost = isFinite(v) && v > 0 ? Math.round(v * 100) / 100 : 0;     // empty / 0 = back to the purchase average
  await db.collection('users').doc(currentUser.uid).collection('products').doc(productId).set({ costPrice: cost }, { merge: true });
  const p = productsCache.find(x => x.id === productId); if(p) p.costPrice = cost;
  spRecompute();
}

/* ---------------- 3. report + graphs ---------------- */
function spRenderReport(){
  const streamSel = spEl('spStream').value, include = { buyers: streamSel !== 'ecommerce', ecommerce: streamSel !== 'buyers' };
  const all = VPT.mergeStreams(spInvMonths, spEcomMonths);                     // table: always both streams
  const desc = all.slice().reverse();
  spEl('spMonthsTable').innerHTML = desc.map(m => `<tr><td data-sort="${esc(m.month)}-01"><b>${esc(spMonthLabel(m.month))}</b></td>
      <td>${m.streams.buyers.soldUnits}</td><td style="${spCol(m.streams.buyers.profit)}">${spInr(m.streams.buyers.profit)}</td>
      <td>${m.streams.ecommerce.soldUnits}</td><td>${m.streams.ecommerce.returnUnits}</td><td>${spInr(m.streams.ecommerce.returnCharges)}</td><td style="${spCol(m.streams.ecommerce.profit)}">${spInr(m.streams.ecommerce.profit)}</td>
      <td>${spInr(m.revenue)}</td><td style="${spCol(m.profit)}"><b>${spInr(m.profit)}</b></td><td>${m.margin}%</td></tr>`).join('')
    || '<tr><td colspan="10" style="color:var(--muted)">No sales yet — raise an invoice, or upload your e-commerce payment files above.</td></tr>';
  const T = all.reduce((a, m) => ({ rev: a.rev + m.revenue, cogs: a.cogs + m.cogs, profit: a.profit + m.profit, b: a.b + m.streams.buyers.profit, e: a.e + m.streams.ecommerce.profit, rc: a.rc + m.returnCharges }), { rev: 0, cogs: 0, profit: 0, b: 0, e: 0, rc: 0 });
  spEl('spTotals').innerHTML = all.length ? `All ${all.length} month(s): revenue ${spInr(T.rev)} − cost ${spInr(T.cogs)} = <b style="${spCol(T.profit)}">profit ${spInr(T.profit)}</b> (sales to buyers ${spInr(T.b)} + e-commerce ${spInr(T.e)}) · return charges ${spInr(T.rc)}, already inside the e-commerce profit` : '';
  const missing = spInvMonths.reduce((a, m) => ({ u: a.u + m.missingCostUnits, p: Object.assign(a.p, m.missingProducts) }), { u: 0, p: {} });
  spEl('spCostWarn').innerHTML = missing.u ? `<div class="msg error" style="margin:0 0 10px">${missing.u} unit(s) on your invoices have no cost yet (${esc(Object.keys(missing.p).slice(0, 5).join(', '))}) — their profit is overstated. Type a cost in <b>1. Product costs</b>.</div>` : '';

  // range selects: oldest → newest, default the last 12 months
  const months = all.map(m => m.month), opts = months.map(m => `<option value="${esc(m)}">${esc(spMonthShort(m))}</option>`).join('');
  const fromEl = spEl('spFrom'), toEl = spEl('spTo'), kf = fromEl.value, kt = toEl.value;
  if(fromEl.options.length !== months.length || kf === '' ){
    const prevLast = toEl.options.length ? toEl.options[toEl.options.length - 1].value : '';
    fromEl.innerHTML = opts; toEl.innerHTML = opts;
    fromEl.value = kf && months.includes(kf) ? kf : (months[Math.max(0, months.length - 12)] || '');
    // "To" follows the newest month (new data must show up) unless you picked an earlier month on purpose
    toEl.value = kt && months.includes(kt) && kt !== prevLast ? kt : (months[months.length - 1] || '');
  }
  const ms = VPT.monthsInRange(VPT.mergeStreams(spInvMonths, spEcomMonths, include), fromEl.value, toEl.value);
  const both = VPT.monthsInRange(all, fromEl.value, toEl.value), labels = ms.map(m => spMonthShort(m.month));
  spEl('spChSales').innerHTML = VPT.barChartSvg({ title: 'Monthly units sold and returned', labels, fmt: VPT.unitsFmt, series: [
    { name: 'Units sold', values: ms.map(m => m.soldUnits), color: '#2E4374' }, { name: 'Returned / RTO units', values: ms.map(m => m.returnUnits), color: '#D97706' }] });
  spEl('spChMoney').innerHTML = VPT.barChartSvg({ title: 'Monthly revenue and profit', labels, fmt: VPT.inrShort, series: [
    { name: 'Revenue (ex-GST)', values: ms.map(m => m.revenue), color: '#E0531A' }, { name: 'Profit', values: ms.map(m => m.profit), color: '#16A34A', negColor: '#DC2626' }] });
  spEl('spChStreams').innerHTML = VPT.barChartSvg({ title: 'Profit by source', labels: both.map(m => spMonthShort(m.month)), fmt: VPT.inrShort, series: [
    { name: 'Sales to buyers', values: both.map(m => m.streams.buyers.profit), color: '#2E4374', negColor: '#DC2626' }, { name: 'E-commerce', values: both.map(m => m.streams.ecommerce.profit), color: '#0E9F8E', negColor: '#DC2626' }] });
  spEl('spChReturns').innerHTML = VPT.barChartSvg({ title: 'Monthly returned units', labels, fmt: VPT.unitsFmt, series: [{ name: 'Returned / RTO units', values: ms.map(m => m.returnUnits), color: '#D97706' }] });
  spEl('spChCharges').innerHTML = VPT.barChartSvg({ title: 'Monthly return charges', labels, fmt: VPT.inrShort, series: [{ name: 'Return charges', values: ms.map(m => m.returnCharges || 0), color: '#DC2626' }] });
  const states = VPT.sumStates(ms), top = (key, n) => VPT.topWithOther(states, n || 12, key), rows = (list, key, note) => list.map(r => ({ label: r.state, value: r[key], note: note(r) }));
  spEl('spChStateSales').innerHTML = VPT.hBarChartSvg({ title: 'State-wise units sold', color: '#2E4374', rows: rows(top('soldUnits'), 'soldUnits', r => VPT.inrShort(r.revenue)) });
  spEl('spChStateProfit').innerHTML = VPT.hBarChartSvg({ title: 'State-wise profit', color: '#16A34A', negColor: '#DC2626', fmt: VPT.inrShort, rows: rows(top('profit'), 'profit', r => r.margin + '% margin') });
  spEl('spChStateReturns').innerHTML = VPT.hBarChartSvg({ title: 'State-wise returned units', color: '#D97706', rows: rows(top('returnUnits'), 'returnUnits', r => r.returnRate + '% of orders · ' + VPT.inrShort(r.returnCharges)) });
  const byProd = {}, byBuyer = {};
  ms.forEach(m => {
    Object.entries(m.byProduct || {}).forEach(([k, p]) => { const a = byProd[k] = byProd[k] || { name: p.name || k, profit: 0, soldUnits: 0 }; a.profit += p.profit; a.soldUnits += p.soldUnits; });
    Object.entries(m.byBuyer || {}).forEach(([k, p]) => { const a = byBuyer[k] = byBuyer[k] || { name: k, profit: 0, soldUnits: 0, revenue: 0, cogs: 0 }; a.profit += p.profit; a.soldUnits += p.soldUnits; a.revenue += p.revenue; a.cogs += p.cogs; });
  });
  spEl('spChProduct').innerHTML = VPT.hBarChartSvg({ title: 'Profit by product', color: '#16A34A', negColor: '#DC2626', fmt: VPT.inrShort,
    rows: Object.values(byProd).sort((a, b) => b.profit - a.profit).slice(0, 12).map(p => ({ label: p.name, value: Math.round(p.profit * 100) / 100, note: p.soldUnits + ' sold' })) });
  const buyers = Object.values(byBuyer).sort((a, b) => b.profit - a.profit);
  spEl('spChBuyers').innerHTML = VPT.hBarChartSvg({ title: 'Top buyers by profit', color: '#2E4374', negColor: '#DC2626', fmt: VPT.inrShort,
    rows: buyers.slice(0, 12).map(b => ({ label: b.name, value: Math.round(b.profit * 100) / 100, note: b.soldUnits + ' units' })) });
  spEl('spBuyersTable').innerHTML = buyers.map(b => `<tr><td><b>${esc(b.name)}</b></td><td>${b.soldUnits}</td><td>${spInr(b.revenue)}</td><td>${spInr(b.cogs)}</td>
      <td style="${spCol(b.profit)}"><b>${spInr(b.profit)}</b></td><td>${b.revenue > 0 ? Math.round(b.profit / b.revenue * 1000) / 10 : 0}%</td></tr>`).join('')
    || '<tr><td colspan="6" style="color:var(--muted)">No invoices in this period.</td></tr>';
  spEl('spStatesTable').innerHTML = states.slice().sort((a, b) => b.soldUnits - a.soldUnits).map(r => `<tr><td><b>${esc(r.state)}</b></td><td>${r.soldUnits}</td><td>${r.returnUnits}</td><td>${r.returnRate}%</td>
      <td>${spInr(r.returnCharges)}</td><td>${spInr(r.revenue)}</td><td style="${spCol(r.profit)}"><b>${spInr(r.profit)}</b></td><td>${r.margin}%</td></tr>`).join('')
    || '<tr><td colspan="8" style="color:var(--muted)">No data in this period yet.</td></tr>';
  spRefreshCaptureCount();
  if(typeof EXP !== 'undefined') EXP.renderNet({ el: spEl('spNetBox'), db, uid: currentUser.uid, side: 'seller', link: 'expenses.html?side=seller',
    gross: all.map(m => ({ month: m.month, profit: m.profit })), inr: spInr, esc, monthLabel: spMonthLabel });
  const unk = states.find(r => r.state === 'Unknown');
  spEl('spStateHint').innerHTML = unk && unk.soldUnits + unk.returnUnits
    ? `${unk.soldUnits + unk.returnUnits} unit(s) have no customer state (shown as “Unknown”). For e-commerce, upload your Orders report above — it carries “Customer State”; for invoices, add the state to the customer.` : '';
}

/* ---------------- 2. e-commerce: upload payment files → profit only ---------------- */
function spMoneyOptions(headers, selected, noneLabel){
  return `<option value="-1">— ${esc(noneLabel)} —</option>` + headers.map((h, i) => `<option value="${i}" ${i === selected ? 'selected' : ''}>${esc(h || ('(column ' + (i + 1) + ')'))}</option>`).join('');
}
async function spReadFiles(){
  const files = spEl('spFiles').files;
  if(!files || !files.length){ showMsg('spUploadMsg', 'Choose at least one file first.', false); return; }
  spSheets = []; let skipped = 0;
  for(const file of files){
    const wb = XLSX.read(await file.arrayBuffer(), { type: 'array' });
    wb.SheetNames.forEach(sheetName => {
      const rows = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { header: 1, raw: true, defval: '' });
      let hdrRow = -1, detected = null;
      for(let r = 0; r < Math.min(rows.length, 8); r++){
        const d = detectSheetFormat(rows[r].map(h => String(h || '').trim()));
        if(d){ hdrRow = r; detected = d; break; }
      }
      if(!detected){ if(rows.length) skipped++; return; }
      const headers = rows[hdrRow].map(h => String(h || '').trim());
      const dataRows = rows.slice(hdrRow + 1).filter(r => r.some(c => c !== '' && c !== undefined && c !== null));
      if(dataRows.length) spSheets.push({ fileName: file.name, sheetName, headers, rows: dataRows, detected });
    });
  }
  if(!spSheets.length){ showMsg('spUploadMsg', 'No Meesho or Flipkart payment / orders data found in the selected files.', false); return; }
  spRenderMap();
  showMsg('spUploadMsg', `Read ${spSheets.length} sheet(s) from ${files.length} file(s).` + (skipped ? ` ${skipped} other sheet(s) were not in a known Meesho / Flipkart format and were left out.` : ''), true);
}
function spRenderMap(){
  spEl('spMapWrap').classList.remove('hidden'); spEl('spPreviewWrap').classList.add('hidden');
  spEl('spMapList').innerHTML = spSheets.map((sh, i) => {
    const preset = sh.detected.format === 'meesho' ? 'MEESHO' : 'FLIPKART', g = list => VPT.guessMoneyCol(sh.headers, list);
    return `<div class="box" style="margin-bottom:10px">
      <p style="margin:0;font-size:13px"><span class="badge">${preset === 'MEESHO' ? 'Meesho' : 'Flipkart'} — detected</span> ${esc(sh.fileName)} — ${esc(sh.sheetName)} (${sh.rows.length} rows)</p>
      <div class="grid2" style="margin-top:6px">
        <div class="field"><label>Platform</label><select id="spPlatform${i}"><option value="MEESHO" ${preset === 'MEESHO' ? 'selected' : ''}>Meesho</option><option value="FLIPKART" ${preset === 'FLIPKART' ? 'selected' : ''}>Flipkart</option></select></div>
        <div class="field"><label>Money column — what the marketplace paid you</label><select id="spSettle${i}">${spMoneyOptions(sh.headers, g(VPT.SETTLE_COL_GUESSES), 'none — this file has no amounts (e.g. Orders report)')}</select></div>
        <div class="field"><label>GST % column (optional)</label><select id="spGst${i}">${spMoneyOptions(sh.headers, g(VPT.GST_COL_GUESSES), 'none — use the default GST %')}</select></div>
        <div class="field"><label>Order date column</label><select id="spOrderDate${i}">${spMoneyOptions(sh.headers, g(VPT.ORDER_DATE_GUESSES), 'none')}</select></div>
        <div class="field"><label>Payment date column</label><select id="spPayDate${i}">${spMoneyOptions(sh.headers, g(VPT.PAY_DATE_GUESSES), 'none')}</select></div>
        <div class="field"><label>Customer state column</label><select id="spState${i}">${spMoneyOptions(sh.headers, g(VPT.STATE_COL_GUESSES), 'none — states stay “Unknown”')}</select></div>
      </div></div>`;
  }).join('');
}
const spVal = id => { const el = spEl(id); return el ? parseInt(el.value, 10) : -1; };
function spOpts(){
  return { basis: spEl('spBasis').value, fallbackMonth: spEl('spFallback').value || '', removeGst: spEl('spRemoveGst').checked, defaultGst: parseFloat(spEl('spDefaultGst').value) };
}
// SKU → your product: a saved SKU mapping, else a product whose own SKU is the same
function spMatchProduct(sku){
  const raw = String(sku).toLowerCase(), m = skuMappingsCache.find(x => x.rawKey === raw);
  if(m && productsCache.some(p => p.id === m.productId)) return m.productId;
  const p = productsCache.find(x => String(x.sku || '').toLowerCase() === raw);
  return p ? p.id : '';
}
async function spPrepare(){
  const sheets = spSheets.map((sh, i) => ({ ...sh, platform: spEl('spPlatform' + i).value, cols: {
    settle: spVal('spSettle' + i), gst: spVal('spGst' + i), orderDate: spVal('spOrderDate' + i), payDate: spVal('spPayDate' + i), state: spVal('spState' + i) } }));
  spBuilt = VPT.buildOldOrders(sheets, spOpts());
  spMap = {}; spCostEdits = {};
  const bySku = new Map();
  spBuilt.orders.filter(o => o.kind === 'sold' || o.kind === 'return').forEach(o => {
    const k = o.platform + '|' + o.sku.toLowerCase();
    if(!bySku.has(k)) bySku.set(k, { key: k, platform: o.platform, sku: o.sku, sold: 0, returned: 0 });
    const r = bySku.get(k); if(o.kind === 'sold') r.sold += o.qty; else r.returned += o.qty;
  });
  spSkuRows = [...bySku.values()].sort((a, b) => (b.sold + b.returned) - (a.sold + a.returned));
  spSkuRows.forEach(r => { spMap[r.key] = spMatchProduct(r.sku); });
  try{                                   // orders with no state in the files get the one read off their label when it was printed
    const live = spBuilt.orders.filter(o => o.kind === 'sold' || o.kind === 'return');
    const filled = await VLS.applyCapturedStates(currentUser.uid, 'seller', live.filter(o => !o.state));
    if(filled){ spBuilt.stats.noState = live.filter(o => !o.state).length; spBuilt.stats.states = new Set(live.filter(o => o.state).map(o => o.state)).size; spBuilt.stats.fromLabels = filled; }
  }catch(err){ console.warn('captured states unavailable', err); }
  if(!spBuilt.orders.some(o => o.kind === 'sold' || o.kind === 'return') && !spBuilt.orders.some(o => o.state)){
    showMsg('spUploadMsg', 'No sold or returned orders were found in these files.', false); return;
  }
  spEl('spPreviewWrap').classList.remove('hidden');
  await spRenderPreview();
}
function spOnMap(i){ const r = spSkuRows[i]; spMap[r.key] = spEl('spSkuMap' + i).value; delete spCostEdits[r.key]; spRenderPreview(); }
function spOnCost(el){ const v = parseFloat(el.value); spCostEdits[el.dataset.skukey] = isFinite(v) && v >= 0 ? v : 0; spRenderPreview(); }
// cost per unit of one order line: the product's cost on the order date; an unmatched SKU uses the cost typed here
function spLineCost(skuKey, order){
  const pid = spMap[skuKey];
  if(pid) return spCostOf(pid, order.orderDate || order.payDate || (order.month + '-28')).cost;
  return spCostEdits[skuKey] != null ? spCostEdits[skuKey] : 0;
}
function spProfitLines(){
  const byMonth = new Map(); let noKey = 0, undated = 0;
  (spBuilt ? spBuilt.orders : []).forEach(o => {
    if(o.kind !== 'sold' && o.kind !== 'return') return;
    if(!o.month){ undated++; return; }
    if(!shipmentIdFromText(String(o.orderId), o.platform)){ noKey++; return; }
    const skuKey = o.platform + '|' + o.sku.toLowerCase(), pid = spMap[skuKey] || '', p = pid ? productsCache.find(x => x.id === pid) : null;
    if(!byMonth.has(o.month)) byMonth.set(o.month, []);
    byMonth.get(o.month).push({ key: labelKey(o.platform, o.sku, String(o.orderId)), qty: o.qty, isReturn: o.kind === 'return', settle: o.settle, gstRate: o.gst,
      mappingId: pid, productName: p ? p.name : o.sku, marketplace: o.platform, sku: o.sku, orderId: o.orderId, state: o.state, costUnit: spLineCost(skuKey, o) });
  });
  return { byMonth, noKey, undated };
}
async function spRenderPreview(){
  const opts = { removeGst: spEl('spRemoveGst').checked, defaultGst: parseFloat(spEl('spDefaultGst').value) };
  spEl('spSkuTable').innerHTML = spSkuRows.map((r, i) => {
    const options = ['<option value="">— not matched (type a cost) —</option>'].concat(productsCache.map(p => `<option value="${p.id}" ${spMap[r.key] === p.id ? 'selected' : ''}>${esc(p.name)}</option>`));
    const matched = !!spMap[r.key], c = matched ? spCostOf(spMap[r.key], spToday()) : null;
    const costCell = matched
      ? (c.cost ? `${spInr(c.cost)} <span class="sub">(${c.source === 'manual' ? 'typed' : 'from purchases'})</span>` : '<span class="badge bad">no cost yet — type it in 1. Product costs</span>')
      : `<input type="number" min="0" step="0.01" value="${spCostEdits[r.key] || 0}" data-skukey="${esc(r.key)}" onchange="spOnCost(this)" style="width:88px;padding:3px 6px">${spCostEdits[r.key] ? '' : ' <span class="badge bad" style="font-size:10.5px">type it</span>'}`;
    return `<tr><td>${esc(r.sku)}</td><td><span class="badge">${esc(r.platform === 'MEESHO' ? 'Meesho' : 'Flipkart')}</span></td><td>${r.sold}</td><td>${r.returned}</td>
      <td><select id="spSkuMap${i}" onchange="spOnMap(${i})">${options.join('')}</select></td><td style="white-space:nowrap">${costCell}</td></tr>`;
  }).join('');
  const { byMonth, noKey, undated } = spProfitLines(), months = [...byMonth.keys()].sort(), results = []; let already = 0;
  for(const mo of months){
    const pr = await VLS.computeProfit(currentUser.uid, 'seller', mo, byMonth.get(mo), opts);
    already += pr.already;
    results.push({ mo, n: pr.rows.length, sold: pr.totals.soldUnits, ret: pr.totals.returnUnits, rc: pr.rows.reduce((a, x) => a + (x.returnCharge || 0), 0), rev: pr.totals.revenue, cogs: pr.totals.cogs, profit: pr.totals.profit });
  }
  const T = k => results.reduce((a, r) => a + r[k], 0), st = spBuilt.stats;
  spEl('spPreviewBox').innerHTML = `<table data-excel-name="E-commerce preview"><thead><tr><th>Month</th><th>New orders</th><th>Units sold</th><th>Returns / RTO</th><th>Return charges</th><th>Revenue (ex-GST)</th><th>Cost of goods</th><th>Profit</th></tr></thead><tbody>
    ${results.map(r => `<tr><td data-sort="${esc(r.mo)}-01"><b>${esc(spMonthLabel(r.mo))}</b></td><td>${r.n}</td><td>${r.sold}</td><td>${r.ret}</td><td>${spInr(r.rc)}</td><td>${spInr(r.rev)}</td><td>${spInr(r.cogs)}</td><td style="${spCol(r.profit)}"><b>${spInr(r.profit)}</b></td></tr>`).join('')
      || '<tr><td colspan="8" style="color:var(--muted)">Nothing new to add from these files.</td></tr>'}
    <tr style="font-weight:700;background:var(--head-bg,#FAF6EF)"><td>Total</td><td>${T('n')}</td><td>${T('sold')}</td><td>${T('ret')}</td><td>${spInr(T('rc'))}</td><td>${spInr(T('rev'))}</td><td>${spInr(T('cogs'))}</td><td style="${spCol(T('profit'))}">${spInr(T('profit'))}</td></tr></tbody></table>
    <p class="sub" style="margin-top:6px">${st.orders} order(s) in the files: ${st.sold} sold, ${st.returned} returned / RTO, ${st.cancelled} cancelled (ignored). Customer state found for ${st.states} state(s)${st.fromLabels ? ` (${st.fromLabels} order(s) from the labels you printed)` : ''}${st.noState ? `; ${st.noState} order(s) have none (shown as “Unknown”)` : ''}.
      ${already ? `${already} order line(s) were already counted earlier — skipped. ` : ''}${undated ? `<b style="color:var(--paprika-dark)">${undated} order(s) have no date — pick a month in “Month for rows that have no date” and press Next again.</b> ` : ''}${noKey ? `${noKey} order(s) have an unreadable order number (skipped). ` : ''}${st.noStatus ? `${st.noStatus} row(s) had no status (skipped). ` : ''}
      ${spSkuRows.some(r => !spMap[r.key] && !spCostEdits[r.key]) ? '<b style="color:var(--paprika-dark)">Some SKUs are not matched to a product and have no cost — their profit is overstated.</b>' : ''}</p>`;
}
async function spApply(){
  const btn = spEl('spApplyBtn'); btn.disabled = true;
  try{
    const opts = { removeGst: spEl('spRemoveGst').checked, defaultGst: parseFloat(spEl('spDefaultGst').value) }, uid = currentUser.uid;
    // SKUs you matched are remembered (the same list Monthly Inventory Reconciliation uses) — stock is NOT touched
    let skuSaved = 0;
    for(const r of spSkuRows){
      const pid = spMap[r.key]; if(!pid) continue;
      const raw = r.sku.toLowerCase(), p = productsCache.find(x => x.id === pid);
      if(p && !skuMappingsCache.some(m => m.rawKey === raw) && String(p.sku || '').toLowerCase() !== raw){
        await db.collection('users').doc(uid).collection('skuMappings').add({ rawKey: raw, productId: pid, productName: p.name, createdAt: firebase.firestore.FieldValue.serverTimestamp() });
        skuSaved++;
      }
    }
    const { byMonth, undated } = spProfitLines(), months = [...byMonth.keys()].sort(), sum = { n: 0, profit: 0, rc: 0, already: 0 };
    for(const mo of months){
      const res = await VLS.recordProfit(uid, 'seller', mo, byMonth.get(mo), opts);
      sum.n += res.rows.length; sum.profit += res.totals.profit; sum.already += res.already; sum.rc += res.rows.reduce((a, x) => a + (x.returnCharge || 0), 0);
    }
    const pairs = spBuilt.orders.filter(o => (o.kind === 'sold' || o.kind === 'return') && o.state && shipmentIdFromText(String(o.orderId), o.platform))
      .map(o => ({ key: labelKey(o.platform, o.sku, String(o.orderId)), state: o.state }));
    const enr = await VLS.enrichStates(uid, 'seller', pairs);
    if(skuSaved) await loadSkuMappings();
    spEl('spPreviewWrap').classList.add('hidden'); spEl('spMapWrap').classList.add('hidden'); spEl('spFiles').value = ''; spSheets = []; spBuilt = null;
    await sellerProfitOpen();
    showMsg('spUploadMsg', `Added to Profit: ${sum.n} e-commerce order(s) in ${months.length} month(s) — profit ${spInr(sum.profit)}, return charges ${spInr(sum.rc)}.` +
      (sum.already ? ` ${sum.already} were already counted before (skipped).` : '') + (enr.updated ? ` Customer state filled in for ${enr.updated} earlier order(s).` : '') +
      (undated ? ` ${undated} undated order(s) were left out.` : '') + ' Your stock was not changed.', true);
  }catch(err){ console.error(err); showMsg('spUploadMsg', 'Could not add the data: ' + err.message, false); }
  btn.disabled = false;
}

/* ---------------- captured order IDs & states: count + clear (month totals are never touched) ---------------- */
async function spRefreshCaptureCount(){
  try{
    const c = await VLS.captureCount(currentUser.uid, 'seller', 1000);
    spEl('spCapCount').textContent = c.n ? `${c.more ? '1,000+' : c.n.toLocaleString('en-IN')} order(s) stored` : 'nothing stored';
  }catch(e){ spEl('spCapCount').textContent = ''; }
}
async function spClearCaptured(){
  const old = spEl('spCapScope').value === 'old', before = old ? new Date().toISOString().slice(0, 7) : '';
  const c = await VLS.captureCount(currentUser.uid, 'seller', 1000);
  if(!c.n){ showMsg('spCapMsg', 'There are no captured orders to clear.', true); return; }
  if(!confirm(`Delete ${c.more ? 'the' : c.n.toLocaleString('en-IN')} captured order ID(s) and state(s)${old ? ' captured before this month' : ''}?\n\nYour monthly profit, state-wise selling and state-wise returns are kept.\nOrders cleared BEFORE their month's report is uploaded will show as "Unknown" state.`)) return;
  try{
    const r = await VLS.clearCaptures(currentUser.uid, 'seller', before ? { beforeMonth: before } : {});
    showMsg('spCapMsg', `Cleared ${r.deleted.toLocaleString('en-IN')} captured order(s). Monthly profit and state-wise figures are untouched.`, true);
  }catch(err){ showMsg('spCapMsg', 'Could not clear: ' + err.message, false); }
  spRefreshCaptureCount();
}
// purchases → cost timeline, for pages that need product costs without opening the Profit page (the reconciliation)
async function spEnsureCosts(){
  if(!purchasesCache.length) await loadPurchases();
  spTimeline = VPT.costTimeline(purchasesCache);
}
