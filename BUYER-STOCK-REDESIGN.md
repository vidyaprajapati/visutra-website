# Buyer stock is now fully separate from the Seller/Billing side

## What changed and why

The original app treated Buyer and Seller as two views onto **one** physical
inventory: `users/{uid}/products` and `users/{uid}/stockMovements` were
shared by both sides, on the theory that a business only has one real stock
count. That's why accepting a marketplace order used to increment the same
`products.stock` field your own Billing/Stock Management page shows.

That's not how you want to use it. Buyer-side stock is now its own,
completely separate number:

- **New collection: `users/{uid}/buyerSkuMappings`** (this already existed
  for Buyer SKU Master's marketplace-SKU mappings) now also carries `stock`
  and `reorderLevel` fields directly on each mapping doc. Each ACTIVE
  mapping **is** a buyer-side product — this is literally what "product
  available in the Buyer SKU Master" means now.
- **New collection: `users/{uid}/buyerStockMovements`** — a buyer-only
  movement log (manual edits, auto stock-ins from accepted orders,
  reconciliation uploads). Separate from the Seller/Billing side's own
  `stockMovements`.
- **New collection: `users/{uid}/buyerReconciliationSkuMap`** — the Monthly
  Inventory Reconciliation upload's remembered SKU→product mappings, now
  scoped to `buyerSkuMappings` instead of the seller's `products`/`skuMappings`
  (which the Seller side's own Stock Management page also uses — the two
  could previously collide on the exact same collection).

**`users/{uid}/products` and `users/{uid}/stockMovements` (the Seller/Billing
side) are untouched by any of this.** Nothing on the buyer side reads or
writes them anymore, and nothing on the seller side (`app.html`,
`billing-app.js`) changed at all.

## How stock updates now

1. **Manually, any time** — the Buyer Stock page (`buyer/stock.html`) lists
   every ACTIVE Buyer SKU Master mapping with an editable stock number and
   reorder level. Type a new number, click Update — done. This is a direct,
   absolute-value edit; no seller data involved.
2. **Automatically, when a seller accepts your order** — `my-orders.html`'s
   sweep, `dashboard.html`'s off-platform confirm flow, `user-menu.js`'s
   site-wide safety-net sweep, and the optional Cloud Function (`functions/`)
   all now do the same thing: for each item in the accepted order, look for
   an ACTIVE Buyer SKU Master mapping for **that exact seller + their
   product** (not by name) and, if found, bump that mapping's `stock`. Items
   with no mapping yet are skipped (and flagged in a small banner) — add the
   mapping once in Buyer SKU Master and it'll track from the next order
   onward.

The Purchase Entry (accounting/GSTR) side is unaffected — an accepted order
still auto-creates a Purchase Entry either way, whether or not any of its
items have a stock mapping. Only the *stock* effect was ever tied to seller
data; that's the part this redesign removes.

## Legacy data note

Purchases created **before** this change may still carry the old
`linkedProductId` field pointing at `users/{uid}/products`. Deleting or
restoring those old purchases (in `dashboard.html`'s Invoice Deletion
Requests, or `purchases-gstr.html`'s Delete Purchase) still reverses that
old field correctly — that code path was left in place, untouched, purely
for backward compatibility. Nothing new ever sets `linkedProductId` again;
new purchases use `linkedSkuMappingId` instead, which reverses against
`buyerSkuMappings` the same way.

## Files changed

- `billing/assets/user-menu.js` — site-wide sweep redirected to
  `buyerSkuMappings`/`buyerStockMovements`.
- `billing/buyer/my-orders.html` — its own sweep, same redirect.
- `billing/buyer/dashboard.html` — off-platform confirm flow (same redirect)
  + Invoice Deletion Request reversal (adds `linkedSkuMappingId` handling
  alongside the legacy `linkedProductId` branch).
- `billing/buyer/purchases-gstr.html` — Delete Purchase reversal (same
  addition).
- `billing/buyer/stock.html` — full rewrite: product-wise, manually editable
  stock from Buyer SKU Master; reconciliation upload retargeted to the new
  buyer-only collections.
- `functions/index.js` — Cloud Function redirected to the same model.

## Firestore rules

No changes needed. `buyerSkuMappings`, `buyerStockMovements`, and
`buyerReconciliationSkuMap` are all subcollections under `users/{uid}`,
already covered by the existing wildcard rule:

```
match /{subcollection}/{docId} {
  allow read, write: if request.auth != null && request.auth.uid == sellerUid;
}
```

(under `match /users/{sellerUid}` — note `sellerUid` here is just the path
variable name for "the uid this users/ doc belongs to", not literally
restricted to sellers).
