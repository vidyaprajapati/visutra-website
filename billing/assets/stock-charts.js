/* VISUTRA — Stock Analysis (KPI cards + charts).
   Shared by Billing → Stock Management (seller products) and Buyer → Stock
   (buyer products). Uses Chart.js (loaded from jsDelivr — not Google).

   VTStockCharts.render(containerEl, {
     items:     [{ id, name, stock, reorderLevel, price? }],
     movements: [{ id: <item id>, type, qty (signed), date: 'YYYY-MM-DD' }],
     days:      30 | 60 | 90,
     valueLabel:'Stock value (at selling price)'   // optional
   })
   Pure data helpers are exposed as VTStockCharts.analyse(...) for testing. */
(function (global) {
  'use strict';
  const C = { brand: '#E0531A', brandSoft: 'rgba(224,83,26,.14)', ok: '#16A34A', warn: '#D97706', bad: '#DC2626',
              indigo: '#2E4374', teal: '#0E9F8E', grey: '#A8A29E', grid: 'rgba(28,25,23,.07)' };
  const OUT = { 'sale-out': 1, 'sell-via-label': 1 };
  const IN_PURCHASE = { 'purchase-in': 1, 'purchase': 1 };
  const IN_RETURN = { 'return-in': 1 };
  const UNDO = { 'undo-print': 1, 'undo': 1 };

  function isoDay(d) { return d.toISOString().slice(0, 10); }
  function lastNDays(n) {
    const out = []; const d = new Date(); d.setHours(12, 0, 0, 0);
    for (let i = n - 1; i >= 0; i--) { const x = new Date(d); x.setDate(d.getDate() - i); out.push(isoDay(x)); }
    return out;
  }
  const fmt = n => (Math.round(n * 10) / 10).toLocaleString('en-IN');
  const fmtMoney = n => '₹' + Math.round(n).toLocaleString('en-IN');

  /* ---------- pure analysis ---------- */
  function analyse(items, movements, days) {
    const dayList = lastNDays(days);
    const from = dayList[0];
    const inWin = movements.filter(m => m.date && m.date >= from);
    const soldByDay = Object.fromEntries(dayList.map(d => [d, 0]));
    const inByDay = Object.fromEntries(dayList.map(d => [d, 0]));
    const soldByItem = {};
    const mix = { sold: 0, returned: 0, purchased: 0, adjusted: 0 };
    inWin.forEach(m => {
      const q = Number(m.qty) || 0;
      if (OUT[m.type]) {
        const u = Math.abs(q);
        if (soldByDay[m.date] != null) soldByDay[m.date] += u;
        soldByItem[m.id] = (soldByItem[m.id] || 0) + u;
        mix.sold += u;
      } else if (UNDO[m.type] && q > 0) {           // an undone print gives the sale back
        if (soldByDay[m.date] != null) soldByDay[m.date] = Math.max(0, soldByDay[m.date] - q);
        soldByItem[m.id] = Math.max(0, (soldByItem[m.id] || 0) - q);
        mix.sold = Math.max(0, mix.sold - q);
      } else if (IN_PURCHASE[m.type]) {
        if (inByDay[m.date] != null) inByDay[m.date] += Math.abs(q);
        mix.purchased += Math.abs(q);
      } else if (IN_RETURN[m.type]) {
        if (inByDay[m.date] != null) inByDay[m.date] += Math.abs(q);
        mix.returned += Math.abs(q);
      } else if (q) {
        mix.adjusted += Math.abs(q);
      }
    });
    const rows = items.map(it => {
      const stock = Number(it.stock) || 0;
      const perDay = (soldByItem[it.id] || 0) / days;
      const cover = perDay > 0 ? stock / perDay : Infinity;
      const reorder = Number(it.reorderLevel) || 0;
      const status = stock <= 0 ? 'out' : (reorder > 0 && stock <= reorder) || cover < 7 ? 'low' : cover < 14 ? 'watch' : 'ok';
      return { ...it, stock, perDay, cover, sold: soldByItem[it.id] || 0, status, value: it.price ? stock * Number(it.price) : 0 };
    });
    const totalUnits = rows.reduce((a, r) => a + Math.max(0, r.stock), 0);
    const totalValue = rows.reduce((a, r) => a + Math.max(0, r.value), 0);
    // Total sold from the running total (an undone print may be larger than
    // that day's sales on the chart, which is clamped at 0 per day).
    const soldTotal = Math.max(0, mix.sold);
    return {
      dayList, soldByDay, inByDay, mix, rows,
      kpi: {
        products: rows.length,
        units: totalUnits,
        value: totalValue,
        out: rows.filter(r => r.status === 'out').length,
        low: rows.filter(r => r.status === 'low').length,
        sold: soldTotal,
        perDay: soldTotal / days
      }
    };
  }

  /* ---------- rendering ---------- */
  function ensureChartJs() {
    if (global.Chart) return Promise.resolve(global.Chart);
    return new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = 'https://cdn.jsdelivr.net/npm/chart.js@4.5.1/dist/chart.umd.min.js';
      s.onload = () => resolve(global.Chart); s.onerror = () => reject(new Error('Chart library could not load'));
      document.head.appendChild(s);
    });
  }
  const charts = new WeakMap();
  function kpiHtml(label, value, note, accent) {
    return `<div class="vt-kpi" style="--kpi-accent:${accent}"><div class="k-label">${label}</div><div class="k-value">${value}</div>${note ? `<div class="k-note">${note}</div>` : ''}</div>`;
  }
  function panel(id, title, sub, wide) {
    return `<div class="vt-chart${wide ? ' wide' : ''}"><h3>${title}</h3><div class="c-sub">${sub}</div><div class="c-box"><canvas id="${id}"></canvas></div></div>`;
  }
  function empty(canvas, text) { canvas.parentElement.innerHTML = `<div class="c-empty">${text}</div>`; }
  const shortDay = d => { const [y, m, dd] = d.split('-'); return dd + ' ' + ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][+m - 1]; };
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  async function render(container, opts) {
    const days = opts.days || 30;
    const a = analyse(opts.items || [], opts.movements || [], days);
    const uid = 'vtc' + Math.random().toString(36).slice(2, 8);
    const k = a.kpi;
    container.innerHTML =
      `<div class="vt-kpis">` +
        kpiHtml('Products', fmt(k.products), '', C.indigo) +
        kpiHtml('Units in stock', fmt(k.units), '', C.teal) +
        (k.value ? kpiHtml(opts.valueLabel || 'Stock value', fmtMoney(k.value), 'at product price', C.brand) : '') +
        kpiHtml(`Sold · ${days} days`, fmt(k.sold), `${fmt(k.perDay)} per day`, C.ok) +
        kpiHtml('Low stock', fmt(k.low), 'under 7 days or at reorder level', C.warn) +
        kpiHtml('Out of stock', fmt(k.out), '', C.bad) +
      `</div><div class="vt-charts">` +
        panel(uid + 'trend', 'Sales & stock-in trend', `Units sold vs. units received (purchases + returns), last ${days} days`, true) +
        panel(uid + 'top', 'Top sellers', `Units sold in the last ${days} days`) +
        panel(uid + 'cover', 'Days of stock left', 'At the current selling speed · red under 7 days, amber under 14') +
        panel(uid + 'level', 'Stock level vs reorder level', 'Current units per product (lowest first)') +
        panel(uid + 'mix', 'Stock movement mix', `All stock changes in the last ${days} days`) +
      `</div>`;

    let Chart;
    try { Chart = await ensureChartJs(); }
    catch (e) { container.querySelectorAll('canvas').forEach(c => empty(c, 'Charts could not load — check your internet connection.')); return a; }
    (charts.get(container) || []).forEach(ch => ch.destroy());
    const made = [];
    const base = { responsive: true, maintainAspectRatio: false, plugins: { legend: { labels: { boxWidth: 12, font: { size: 12 } } } },
      scales: { x: { grid: { color: C.grid } }, y: { grid: { color: C.grid }, beginAtZero: true } } };
    const $ = id => container.querySelector('#' + uid + id);

    // 1. trend
    const anyTrend = a.dayList.some(d => a.soldByDay[d] || a.inByDay[d]);
    if (!anyTrend) empty($('trend'), 'No sales or stock received in this period yet.');
    else made.push(new Chart($('trend'), { type: 'line', data: { labels: a.dayList.map(shortDay), datasets: [
      { label: 'Sold', data: a.dayList.map(d => a.soldByDay[d]), borderColor: C.brand, backgroundColor: C.brandSoft, fill: true, tension: .35, pointRadius: 0, borderWidth: 2.2 },
      { label: 'Received', data: a.dayList.map(d => a.inByDay[d]), borderColor: C.teal, backgroundColor: 'transparent', tension: .35, pointRadius: 0, borderWidth: 2, borderDash: [5, 4] }
    ] }, options: { ...base, interaction: { mode: 'index', intersect: false } } }));

    // 2. top sellers
    const top = a.rows.filter(r => r.sold > 0).sort((x, y) => y.sold - x.sold).slice(0, 10);
    if (!top.length) empty($('top'), 'No sales in this period yet.');
    else made.push(new Chart($('top'), { type: 'bar', data: { labels: top.map(r => r.name), datasets: [{ label: 'Units sold', data: top.map(r => r.sold), backgroundColor: C.brand, borderRadius: 6 }] },
      options: { ...base, indexAxis: 'y', plugins: { legend: { display: false } }, scales: { x: { grid: { color: C.grid }, beginAtZero: true }, y: { grid: { display: false }, ticks: { font: { size: 11 } } } } } }));

    // 3. days of cover
    const cov = a.rows.filter(r => r.perDay > 0).sort((x, y) => x.cover - y.cover).slice(0, 12);
    if (!cov.length) empty($('cover'), 'Appears once products have sales in this period.');
    else made.push(new Chart($('cover'), { type: 'bar', data: { labels: cov.map(r => r.name), datasets: [{ label: 'Days left', data: cov.map(r => Math.round(r.cover * 10) / 10),
      backgroundColor: cov.map(r => r.cover < 7 ? C.bad : r.cover < 14 ? C.warn : C.ok), borderRadius: 6 }] },
      options: { ...base, indexAxis: 'y', plugins: { legend: { display: false } }, scales: { x: { grid: { color: C.grid }, beginAtZero: true, title: { display: true, text: 'days' } }, y: { grid: { display: false }, ticks: { font: { size: 11 } } } } } }));

    // 4. stock level vs reorder
    const lvl = a.rows.slice().sort((x, y) => x.stock - y.stock).slice(0, 15);
    if (!lvl.length) empty($('level'), 'No products yet.');
    else made.push(new Chart($('level'), { type: 'bar', data: { labels: lvl.map(r => r.name), datasets: [
      { label: 'In stock', data: lvl.map(r => r.stock), backgroundColor: lvl.map(r => r.status === 'out' ? C.bad : r.status === 'low' ? C.warn : C.indigo), borderRadius: 6, order: 2 },
      // Reorder level as a short red line across each bar, drawn ON TOP of the bars.
      { label: 'Reorder level', data: lvl.map(r => Number(r.reorderLevel) || null), type: 'line', order: 1, showLine: false,
        pointStyle: 'line', pointRadius: 14, pointHoverRadius: 16, pointBorderWidth: 3, borderColor: C.bad, pointBorderColor: C.bad, backgroundColor: C.bad }
    ] }, options: { ...base,
      plugins: { legend: { labels: { boxWidth: 12, font: { size: 12 }, generateLabels: () => [
        { text: 'In stock', fillStyle: C.indigo, strokeStyle: C.indigo, lineWidth: 0 },
        { text: 'Low', fillStyle: C.warn, strokeStyle: C.warn, lineWidth: 0 },
        { text: 'Out', fillStyle: C.bad, strokeStyle: C.bad, lineWidth: 0 },
        { text: '— Reorder level', fillStyle: 'transparent', strokeStyle: 'transparent', lineWidth: 0, fontColor: C.bad }
      ] }, onClick: () => {} } },
      scales: { x: { grid: { display: false }, ticks: { font: { size: 10 }, maxRotation: 50, autoSkip: false } }, y: { grid: { color: C.grid }, beginAtZero: true } } } }));

    // 5. movement mix
    const mixVals = [a.mix.sold, a.mix.returned, a.mix.purchased, a.mix.adjusted];
    if (!mixVals.some(Boolean)) empty($('mix'), 'No stock movements in this period yet.');
    else made.push(new Chart($('mix'), { type: 'doughnut', data: { labels: ['Sold', 'Returned', 'Purchased / received', 'Adjusted'],
      datasets: [{ data: mixVals, backgroundColor: [C.brand, C.teal, C.indigo, C.grey], borderWidth: 2, borderColor: '#fff' }] },
      options: { responsive: true, maintainAspectRatio: false, cutout: '62%', plugins: { legend: { position: 'right', labels: { boxWidth: 12, font: { size: 12 } } } } } }));

    charts.set(container, made);
    return a;
  }

  global.VTStockCharts = { render, analyse, esc };
})(window);
