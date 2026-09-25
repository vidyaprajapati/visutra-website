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

Firestore rules — UPDATE THEM: Firebase console → Firestore → Rules → paste
the whole of `firestore.rules` (in this folder) → Publish.
It closes three public lists: every buyer's email (buyerDirectory), every
invoice (public_invoices) and every username (usernames) could be LISTED by
anyone. Opening one invoice by its link, logging in by username and linking a
buyer by email all keep working — only listing is blocked.

## 1b. Backups (do this once, before real data)
Firebase console → Firestore → Disaster recovery (or "Backups"):
- Turn on **Point-in-time recovery** (restore to any minute of the last 7 days), and
- Create a **daily backup schedule** (keep e.g. 14 days).
Both need the Blaze (pay-as-you-go) plan; cost at your data size is a few rupees
a month. Code can't undo a wrong delete — a backup can.

## 1c. Android app (only if you use the app)
Downloads (PDFs, Excel) need a small addition to the app — see
ANDROID-DOWNLOADS.md. The website side is already in place.

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
  Buyer (new): buyerUnmappedLabelSkus, buyerReturnedLabels
  Printing: printLog
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

Buyer SKU Master
- [ ] My Products: add a product with only a name → no error.
- [ ] Map SKUs to a Product: select it, link seller, add SKUs → saved.
- [ ] Bulk: Export products → add rows/SKUs in Excel → Preview import → Apply.
      A SKU that belongs to another product is skipped with a note.
- [ ] SKU Mappings table: Deactivate a SKU → its labels show as unmapped.
- [ ] Label Cropper: a new SKU similar to existing ones shows "★ suggested".

Newer features
- [ ] Undo: print a file → "↶ Undo last print" → product, packing and label
      stock all come back; printing again counts normally.
- [ ] Monthly Reconciliation (Billing Stock page and Buyer Stock page): upload
      a Meesho/Flipkart report for orders you already printed → they show
      under "Already counted (skipped)"; upload the same report again → no change.
- [ ] Reorder suggestions: Billing → Stock, Buyer → Stock, and Label Cropper →
      Label & Packing Settings (needs a few days of sales/prints to show).
- [ ] "SKUs need mapping" alert: Buyer Dashboard, and the banner at the top of Billing.
- [ ] Android app: after adding the code in ANDROID-DOWNLOADS.md, Crop &
      download saves the PDF to the phone's Downloads.

Buyer — Import Historical Purchase Data
- [ ] File with SKU/name columns → preview matches → pick unmatched → import →
      buyer product stock goes up; next import remembers the pick.
