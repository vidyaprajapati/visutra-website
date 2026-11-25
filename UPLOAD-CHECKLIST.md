# VISUTRA — everything that changed (supplier access · order merge · cost · free tools · sorting · label-order fix)

## A) SUPABASE  (do this FIRST)
1. Supabase → **SQL Editor → New query** → paste ALL of `supabase/schema.sql` → **Run**.   (safe to re-run)
2. New query → paste ALL of `supabase/supplier-access.sql` → **Run**.                       (safe to re-run)
   Run them in this order. If you ever re-run schema.sql later, nothing breaks (supplier sign-up rule is inside it too).
3. **Authentication → Sign In / Providers → Email:** Enable Email ON, **Confirm email ON**.
4. **Authentication → URL Configuration → Redirect URLs:** add
      https://visutra.in/billing/supplier/dashboard.html
      https://visutra.in/billing/supplier/login.html
   (keep the existing billing/login.html and billing/reset-password.html entries)
5. Keep your custom SMTP (suppliers' login links are emails).
Nothing else changes in Supabase (sorting and the label-order fix need no database change).

## B) GITHUB
1. Unzip this package over your repo, keeping the folders (new files are added, changed files are replaced).
2. **DELETE `billing/label-order.html`** on GitHub (the wrong-folder copy; uploading does not remove it).
   Optional old unused copies you can also delete: `tools/label-order.html`, `billing/order-place.html`, `billing/order-receive.html`.
3. Commit. GitHub Pages redeploys in a minute or two.

## C) After it is live
- Buyer account → **My Orders** → **Combine into one order** (merges the pending duplicates you already have).
- Label-Based Auto Order → click **✎** next to any Stock Now figure that is wrong (e.g. Washing Machine Cover) and set the right number.
- Billing → Supplier Master → add a supplier with YOUR second email → check the invite mail → open
  https://visutra.in/billing/supplier/login.html with that email.

## Update — one order, one invoice (latest)
- billing/seller/order-receive.html: Accept refuses if the buyer added items while you had the order open (refreshes the list);
  a notice appears if a buyer still has several pending orders.
- billing/assets/user-menu.js: older duplicate pending orders are combined automatically when the buyer opens any buyer page.
- tests/single-invoice.test.js: the full story (forgotten day, unaccepted order, 3 days of labels → ONE order → ONE invoice).
No new Supabase step.

## Update — supplier login made simple (latest)
- Supplier signs in with **email + password**. The emailed link is needed **once** (first time, or forgot password);
  after opening it the dashboard asks them to choose a password. A **Password** button in the top bar changes it later.
  A device also stays signed in until "Sign out".
- Files: billing/supplier/login.html, billing/supplier/dashboard.html, billing/assets/billing-app.js (invite email wording).
- Supabase: nothing new — just keep Authentication → Email enabled with passwords allowed (your normal login already uses it).

## Update — Monthly Inventory Reconciliation: profit + Return/RTO stock (latest)
Buyer → **Stock** page (billing/buyer/stock.html). No new Supabase step (new data is stored under your own account).
- **Return & RTO stock:** a ticked box (on by default) adds EVERY returned / RTO unit back to stock, once (re-uploading never adds it twice).
  Untick it for the old rule (only orders this system had deducted come back). **LOST** parcels are never added back (this also applies on the Seller page).
- **Profit:** per order = marketplace settlement (GST taken out) − cost of goods. Pick the **money column** per file in Step 1
  (auto-guessed: Meesho "Final Settlement Amount", Flipkart "Bank Settlement Value"). Cost per unit comes from your purchases, can be typed, and is remembered.
  A return gives its cost back and its settlement deduction lowers profit. Each order is counted once, ever.
- **Monthly Profit** section at the bottom of the page: month list (newest first) + product-wise detail + platform split, Excel-exportable.
- Files: billing/buyer/stock.html, billing/assets/label-stock-core.js, billing/assets/table-sort.js, billing/app.html (help text),
  tests/recon-profit.test.js, tests/buyer-stock.test.js.

## Update — Old Payment Data upload, return charges, and profit graphs (latest)
Buyer → **Stock** page (billing/buyer/stock.html). No Supabase step. New file: billing/assets/profit-tools.js.
- **Upload Old Payment Data → Monthly Profit** (its own section, above Monthly Profit). Meesho / Flipkart payment files, plus optionally the
  Orders report (carries "Customer State"). Goes ONLY into Monthly Profit: no stock change, not part of Monthly Inventory Reconciliation.
  Each order is counted in its own month (choose Order date or Payment date); same file twice = nothing counted twice.
- **Return charges** = what a returned / RTO order cost you (revenue lost on it, GST out). Shown per month, product and state; already inside the profit.
- **Graphs** (From / To month): monthly selling, revenue + profit, returns, return charges; state-wise selling, profit, returns (+ return rate);
  profit by product; plus a state-wise table (Excel-exportable).
- An Orders report uploaded later fills the customer state into orders already saved without one.
- Files: billing/buyer/stock.html, billing/assets/profit-tools.js, billing/assets/label-stock-core.js, billing/assets/table-sort.js,
  tests/old-payments.test.js, tests/profit-tools.test.js, tests/recon-profit.test.js.

## Update — SELLER profit (buys from suppliers → sells to buyers, and sells on e-commerce) (latest)
Seller app (billing/app.html) → new sidebar item **Profit → Profit & Graphs**. No Supabase step. New file: billing/assets/seller-profit.js.
- **1. Product costs** — cost per unit (ex-GST) from your supplier purchases (average up to the date of each sale); type a cost to override it.
- **Sales to buyers** — worked out automatically from your invoices (cancelled invoices left out): revenue ex-GST − cost. By month, state (customer state), product and buyer.
- **2. E-commerce** — upload Meesho / Flipkart payment files (+ Orders report for customer state) for any month. Profit only: no stock change.
  Return charges, state-wise data, each order counted once in its own month.
- **3. Monthly profit + graphs** — both streams in one table; graphs for monthly selling / revenue+profit / returns / return charges,
  profit by source, state-wise selling / profit / returns, product and buyer; filter: everything / buyers only / e-commerce only + month range.
- Seller **Monthly Inventory Reconciliation** now has the same tick box as the Buyer: add every Return / RTO back to stock (once); LOST never.
- Fixed (Buyer + Seller): the graphs' "To month" now follows the newest month when you add newer data.
- Files: billing/app.html, billing/assets/seller-profit.js, billing/assets/profit-tools.js, billing/assets/billing-app.js, billing/assets/table-sort.js,
  billing/buyer/stock.html, tests/seller-profit.test.js, tests/profit-tools.test.js, tests/old-payments.test.js.

## Update — capture order ID + customer state at label time; state-wise profit; Clear button (latest)
No Supabase step (new data lives under your own account).
- **Capture:** while labels are read / printed — Buyer *Label-Based Auto Order*, *Label Cropper* (buyer + seller), Seller *Sell via Label* — the customer's STATE
  (and GST state code, PIN) is read from the label text and kept as one small record per order (order ID + state). The customer's address is told apart from the
  seller's return address; "Place of Supply" on invoices is used when present; an unreadable label stores nothing (never a guess).
- **Use:** when you upload the month's report (Buyer Stock → Monthly Inventory Reconciliation, Buyer Old Payment Data, Seller Profit & Graphs upload, and now the
  **Seller Monthly Inventory Reconciliation too**), every order gets its state from the capture → profit / loss, state-wise selling, state-wise returns (+ return charges).
- **Clear captured order IDs & states** button (Buyer: Stock → Monthly Profit; Seller: Profit & Graphs), with a live count and "all" / "only before this month".
  It frees database space. Monthly profit / loss, state-wise selling and returns are kept (they are separate month totals). An order cleared before its month's
  report is uploaded shows as "Unknown" state. The per-order profit records are kept on purpose (they stop the same report being counted twice).
- Seller reconciliation: pick the money column and the upload also records profit; a product with no cost yet is left out (set its cost, upload again — stock is never changed twice).
- Files: billing/assets/label-sku-extract.js, label-stock-core.js, profit-tools.js, seller-profit.js, billing-app.js, billing/app.html, billing/buyer/stock.html,
  billing/buyer/label-order.html, **tools/label-cropper.html**, tests/order-capture.test.js, tests/label-state.test.js.

## ADMIN FIX (latest)
Supabase SQL: run schema.sql → supplier-access.sql → admin-setup.sql (edit your email first).
GitHub: admin.html, ADMIN-SETUP.md, billing/admin-approvals.html.

## LABEL CROPPER EXCEL — courier sheet (latest)
GitHub: tools/label-cropper.html, billing/assets/vt-excel.js (no Supabase change).

## BUSINESS EXPENSES (packing, labels …) → net profit
GitHub (new): billing/expenses.html, billing/assets/expenses-tools.js
GitHub (changed): billing/app.html, billing/assets/billing-app.js, billing/assets/seller-profit.js, billing/assets/user-menu.js, billing/buyer/stock.html
Supabase: nothing to run (uses the existing docs table).
