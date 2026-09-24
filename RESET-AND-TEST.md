# VISUTRA — deploy, reset demo data, and test

## 1. Deploy
Upload this whole folder to the repo (GitHub Pages), replacing what's there.

Uploading does NOT delete old files. Delete these by hand in the repo — they are
unused leftovers (nothing links to them), and `billing/buyer/app.html` is an old
copy of the Seller app sitting inside the Buyer folder:

- billing/buyer/app.html
- billing/assets/app.html
- billing/order-place.html
- billing/order-receive.html   (old order flow; replaced by seller/order-receive.html)
- tools/label-order.html        (broken copy; the real page is billing/buyer/label-order.html)
- tools/tools-home.htm          (empty 1-byte file; the real page is tools-home.html)

Firestore rules: no change needed. Every new collection lives under users/{uid},
already covered by the existing wildcard rule.

## 2. Reset demo data (Firebase console → Firestore)
Quickest full wipe (also removes profiles, so you'll complete your profile again):
  firebase firestore:delete --all-collections      (Firebase CLI)
Login accounts (Authentication) are not affected either way.

Or by hand. IMPORTANT: deleting a users/{uid} document in the console does NOT
delete its subcollections — delete the subcollections themselves.

Top-level collections:
  marketplaceOrders, sellerLinks, invoiceDeleteRequests, paymentConfirmations,
  public_invoices, orders, buyerDirectory, usernames
  (keep buyerDirectory/usernames/users docs if you want to keep your profiles)

Under each users/{uid}:
  Seller: products, customers, invoices, receipts, suppliers, purchases,
    payments, purchaseProducts, stockMovements, skuMappings, meta,
    processedSellerLabels, sellerUnmappedLabelSkus, sellerReturnedLabels
  Buyer: buyerSkuMappings, buyerStockMovements, buyerSuppliers, buyerPurchases,
    buyerPayments, buyerReconciliationSkuMap, buyerImportItemMap,
    buyerProcessedLabels, processedLabels, labelOrderDrafts, unmappedSkus
  Label & packing (shared): buyerPackagingSizes, buyerLabelSizes,
    buyerProductPackaging, packagingConsumedLabels, sizeStockMovements,
    stockConsumedGroups (old, no longer written)

## 3. Test checklist
Section separation
- [ ] Buyer pages: every menu/button/link stays in Buyer (the Buyer | Seller pills
      at the top are the one deliberate switch).
- [ ] Billing (Seller) pages: nothing opens a Buyer page.
- [ ] Label Cropper opened from Billing opens as Seller; from Buyer SKU Master as Buyer.

Label Cropper — Seller
- [ ] Settings: activate 4×6, add label stock, add a packing size + stock.
- [ ] Upload a label file → unmapped SKU → map it in the Seller Stock box; pick
      packing/label size in the same row.
- [ ] Print → product −qty, packing −1 per label, 4×6 −1 per label.
- [ ] Reprint → only 4×6 label goes down.
- [ ] Amazon file with 2+ orders of the SAME SKU → product down once PER ORDER.
- [ ] Print with an unmapped SKU → appears in Billing → Stock Management →
      Unmapped Label SKUs → Map & Deduct there.
- [ ] Low stock → "Print anyway?" prompt; Cancel changes nothing.
- [ ] Returns box → stock added back once; second time "already returned".
- [ ] Settings → Stock history shows every change.

Label Cropper — Buyer
- [ ] Buyer SKU Master: add own product (Not linked) + a linked one, with own SKU
      and marketplace SKUs; assign packing/label size.
- [ ] Print → buyer product stock down once per shipment; Send to Label-Based
      Auto Order → order reaches the seller with the seller's product name.

Buyer — Import Historical Purchase Data
- [ ] File with SKU/name columns → preview matches → pick unmatched → import →
      buyer product stock goes up; next import remembers the pick.
