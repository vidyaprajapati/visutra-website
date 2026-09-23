/**
 * VISUTRA — server-side buyer stock update.
 *
 * Root cause this replaces: ensureBuyerPurchaseForOrder() (the code that
 * creates a Purchase Entry from an accepted order and posts the stock-in)
 * previously only ran client-side, and only when the buyer happened to open
 * My Orders (or, for the off-platform confirm flow, the Dashboard). If the
 * buyer never opened that page, stock never moved.
 *
 * IMPORTANT — stock model (see BUYER-STOCK-REDESIGN.md): buyer-side stock is
 * its OWN number, tracked on each ACTIVE Buyer SKU Master mapping
 * (users/{buyerUid}/buyerSkuMappings/{id}.stock) — never on the seller/
 * Billing side's own sellable Products (users/{uid}/products). This function
 * never reads or writes that collection. A mapping is matched by the exact
 * seller + their product id (order.sellerUid + item.productId) — never by
 * product name. Items with no ACTIVE mapping for that seller are recorded in
 * the Purchase Entry (for GSTR/accounting) but their stock is left untouched;
 * add the mapping in Buyer SKU Master and it will track from the next order.
 *
 * This function watches marketplaceOrders for the transition to ACCEPTED (a
 * seller accepting a normal Place Order) and does the Supplier / Purchase
 * Product / Purchase / mapping-stock-increment / buyerStockMovement /
 * buyerPurchaseId work the moment it happens, with the Admin SDK (which
 * bypasses Firestore security rules), so it no longer depends on any client
 * page being open at all.
 *
 * NOTE: the PENDING_BUYER_CONFIRMATION -> ACCEPTED path (buyer approving an
 * off-platform sale from the Dashboard) is deliberately left as-is — that
 * transition is written by the buyer's own client in dashboard.html and
 * already calls ensureBuyerPurchaseForOrder() synchronously in the same
 * click, so it isn't affected by this bug. This function's guard will still
 * fire for that path too since Cloud Functions can't tell who triggered a
 * write — see the buyerPurchaseId check below for why that's harmless
 * (whichever side gets there first — Dashboard's client write or this
 * function — wins, and the other becomes a no-op).
 */

const { onDocumentUpdated } = require('firebase-functions/v2/firestore');
const { initializeApp } = require('firebase-admin/app');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');

initializeApp();
const db = getFirestore();

exports.onOrderAccepted = onDocumentUpdated('marketplaceOrders/{orderId}', async (event) => {
  const before = event.data.before.data();
  const after = event.data.after.data();
  const orderId = event.params.orderId;

  if (before.status === after.status) return; // not a status change at all
  if (after.status !== 'ACCEPTED') return;     // only care about landing on ACCEPTED
  if (after.buyerPurchaseId) return;           // already turned into a purchase (e.g. by the buyer's own client) — avoid a duplicate

  const order = { id: orderId, ...after };

  try {
    await ensureBuyerPurchaseForOrder(order);
  } catch (err) {
    // Logged for the Firebase Functions console; the order stays ACCEPTED
    // either way (never rolled back) so a manual Purchase Entry is still
    // possible as a fallback, and a future retry (a real edit to the order,
    // or a manual re-run) can pick it up since buyerPurchaseId is still unset.
    console.error(`onOrderAccepted: failed to create purchase/stock for order ${orderId}`, err);
  }
});

async function ensureBuyerPurchaseForOrder(order) {
  const buyerUid = order.buyerUid;
  const usersRef = db.collection('users').doc(buyerUid);

  const supplierId = await ensureSupplierForSeller(usersRef, order.sellerUid, order.sellerName);

  // Fetched once per order, not per item — cheap, and mappings rarely change
  // mid-order.
  const mapSnap = await usersRef.collection('buyerSkuMappings').where('status', '==', 'ACTIVE').get();
  const skuMappings = mapSnap.docs.map((d) => ({ id: d.id, ...d.data() }));

  const items = [];
  const stockIns = []; // {mappingId, productName, qty} — applied to buyerSkuMappings, never to products
  const unmappedNames = [];

  for (const item of order.items) {
    const purchaseProductId = await ensurePurchaseProduct(usersRef, order.sellerUid, item);
    const mapping = findSkuMapping(skuMappings, order.sellerUid, item.productId);
    items.push({
      productId: purchaseProductId, name: item.productName, unit: item.unit || 'PCS', hsn: item.hsn || '',
      qty: item.qty, rate: item.rate || 0, gstRate: item.gstRate || 0,
      taxable: item.taxable || 0, gstAmt: item.gstAmt || 0, total: item.total || 0,
      priceMode: 'excl', linkedSkuMappingId: mapping ? mapping.id : null
    });
    if (mapping) stockIns.push({ mappingId: mapping.id, productName: mapping.productName || item.productName, qty: item.qty });
    else unmappedNames.push(item.productName);
  }

  const summary = order.invoiceSummary || {};
  const now = new Date();
  const purchaseData = {
    supplierId, supplierName: order.sellerName,
    date: now.toISOString().slice(0, 10),
    items,
    subtotal: summary.subtotal || 0,
    gstTotal: (summary.cgst || 0) + (summary.sgst || 0) + (summary.igst || 0),
    grandTotal: summary.grandTotal || 0,
    orderId: order.id, orderNumber: order.orderNumber || '', invoiceId: order.invoiceId || null, invoiceNo: order.invoiceNo || '',
    autoCreatedFromOrder: true,
    createdAt: FieldValue.serverTimestamp()
  };

  const purRef = await usersRef.collection('buyerPurchases').add(purchaseData);

  for (const s of stockIns) {
    await usersRef.collection('buyerSkuMappings').doc(s.mappingId).update({
      stock: FieldValue.increment(s.qty),
      updatedAt: FieldValue.serverTimestamp()
    });
    await usersRef.collection('buyerStockMovements').add({
      type: 'purchase-in', mappingId: s.mappingId, productName: s.productName, qty: s.qty, date: purchaseData.date,
      note: `Purchase from ${order.sellerName} (order ${order.orderNumber || ''})`,
      createdAt: FieldValue.serverTimestamp()
    });
  }

  // Admin SDK bypasses Firestore rules entirely, so the "buyer may only set
  // buyerPurchaseId once" rule doesn't apply here — but the buyerPurchaseId
  // check at the top of onOrderAccepted() already prevents this function
  // itself from running twice for the same order.
  const updatePayload = {
    buyerPurchaseId: purRef.id,
    buyerPurchaseCreatedAt: FieldValue.serverTimestamp()
  };
  if (unmappedNames.length) updatePayload.unmappedStockItems = unmappedNames; // buyer UI can read this to show the "not tracked yet" warning
  await db.collection('marketplaceOrders').doc(order.id).update(updatePayload);
}

async function ensureSupplierForSeller(usersRef, sellerUid, sellerName) {
  const snap = await usersRef.collection('buyerSuppliers').where('sellerUid', '==', sellerUid).limit(1).get();
  if (!snap.empty) return snap.docs[0].id;
  const ref = await usersRef.collection('buyerSuppliers').add({
    name: sellerName, sellerUid, gstin: '', address: '', stateCode: '', state: '', email: '', phone: '',
    autoCreatedFromOrder: true
  });
  return ref.id;
}

// Finds this buyer's ACTIVE Buyer SKU Master mapping for an exact seller +
// their product — the sole source of truth for which items track stock.
function findSkuMapping(skuMappings, sellerUid, sellerProductId) {
  return skuMappings.find((m) => m.sellerId === sellerUid && m.productId === sellerProductId) || null;
}

// Purchase Product record for GSTR/accounting purposes only — carries no
// link into users/{uid}/products; stock is resolved separately via
// findSkuMapping() above.
async function ensurePurchaseProduct(usersRef, sellerUid, item) {
  const existing = await usersRef.collection('purchaseProducts')
    .where('sellerUid', '==', sellerUid).where('sellerProductId', '==', item.productId).limit(1).get();
  if (!existing.empty) return existing.docs[0].id;
  const ref = await usersRef.collection('purchaseProducts').add({
    name: item.productName, hsn: item.hsn || '', unit: item.unit || 'PCS',
    sellerUid, sellerProductId: item.productId, autoCreatedFromOrder: true
  });
  return ref.id;
}
