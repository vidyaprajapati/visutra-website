/* VISUTRA — Business expenses (packing, labels, courier, ads …) that are NOT stock you resell,
   but cost money to run the business. They are subtracted from the monthly gross profit:
       Net profit = gross profit (sales − cost of goods) − business expenses.
   Stored in users/{uid}/businessExpenses — one document per entry:
     { date:'YYYY-MM-DD', month:'YYYY-MM', side:'seller'|'buyer', category, item, vendor, qty, rate,
       amount (ex-GST), gstPct, gst, claimGst (true = GST comes back as input credit → NOT a cost), note }
   Cost used in profit = amount + (claimGst ? 0 : gst).  Pure functions + a tiny loader (global EXP). */
(function (root) {
  'use strict';
  const CATEGORIES = ['Packing material', 'Labels & label paper', 'Courier & shipping', 'Printing / ink / tape', 'Marketing & ads',
    'Rent & utilities', 'Salary / labour', 'Software & subscriptions', 'Other'];
  const r2 = n => Math.round((Number(n) || 0) * 100) / 100;

  // build a clean entry from form values (never trusts a typed total over qty × rate)
  function makeEntry(f) {
    const qty = Number(f.qty) > 0 ? Number(f.qty) : 1;
    const rate = Number(f.rate) > 0 ? Number(f.rate) : 0;
    const amount = r2(f.amount != null && f.amount !== '' && !(rate > 0) ? Number(f.amount) : qty * rate);
    const gstPct = Math.max(0, Number(f.gstPct) || 0), gst = r2(amount * gstPct / 100);
    const date = /^\d{4}-\d{2}-\d{2}$/.test(f.date || '') ? f.date : '';
    return {
      date, month: date.slice(0, 7), side: f.side === 'buyer' ? 'buyer' : 'seller',
      category: CATEGORIES.includes(f.category) ? f.category : (String(f.category || '').trim() || 'Other'),
      item: String(f.item || '').trim().slice(0, 120), vendor: String(f.vendor || '').trim().slice(0, 80),
      qty, rate: r2(rate), amount, gstPct, gst, claimGst: f.claimGst !== false,
      note: String(f.note || '').trim().slice(0, 200)
    };
  }
  function problems(e) {
    const p = [];
    if (!e.date) p.push('Pick the date.');
    if (!(e.amount > 0)) p.push('Enter the amount (or quantity × rate).');
    if (!e.item) p.push('Say what it was for (e.g. "4×6 label roll, 500 pcs").');
    return p;
  }
  const costOf = e => r2((Number(e.amount) || 0) + (e.claimGst === false ? (Number(e.gst) || 0) : 0));
  const monthOf = e => e.month || String(e.date || '').slice(0, 7);

  // {month: {total, byCat:{cat: amount}, count}} for one side
  function monthTotals(list, side) {
    const out = {};
    (list || []).forEach(e => {
      if (side && e.side && e.side !== side) return;
      const m = monthOf(e); if (!m) return;
      const a = out[m] = out[m] || { total: 0, byCat: {}, count: 0 };
      const c = costOf(e);
      a.total = r2(a.total + c); a.count++; a.byCat[e.category || 'Other'] = r2((a.byCat[e.category || 'Other'] || 0) + c);
    });
    return out;
  }
  // gross: [{month, profit}] → rows newest first: {month, gross, expenses, net}
  function netRows(gross, totals) {
    const g = {}; (gross || []).forEach(x => { g[x.month] = r2((g[x.month] || 0) + (Number(x.profit) || 0)); });
    const months = [...new Set([...Object.keys(g), ...Object.keys(totals || {})])].sort().reverse();
    return months.map(m => { const gp = g[m] || 0, ex = (totals[m] && totals[m].total) || 0; return { month: m, gross: gp, expenses: ex, net: r2(gp - ex) }; });
  }
  function sum(rows) { return rows.reduce((a, r) => ({ gross: r2(a.gross + r.gross), expenses: r2(a.expenses + r.expenses), net: r2(a.net + r.net) }), { gross: 0, expenses: 0, net: 0 }); }

  async function load(db, uid) {
    const snap = await db.collection('users').doc(uid).collection('businessExpenses').get();
    return snap.docs.map(d => ({ id: d.id, ...d.data() })).sort((a, b) => String(b.date).localeCompare(String(a.date)));
  }

  /* Card shown on both Profit pages: gross profit − expenses = net profit, per month. */
  async function renderNet(opts) {   // { el, db, uid, side, gross:[{month,profit}], inr, esc, monthLabel, link }
    const el = opts.el; if (!el) return;
    let list = [];
    try { list = await load(opts.db, opts.uid); } catch (e) { el.innerHTML = ''; return; }
    const rows = netRows(opts.gross, monthTotals(list, opts.side)), t = sum(rows);
    const col = n => (n < 0 ? 'color:var(--paprika-dark)' : n > 0 ? 'color:#0E7C6B' : '');
    el.innerHTML = `<div class="box" style="margin:16px 0"><b>Profit after business expenses</b>
      <span class="sub" style="margin-left:6px">gross profit − packing, labels, courier & other running costs you entered</span>
      <a class="btn small" style="margin-left:8px" href="${opts.link}">＋ Add / see expenses</a>
      ${rows.length ? `<div style="overflow-x:auto"><table data-excel-name="Net profit after expenses" style="margin-top:8px"><thead><tr><th>Month</th><th>Gross profit</th><th>Business expenses</th><th>Net profit / loss</th></tr></thead><tbody>
        ${rows.map(r => `<tr><td data-sort="${opts.esc(r.month)}-01"><b>${opts.esc(opts.monthLabel(r.month))}</b></td><td style="${col(r.gross)}">${opts.inr(r.gross)}</td><td>${opts.inr(r.expenses)}</td><td style="${col(r.net)}"><b>${opts.inr(r.net)}</b></td></tr>`).join('')}
        </tbody></table></div>
        <div class="sub" style="margin-top:6px">All ${rows.length} month(s): gross ${opts.inr(t.gross)} − expenses ${opts.inr(t.expenses)} = <b style="${col(t.net)}">net ${opts.inr(t.net)}</b></div>`
        : '<div class="sub" style="margin-top:6px">No profit or expenses recorded yet.</div>'}</div>`;
  }
  root.EXP = { CATEGORIES, makeEntry, problems, costOf, monthTotals, netRows, sum, load, renderNet };
  if (typeof module !== 'undefined' && module.exports) module.exports = root.EXP;
})(typeof window !== 'undefined' ? window : globalThis);
