# Latest entry first + "Sort by" on every list

**What you get**
- Every list of entered data (suppliers, customers, products, purchases, payments, invoices, receipts,
  stock movements, recycle bin, orders, GST registers, buyer purchases/payments/orders, SKU master …)
  opens with the **most recently entered record on top**. The "entry time" is when the record was first
  saved — so a back-dated purchase you just typed is still the first row.
- **Ledgers / supplier & customer dashboards** (running balance) open **newest date first**; each row keeps
  its own balance.
- A **Sort by** box above each list (next to the Excel button): Latest first · Oldest first · Date
  newest/oldest · and every column (A → Z, high → low …). The choice stays when the list refreshes.
- The "＋ View all" button now hides the OLDEST rows, so the first 10 shown are the latest 10.
- Not touched on purpose: entry forms (invoice / purchase line items, cart) and computed reports
  (GSTR tables, stock reports).

**To install:** upload the files in the zip (keep folders). No database change.
New file: `billing/assets/table-sort.js`.

**Adding it to another table later:** add `data-vt-sort` to the `<table>` (and `data-vt-statement` for a
ledger) and load `table-sort.js`; or add its tbody id to the `LISTS` array at the top of the script.
