// VISUTRA — order helpers shared by the buyer pages (Label Auto Order, Place Order, My Orders)
// and the seller's Order Receive page:
//   · ONE pending order per buyer + seller (later sends are merged into it)
//   · order cost (taxable + GST at the seller's prices)
// Needs the globals `db` and `firebase` (loaded before this file, like every other page script).

/* ---------------- ONE pending order per buyer + seller ----------------
   While a seller has not accepted or rejected an order, every further order the
   buyer sends to that seller — the same day or on later days, Label Auto Order or
   Place Order — is added INTO that pending order instead of becoming another one.
   The seller then handles one order and gets one invoice. If the seller accepts at
   the very moment the buyer sends more, the merge is refused by the database and
   the extra items go out as a normal new order (nothing is lost). */
const VT_MERGEABLE_TYPES = ['LABEL_AUTO', 'PRODUCT_SELECT'];
function vtMergeOrderItems(existing, extra) {
  const out = (existing || []).map(function (i) {
    const c = Object.assign({}, i);
    if (i.marketplaceBreakdown) c.marketplaceBreakdown = Object.assign({}, i.marketplaceBreakdown);
    return c;
  });
  (extra || []).forEach(function (n) {
    const hit = out.find(function (i) { return i.productId === n.productId; });
    if (!hit) {
      const c = Object.assign({}, n);
      if (n.marketplaceBreakdown) c.marketplaceBreakdown = Object.assign({}, n.marketplaceBreakdown);
      out.push(c); return;
    }
    hit.qty = (Number(hit.qty) || 0) + (Number(n.qty) || 0);
    if (n.marketplaceBreakdown) {
      const b = hit.marketplaceBreakdown = hit.marketplaceBreakdown || { amazon: 0, meesho: 0, flipkart: 0 };
      ['amazon', 'meesho', 'flipkart'].forEach(function (k) { b[k] = (Number(b[k]) || 0) + (Number(n.marketplaceBreakdown[k]) || 0); });
    }
  });
  return out;
}
function vtDayRange(from, to) {
  const f = function (k) { const p = String(k || '').split('-').map(Number); return p[0] ? new Date(p[0], p[1] - 1, p[2]).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) : ''; };
  const a = f(from), b = f(to || from);
  return !a ? '' : a === b ? a : a + ' – ' + b;
}
// fields that change on the target order when another one is folded into it
function vtMergeFields(cur, extra, items) {
  const upd = {
    items: items,
    mergedCount: (Number(cur.mergedCount) || 0) + 1,
    mergedNumbers: (cur.mergedNumbers || []).concat(extra.orderNumber ? [extra.orderNumber] : []),
    updatedAt: firebase.firestore.FieldValue.serverTimestamp()
  };
  if (cur.orderType === 'LABEL_AUTO' && extra.orderType === 'LABEL_AUTO') {
    const from = [cur.labelsFrom || cur.labelsDate, extra.labelsFrom || extra.labelsDate].filter(Boolean).sort()[0];
    const to = [cur.labelsDate, extra.labelsDate].filter(Boolean).sort().pop();
    if (from) { upd.labelsFrom = from; upd.labelsDate = to || from; upd.note = 'Labels dispatched ' + vtDayRange(from, to || from); }
  } else if (extra.note && extra.note !== cur.note) {
    upd.note = [cur.note, extra.note].filter(Boolean).join(' | ');
  }
  return upd;
}
async function vtPendingOrdersBySeller(uid) {
  const snap = await db.collection('marketplaceOrders').where('buyerUid', '==', uid).get();
  const by = {};
  snap.docs.map(function (d) { return Object.assign({ id: d.id }, d.data()); })
    .filter(function (o) { return o.status === 'PENDING' && VT_MERGEABLE_TYPES.indexOf(o.orderType) >= 0; })
    .sort(function (a, b) { return ((a.createdAt && a.createdAt.toMillis && a.createdAt.toMillis()) || 0) - ((b.createdAt && b.createdAt.toMillis && b.createdAt.toMillis()) || 0); })
    .forEach(function (o) { (by[o.sellerUid] = by[o.sellerUid] || []).push(o); });
  return by;
}
// Place `orderData` (already carrying orderNumber etc.) as `orderRef`, OR merge it into the
// buyer's existing pending order with the same seller. Returns { merged, orderId, orderNumber, items }.
async function vtPlaceOrMergeOrder(uid, orderRef, orderData) {
  if (VT_MERGEABLE_TYPES.indexOf(orderData.orderType) >= 0) {
    let target = null;
    try { target = ((await vtPendingOrdersBySeller(uid))[orderData.sellerUid] || [])[0] || null; } catch (e) { target = null; }
    if (target) {
      try {
        const ref = db.collection('marketplaceOrders').doc(target.id);
        const res = await db.runTransaction(async function (tx) {
          const snap = await tx.get(ref);
          const cur = snap.exists ? snap.data() : null;
          if (!cur || cur.status !== 'PENDING') throw Object.assign(new Error('VT_NOT_PENDING'), { vtSkip: true });
          const items = vtMergeOrderItems(cur.items, orderData.items);
          tx.update(ref, vtMergeFields(cur, orderData, items));
          return { orderId: target.id, orderNumber: cur.orderNumber, items: items, mergedCount: (Number(cur.mergedCount) || 0) + 1 };
        });
        return Object.assign({ merged: true }, res);
      } catch (e) {
        // seller accepted/rejected it a moment ago → send as a new order instead
        if (!(e && (e.vtSkip || /VT_DENIED|VT_CONFLICT|VT_NOT_FOUND|permission/i.test(e.message || '')))) throw e;
      }
    }
  }
  await orderRef.set(orderData);
  return { merged: false, orderId: orderRef.id, orderNumber: orderData.orderNumber, items: orderData.items };
}
// One-off tidy-up for pending orders sent before this existed: fold every extra pending
// order of a seller into the oldest one (the others become status MERGED and leave the
// seller's list). Returns the number of orders folded away.
async function vtMergeExistingPendingOrders(uid) {
  const by = await vtPendingOrdersBySeller(uid);
  let folded = 0;
  for (const sid of Object.keys(by)) {
    const list = by[sid];
    if (list.length < 2) continue;
    const targetRef = db.collection('marketplaceOrders').doc(list[0].id);
    for (const extra of list.slice(1)) {
      const extraRef = db.collection('marketplaceOrders').doc(extra.id);
      await db.runTransaction(async function (tx) {
        const t = await tx.get(targetRef), x = await tx.get(extraRef);
        if (!t.exists || !x.exists || t.data().status !== 'PENDING' || x.data().status !== 'PENDING') return;
        const items = vtMergeOrderItems(t.data().items, x.data().items);
        tx.update(targetRef, vtMergeFields(t.data(), x.data(), items));
        tx.update(extraRef, { status: 'MERGED', mergedInto: list[0].id, updatedAt: firebase.firestore.FieldValue.serverTimestamp() });
      });
      folded++;
    }
  }
  return folded;
}

/* ---------------- Order cost ---------------- */
function vtMoney(n) { return '₹' + (Number(n) || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
// items: [{productId, qty}] · prices: { productId: {price, gstRate} } → taxable + GST at those prices
function vtOrderCost(items, prices) {
  let taxable = 0, gst = 0, unpriced = 0;
  (items || []).forEach(function (i) {
    const p = prices[i.productId];
    if (!p || !(Number(p.price) >= 0)) { unpriced++; return; }
    const t = Math.round((Number(i.qty) || 0) * Number(p.price) * 100) / 100;
    taxable += t; gst += Math.round(t * (Number(p.gstRate) || 0) / 100 * 100) / 100;
  });
  return { taxable: taxable, gst: gst, total: taxable + gst, unpriced: unpriced };
}
// the seller's catalogue prices a LINKED buyer is allowed to see (active + buyer-visible products only)
const _vtSellerPriceCache = {};
async function vtSellerPrices(sellerUid) {
  if (_vtSellerPriceCache[sellerUid]) return _vtSellerPriceCache[sellerUid];
  const map = {};
  try {
    const snap = await db.collection('users').doc(sellerUid).collection('products').get();
    snap.docs.forEach(function (d) { const p = d.data(); map[d.id] = { price: Number(p.price) || 0, gstRate: Number(p.gstRate) || 0 }; });
  } catch (e) { /* no access → costs show as "priced on acceptance" */ }
  return (_vtSellerPriceCache[sellerUid] = map);
}
function vtCostHtml(c, opts) {
  opts = opts || {};
  if (!c) return '<span style="color:var(--muted)">—</span>';
  const note = c.unpriced ? '<div style="font-size:11px;color:var(--muted)">+ ' + c.unpriced + ' item(s) priced on acceptance</div>' : '';
  return '<b>' + vtMoney(c.total) + '</b><div style="font-size:11px;color:var(--muted)">' + vtMoney(c.taxable) + ' + ' + vtMoney(c.gst) + ' GST' + (opts.estimate ? ' (estimate)' : '') + '</div>' + note;
}
