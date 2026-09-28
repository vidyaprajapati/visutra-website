# VISUTRA — GST filing (GSTR-1, GSTR-3B, GSTR-2B)

All GST files are built by one shared engine (`billing/assets/gst-returns.js`) in the
current GST portal format.

## Seller — Billing → GSTR-1 Filing
1. Choose Financial Year, Monthly or Quarterly (QRMP), and the month/quarter → **Generate Report**.
2. **Check before filing** lists anything the portal would reject (invalid GSTINs, missing
   HSN, missing state, invoice numbers over 16 characters…). Fix those first.
3. **GSTR-1 JSON (portal upload)** → GST portal → Returns → GSTR-1 → **Prepare Offline** →
   Upload → choose the JSON → wait for "Processed" → review → submit/file.
   Contains: B2B (4), B2CL (5), B2CS (7), Nil-rated (8), HSN summary split B2B/B2C (12),
   Documents issued (13, deleted invoices counted as cancelled).
4. **GSTR-1 Excel (Offline Tool)** — same data in the GSTN Returns Offline Tool workbook
   layout (sheets b2b,sez,de / b2cl / b2cs / hsn(b2b) / hsn(b2c) / docs / exemp).
5. **GSTR-3B** — Table 3.1 (outward tax), 3.2 (inter-state to unregistered, by state),
   4 (ITC from your purchase entries), 5 (exempt inward) and the approximate cash payable
   after credit set-off. JSON for the GSTR-3B offline utility, Excel to copy figures.
6. **GSTR-2B Reconciliation** — download GSTR-2B (JSON or Excel) from the portal, choose it,
   click Reconcile. Claim in GSTR-3B only the ITC shown as matched.

Quarterly (QRMP): the files use the quarter's last month as the return period, as GSTN requires.

## Buyer — Buyer → GST & ITC
Pick the period → Generate. The **ITC & GSTR-2B Reconciliation** card shows eligible ITC
(IGST/CGST/SGST) from your purchases and matches them with your GSTR-2B.
Enter the **Supplier invoice no.** on each purchase (Purchase Entry) for exact matching;
without it, matching falls back to supplier GSTIN + amount + date.

## Marketplace sales — Tools → GST Return Tool
Upload the Amazon / Flipkart / Meesho reports as before, choose the **Return period**, then
**GSTR-1 JSON (portal upload)** or **GSTR-1 Excel**. Marketplace sales are reported with the
operator's GSTIN, including Table 14 (supplies through e-commerce operators). Consumer
returns are netted into B2CS/HSN; returns from GST-registered buyers are listed as a warning
— file those as credit notes (Table 9B) on the portal.

## Not generated (enter on the portal if you have them)
Credit/debit notes to registered buyers (9B), amendments (9A/10), advances (11), exports (6).

## Always
Upload on the portal, check the portal's summary against your books, and keep the Excel files.
GSTN changes formats from time to time; if the portal ever rejects a file, send the error
message and it can be adjusted.
