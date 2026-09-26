/* VISUTRA — shared label stock rules.
   ONE place for every stock effect of a shipping label, used by:
     tools/label-cropper.html          (Seller + Buyer printing, returns, settings)
     billing/app.html → billing-app.js (Sell via Label, Unmapped Label SKUs)
     billing/buyer/label-order.html    (Upload Shipping Labels)
     billing/buyer/buyer-sku-master.html (size stock edits → history)
   Needs the Firebase compat globals `db` and `firebase`, plus labelKey()/
   packingKey() from label-sku-extract.js.

   An "item" is one product line on one shipping label:
     { marketplace, sku, qty, key, packKey }
   key     = labelKey()   — one per product line per shipment
   packKey = packingKey() — one per shipment

   Rules (identical everywhere):
     PRODUCT stock  — once per item, ever (reprints never deduct again).
     PACKING        — ONE packet per label (shipment), first time only.
     LABEL sticker  — every physical print (the caller decides how many).
     Every packing/label size change is logged to sizeStockMovements. */
(function(global){
  const FV = () => firebase.firestore.FieldValue;
  const u = uid => db.collection('users').doc(uid);
  const today = () => new Date().toISOString().slice(0, 10);

  async function logSize(uid, col, sizeId, sizeName, qty, type, note){
    if(!qty) return;
    try{
      await u(uid).collection('sizeStockMovements').add({
        kind: col === 'buyerLabelSizes' ? 'label' : 'packing',
        sizeId, sizeName: sizeName || '', qty, type: type || '', note: note || '',
        date: today(), createdAt: FV().serverTimestamp()
      });
    }catch(err){ console.error('Size stock history write failed:', err); }
  }

  /* +qty adds, -qty deducts. Always logged. */
  async function adjustSize(uid, col, sizeId, qty, opts){
    if(!sizeId || !qty) return false;
    opts = opts || {};
    try{
      await u(uid).collection(col).doc(sizeId).update({ stock: FV().increment(qty), updatedAt: FV().serverTimestamp() });
    }catch(err){
      console.error(`${col}/${sizeId} stock update failed:`, err);
      return false;
    }
    await logSize(uid, col, sizeId, opts.sizeName, qty, opts.type, opts.note);
    return true;
  }

  /* Every "count once" below runs in a Firestore TRANSACTION: the marker
     check and the stock change commit together or not at all. If two
     devices process the same label at the same moment, Firestore retries
     the loser, which then sees the marker and returns 'already' — so the
     same label can never be deducted twice. */

  /* Seller product (users/{uid}/products) — once per item. */
  async function sellerProductOnce(uid, item, product, source){
    const marker = u(uid).collection('processedSellerLabels').doc(item.key);
    const movement = u(uid).collection('stockMovements').doc();
    return db.runTransaction(async tx => {
      if((await tx.get(marker)).exists) return 'already';
      tx.update(u(uid).collection('products').doc(product.id), { stock: FV().increment(-item.qty) });
      tx.set(movement, {
        type: 'sale-out', productId: product.id, productName: product.name, qty: -item.qty, date: today(),
        note: `Label printed — ${item.marketplace} ${item.sku}`, createdAt: FV().serverTimestamp()
      });
      tx.set(marker, {
        marketplace: item.marketplace, sku: item.sku, qty: item.qty, productId: product.id,
        source: source || '', processedAt: FV().serverTimestamp()
      });
      return 'deducted';
    });
  }

  /* Buyer product (users/{uid}/buyerSkuMappings) — once per item. */
  async function buyerProductOnce(uid, item, mapping, source){
    const marker = u(uid).collection('buyerProcessedLabels').doc(item.key);
    const movement = u(uid).collection('buyerStockMovements').doc();
    return db.runTransaction(async tx => {
      if((await tx.get(marker)).exists) return 'already';
      tx.update(u(uid).collection('buyerSkuMappings').doc(mapping.id), { stock: FV().increment(-item.qty), updatedAt: FV().serverTimestamp() });
      tx.set(movement, {
        type: 'sale-out', mappingId: mapping.id, productName: mapping.productName, qty: -item.qty, date: today(),
        note: `Label printed — ${item.marketplace} ${item.sku}`, createdAt: FV().serverTimestamp()
      });
      tx.set(marker, {
        marketplace: item.marketplace, sku: item.sku, qty: item.qty, mappingId: mapping.id,
        source: source || '', processedAt: FV().serverTimestamp()
      });
      return 'deducted';
    });
  }

  async function packingDone(uid, packKey){
    return (await u(uid).collection('packagingConsumedLabels').doc(packKey).get()).exists;
  }
  /* One packet per label, first time only. Returns true if deducted now. */
  async function packingOnce(uid, item, packagingSizeId, sizeName, note){
    if(!packagingSizeId || !item.packKey) return false;
    const marker = u(uid).collection('packagingConsumedLabels').doc(item.packKey);
    const sizeRef = u(uid).collection('buyerPackagingSizes').doc(packagingSizeId);
    const done = await db.runTransaction(async tx => {
      if((await tx.get(marker)).exists) return false;
      tx.set(marker, { marketplace: item.marketplace, sku: item.sku, packagingSizeId, consumedAt: FV().serverTimestamp() });
      tx.update(sizeRef, { stock: FV().increment(-1), updatedAt: FV().serverTimestamp() });
      return true;
    });
    if(done) await logSize(uid, 'buyerPackagingSizes', packagingSizeId, sizeName, -1, 'print', note || `${item.marketplace} ${item.sku}`);
    return done;
  }

  /* ---------- Unmapped-label queues ----------
     Seller: users/{uid}/sellerUnmappedLabelSkus  (shown in Billing → Stock Management)
     Buyer : users/{uid}/buyerUnmappedLabelSkus   (settled when the SKU is added to a
             buyer product — in Label Cropper's Buyer Stock box or Buyer SKU Master) */
  const SELLER_Q = 'sellerUnmappedLabelSkus', BUYER_Q = 'buyerUnmappedLabelSkus';
  function queueDocId(sku){ return 'sku_' + hashText(String(sku).trim().toLowerCase()); }
  async function queueUnmapped(uid, items, labelDone, source, col){
    col = col || SELLER_Q;
    const bySku = {};
    items.forEach(it => { const k = it.sku.trim().toLowerCase(); (bySku[k] = bySku[k] || []).push(it); });
    for(const k of Object.keys(bySku)){
      const first = bySku[k][0];
      const ref = u(uid).collection(col).doc(queueDocId(first.sku));
      try{
        await db.runTransaction(async tx => {
          const snap = await tx.get(ref);
          const data = snap.exists ? snap.data() : { sku: first.sku, marketplace: first.marketplace, firstSeen: today(), pending: {} };
          data.pending = data.pending || {};
          bySku[k].forEach(it => {
            const cur = data.pending[it.key];
            if(cur){ if(labelDone) cur.labelDone = true; }
            else data.pending[it.key] = { key: it.key, packKey: it.packKey, marketplace: it.marketplace, sku: it.sku, qty: it.qty, labelDone: !!labelDone, printedAt: today() };
          });
          const list = Object.values(data.pending);
          data.labelCount = list.length;
          data.unitCount = list.reduce((a, x) => a + (x.qty || 0), 0);
          data.marketplaces = [...new Set(list.map(x => x.marketplace))];
          data.lastSeen = today();
          data.status = 'UNMAPPED';
          data.source = source || data.source || '';
          data.updatedAt = FV().serverTimestamp();
          tx.set(ref, data);
        });
      }catch(err){ console.error('Could not queue unmapped SKU ' + first.sku + ':', err); }
    }
  }
  /* Deducts everything queued under one doc for `product`, then deletes it.
     pkg = the product's buyerProductPackaging assignment (or null),
     sizeName(col, id) = display name lookup for history notes. */
  /* opts.col = which queue (default Seller); opts.buyerMapping = the buyer
     product to deduct instead of a Seller product. */
  async function settleQueued(uid, docId, product, pkg, sizeName, opts){
    opts = opts || {};
    const ref = u(uid).collection(opts.col || SELLER_Q).doc(docId);
    const snap = await ref.get();
    const out = { labels: 0, units: 0, already: 0, packing: 0, stickers: 0 };
    if(!snap.exists) return out;
    const pending = Object.values(snap.data().pending || {}).map(p => ({
      ...p, key: p.key || p.sellerHash, packKey: p.packKey || p.packHash   // older queue entries
    }));
    const stickerLabels = new Set();
    for(const it of pending){
      const r = opts.buyerMapping
        ? await buyerProductOnce(uid, it, opts.buyerMapping, 'queue')
        : await sellerProductOnce(uid, it, product, 'queue');
      if(r === 'deducted'){ out.labels++; out.units += it.qty; } else out.already++;
      if(pkg && pkg.packagingSizeId && await packingOnce(uid, it, pkg.packagingSizeId, sizeName('buyerPackagingSizes', pkg.packagingSizeId), `Catch-up — ${it.marketplace} ${it.sku}`)) out.packing++;
      if(pkg && pkg.labelSizeId && !it.labelDone) stickerLabels.add(it.packKey || it.key);
    }
    if(stickerLabels.size){
      await adjustSize(uid, 'buyerLabelSizes', pkg.labelSizeId, -stickerLabels.size, { sizeName: sizeName('buyerLabelSizes', pkg.labelSizeId), type: 'catch-up', note: `${product.name} — labels printed while unmapped` });
      out.stickers = stickerLabels.size;
    }
    await ref.delete();
    return out;
  }

  /* ---------- Returns (seller) — once per item ---------- */
  async function sellerReturnOnce(uid, item, product){
    const marker = u(uid).collection('sellerReturnedLabels').doc(item.key);
    const soldRef = u(uid).collection('processedSellerLabels').doc(item.key);
    const movement = u(uid).collection('stockMovements').doc();
    return db.runTransaction(async tx => {
      if((await tx.get(marker)).exists) return 'already';
      const wasSold = (await tx.get(soldRef)).exists;
      tx.update(u(uid).collection('products').doc(product.id), { stock: FV().increment(item.qty) });
      tx.set(movement, {
        type: 'return-in', productId: product.id, productName: product.name, qty: item.qty, date: today(),
        note: `Return — ${item.marketplace} ${item.sku}${wasSold ? '' : ' (no matching sale on record)'}`, createdAt: FV().serverTimestamp()
      });
      tx.set(marker, { marketplace: item.marketplace, sku: item.sku, qty: item.qty, productId: product.id, wasSold, returnedAt: FV().serverTimestamp() });
      return wasSold ? 'returned' : 'returned-unsold';
    });
  }

  /* ---------- Speed: run async work N at a time (#11) ----------
     Label files with hundreds of labels were processed one Firestore call
     after another. Each once-only step is its own transaction that only
     READS its own marker (stock is changed with an increment, never read),
     so they don't block each other and can safely run in parallel. */
  async function mapLimit(list, limit, fn){
    const out = new Array(list.length);
    let next = 0;
    async function worker(){
      while(next < list.length){ const i = next++; out[i] = await fn(list[i], i); }
    }
    await Promise.all(Array.from({ length: Math.min(limit, list.length) }, worker));
    return out;
  }

  /* ---------- Undo last print (#8) ----------
     A print records exactly what it changed in users/{uid}/printLog:
       product: [{ side:'seller'|'buyer', key, id, name, qty }]
       packing: [{ packKey, sizeId, sizeName }]
       labels:  [{ sizeId, sizeName, qty }]
       queued:  [{ col, sku, key }]      (unmapped labels added to a list)
     Undo reverses each one — removing its "already counted" marker too, so a
     corrected reprint is counted fresh. Each product/packing reversal is its
     own transaction and only happens if the marker is still there, so undo
     can never add stock back twice. */
  async function savePrintRecord(uid, rec){
    const ref = u(uid).collection('printLog').doc();
    await ref.set({ ...rec, undone: false, createdAt: FV().serverTimestamp(), date: today() });
    return ref.id;
  }
  async function lastPrintRecord(uid){
    const snap = await u(uid).collection('printLog').orderBy('createdAt', 'desc').limit(1).get();
    if(!snap.docs.length) return null;
    const d = snap.docs[0];
    return { id: d.id, ...d.data() };
  }
  async function undoPrint(uid, recId){
    const recRef = u(uid).collection('printLog').doc(recId);
    const rec = (await recRef.get()).data();
    if(!rec || rec.undone) return null;
    const out = { units: 0, packing: 0, labels: 0 };
    for(const p of rec.product || []){
      const markerCol = p.side === 'buyer' ? 'buyerProcessedLabels' : 'processedSellerLabels';
      const stockRef = p.side === 'buyer' ? u(uid).collection('buyerSkuMappings').doc(p.id) : u(uid).collection('products').doc(p.id);
      const movRef = u(uid).collection(p.side === 'buyer' ? 'buyerStockMovements' : 'stockMovements').doc();
      const marker = u(uid).collection(markerCol).doc(p.key);
      const did = await db.runTransaction(async tx => {
        if(!(await tx.get(marker)).exists) return false;
        tx.delete(marker);
        tx.update(stockRef, { stock: FV().increment(p.qty) });
        tx.set(movRef, p.side === 'buyer'
          ? { type: 'undo-print', mappingId: p.id, productName: p.name, qty: p.qty, date: today(), note: 'Undo last print', createdAt: FV().serverTimestamp() }
          : { type: 'undo-print', productId: p.id, productName: p.name, qty: p.qty, date: today(), note: 'Undo last print', createdAt: FV().serverTimestamp() });
        return true;
      });
      if(did) out.units += p.qty;
    }
    for(const k of rec.packing || []){
      const marker = u(uid).collection('packagingConsumedLabels').doc(k.packKey);
      const did = await db.runTransaction(async tx => {
        if(!(await tx.get(marker)).exists) return false;
        tx.delete(marker);
        tx.update(u(uid).collection('buyerPackagingSizes').doc(k.sizeId), { stock: FV().increment(1) });
        return true;
      });
      if(did){ out.packing++; await logSize(uid, 'buyerPackagingSizes', k.sizeId, k.sizeName, 1, 'undo', 'Undo last print'); }
    }
    for(const l of rec.labels || []){
      if(await adjustSize(uid, 'buyerLabelSizes', l.sizeId, l.qty, { sizeName: l.sizeName, type: 'undo', note: 'Undo last print' })) out.labels += l.qty;
    }
    for(const q of rec.queued || []){
      const ref = u(uid).collection(q.col).doc(queueDocId(q.sku));
      try{
        await db.runTransaction(async tx => {
          const snap = await tx.get(ref);
          if(!snap.exists) return;
          const data = snap.data();
          if(!data.pending || !data.pending[q.key]) return;
          delete data.pending[q.key];
          const list = Object.values(data.pending);
          if(!list.length){ tx.delete(ref); return; }
          data.labelCount = list.length;
          data.unitCount = list.reduce((a, x) => a + (x.qty || 0), 0);
          tx.set(ref, data);
        });
      }catch(err){ console.error('Undo: could not remove queued label', err); }
    }
    await recRef.set({ undone: true, undoneAt: FV().serverTimestamp() }, { merge: true });
    return out;
  }

  /* ---------- Monthly Reconciliation ↔ labels & returns (#9) ----------
     A marketplace report row carries the ORDER ID, so it gets the same
     shipment key a printed label gets (labelKey). Then:
       delivered row → skipped if that shipment was already deducted
                       (label printed / earlier upload); else deducted + marked.
       return row    → skipped only if that return was already added back
                       (Returns box / earlier upload); else added back + marked.
     Re-uploading the same report therefore changes nothing the second time.
     rows: [{ marketplace, sku, orderId, qty, isReturn }]  side: 'seller'|'buyer'
     Adds to each row: key (null = no order ID → old behaviour) and
     status: 'new' | 'already'. */
  /* How a marketplace report status counts (Meesho "Reason for Credit
     Entry", Flipkart "Order Status"):
       CANCELLED                        → 'cancel' (counts 0)
       anything with RTO / RETURN       → 'return' (e.g. RTO_DELIVERED is a return,
                                           even though it says "delivered")
       DELIVERED / EXCHANGED            → 'sold'   (e.g. DOOR_STEP_EXCHANGED)
       any other non-empty status       → 'return' (LOST, RTO_LOCKED …)
       empty                            → null     (row ignored) */
  function reconStatusKind(status){
    const s = String(status == null ? '' : status).trim().toUpperCase();
    if(!s) return null;
    if(/CANCEL/.test(s)) return 'cancel';
    if(/RTO|RETURN/.test(s)) return 'return';
    if(/DELIVER|EXCHANGE/.test(s)) return 'sold';
    return 'return';
  }
  /* One order can appear on several rows of a Meesho payment file (e.g. an
     advance "Shipped" payment row and a later "Return" adjustment row, or a
     "Return" row plus a blank-status row). Counting each row would count
     one parcel twice — so rows are collapsed to ONE per (order ID + SKU),
     keeping the most final status:
       RTO / RETURN  >  CANCELLED  >  DELIVERED / EXCHANGED  >  other  >  blank */
  function reconStatusRank(status){
    const s = String(status == null ? '' : status).trim().toUpperCase();
    if(!s) return 0;
    if(/RTO|RETURN/.test(s)) return 5;
    if(/CANCEL/.test(s)) return 4;
    if(/DELIVER|EXCHANGE/.test(s)) return 3;
    return 2;
  }
  function collapseReconRows(rows, orderIdx, statusIdx, skuIdx){
    if(orderIdx == null || orderIdx < 0) return rows;
    const best = new Map(), out = [];
    rows.forEach(row => {
      const id = String(row[orderIdx] ?? '').trim();
      if(!id){ out.push(row); return; }
      const k = id + '|' + String(row[skuIdx] ?? '').trim().toLowerCase();
      const cur = best.get(k);
      if(!cur || reconStatusRank(row[statusIdx]) > reconStatusRank(cur[statusIdx])) best.set(k, row);
    });
    return out.concat([...best.values()]);
  }
  function reconCols(side){
    return side === 'buyer'
      ? { sold: 'buyerProcessedLabels', ret: 'buyerReturnedLabels' }
      : { sold: 'processedSellerLabels', ret: 'sellerReturnedLabels' };
  }
  async function linkReconRows(uid, side, rows){
    const cols = reconCols(side);
    rows.forEach(r => {
      const id = r.orderId ? shipmentIdFromText(String(r.orderId), r.marketplace) : null;
      r.key = id ? labelKey(r.marketplace, r.sku, String(r.orderId)) : null;
    });
    const linked = rows.filter(r => r.key);
    const soldKeys = [...new Set(linked.map(r => r.key))];
    const soldExists = {}, retExists = {};
    await mapLimit(soldKeys, 12, async k => {
      soldExists[k] = (await u(uid).collection(cols.sold).doc(k).get()).exists;
      retExists[k] = (await u(uid).collection(cols.ret).doc(k).get()).exists;
    });
    // A return no longer needs its sale to be on record: most returns in a
    // month's report are for orders sold before that record existed, and
    // requiring it wrongly skipped them. Cancellations — the case that rule
    // was guarding — now count 0 anyway (reconStatusKind).
    const seen = new Set();
    linked.forEach(r => {
      const done = r.isReturn ? retExists[r.key] : soldExists[r.key];
      const dupKey = (r.isReturn ? 'R|' : 'S|') + r.key;
      if(done || seen.has(dupKey)) r.status = 'already';   // counted before, or listed twice in this upload
      else { r.status = 'new'; seen.add(dupKey); }
    });
    return rows;
  }
  /* Writes the markers for rows applied as 'new' (so a later label print,
     Returns box or re-upload sees them). targetId = productId / mappingId. */
  async function markReconRows(uid, side, rows, targetId, source){
    const cols = reconCols(side);
    const todo = rows.filter(r => r.key && r.status === 'new');
    for(let i = 0; i < todo.length; i += 400){
      const batch = db.batch();
      todo.slice(i, i + 400).forEach(r => {
        batch.set(u(uid).collection(r.isReturn ? cols.ret : cols.sold).doc(r.key), {
          marketplace: r.marketplace, sku: r.sku, qty: r.qty, [side === 'buyer' ? 'mappingId' : 'productId']: targetId,
          source: source || 'reconciliation', processedAt: FV().serverTimestamp()
        }, { merge: true });
      });
      await batch.commit();
    }
  }

  /* ---------- Reorder suggestions (#7) ----------
     From the last `days` days of movements: average sold per day, days of
     stock left, and how many to order to cover `coverDays` more days.
     items: [{ id, name, stock }]   sold: { id: qtySoldInWindow } */
  function reorderRows(items, sold, days, coverDays){
    return items.map(it => {
      const perDay = (sold[it.id] || 0) / days;
      const stock = it.stock || 0;
      const daysLeft = perDay > 0 ? stock / perDay : Infinity;
      const orderQty = perDay > 0 ? Math.max(0, Math.ceil(perDay * coverDays - stock)) : 0;
      const status = perDay <= 0 ? 'no-sales' : daysLeft < 7 ? 'now' : daysLeft < 14 ? 'soon' : 'ok';
      return { ...it, soldWindow: sold[it.id] || 0, perDay, daysLeft, orderQty, status };
    }).filter(r => r.perDay > 0)
      .sort((a, b) => a.daysLeft - b.daysLeft);
  }
  function daysAgo(n){ const d = new Date(); d.setDate(d.getDate() - n); return d.toISOString().slice(0, 10); }
  /* Units used per item over the last `days` days, from a movement log.
     col: stockMovements | buyerStockMovements | sizeStockMovements
     idField: productId | mappingId | sizeId
     Counts sales/prints as usage and subtracts undone prints. */
  async function usagePerItem(uid, col, idField, days){
    const USE = { 'sale-out': 1, 'print': 1, 'reprint': 1, 'sell-via-label': 1, 'catch-up': 1, 'undo-print': 1, 'undo': 1 };
    const snap = await u(uid).collection(col).where('date', '>=', daysAgo(days)).get();
    const used = {};
    snap.docs.forEach(d => {
      const m = d.data();
      if(!USE[m.type] || !m[idField]) return;
      used[m[idField]] = (used[m[idField]] || 0) - (Number(m.qty) || 0); // sales are negative, undo positive
    });
    Object.keys(used).forEach(k => { if(used[k] < 0) used[k] = 0; });
    return used;
  }
  /* Shared table body for every "Reorder suggestions" card. */
  function reorderTableHtml(rows, esc, coverDays){
    if(!rows.length) return '<tr><td colspan="7" style="color:var(--muted)">No sales in this period yet — suggestions appear once items start selling.</td></tr>';
    const badge = st => st === 'now' ? '<span class="badge" style="background:#FBE4DE;color:#9E3608">Order now</span>'
      : st === 'soon' ? '<span class="badge" style="background:#FFF1D6;color:#8A5A00">Soon</span>'
      : '<span class="badge" style="background:#D6EFE7;color:#0A5C4F">OK</span>';
    return rows.map(r => `<tr>
      <td>${esc(r.name)}</td><td>${r.stock || 0}</td><td>${r.soldWindow}</td>
      <td>${r.perDay >= 10 ? Math.round(r.perDay) : r.perDay.toFixed(1)}</td>
      <td>${isFinite(r.daysLeft) ? (r.daysLeft < 1 ? '< 1' : Math.floor(r.daysLeft)) : '—'}</td>
      <td><b>${r.orderQty || '—'}</b>${r.orderQty ? ` <span style="color:var(--muted);font-size:11px">(${coverDays} days)</span>` : ''}</td>
      <td>${badge(r.status)}</td></tr>`).join('');
  }

  global.VLS = { reconStatusKind, reconStatusRank, collapseReconRows, SELLER_Q, BUYER_Q, today, mapLimit, savePrintRecord, lastPrintRecord, undoPrint, linkReconRows, markReconRows, reorderRows, daysAgo, usagePerItem, reorderTableHtml, logSize, adjustSize, sellerProductOnce, buyerProductOnce, packingDone, packingOnce, queueDocId, queueUnmapped, settleQueued, sellerReturnOnce };
})(window);
