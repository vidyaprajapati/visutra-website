# Buyer and Seller no longer share Suppliers/Purchases/Payments

## What was wrong

`users/{uid}/suppliers`, `users/{uid}/purchases`, and `users/{uid}/payments`
were shared storage between two independent features built at different
times:

- The **Seller's own Purchase Entry** (`billing/app.html`, via
  `billing-app.js`) — for the seller's own procurement (raw materials, etc.)
- The **Buyer side's Purchase Entry / Payment Entry / My Sellers**
  (`billing/buyer/*.html`) — for buying from other sellers/suppliers

Since both live under the same account (`users/{uid}`), and both wrote to
the exact same collection names with no field telling them apart, opening
the Buyer Dashboard, Purchase Entry, or Payment Entry showed the Seller's
own procurement records mixed in, and vice versa.

## The fix

The Buyer side now uses its own, separate collections:

- `users/{uid}/buyerSuppliers` (was `suppliers`)
- `users/{uid}/buyerPurchases` (was `purchases`)
- `users/{uid}/buyerPayments` (was `payments`)

The Seller side (`billing/app.html`, `billing-app.js`) is **completely
unchanged** — it keeps using `suppliers`/`purchases`/`payments` exactly as
before. Only the Buyer-side files were updated to point at the new names:
`my-orders.html`, `dashboard.html`, `purchase-entry.html`,
`purchases-gstr.html`, `payment-entry.html`, `my-sellers.html`,
`import-purchases.html`, the site-wide sweep in `user-menu.js`, and the
Cloud Function in `functions/index.js`.

No Firestore rules changes needed — these are still subcollections under
`users/{uid}`, already covered by the existing wildcard rule.

## Existing data needs a one-time move

Anything already entered through the Buyer side before this change is
still sitting in the old `suppliers`/`purchases`/`payments` collections.
**`billing/buyer/migrate-buyer-data.html`** is a one-time tool (linked from
the Buyer Dashboard) that moves it over:

- A supplier tied to a real linked VISUTRA seller (`sellerUid` set) is
  unambiguously Buyer-origin — moved automatically.
- A plain off-platform supplier (no `sellerUid`) can't be told apart from a
  genuine Seller-side material supplier by data alone — the tool lists
  these and asks which ones are actually Buyer suppliers before moving them.
- A purchase is moved if it's flagged `recordedByBuyer`,
  `autoCreatedFromOrder`, or `importedHistorical` (all Buyer-only flags),
  or if it references a supplier confirmed Buyer-side above.
- A payment is moved the same way, via its supplier.

Doc IDs are preserved during the move (not regenerated), so existing
references — like `marketplaceOrders.buyerPurchaseId` — keep working
without any further changes. The tool is safe to re-run; already-moved
records are simply absent from the old collections and won't reappear in
the scan.
