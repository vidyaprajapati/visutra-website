// Pure functions behind "Old Payment Data" and the Monthly Profit graphs (no browser, no database).
const { test } = require('node:test');
const assert = require('node:assert/strict');
global.window = globalThis;
require('../billing/assets/label-stock-core.js');            // VLS: the same status rules the reconciliation uses
const VPT = require('../billing/assets/profit-tools.js');

test('state names: spelling, case, codes and old names all become one clean name', () => {
  for (const [raw, want] of [['UTTAR PRADESH', 'Uttar Pradesh'], ['uttar  pradesh', 'Uttar Pradesh'], ['UP', 'Uttar Pradesh'], ['IN-MH', 'Maharashtra'], ['09', 'Uttar Pradesh'], [9, 'Uttar Pradesh'],
    ['Orissa', 'Odisha'], ['CHATTISGARH', 'Chhattisgarh'], ['Jammu & Kashmir', 'Jammu and Kashmir'], ['NCT of Delhi', 'Delhi'], ['Pondicherry', 'Puducherry'],
    ['DADRA & NAGAR HAVELI AND DAMAN & DIU', 'Dadra and Nagar Haveli and Daman and Diu'], ['TELENGANA', 'Telangana'], ['tamil nadu', 'Tamil Nadu'], ['Narnia', 'Narnia'], ['', ''], [null, '']])
    assert.equal(VPT.normalizeState(raw), want, String(raw));
});

test('dates: Excel serials, DD/MM/YYYY (India), ISO, "5 Sep 2026", Date objects', () => {
  assert.equal(VPT.parseDateCell(46270), '2026-09-05');                         // Excel serial
  assert.equal(VPT.parseDateCell('05/09/2026'), '2026-09-05');                  // 5 September, not 9 May
  assert.equal(VPT.parseDateCell('5-9-2026 14:30'), '2026-09-05');
  assert.equal(VPT.parseDateCell('2026-09-05 10:00:00'), '2026-09-05');
  assert.equal(VPT.parseDateCell('5 Sep 2026'), '2026-09-05');
  assert.equal(VPT.parseDateCell('05-Sept-2026'), '2026-09-05');
  assert.equal(VPT.parseDateCell(new Date('2026-09-05T00:00:00Z')), '2026-09-05');
  for (const bad of ['', null, undefined, 'soon', 12, 'Delivered']) assert.equal(VPT.parseDateCell(bad), '');
});

const H = { orderIdx: 0, skuIdx: 2, statusIdx: 3, qtyIdx: 4 };
test('old files → one record per order: money summed, final status wins, state/dates picked up, files merged', () => {
  const pay = { platform: 'MEESHO', detected: H, cols: { settle: 6, gst: 5, orderDate: 1, payDate: 7, state: -1 }, rows: [
    ['A1_1', '2026-03-02', 'VST-A', 'DELIVERED', 1, 5, 168, '2026-03-10'],        // sold, later returned: payment row …
    ['A1_1', '2026-03-02', 'VST-A', 'RTO_COMPLETE', 1, 5, -188, '2026-04-02'],    // … and its return adjustment
    ['B2_1', '2026-03-05', 'VST-A', 'DELIVERED', 2, 5, 336, '2026-03-12'],
    ['C3_1', '2026-04-01', 'VST-B', 'CANCELLED', 1, 12, 0, ''],
    ['D4_1', '2026-04-03', 'VST-A', 'LOST', 1, 5, 100, '2026-04-20'],
    ['E5_1', '', 'VST-A', '', 1, 5, 50, ''],                                       // no status → ignored, counted
    ['', '2026-04-03', 'VST-A', 'DELIVERED', 1, 5, 10, ''],                        // no order id → counted, skipped
  ] };
  const orders = { platform: 'MEESHO', detected: { ...H, reasonIdx: 3 }, cols: { settle: -1, gst: -1, orderDate: 1, payDate: -1, state: 5 }, rows: [
    ['A1_1', '2026-03-02', 'VST-A', 'DELIVERED', 1, 'up'], ['B2_1', '2026-03-05', 'VST-A', 'DELIVERED', 2, 'Maharashtra'], ['D4_1', '2026-04-03', 'VST-A', 'LOST', 1, 'KARNATAKA'] ] };
  const { orders: out, stats } = VPT.buildOldOrders([pay, orders], { basis: 'order' });
  const o = k => out.find(x => x.orderId === k);
  assert.equal(out.length, 5, 'A1, B2, C3, D4, E5');
  assert.deepEqual([o('A1_1').kind, o('A1_1').settle, o('A1_1').state, o('A1_1').month, o('A1_1').qty], ['return', -20, 'Uttar Pradesh', '2026-03', 1], '168 − 188 = −20; RTO beats DELIVERED');
  assert.deepEqual([o('B2_1').kind, o('B2_1').settle, o('B2_1').state, o('B2_1').gst], ['sold', 336, 'Maharashtra', 5]);
  assert.equal(o('C3_1').kind, 'cancel'); assert.equal(o('D4_1').kind, 'sold', 'LOST = a sale that is gone'); assert.equal(o('E5_1').kind, null);
  assert.deepEqual([stats.orders, stats.sold, stats.returned, stats.cancelled, stats.noStatus, stats.noOrderId, stats.states], [5, 2, 1, 1, 1, 1, 3]);
  // month by PAYMENT date instead: the returned order lands in the refund month
  assert.equal(VPT.buildOldOrders([pay, orders], { basis: 'pay' }).orders.find(x => x.orderId === 'A1_1').month, '2026-04');
  // undated rows use the fallback month (or are counted as undated)
  const undated = { ...pay, rows: [['Z9_1', '', 'VST-A', 'DELIVERED', 1, 5, 100, '']] };
  assert.equal(VPT.buildOldOrders([undated], { fallbackMonth: '2025-12' }).orders[0].month, '2025-12');
  assert.equal(VPT.buildOldOrders([undated], {}).stats.undated, 1);
});

test('roll-ups for the graphs: months in range, state totals with return rate, top-N + Other', () => {
  const mk = (month, byState) => ({ month, byState });
  const docs = [mk('2026-02', { 'Uttar Pradesh': { soldUnits: 10, returnUnits: 2, revenue: 1000, cogs: 600, profit: 400, returnCharges: 50 } }),
    mk('2026-03', { 'Uttar Pradesh': { soldUnits: 20, returnUnits: 3, revenue: 2000, cogs: 1200, profit: 800, returnCharges: 70 }, Bihar: { soldUnits: 5, returnUnits: 5, revenue: 300, cogs: 300, profit: -100, returnCharges: 100 } }),
    mk('2026-04', { Goa: { soldUnits: 1, returnUnits: 0, revenue: 100, cogs: 60, profit: 40, returnCharges: 0 } })];
  assert.deepEqual(VPT.monthsInRange(docs, '2026-03', '2026-04').map(m => m.month), ['2026-03', '2026-04']);
  assert.deepEqual(VPT.monthsInRange(docs, '', '').map(m => m.month), ['2026-02', '2026-03', '2026-04']);
  const st = VPT.sumStates(docs), up = st.find(s => s.state === 'Uttar Pradesh'), bi = st.find(s => s.state === 'Bihar');
  assert.deepEqual([up.soldUnits, up.returnUnits, up.revenue, up.profit, up.returnCharges, up.returnRate, up.margin], [30, 5, 3000, 1200, 120, 14.3, 40]);
  assert.deepEqual([bi.returnRate, bi.profit], [50, -100]);
  const top = VPT.topWithOther(st, 2, 'soldUnits');
  assert.deepEqual(top.map(r => r.state), ['Uttar Pradesh', 'Bihar', 'Other states (1)']);
  assert.equal(top[2].soldUnits, 1);
});

test('graphs: SVG with every value labelled, negative profit in red below the zero line, empty data handled', () => {
  const bar = VPT.barChartSvg({ title: 'Monthly profit', labels: ['Jan 2026', 'Feb 2026'], fmt: VPT.inrShort,
    series: [{ name: 'Profit', values: [120000, -3500], color: '#16A34A', negColor: '#DC2626' }] });
  assert.match(bar, /^<svg/); assert.match(bar, /aria-label="Monthly profit"/);
  assert.match(bar, /Jan 2026 — Profit: ₹1\.2L/); assert.match(bar, /Feb 2026 — Profit: −₹3\.5k/);
  assert.match(bar, /fill="#DC2626"/, 'negative bar is red');
  const h = VPT.hBarChartSvg({ title: 'State-wise units', rows: [{ label: 'Uttar Pradesh', value: 30, note: '14.3% returned' }, { label: 'Bihar', value: 5 }], color: '#2E4374' });
  assert.match(h, /Uttar Pradesh: 30 · 14\.3% returned/);
  assert.match(VPT.barChartSvg({ labels: [], series: [] }), /No data in this period yet/);
  assert.match(VPT.hBarChartSvg({ rows: [] }), /No data in this period yet/);
  assert.equal(VPT.inrShort(12500000), '₹1.3Cr'); assert.equal(VPT.inrShort(950), '₹950'); assert.equal(VPT.inrShort(-100000), '−₹1L');
  assert.ok(!/<script/i.test(VPT.barChartSvg({ labels: ['<script>x</script>'], series: [{ name: '<b>', values: [1], color: '#000' }] })), 'labels are escaped');
});

/* ---------------- SELLER: cost from supplier purchases, invoice profit, two streams ---------------- */
const purchases = [
  { date: '2026-01-10', items: [{ linkedProductId: 'P1', qty: 100, taxable: 8000 }] },                       // 80 / unit
  { date: '2026-03-05', items: [{ linkedProductId: 'P1', qty: 100, rate: 100 }, { linkedProductId: 'P2', qty: 10, taxable: 500 }] },   // 100 / unit; P2 50 / unit
  { date: '2026-03-06', deleted: true, items: [{ linkedProductId: 'P1', qty: 1000, taxable: 1 }] },           // recycle-bin purchase: ignored
  { date: '2026-03-07', items: [{ linkedProductId: null, qty: 5, taxable: 5 }, { linkedProductId: 'P1', qty: 0, taxable: 99 }] }];  // unlinked / zero-qty: ignored
test('seller cost per unit = weighted average of supplier purchases UP TO the sale date (a typed cost wins)', () => {
  const tl = VPT.costTimeline(purchases);
  assert.deepEqual(Object.keys(tl).sort(), ['P1', 'P2']);
  assert.deepEqual(VPT.costAt(tl, 'P1', '2026-02-01'), { cost: 80, source: 'purchases' }, 'only the January purchase existed');
  assert.deepEqual(VPT.costAt(tl, 'P1', '2026-03-05'), { cost: 90, source: 'purchases' }, '(8000 + 10000) ÷ 200');
  assert.deepEqual(VPT.costAt(tl, 'P1', '2026-12-31'), { cost: 90, source: 'purchases' });
  assert.deepEqual(VPT.costAt(tl, 'P1', '2025-12-01'), { cost: 90, source: 'purchases' }, 'sale back-dated before any purchase → overall average');
  assert.deepEqual(VPT.costAt(tl, 'P2', '2026-04-01'), { cost: 50, source: 'purchases' });
  assert.deepEqual(VPT.costAt(tl, 'P1', '2026-02-01', 70), { cost: 70, source: 'manual' }, 'typed cost overrides');
  assert.deepEqual(VPT.costAt(tl, 'P9', '2026-02-01'), { cost: 0, source: 'missing' });
});

const inv = (date, customer, items, extra) => Object.assign({ date, customer, items }, extra);
const UP = { name: 'Raj Traders', state: 'Uttar Pradesh', stateCode: '09' }, MH = { name: 'Mumbai Mart', stateCode: '27' };
test('profit on sales to buyers: straight from invoices — revenue ex-GST minus cost, by month, state, product and buyer', () => {
  const tl = VPT.costTimeline(purchases), costOf = (id, d) => VPT.costAt(tl, id, d);
  const months = VPT.invoiceMonths([
    inv('2026-02-10', UP, [{ productId: 'P1', name: 'WM Cover', qty: 10, taxable: 1500 }]),                    // cost 80 → 800 → profit 700
    inv('2026-03-15', MH, [{ productId: 'P1', name: 'WM Cover', qty: 5, taxable: 750 }, { productId: 'P2', name: 'Fridge Top', qty: 2, taxable: 200 }]),   // cost 90×5=450 → 300 ; 50×2=100 → 100
    inv('2026-03-20', UP, [{ productId: 'P1', name: 'WM Cover', qty: 1, taxable: 150 }]),
    inv('2026-03-21', UP, [{ productId: 'P1', name: 'WM Cover', qty: 99, taxable: 99999 }], { deleted: true }),  // cancelled → ignored
    inv('2026-03-22', UP, [{ productId: null, name: 'Freight', qty: 1, taxable: 100 }])                       // no product → no cost, flagged
  ], costOf);
  assert.deepEqual(months.map(m => m.month), ['2026-02', '2026-03']);
  const [feb, mar] = months;
  assert.deepEqual([feb.soldUnits, feb.revenue, feb.cogs, feb.profit, feb.margin], [10, 1500, 800, 700, 46.7]);
  assert.deepEqual([mar.soldUnits, mar.revenue, mar.cogs, mar.profit], [9, 1200, 450 + 100 + 90 + 0, 560], 'units 5+2+1+1');
  assert.deepEqual([mar.returnUnits, mar.returnCharges], [0, 0], 'invoices have no returns');
  assert.equal(mar.byState.Maharashtra.profit, 400); assert.equal(mar.byState['Uttar Pradesh'].profit, 160, '150 − 90 + (100 freight)');
  assert.equal(mar.byBuyer['Mumbai Mart'].profit, 400); assert.equal(mar.byPlatform.BUYERS.soldUnits, 9);
  assert.equal(mar.byProduct.P1.profit, 300 + 60, 'P1 across Mumbai Mart and Raj Traders');
  assert.deepEqual([mar.missingCostUnits, Object.keys(mar.missingProducts)], [1, ['Freight']]);
});

test('both streams merged: totals add up, a stream can be switched off, each month keeps its per-stream split', () => {
  const buyers = [{ month: '2026-03', soldUnits: 9, returnUnits: 0, revenue: 1200, cogs: 640, profit: 560, returnCharges: 0, byState: { Maharashtra: { soldUnits: 9, returnUnits: 0, revenue: 1200, cogs: 640, profit: 560, returnCharges: 0 } }, byProduct: { P1: { name: 'WM Cover', soldUnits: 9, returnUnits: 0, revenue: 1200, cogs: 640, profit: 560, returnCharges: 0 } }, byBuyer: {}, byPlatform: {} }];
  const ecom = [{ month: '2026-03', soldUnits: 4, returnUnits: 1, revenue: 300, cogs: 200, profit: 100, returnCharges: 19.05, byState: { Maharashtra: { soldUnits: 4, returnUnits: 1, revenue: 300, cogs: 200, profit: 100, returnCharges: 19.05 }, Goa: { soldUnits: 0, returnUnits: 0, revenue: 0, cogs: 0, profit: 0, returnCharges: 0 } }, byProduct: { P1: { name: 'WM Cover', soldUnits: 4, returnUnits: 1, revenue: 300, cogs: 200, profit: 100, returnCharges: 19.05 } }, byPlatform: { MEESHO: {} } },
    { month: '2026-04', soldUnits: 2, returnUnits: 0, revenue: 200, cogs: 100, profit: 100, returnCharges: 0, byState: {}, byProduct: {}, byPlatform: {} }];
  const all = VPT.mergeStreams(buyers, ecom), mar = all[0];
  assert.deepEqual(all.map(m => m.month), ['2026-03', '2026-04']);
  assert.deepEqual([mar.soldUnits, mar.returnUnits, mar.revenue, mar.profit, mar.returnCharges, mar.margin], [13, 1, 1500, 660, 19.05, 44]);
  assert.equal(mar.byState.Maharashtra.profit, 660); assert.equal(mar.byProduct.P1.profit, 660); assert.equal(mar.byProduct.P1.name, 'WM Cover');
  assert.deepEqual([mar.streams.buyers.profit, mar.streams.ecommerce.profit], [560, 100]);
  const onlyBuyers = VPT.mergeStreams(buyers, ecom, { buyers: true, ecommerce: false });
  assert.deepEqual([onlyBuyers[0].soldUnits, onlyBuyers[0].profit], [9, 560]);
  assert.equal(onlyBuyers[0].streams.ecommerce.profit, 100, 'the split is still recorded for the stream graph');
  assert.equal(onlyBuyers[1].profit, 0, 'a month with only e-commerce data is empty when e-commerce is off');
  const onlyEcom = VPT.mergeStreams(buyers, ecom, { buyers: false, ecommerce: true });
  assert.deepEqual([onlyEcom[0].soldUnits, onlyEcom[0].returnUnits, onlyEcom[0].returnCharges], [4, 1, 19.05]);
});
