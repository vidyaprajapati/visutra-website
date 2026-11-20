/* VISUTRA — profit tools (pure functions, no database, no DOM):
     VPT.normalizeState(v)          "UTTAR PRADESH" / "up" / "09" / "IN-UP"  →  "Uttar Pradesh"
     VPT.parseDateCell(v)           Excel serial / "05-09-2026" / "5 Sep 2026" / Date  →  "2026-09-05"
     VPT.buildOldOrders(sheets, o)  old Meesho / Flipkart payment (+ orders) files → ONE record per order line
     VPT.sumStates / monthsInRange  roll the monthly profit documents up for the graphs
     VPT.barChartSvg / hBarChartSvg inline SVG graphs (no chart library, work offline, can be printed)
   Used by billing/buyer/stock.html (Old Payment Data + Monthly Profit graphs) and by the tests. */
(function (global) {
  'use strict';

  /* ---------------- states ---------------- */
  const STATES = { '01': 'Jammu and Kashmir', '02': 'Himachal Pradesh', '03': 'Punjab', '04': 'Chandigarh', '05': 'Uttarakhand', '06': 'Haryana', '07': 'Delhi',
    '08': 'Rajasthan', '09': 'Uttar Pradesh', '10': 'Bihar', '11': 'Sikkim', '12': 'Arunachal Pradesh', '13': 'Nagaland', '14': 'Manipur', '15': 'Mizoram',
    '16': 'Tripura', '17': 'Meghalaya', '18': 'Assam', '19': 'West Bengal', '20': 'Jharkhand', '21': 'Odisha', '22': 'Chhattisgarh', '23': 'Madhya Pradesh',
    '24': 'Gujarat', '26': 'Dadra and Nagar Haveli and Daman and Diu', '27': 'Maharashtra', '29': 'Karnataka', '30': 'Goa', '31': 'Lakshadweep', '32': 'Kerala',
    '33': 'Tamil Nadu', '34': 'Puducherry', '35': 'Andaman and Nicobar Islands', '36': 'Telangana', '37': 'Andhra Pradesh', '38': 'Ladakh' };
  const keyOf = s => String(s).toUpperCase().replace(/&/g, 'AND').replace(/[^A-Z]/g, '');
  const BY_KEY = {};
  Object.values(STATES).forEach(n => { BY_KEY[keyOf(n)] = n; });
  [['JAMMUKASHMIR', '01'], ['JAMMUANDKASHMIR', '01'], ['UTTARANCHAL', '05'], ['NEWDELHI', '07'], ['NCTOFDELHI', '07'], ['ORISSA', '21'], ['CHATTISGARH', '22'],
    ['CHHATISGARH', '22'], ['CHATISGARH', '22'], ['PONDICHERRY', '34'], ['DAMANANDDIU', '26'], ['DAMANDIU', '26'], ['DADRAANDNAGARHAVELI', '26'],
    ['DADRANAGARHAVELIANDDAMANANDDIU', '26'], ['DADRANAGARHAVELIDAMANDIU', '26'], ['ANDAMANNICOBARISLANDS', '35'], ['ANDAMANANDNICOBAR', '35'],
    ['TELENGANA', '36'], ['PUDUCHERY', '34']].forEach(([k, c]) => { BY_KEY[k] = STATES[c]; });
  const ISO = { JK: '01', HP: '02', PB: '03', CH: '04', UK: '05', UT: '05', HR: '06', DL: '07', RJ: '08', UP: '09', BR: '10', SK: '11', AR: '12', NL: '13', MN: '14',
    MZ: '15', TR: '16', ML: '17', AS: '18', WB: '19', JH: '20', OR: '21', OD: '21', CG: '22', CT: '22', MP: '23', GJ: '24', DD: '26', DN: '26', DH: '26', MH: '27',
    KA: '29', GA: '30', LD: '31', KL: '32', TN: '33', PY: '34', AN: '35', TS: '36', TG: '36', AP: '37', LA: '38' };
  const titleCase = s => s.toLowerCase().replace(/\b[a-z]/g, c => c.toUpperCase());
  function normalizeState(v) {
    const raw = String(v == null ? '' : v).trim();
    if (!raw) return '';
    if (/^\d{1,2}$/.test(raw)) return STATES[raw.padStart(2, '0')] || '';
    const code = raw.toUpperCase().replace(/^IN-/, '');
    if (/^[A-Z]{2}$/.test(code) && ISO[code]) return STATES[ISO[code]];
    return BY_KEY[keyOf(raw)] || titleCase(raw.replace(/\s+/g, ' '));
  }

  /* ---------------- dates ---------------- */
  const MON = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
  const pad = n => String(n).padStart(2, '0');
  function parseDateCell(v) {
    if (v == null || v === '') return '';
    if (v instanceof Date) return isNaN(v) ? '' : v.toISOString().slice(0, 10);
    if (typeof v === 'number') return v > 20000 && v < 80000 ? new Date(Math.round((v - 25569) * 864e5)).toISOString().slice(0, 10) : '';
    const s = String(v).trim();
    let m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(s);
    if (m) return m[1] + '-' + pad(m[2]) + '-' + pad(m[3]);
    m = /^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4})/.exec(s);                         // DD/MM/YYYY — the Indian order
    if (m) return m[3] + '-' + pad(m[2]) + '-' + pad(m[1]);
    m = /^(\d{1,2})[\s\-]([A-Za-z]{3})[A-Za-z]*[\s\-,]+(\d{4})/.exec(s);
    if (m && MON[m[2].toLowerCase()]) return m[3] + '-' + pad(MON[m[2].toLowerCase()]) + '-' + pad(m[1]);
    return '';
  }

  /* ---------------- old payment files → one record per order line ----------------
     sheets: [{ platform, rows, detected, cols:{ settle, gst, orderDate, payDate, state } }]  (column indexes, -1 = none)
       detected = detectSheetFormat() result: statusIdx|reasonIdx, skuIdx, qtyIdx, orderIdx
     opts  : { basis: 'order' | 'pay', fallbackMonth: 'YYYY-MM' }
     An order can sit on several rows (a payment row, a later return adjustment, rows in two files): its money is
     the SUM of its rows, its status the most final one (RTO/RETURN > CANCELLED > DELIVERED), its state / dates the
     first one found. Money is optional — an Orders report (no money, has "Customer State") still contributes the state.
     Returns { orders:[{platform, orderId, sku, qty, kind, settle, gst, state, month, ...}], stats } */
  const money = v => {
    if (typeof v === 'number') return isFinite(v) ? v : 0;
    const n = parseFloat(String(v == null ? '' : v).replace(/[₹,\s]/g, '').replace(/^\((.*)\)$/, '-$1'));
    return isFinite(n) ? n : 0;
  };
  function buildOldOrders(sheets, opts, V) {
    V = V || global.VLS; opts = opts || {};
    const basis = opts.basis === 'pay' ? 'pay' : 'order';
    const by = new Map(), st = { rows: 0, noOrderId: 0, noSku: 0 };
    sheets.forEach(sh => {
      const d = sh.detected, c = sh.cols || {}, statusIdx = d.reasonIdx != null ? d.reasonIdx : d.statusIdx;
      sh.rows.forEach(row => {
        st.rows++;
        const orderId = String(row[d.orderIdx] == null ? '' : row[d.orderIdx]).trim(), sku = String(row[d.skuIdx] == null ? '' : row[d.skuIdx]).trim();
        if (!orderId) { st.noOrderId++; return; }
        if (!sku) { st.noSku++; return; }
        const k = sh.platform + '|' + orderId + '|' + sku.toLowerCase();
        if (!by.has(k)) by.set(k, { platform: sh.platform, orderId, sku, qty: 0, rank: -1, status: '', settle: null, gst: null, state: '', orderDate: '', payDate: '', bestPay: '' });
        const o = by.get(k), status = String(row[statusIdx] == null ? '' : row[statusIdx]).trim();
        if (c.settle >= 0 && String(row[c.settle] == null ? '' : row[c.settle]).trim() !== '') o.settle = (o.settle || 0) + money(row[c.settle]);
        const qty = parseFloat(row[d.qtyIdx]) || 0, rk = V.reconStatusRank(status);
        if (rk >= o.rank) { o.rank = rk; o.status = status; if (qty > 0 || !o.qty) o.qty = qty; if (c.payDate >= 0) o.bestPay = parseDateCell(row[c.payDate]); }
        if (!o.orderDate && c.orderDate >= 0) o.orderDate = parseDateCell(row[c.orderDate]);
        if (!o.payDate && c.payDate >= 0) o.payDate = parseDateCell(row[c.payDate]);
        if (!o.state && c.state >= 0) o.state = normalizeState(row[c.state]);
        if (o.gst == null && c.gst >= 0 && String(row[c.gst] == null ? '' : row[c.gst]).trim() !== '') o.gst = money(row[c.gst]);
      });
    });
    const stats = Object.assign(st, { orders: 0, sold: 0, returned: 0, cancelled: 0, noStatus: 0, undated: 0, noMoney: 0, noState: 0 });
    const states = new Set(), orders = [];
    by.forEach(o => {
      o.kind = V.reconStatusKind(o.status);                      // 'sold' | 'return' | 'cancel' | null (no status)
      const date = basis === 'pay' ? (o.bestPay || o.payDate || o.orderDate) : (o.orderDate || o.bestPay || o.payDate);
      o.month = date ? date.slice(0, 7) : (opts.fallbackMonth || '');
      stats.orders++;
      if (o.kind === 'sold') stats.sold++; else if (o.kind === 'return') stats.returned++; else if (o.kind === 'cancel') stats.cancelled++; else stats.noStatus++;
      if (o.kind === 'sold' || o.kind === 'return') {
        if (!o.month) stats.undated++;
        if (o.settle == null) stats.noMoney++;
        if (!o.state) stats.noState++; else states.add(o.state);
      }
      orders.push(o);
    });
    stats.states = states.size;
    return { orders, stats };
  }

  /* ---------------- roll-ups for the graphs ---------------- */
  const blank = () => ({ soldUnits: 0, returnUnits: 0, revenue: 0, cogs: 0, profit: 0, returnCharges: 0 });
  const r2 = n => Math.round((Number(n) || 0) * 100) / 100;
  function monthsInRange(monthDocs, from, to) {
    return (monthDocs || []).filter(m => (!from || m.month >= from) && (!to || m.month <= to)).sort((a, b) => String(a.month).localeCompare(String(b.month)));
  }
  function sumStates(monthDocs) {
    const acc = {};
    monthDocs.forEach(m => Object.entries(m.byState || {}).forEach(([s, v]) => {
      const a = acc[s] = acc[s] || blank();
      Object.keys(blank()).forEach(k => { a[k] += Number(v[k]) || 0; });
    }));
    return Object.entries(acc).map(([state, a]) => {
      const ordered = a.soldUnits + a.returnUnits;
      return Object.assign({ state }, a, { revenue: r2(a.revenue), cogs: r2(a.cogs), profit: r2(a.profit), returnCharges: r2(a.returnCharges),
        returnRate: ordered > 0 ? Math.round(a.returnUnits / ordered * 1000) / 10 : 0, margin: a.revenue > 0 ? Math.round(a.profit / a.revenue * 1000) / 10 : 0 });
    });
  }
  // top n rows by `key` (desc); the rest folded into one "Other states" row
  function topWithOther(list, n, key) {
    const sorted = list.slice().sort((a, b) => b[key] - a[key]);
    if (sorted.length <= n) return sorted;
    const rest = sorted.slice(n), other = Object.assign({ state: 'Other states (' + rest.length + ')' }, blank());
    rest.forEach(r => Object.keys(blank()).forEach(k => { other[k] += r[k]; }));
    const ordered = other.soldUnits + other.returnUnits;
    other.returnRate = ordered > 0 ? Math.round(other.returnUnits / ordered * 1000) / 10 : 0;
    return sorted.slice(0, n).concat([other]);
  }

  /* ---------------- SVG graphs ---------------- */
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const inrShort = n => {
    const a = Math.abs(n), sign = n < 0 ? '−' : '';
    if (a >= 1e7) return sign + '₹' + (a / 1e7).toFixed(a >= 1e8 ? 0 : 1).replace(/\.0$/, '') + 'Cr';
    if (a >= 1e5) return sign + '₹' + (a / 1e5).toFixed(a >= 1e6 ? 0 : 1).replace(/\.0$/, '') + 'L';
    if (a >= 1e3) return sign + '₹' + (a / 1e3).toFixed(a >= 1e4 ? 0 : 1).replace(/\.0$/, '') + 'k';
    return sign + '₹' + Math.round(a);
  };
  const unitsFmt = n => Math.round(n).toLocaleString('en-IN');
  function niceStep(raw) {
    if (!(raw > 0)) return 1;
    const p = Math.pow(10, Math.floor(Math.log10(raw))), f = raw / p;
    return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * p;
  }
  function scale(min, max, ticks) {
    const lo = Math.min(0, min), hi = Math.max(0, max);
    if (hi === lo) return { lo: 0, hi: 1, step: 1 };
    const step = niceStep((hi - lo) / (ticks || 4));
    return { lo: Math.floor(lo / step) * step, hi: Math.ceil(hi / step) * step, step };
  }
  function empty(msg, h) {
    return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 720 ' + (h || 120) + '" role="img" aria-label="' + esc(msg) + '"><text x="360" y="' + ((h || 120) / 2) + '" text-anchor="middle" font-size="13" fill="#78716C">' + esc(msg) + '</text></svg>';
  }
  /* Vertical grouped bars. cfg: { labels:[..], series:[{ name, values:[..], color, negColor? }], fmt, height, title } */
  function barChartSvg(cfg) {
    const labels = cfg.labels || [], S = cfg.series || [], fmt = cfg.fmt || unitsFmt, W = 720, H = cfg.height || 270;
    if (!labels.length || !S.length) return empty('No data in this period yet', 120);
    const all = S.flatMap(s => s.values), sc = scale(Math.min(...all), Math.max(...all), 4);
    const L = 62, R = 12, T = 34, B = labels.length > 8 ? 62 : 40, pw = W - L - R, ph = H - T - B;
    const y = v => T + ph - (v - sc.lo) / (sc.hi - sc.lo) * ph, gw = pw / labels.length;
    let g = '';
    for (let v = sc.lo; v <= sc.hi + sc.step / 2; v += sc.step) g += '<line x1="' + L + '" x2="' + (W - R) + '" y1="' + y(v).toFixed(1) + '" y2="' + y(v).toFixed(1) + '" stroke="#E7E5E4"/><text x="' + (L - 6) + '" y="' + (y(v) + 4).toFixed(1) + '" text-anchor="end" font-size="10.5" fill="#78716C">' + esc(fmt(v)) + '</text>';
    const bw = Math.min(34, gw * 0.76 / S.length), showVals = labels.length * S.length <= 18;
    labels.forEach((lb, i) => {
      const gx = L + gw * i + (gw - bw * S.length) / 2;
      S.forEach((s, j) => {
        const v = s.values[i] || 0, x = gx + bw * j, y0 = y(0), y1 = y(v), col = v < 0 && s.negColor ? s.negColor : s.color;
        g += '<rect x="' + x.toFixed(1) + '" y="' + Math.min(y0, y1).toFixed(1) + '" width="' + (bw - 1.5).toFixed(1) + '" height="' + Math.max(1, Math.abs(y1 - y0)).toFixed(1) + '" rx="2" fill="' + col + '"><title>' + esc(lb + ' — ' + s.name + ': ' + fmt(v)) + '</title></rect>';
        if (showVals) g += '<text x="' + (x + (bw - 1.5) / 2).toFixed(1) + '" y="' + (v < 0 ? y1 + 11 : y1 - 4).toFixed(1) + '" text-anchor="middle" font-size="9.5" fill="#44403C">' + esc(fmt(v)) + '</text>';
      });
      const lx = L + gw * i + gw / 2, ly = H - B + 14;
      g += labels.length > 8
        ? '<text transform="translate(' + lx.toFixed(1) + ',' + ly + ') rotate(-40)" text-anchor="end" font-size="10.5" fill="#57534E">' + esc(lb) + '</text>'
        : '<text x="' + lx.toFixed(1) + '" y="' + ly + '" text-anchor="middle" font-size="10.5" fill="#57534E">' + esc(lb) + '</text>';
    });
    g += '<line x1="' + L + '" x2="' + (W - R) + '" y1="' + y(0).toFixed(1) + '" y2="' + y(0).toFixed(1) + '" stroke="#A8A29E"/>';
    let lx = L;
    const legend = S.map(s => { const t = '<rect x="' + lx + '" y="9" width="11" height="11" rx="2" fill="' + s.color + '"/><text x="' + (lx + 16) + '" y="19" font-size="11.5" fill="#44403C">' + esc(s.name) + '</text>'; lx += 30 + s.name.length * 6.4; return t; }).join('');
    return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="' + esc(cfg.title || 'Bar chart') + '" style="width:100%;height:auto;font-family:inherit">' + legend + g + '</svg>';
  }
  /* Horizontal bars, one per row. cfg: { rows:[{ label, value, note? }], color, negColor?, fmt, title } */
  function hBarChartSvg(cfg) {
    const rows = cfg.rows || [], fmt = cfg.fmt || unitsFmt, W = 720, RH = 26;
    if (!rows.length) return empty('No data in this period yet', 120);
    const vals = rows.map(r => r.value), sc = scale(Math.min(...vals), Math.max(...vals), 4);
    const L = 170, R = 150, T = 8, H = T + rows.length * RH + 8, pw = W - L - R;
    const x = v => L + (v - sc.lo) / (sc.hi - sc.lo) * pw;
    let g = '';
    rows.forEach((r, i) => {
      const yy = T + i * RH, x0 = x(0), x1 = x(r.value), col = r.value < 0 && cfg.negColor ? cfg.negColor : cfg.color;
      g += '<text x="' + (L - 8) + '" y="' + (yy + 16) + '" text-anchor="end" font-size="11.5" fill="#44403C">' + esc(r.label.length > 24 ? r.label.slice(0, 23) + '…' : r.label) + '</text>'
        + '<rect x="' + Math.min(x0, x1).toFixed(1) + '" y="' + (yy + 3) + '" width="' + Math.max(1, Math.abs(x1 - x0)).toFixed(1) + '" height="' + (RH - 8) + '" rx="2" fill="' + col + '"><title>' + esc(r.label + ': ' + fmt(r.value) + (r.note ? ' · ' + r.note : '')) + '</title></rect>'
        + '<text x="' + (r.value < 0 ? Math.min(x0, x1) - 5 : Math.max(x0, x1) + 5).toFixed(1) + '" y="' + (yy + 16) + '" text-anchor="' + (r.value < 0 ? 'end' : 'start') + '" font-size="11" fill="#292524">' + esc(fmt(r.value)) + (r.note ? '  <tspan fill="#78716C" font-size="10">' + esc(r.note) + '</tspan>' : '') + '</text>';
    });
    g += '<line x1="' + x(0).toFixed(1) + '" x2="' + x(0).toFixed(1) + '" y1="' + T + '" y2="' + (H - 8) + '" stroke="#A8A29E"/>';
    return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="' + esc(cfg.title || 'Bar chart') + '" style="width:100%;height:auto;font-family:inherit">' + g + '</svg>';
  }

  /* ---------------- SELLER: cost from supplier purchases, profit on invoices, two streams merged ---------------- */
  const FIELDS = ['soldUnits', 'returnUnits', 'revenue', 'cogs', 'profit', 'returnCharges'];
  const mkTotals = () => ({ soldUnits: 0, returnUnits: 0, revenue: 0, cogs: 0, profit: 0, returnCharges: 0 });
  const finTotals = x => { ['revenue', 'cogs', 'profit', 'returnCharges'].forEach(k => { x[k] = r2(x[k]); }); x.margin = x.revenue > 0 ? Math.round(x.profit / x.revenue * 1000) / 10 : 0; return x; };
  const addInto = (a, b) => { FIELDS.forEach(k => { a[k] += Number(b[k]) || 0; }); return a; };
  /* purchases: [{ date, deleted, items:[{ linkedProductId, qty, taxable | rate }] }] (Purchase Products are linked to your
     sale Products) → { productId: [{ date, q, t }] } oldest first */
  function costTimeline(purchases) {
    const tl = {};
    (purchases || []).forEach(p => {
      if (p.deleted) return;
      (p.items || []).forEach(it => {
        const id = it.linkedProductId, q = Number(it.qty) || 0;
        if (!id || q <= 0) return;
        const t = it.taxable != null && Number(it.taxable) > 0 ? Number(it.taxable) : q * (Number(it.rate) || 0);
        (tl[id] = tl[id] || []).push({ date: String(p.date || ''), q, t });
      });
    });
    Object.values(tl).forEach(a => a.sort((x, y) => (x.date < y.date ? -1 : x.date > y.date ? 1 : 0)));
    return tl;
  }
  /* Cost per unit (ex-GST) of a product ON a date: a cost you typed wins; otherwise the weighted average of every
     purchase made up to that date (a sale dated before the first purchase uses the overall average). */
  function costAt(tl, productId, date, manual) {
    if (Number(manual) > 0) return { cost: r2(manual), source: 'manual' };
    const a = (tl || {})[productId];
    if (!a || !a.length) return { cost: 0, source: 'missing' };
    let q = 0, t = 0;
    for (const e of a) { if (e.date <= String(date || '9999')) { q += e.q; t += e.t; } else break; }
    if (q <= 0) a.forEach(e => { q += e.q; t += e.t; });
    return q > 0 ? { cost: r2(t / q), source: 'purchases' } : { cost: 0, source: 'missing' };
  }
  /* Profit on SALES TO BUYERS, straight from the invoices (nothing to upload): revenue = the invoice line's taxable value
     (ex-GST), cost = units × the product's cost on the invoice date. Cancelled (deleted) invoices are left out.
     Same shape as the e-commerce month documents, plus byBuyer. costOf(productId, date) → { cost, source } */
  function invoiceMonths(invoices, costOf) {
    const by = {};
    (invoices || []).forEach(inv => {
      const month = String(inv.date || '').slice(0, 7);
      if (inv.deleted || !/^\d{4}-\d{2}$/.test(month)) return;
      const M = by[month] = by[month] || Object.assign({ month, orderLines: 0, missingCostUnits: 0, missingProducts: {}, byProduct: {}, byPlatform: {}, byState: {}, byBuyer: {} }, mkTotals());
      const cust = inv.customer || {}, state = normalizeState(cust.state) || normalizeState(cust.stateCode) || 'Unknown', buyer = cust.name || cust.legalName || 'Customer';
      M.orderLines++;
      (inv.items || []).forEach(it => {
        const qty = Number(it.qty) || 0, revenue = r2(it.taxable != null ? it.taxable : qty * (Number(it.rate) || 0));
        if (qty <= 0 && !revenue) return;
        const c = it.productId ? costOf(it.productId, inv.date) : { cost: 0, source: 'missing' };
        const cogs = r2(c.cost * qty), line = { soldUnits: qty, returnUnits: 0, revenue, cogs, profit: r2(revenue - cogs), returnCharges: 0 };
        if (c.source === 'missing') { M.missingCostUnits += qty; M.missingProducts[it.name || 'Item'] = true; }
        const pk = it.productId || ('n_' + String(it.name || 'item').toLowerCase().replace(/[^a-z0-9]+/g, '_'));
        addInto(M, line);
        addInto(M.byProduct[pk] = M.byProduct[pk] || Object.assign({ name: it.name || 'Item' }, mkTotals()), line);
        addInto(M.byPlatform.BUYERS = M.byPlatform.BUYERS || mkTotals(), line);
        addInto(M.byState[state] = M.byState[state] || mkTotals(), line);
        addInto(M.byBuyer[buyer] = M.byBuyer[buyer] || mkTotals(), line);
      });
    });
    return Object.values(by).map(M => {
      finTotals(M);
      ['byProduct', 'byPlatform', 'byState', 'byBuyer'].forEach(k => Object.values(M[k]).forEach(finTotals));
      return M;
    }).sort((a, b) => a.month.localeCompare(b.month));
  }
  /* Both streams into one list of months. include: { buyers, ecommerce }.
     Each month also carries `streams: { buyers, ecommerce }` (totals of each) for the stream-by-stream graph. */
  function mergeStreams(buyersMonths, ecomMonths, include) {
    include = include || { buyers: true, ecommerce: true };
    const by = {}, mergeMap = (dst, src) => Object.keys(src || {}).forEach(k => { addInto(dst[k] = dst[k] || Object.assign(src[k].name ? { name: src[k].name } : {}, mkTotals()), src[k]); });
    const take = (docs, stream) => (docs || []).forEach(d => {
      const M = by[d.month] = by[d.month] || Object.assign({ month: d.month, byProduct: {}, byPlatform: {}, byState: {}, byBuyer: {}, streams: { buyers: mkTotals(), ecommerce: mkTotals() }, missingCostUnits: 0 }, mkTotals());
      addInto(M.streams[stream], d);                                           // always recorded: the stream graph shows both
      if (!include[stream]) return;
      addInto(M, d); M.missingCostUnits += d.missingCostUnits || 0;
      ['byProduct', 'byPlatform', 'byState', 'byBuyer'].forEach(k => mergeMap(M[k], d[k]));
    });
    take(buyersMonths, 'buyers'); take(ecomMonths, 'ecommerce');
    return Object.values(by).map(M => {
      finTotals(M); finTotals(M.streams.buyers); finTotals(M.streams.ecommerce);
      ['byProduct', 'byPlatform', 'byState', 'byBuyer'].forEach(k => Object.values(M[k]).forEach(finTotals));
      return M;
    }).sort((a, b) => a.month.localeCompare(b.month));
  }
  // header guessing shared by the file pickers
  const SETTLE_COL_GUESSES = ['final settlement amount', 'bank settlement value (rs.)', 'bank settlement value', 'bank settlement', 'settlement amount', 'settlement value', 'net settlement', 'settled amount', 'net payout', 'net amount'];
  const GST_COL_GUESSES = ['product gst %', 'gst %', 'gst rate', 'gst percentage'];
  const ORDER_DATE_GUESSES = ['order date', 'order_date', 'ordered on', 'order placed date', 'date'];
  const PAY_DATE_GUESSES = ['payment date', 'settlement date', 'settled date', 'payout date', 'payment_date'];
  const STATE_COL_GUESSES = ['customer state', "customer's delivery state", 'delivery state', 'ship to state', 'shipping state', 'customer_state', 'state'];
  function guessMoneyCol(headers, list) {
    const lower = headers.map(h => String(h || '').trim().toLowerCase());
    for (const c of list) { const i = lower.findIndex(h => h === c); if (i !== -1) return i; }
    for (const c of list) { const i = lower.findIndex(h => h.includes(c)); if (i !== -1) return i; }
    return -1;
  }

  const api = { parseMoney: money, costTimeline, costAt, invoiceMonths, mergeStreams, guessMoneyCol, SETTLE_COL_GUESSES, GST_COL_GUESSES, ORDER_DATE_GUESSES, PAY_DATE_GUESSES, STATE_COL_GUESSES, normalizeState, parseDateCell, buildOldOrders, monthsInRange, sumStates, topWithOther, barChartSvg, hBarChartSvg, inrShort, unitsFmt, STATES };
  global.VPT = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
