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

  /* Seller product (users/{uid}/products) — once per item. */
  async function sellerProductOnce(uid, item, product, source){
    const marker = u(uid).collection('processedSellerLabels').doc(item.key);
    if((await marker.get()).exists) return 'already';
    const batch = db.batch();
    batch.update(u(uid).collection('products').doc(product.id), { stock: FV().increment(-item.qty) });
    batch.set(u(uid).collection('stockMovements').doc(), {
      type: 'sale-out', productId: product.id, productName: product.name, qty: -item.qty, date: today(),
      note: `Label printed — ${item.marketplace} ${item.sku}`, createdAt: FV().serverTimestamp()
    });
    batch.set(marker, {
      marketplace: item.marketplace, sku: item.sku, qty: item.qty, productId: product.id,
      source: source || '', processedAt: FV().serverTimestamp()
    });
    await batch.commit();
    return 'deducted';
  }

  /* Buyer product (users/{uid}/buyerSkuMappings) — once per item. */
  async function buyerProductOnce(uid, item, mapping, source){
    const marker = u(uid).collection('buyerProcessedLabels').doc(item.key);
    if((await marker.get()).exists) return 'already';
    const batch = db.batch();
    batch.update(u(uid).collection('buyerSkuMappings').doc(mapping.id), { stock: FV().increment(-item.qty), updatedAt: FV().serverTimestamp() });
    batch.set(u(uid).collection('buyerStockMovements').doc(), {
      type: 'sale-out', mappingId: mapping.id, productName: mapping.productName, qty: -item.qty, date: today(),
      note: `Label printed — ${item.marketplace} ${item.sku}`, createdAt: FV().serverTimestamp()
    });
    batch.set(marker, {
      marketplace: item.marketplace, sku: item.sku, qty: item.qty, mappingId: mapping.id,
      source: source || '', processedAt: FV().serverTimestamp()
    });
    await batch.commit();
    return 'deducted';
  }

  async function packingDone(uid, packKey){
    return (await u(uid).collection('packagingConsumedLabels').doc(packKey).get()).exists;
  }
  /* One packet per label, first time only. Returns true if deducted now. */
  async function packingOnce(uid, item, packagingSizeId, sizeName, note){
    if(!packagingSizeId || !item.packKey) return false;
    const marker = u(uid).collection('packagingConsumedLabels').doc(item.packKey);
    if((await marker.get()).exists) return false;
    await marker.set({ marketplace: item.marketplace, sku: item.sku, packagingSizeId, consumedAt: FV().serverTimestamp() });
    await adjustSize(uid, 'buyerPackagingSizes', packagingSizeId, -1, { sizeName, type: 'print', note: note || `${item.marketplace} ${item.sku}` });
    return true;
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
    if((await marker.get()).exists) return 'already';
    const wasSold = (await u(uid).collection('processedSellerLabels').doc(item.key).get()).exists;
    const batch = db.batch();
    batch.update(u(uid).collection('products').doc(product.id), { stock: FV().increment(item.qty) });
    batch.set(u(uid).collection('stockMovements').doc(), {
      type: 'return-in', productId: product.id, productName: product.name, qty: item.qty, date: today(),
      note: `Return — ${item.marketplace} ${item.sku}${wasSold ? '' : ' (no matching sale on record)'}`, createdAt: FV().serverTimestamp()
    });
    batch.set(marker, { marketplace: item.marketplace, sku: item.sku, qty: item.qty, productId: product.id, wasSold, returnedAt: FV().serverTimestamp() });
    await batch.commit();
    return wasSold ? 'returned' : 'returned-unsold';
  }

  global.VLS = { SELLER_Q, BUYER_Q, today, logSize, adjustSize, sellerProductOnce, buyerProductOnce, packingDone, packingOnce, queueDocId, queueUnmapped, settleQueued, sellerReturnOnce };
})(window);
