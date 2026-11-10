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
