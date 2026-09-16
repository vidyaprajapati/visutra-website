# VISUTRA GST Billing — Setup Guide

This adds a full sign-up/login billing system to visutra.in, separate from the
free tools. Each business that signs up gets its own isolated products,
customers, and invoices. Invoices are GST-compliant PDFs with your signature,
and can be emailed straight to the buyer.

You'll need to set up two free services: **Firebase** (accounts + database +
file storage) and **EmailJS** (sending the invoice email). Both have free
tiers that comfortably cover a small-to-medium business.

---

## Part 1 — Create your Firebase project

1. Go to [console.firebase.google.com](https://console.firebase.google.com) and sign in with your Google account.
2. Click **Add project**. Name it something like `visutra-billing`. You can skip Google Analytics for this project (not needed).
3. Once created, click the **`</>`** (web) icon on the project overview page to register a web app. Name it `visutra-billing-web`. You do **not** need Firebase Hosting — you're already using GitHub Pages.
4. Firebase will show you a `firebaseConfig` object with 6 values (`apiKey`, `authDomain`, `projectId`, etc.). Copy all of them.
5. Open `billing/assets/firebase-config.js` from this package and paste your 6 values in, replacing the `PASTE_YOUR_...` placeholders.

## Part 2 — Turn on the features you need

In the Firebase console, on the left sidebar:

**Authentication**
1. Click **Authentication → Get started**.
2. Under **Sign-in method**, enable **Google** (just toggle it on, no extra config needed).
3. Also enable **Email/Password** (toggle it on).

**Firestore Database** (this stores products, customers, invoices)
1. Click **Firestore Database → Create database**.
2. Choose **Start in production mode**, pick a location close to India (e.g. `asia-south1`).
3. Once created, go to the **Rules** tab and replace everything with:

```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {

    match /users/{sellerUid} {
      allow read, write: if request.auth != null && request.auth.uid == sellerUid;

      // Product Master: the owner can always read/write their own products.
      // A buyer whose account has an ACTIVE link to this seller (see
      // sellerLinks below) may read a product only when the seller has
      // marked it both active and buyer-visible. Everything else about the
      // seller's account (customers, invoices, purchases, etc.) still falls
      // through to the generic subcollection rule further down, which stays
      // owner-only.
      match /products/{productId} {
        allow read: if request.auth != null && (
          request.auth.uid == sellerUid ||
          (
            resource.data.active == true &&
            resource.data.buyerVisibility == true &&
            exists(/databases/$(database)/documents/sellerLinks/$(sellerUid + '_' + request.auth.uid)) &&
            get(/databases/$(database)/documents/sellerLinks/$(sellerUid + '_' + request.auth.uid)).data.status == 'ACTIVE'
          )
        );
        allow write: if request.auth != null && request.auth.uid == sellerUid;
      }

      match /{subcollection}/{docId} {
        allow read, write: if request.auth != null && request.auth.uid == sellerUid;
      }
    }

    // A seller <-> buyer relationship, one doc per pair, ID = "{sellerUid}_{buyerUid}"
    // so the products rule above can look it up directly without a query.
    // Only the seller can create or change it — a buyer can never grant
    // themselves access to a seller's private catalog. Both sides can read it
    // (buyer needs this to list "My Sellers").
    match /sellerLinks/{linkId} {
      allow read: if request.auth != null &&
        (request.auth.uid == resource.data.sellerUid || request.auth.uid == resource.data.buyerUid);
      allow create: if request.auth != null && request.auth.uid == request.resource.data.sellerUid;
      allow update: if request.auth != null && request.auth.uid == resource.data.sellerUid;
      allow delete: if false;
    }

    // Public uid<->email index so a seller can resolve "does this email have
    // a buyer account" without exposing anything else about that account.
    // Only the account owner can create/update their own entry (same
    // trade-off as usernames below: the mapping itself is not secret).
    match /buyerDirectory/{email} {
      allow read: if true;
      allow create, update: if request.auth != null && request.resource.data.uid == request.auth.uid;
      allow delete: if request.auth != null && resource.data.uid == request.auth.uid;
    }

    // A single marketplace order between a linked buyer and seller. Item
    // prices/GST are deliberately NOT trusted from this document at all —
    // the seller's own client re-reads its Product Master fresh inside a
    // Firestore transaction when accepting (see order-receive.html), so
    // nothing written here by the buyer ever reaches an invoice unchecked.
    match /marketplaceOrders/{orderId} {
      allow read: if request.auth != null &&
        (request.auth.uid == resource.data.buyerUid || request.auth.uid == resource.data.sellerUid);

      // Only a buyer with an ACTIVE link to that seller can create an order,
      // and only in PENDING status (a fresh order, not pre-accepted).
      allow create: if request.auth != null &&
        request.auth.uid == request.resource.data.buyerUid &&
        request.resource.data.status == 'PENDING' &&
        exists(/databases/$(database)/documents/sellerLinks/$(request.resource.data.sellerUid + '_' + request.auth.uid)) &&
        get(/databases/$(database)/documents/sellerLinks/$(request.resource.data.sellerUid + '_' + request.auth.uid)).data.status == 'ACTIVE';

      allow update: if request.auth != null && (
        // The seller accepting or rejecting a still-PENDING order. This is
        // also what makes double-accept impossible: a transaction's write
        // only commits if resource.data.status is still 'PENDING' at commit
        // time, so a second, near-simultaneous Accept click always loses.
        (request.auth.uid == resource.data.sellerUid &&
         resource.data.status == 'PENDING' &&
         request.resource.data.status in ['ACCEPTED', 'REJECTED']) ||
        // The buyer recording that their own Purchase Entry record has been
        // created for this (already-accepted) order — exactly once, and
        // touching only these two fields, so a buyer can never rewrite
        // anything a seller's acceptance produced.
        (request.auth.uid == resource.data.buyerUid &&
         resource.data.status == 'ACCEPTED' &&
         !('buyerPurchaseId' in resource.data) &&
         request.resource.data.diff(resource.data).affectedKeys().hasOnly(['buyerPurchaseId', 'buyerPurchaseCreatedAt']))
      );
      allow delete: if false;
    }

    match /public_invoices/{invoiceId} {
      allow read: if true;
      allow create, update: if request.auth != null;
      allow delete: if false;
    }

    // "Order to Supplier" (see order-place.html/order-receive.html): a single
    // top-level doc per order so the supplier's own logged-in account can be
    // granted access to that ONE order by matching their email — nothing
    // else of the buyer's account is exposed.
    match /orders/{orderId} {
      allow read: if request.auth != null && (request.auth.uid == resource.data.buyerUid || request.auth.token.email == resource.data.supplierEmail);
      allow create: if request.auth != null && request.auth.uid == request.resource.data.buyerUid;
      allow update: if request.auth != null && (request.auth.uid == resource.data.buyerUid || request.auth.token.email == resource.data.supplierEmail);
      allow delete: if request.auth != null && request.auth.uid == resource.data.buyerUid;
    }

    match /usernames/{username} {
      // Must be readable by anyone (including signed-out visitors), because
      // the sign-in page needs to look up "which email does this username
      // belong to" BEFORE the person is authenticated. This does mean a
      // username's associated email address is not private — anyone who
      // knows or guesses a username can see the email behind it. That's a
      // deliberate, standard trade-off for username-based login; if you'd
      // rather not accept it, email-only login remains fully supported by
      // not filling in a username at signup.
      allow read: if true;
      allow create: if request.auth != null && request.resource.data.uid == request.auth.uid;
      allow update, delete: if false;
    }
  }
}
```

4. Click **Publish**.

**If you're updating rules on a project that's already live** (not a fresh setup): this block now also includes rules for `sellerLinks` and `buyerDirectory` (from the Buyer/Seller linking feature), `marketplaceOrders` (from the order-flow feature below), and `orders` (from the existing "Order to Supplier" feature, which was missing from this doc even though it was already live — this replacement also fixes that drift). Paste the whole block above over whatever is currently in your Rules tab; nothing here removes access your existing data relies on.

**No Storage needed.** Earlier versions of this guide had you also enable Firebase Storage to hold the generated invoice PDFs. That's been removed: Google now requires the paid "Blaze" plan just to turn Storage on at all, even at zero usage — which conflicts with keeping this whole setup free. Instead, PDFs are generated fresh on the spot every time someone needs one (the business owner re-downloading from Invoice History, or a buyer clicking "Download PDF" on their emailed link) directly from the invoice data already sitting in Firestore. Nothing is ever uploaded as a file, so there's nothing to pay for.

That's the entire Firebase side done — no billing card required for any of this at normal small-business volumes (Firebase's free "Spark" plan covers it).

---

## Part 3 — Set up EmailJS (for sending invoices)

1. Go to [emailjs.com](https://www.emailjs.com) and create a free account.
2. Under **Email Services**, click **Add New Service**, and connect your Gmail (or another provider) — this is the account the invoice emails will be sent *from*.
3. Under **Email Templates**, click **Create New Template**. Set it up with these variables available to use in the template body: `{{to_name}}`, `{{invoice_no}}`, `{{invoice_date}}`, `{{business_name}}`, `{{grand_total}}`, `{{view_link}}`.

   A simple template body:
   ```
   Hi {{to_name}},

   Please find your invoice {{invoice_no}} dated {{invoice_date}} from {{business_name}}, for a total of ₹{{grand_total}}.

   View and download your invoice here: {{view_link}}

   Thank you for your business.
   ```
   Set the **To email** field in the template settings to `{{to_email}}`.

4. Go to **Account → General** and copy your **Public Key**.
5. Open `billing/assets/firebase-config.js` again and fill in:
   - `EMAILJS_PUBLIC_KEY` — your public key
   - `EMAILJS_SERVICE_ID` — from your Email Service
   - `EMAILJS_TEMPLATE_ID` — from your Email Template

**Note on attachments:** the email sends a **link** to view the invoice online (`invoice-view.html`). Opening that link automatically triggers a PDF download of the invoice to the buyer's device — no click needed beyond opening the link — and the page also keeps a "Download PDF again" button in case a browser blocks the automatic download or they need another copy later. The PDF is generated fresh in the buyer's browser from the invoice data already in Firestore rather than being a literal file attached to the email itself, which is what lets this work on EmailJS's free plan — actual email attachments require EmailJS's paid Personal plan ($9/mo) or higher.

---

## Part 4 — Set up bot protection (reCAPTCHA)

The login and sign-up forms show a Google reCAPTCHA "I'm not a robot" checkbox before the button can be clicked.

1. Go to [google.com/recaptcha/admin](https://www.google.com/recaptcha/admin) and sign in.
2. Register a new site: give it a label (e.g. `VISUTRA Billing`), choose **reCAPTCHA v2 → "I'm not a robot" Checkbox**, and add your domain `visutra.in`.
3. Submit, then copy the **Site key** shown.
4. Open `billing/assets/firebase-config.js` and paste it into `RECAPTCHA_SITE_KEY`.

**Honest limitation worth knowing:** this checkbox is a real deterrent against simple automated bots and scripted sign-ups — but full protection also involves verifying the response server-side with your **Secret Key**, which needs a backend (a Cloud Function) to check without exposing that secret. That's the same trade-off as the GST-lookup auto-fill feature discussed earlier, which you chose to skip to avoid needing Firebase's paid Blaze plan and command-line tooling. This client-side checkbox alone still meaningfully raises the bar against casual bots and is the right call for a small business site, but a sufficiently motivated attacker could technically get past it without the server-side check. If that becomes a real problem later, revisit the Blaze/Cloud Function option.

If you'd rather skip this entirely for now, leave `RECAPTCHA_SITE_KEY` as the placeholder — the checkbox simply won't appear, and sign-in/sign-up work normally without it.

---

## Part 5 — Upload to your site

Upload the entire `billing/` folder (with your filled-in `firebase-config.js`) to your GitHub repo at the root level, alongside your `tools/` folder.

Your billing system will then be live at:
- `visutra.in/billing/login.html` — sign up / sign in
- `visutra.in/billing/app.html` — the dashboard (redirects here after login)
- `visutra.in/billing/complete-profile.html` — one-time extra details step for Google sign-ups
- `visutra.in/billing/account.html` — change email/password, view account details
- `visutra.in/billing/invoice-view.html` — the public link buyers receive by email

Also re-upload your `tools/` folder — it now includes an access guard that uses this same login (see Part 5 below).

---

## Part 6 — Free tools now require login too

Once Firebase is set up (Parts 1–2 above), the same login also gates your
free tools (Label Studio, Label Cropper, GST Return Tool, Tools Home). A
visitor clicking any of these is redirected to sign in first, then sent
back to the exact tool they wanted. Once signed in, a slim bar appears at
the top of the tool page showing their email, a link to their Billing
account, and a Log out link.

This uses the **same Firebase project and the same accounts** as billing —
no separate setup needed. It reads `billing/assets/firebase-config.js`
from the tools pages via a relative path, so as long as you've filled that
file in for billing, the tools are covered automatically.

**Important — fails open during setup:** until you fill in real values in
`firebase-config.js` (replacing the `PASTE_YOUR_...` placeholders), the
tools stay open to everyone with no login required, so your site never
breaks while you're still setting Firebase up. The login requirement
switches on automatically the moment real config values are in place.

---

## How it works, end to end

1. **A business signs up** at `login.html` with either "Continue with Google" or a full sign-up form: full name, type of business, mobile number, a chosen username, email, and password. Signup also silently asks the browser for location access (for record-keeping — approximate city/state, or exact coordinates if reverse lookup fails) and never blocks signup if that's denied. Email/password sign-ups get a verification email and can't get in until they click it; Google sign-ups skip straight to a short **"complete your profile"** step to collect the details Google doesn't provide (business type, mobile, username).
2. **They can log in with either their username or their email**, plus their password. Behind the scenes, a username is looked up against a small public index to find the matching email before Firebase checks the password.
3. **Both the sign-in and sign-up forms show a reCAPTCHA checkbox** ("I'm not a robot") that must be ticked before the button works — see Part 4 for enabling it.
4. **A profile menu (top-right, on every page)** shows their name/email with a dropdown for **My Account**, **My Billing Account** (from the tools pages), and **Log out** — consistent everywhere, not just inline text.
5. **My Account** (`account.html`) lets them change their password (with re-entry of the current password first) and change their email address — a new email only takes effect after they click a confirmation link Firebase sends to that new address, exactly like the original account's email verification.
6. **They fill in Business Profile** (inside the dashboard) — business name, GSTIN, address, state, and draw their signature on the signature pad. This is separate from their personal account details, and is saved once and reused on every invoice.
7. **They add Products** — name, HSN code, unit, default price, GST rate. This is their master data, so billing becomes a matter of picking from a list.
8. **They add Customers** — name, GSTIN (if registered), address, state, email. If a customer is also a VISUTRA buyer account (see below), the seller can **link** it from the Customers tab by entering the buyer's login email — this is what gates catalog visibility, not the customer's stored email field.

### Buyer / Seller product visibility (new)

- Any account can turn on **Buyer Features** from **My Account** — this just registers their login email in a small public lookup table (`buyerDirectory`) so sellers can find them. It doesn't change anything about their own seller-side billing account.
- A seller links a buyer to one of their Customer Master entries (Customers tab → enter the buyer's login email → **Link Buyer**). This only works if that email has already turned on Buyer Features.
- Once linked, the seller can mark individual products **Active** and **Buyer Visible** from the Product Master table (two click-to-toggle columns).
- The linked buyer sees that seller listed under **My Sellers** (from the account dropdown menu), and can open **View Products** to see a read-only list of exactly the products marked both Active and Buyer Visible — nothing else about the seller's account.
- All of this is enforced in the Firestore rules above, not just in the page's JavaScript — a buyer who isn't linked, or a product that isn't marked visible, simply won't come back from the database no matter what the browser asks for.
- **Not built yet:** actually placing an order from that catalog (that's a further step — see the "what this does not include yet" list).

### Buyer SKU Master (new)

- A linked buyer can open **Buyer SKU Master** (from the account dropdown menu, or a link on My Sellers) to map each of a seller's products to their own Amazon/Meesho/Flipkart SKUs, plus an optional internal buyer SKU. This deliberately maps **seller + product**, not the SKU text alone — the same SKU text can mean a different product for two different sellers.
- Sellers can now optionally give a product a **SKU** in the Product Master (new field, alongside HSN/Unit) — this is what shows up as the read-only "Seller SKU" once a buyer picks that product in the mapping form. It's optional; leaving it blank doesn't break anything, buyers just won't have a seller SKU to reference yet.
- **Linking a buyer is now a one-click action right on the customer's row** (a **Link Buyer** / **Unlink** button next to Edit/Delete, prompting for the buyer's email) — it does **not** require opening Edit first. An earlier version needed that extra click, which was confusing enough in practice that it's worth calling out: forgetting it produced a "save this customer first" message even for an already-saved customer, because the link action was silently keyed off the edit form's hidden state instead of the row itself.
- The page also has an **Unmapped SKUs** queue: paste in a marketplace SKU you've noticed that isn't defined yet (for now this is a manual "Report" button — nothing parses labels or marketplace orders automatically yet), and it sits in the queue with an occurrence count until you click **Define SKU** and pick the seller + product it belongs to. Defining it once resolves every prior occurrence.
- No Firestore rules changes were needed for this — `buyerSkuMappings` and `unmappedSkus` are subcollections under the buyer's own `users/{uid}`, which the existing owner-only rule already covers (Part 64 of the spec — "buyer A cannot read buyer B's SKU mappings" — is automatically true here, not something added on top).
- **Not built yet:** automatic SKU detection from an uploaded label/PDF/barcode, and the two order-placement flows (Product Select Order / Label-Based Auto Order) that would consume this SKU Master — those come with the order-flow phase.

### Order flow: Place Order → Accept → Invoice + Inventory (new)

This is the "Product Select Order" flow — a buyer picks straight from a linked seller's catalog (no SKU mapping required for this path; that's only needed for the not-yet-built Label-Based Auto Order). New pages: `billing/buyer/place-order.html`, `billing/buyer/my-orders.html`, `billing/seller/order-receive.html`. New collection: `marketplaceOrders` — deliberately separate from the existing top-level `orders` collection (the "Order to Supplier" feature), because that one has no product catalog, no acceptance step, and no invoice/inventory automation; it's a different, simpler thing doing a different job, not a duplicate of this one.

- **Buyer places an order**: picks a linked seller, adds catalog items + quantities, submits. The buyer's own Business Profile (name/GSTIN/address/state) is snapshotted onto the order at this point — same pattern the existing "Order to Supplier" feature already uses — so the seller never needs read access into the buyer's private account to invoice them later.
- **Seller accepts or rejects** from Order Receive. **Accepting runs a single Firestore transaction** that: re-reads each product's current price/GST/HSN/stock directly from the seller's own Product Master (never trusting anything the buyer's order carried), checks stock is sufficient for every line, and only if everything checks out, atomically (a) generates a GST invoice using the **same numbering counter, same document shape, and same public invoice-view.html PDF viewer** as a manually created invoice, (b) deducts stock, and (c) logs a stock movement — or, if anything fails, writes nothing at all. Two people clicking Accept on the same order at the same moment cannot both succeed: the transaction only commits if the order was still PENDING at commit time, so the second attempt is rejected outright, both by the transaction's own optimistic-concurrency check and by the Firestore security rule.
- **Buyer's Purchase Entry updates automatically**: `my-orders.html` listens in real time, and the moment it sees an order flip to ACCEPTED, it creates (or reuses) a Supplier record for that seller and a Purchase Product per item in the buyer's **existing** Purchase Entry system, then logs one purchase using the exact invoice figures the seller's acceptance produced.

**Three honest limitations worth knowing:**

1. **"Automatic" purchase creation depends on the buyer's browser having been open at some point after acceptance** — not a guaranteed server-side action the moment the seller clicks Accept. There's no Cloud Functions trigger doing this in the background, because Cloud Functions require enrolling in Firebase's paid **Blaze** plan (still free at normal volume, but needs a billing card on file) — the same trade-off this project has already made elsewhere (see the Storage and reCAPTCHA notes above) to stay entirely on the free Spark plan. In practice this just means: the first time the buyer opens **My Orders** after an acceptance, the purchase appears — it doesn't require them to have been watching at the exact moment.
2. **The Accept transaction runs from the seller's own browser, not a trusted server.** This is genuinely atomic (all the writes above happen together or not at all, and double-accept is blocked) and it never trusts anything from the *buyer's* side — but it does trust the *seller's own* client to read their own Product Master honestly, which is no different from the risk a seller already has today when creating a manual invoice by hand. If you want the stronger guarantee of a server-side Cloud Function (useful mainly if you don't fully trust whoever's logged into the seller's own account, or want acceptance emails sent from a hidden secret instead of client-side EmailJS), that's a well-defined next step, but it requires the Blaze plan — flag it if you want it built.
3. **Order/acceptance email notifications are not wired up yet** — the pieces (EmailJS, already used for invoices) are there to add, just not connected to this flow yet.

### Label-Based Auto Order (new)

The second order-placement method, now built from a real Flipkart shipping-label sample. New page: `billing/buyer/label-order.html`. New shared file: `billing/assets/label-sku-extract.js`.

- The buyer uploads one or more marketplace shipping-label PDFs (label + tax invoice, whatever's in the file they'd normally print). Parsing happens entirely in the browser using PDF.js — nothing is uploaded anywhere, same approach as the free Label Cropper tool.
- **Amazon and Meesho extraction reuses the exact, already-working regex logic from `tools/label-cropper.html`** (copied, not rewritten — that tool already reads these correctly). **Flipkart extraction is new**, built and tested against a real Flipkart label: the SKU is read from the label's own "SKU ID | Description" table, with a second independent fallback anchored on the tax invoice's "| IMEI/SrNo" line, in case a particular Flipkart label layout only prints one of the two.
- Every detected `{marketplace, SKU, qty}` is checked against the buyer's **Buyer SKU Master** (Phase 2). A match groups it into that seller's Auto Order Summary, consolidating quantities across multiple labels of the same seller + product and keeping the Amazon/Meesho/Flipkart breakdown alongside the total (e.g. "Amazon 5 / Meesho 3 / Flipkart 2 → 10"). No match drops it into the same **Unmapped SKUs** queue used by Buyer SKU Master (Phase 2) — one shared queue, so a SKU found here or reported manually there both resolve together.
- **An unmapped SKU can never silently join an order.** Only seller groups made entirely of mapped items get a "Place Order to [Seller]" button; unmapped items sit in their own list with a Define SKU link and don't block *other* sellers' already-mapped orders from being placed.
- **Duplicate-label protection**: each page is fingerprinted (a simple hash of its marketplace + SKU + text), checked against `users/{uid}/processedLabels` before counting it, and only recorded there once an order using it is actually submitted — so re-processing a file you haven't ordered from yet is harmless, but re-uploading a label you've already ordered from won't double the quantity.
- No Firestore rules changes needed — `processedLabels` is a subcollection under the buyer's own `users/{uid}`, already covered by the existing owner-only rule, same as `buyerSkuMappings` and `unmappedSkus` in Phase 2.
- Accepted Label Auto orders carry their marketplace breakdown all the way through to the seller's Order Receive screen and the buyer's My Orders screen (both now show it inline), for traceability back to which marketplace order each unit came from.

**Honest limitations:**
- The Flipkart regex is built and tested against one real sample; if a different Flipkart label layout (different seller template, international shipment, etc.) doesn't match the two patterns above, that SKU falls through to the Unmapped queue rather than failing silently — send another sample if you hit one that doesn't parse, and it can be added as a third tier.
- `tools/label-cropper.html` (the free tool) has since had two additive changes made to it — Flipkart SKU-stamping and a Detected SKUs panel, both described further down under "Label Cropper: Flipkart stamping + Detected SKUs panel". Its working Amazon/Meesho code paths were never rewritten, only extended.
9. **They create an invoice** — pick a customer, add line items from the product list, adjust quantity/rate/discount if needed. The system automatically works out whether it's CGST+SGST (same state) or IGST (different state) based on the business's and customer's states, and computes an invoice number in the format `FY/0001` (e.g. `25-26/0007`).
10. **Save & Download** generates a legally-formatted PDF with all required GST fields and the saved signature embedded, and downloads it to the business owner's device.
11. **Save, Download & Email** does the same, plus emails the customer a link to view the invoice online (`invoice-view.html`) — opening that link auto-downloads the PDF to their device immediately, with a button to grab it again if needed — both without requiring the customer to log in anywhere.
12. **Invoice History** shows every invoice created, whether it was emailed, and lets the business re-open the PDF or the shareable link any time.
13. **They can file GSTR-1 directly from this data** — no re-entry needed. The **GSTR-1 Filing** tab lets them pick a return period — either a specific month, or a full quarter for QRMP filers, chosen from the last 3 financial years — and the system reads every saved invoice from that period and automatically sorts it into:
    - **B2B** — one row per registered customer's invoice
    - **B2CL** — unregistered, inter-state invoices over ₹1,00,000 (the current GST threshold, effective Aug 2024)
    - **B2CS** — everything else unregistered, grouped by state and tax rate
    - **HSN summary** — every line item aggregated by HSN code and rate

    **Download GSTR-1 Excel** produces a workbook with `b2b`, `b2cl`, `b2cs`, and `hsn` sheets in the same column format as the official GST offline tool — ready to upload on the GST portal.

## What this does *not* include yet (things to consider later)

- **GSTR-1 export** — ~~this billing system generates invoices, but doesn't yet total them into a GSTR-1 filing~~ **Done** — see the GSTR-1 Filing tab above.
- **Input Tax Credit / purchases tracking** — intentionally not built. ITC is auto-populated on the GST portal via GSTR-2B, sourced directly from what your suppliers upload in their own GSTR-1 filings — tracking it separately here would just be duplicate data entry.
- **Editing/cancelling invoices** — once saved, an invoice isn't editable from the dashboard. For corrections, the standard GST-compliant approach is a credit note against the original, which isn't built here yet.
- **Server-verified bot protection** — the reCAPTCHA checkbox is a real deterrent but isn't backed by a server-side secret-key check (see Part 4).
- **Editing username or business type after signup** — currently one-time at signup (or at the profile-completion step for Google sign-ups). The account settings page only supports changing email and password so far.
- **Multi-user access per business** — right now each Firebase login is its own isolated business; there's no way yet for two people to share access to one business's data.
- **Ordering from a linked seller's visible catalog** — **done**, see the Order Flow section above (Product Select Order only).
- **Automatic marketplace SKU detection** — **done** for Amazon, Meesho, and Flipkart via the Label-Based Auto Order upload flow (see below); there's still no automatic *fetching* of labels from each marketplace's own dashboard/API — you upload the PDF yourself.
- **Label-Based Auto Order** — **done**, see the Label-Based Auto Order section below (built from a real Flipkart sample; Amazon/Meesho reuse the free Label Cropper tool's proven extraction).
- **Order/acceptance email notifications** — not wired up yet; the invoice email path (EmailJS) already exists and could be extended to this flow.
- **Cloud Function-backed order acceptance** — the current Accept step is a client-side Firestore transaction (see the Order Flow section above for exactly what that does and doesn't guarantee). A Cloud Function version is a well-defined upgrade but requires Firebase's paid Blaze plan.

### Order email notifications (new)

Buyer places an order → seller gets emailed. Seller accepts or rejects → buyer gets emailed. Every email is a **notification with a link back into the site** — there's no accept/reject action inside the email itself; the seller still has to actually open Order Receive and click Accept there. That's deliberate: accepting is the sensitive, atomic operation described above, and it should only ever happen through the page that runs that transaction, never from a link click in an inbox.

**One-time setup — a new EmailJS template** (separate from the existing invoice template, so its wording stays order-specific and the invoice template is untouched):

1. In [emailjs.com](https://www.emailjs.com), under **Email Templates**, click **Create New Template**.
2. Set the **Subject** field to `{{email_subject}}` (a variable, not fixed text) — this is what lets one template cover all three notification types ("New Order Received…", "Order Accepted…", "Order Rejected…") with the exact subject line each one needs.
3. Set **To email** to `{{to_email}}`.
4. Body:
   ```
   Hi {{to_name}},

   {{headline}}

   {{detail_line}}

   View details: {{view_link}}

   — VISUTRA
   ```
5. Copy the template's ID and paste it into `billing/assets/firebase-config.js` as `EMAILJS_ORDER_TEMPLATE_ID` (replacing the `PASTE_YOUR_ORDER_TEMPLATE_ID` placeholder).

**Fails open, same as everything else in this project that depends on config being filled in**: until that placeholder is replaced with a real template ID, order emails are silently skipped — placing/accepting/rejecting an order still works exactly as before, just without the email. Nothing breaks either way.

What each email links to:
- **New order → seller**: links to `seller/order-receive.html?id=<orderId>`, which opens Order Receive with that exact order's status filter selected and the row scrolled into view and outlined, so the seller lands right on it instead of having to search.
- **Accepted/Rejected → buyer**: links straight to **the GST bill itself** (`invoice-view.html?id=<invoiceId>`) on acceptance — no sign-in needed, and it auto-downloads the PDF the moment the page opens, so the buyer's email genuinely delivers the bill, not just a status page. Rejection still links to `buyer/my-orders.html?id=<orderId>` (deep-link-and-highlight), since there's no invoice to show.

**Where this fires from, and what's genuinely reliable about it**: sending happens right after each event, from the client that just performed it (buyer's browser after placing an order; seller's browser after Accept/Reject succeeds). It's fire-and-forget — a failed or skipped email never blocks or undoes the underlying order/invoice/inventory changes, which are already saved by the time the email is attempted.

### Label Cropper: Flipkart stamping + Detected SKUs panel (new)

Two additive changes to `tools/label-cropper.html`, the free public tool — Amazon and Meesho's existing, working code paths were never rewritten, only extended:

- **Flipkart SKU-stamping**, matching what Amazon/Meesho already had: a checkbox to reprint the SKU + Qty in larger, clearer text at the bottom of each cropped label.
- **A "Detected SKUs" panel** under the preview, listing page number, SKU, and quantity for every page — regardless of platform. This runs **whether or not the "print SKU on label" checkbox is on** — that checkbox only controls whether the SKU gets stamped onto the *output* PDF; detection itself always happens right on upload, so the panel shows what was found either way. It includes a link straight to **Label-Based Auto Order** (`billing/buyer/label-order.html`) for turning that same file into an actual order — signing in and being linked to the seller is still required there, same as everywhere else in the buyer flow.

### Site navigation cleanup + Business Portal (new)

Two changes, matching the original spec's Part 3 (single "Free Services for Sellers" nav entry) and Part 5 (a Buyer/Seller portal split), which had been built partially — `free-services.html` already existed with the right nav, but the actual site-wide navigation had never been switched over to point at it.

- **Every marketing page's header, mobile menu, and footer** (`index.html` plus all 15 other top-level pages) had their separate "Free Tools" / "GST Billing" / "Purchase Entry" links replaced with one: **Free Services for Sellers**, linking to `free-services.html`. Nothing else on any of these pages was touched — this was a mechanical, exact-text find-and-replace across the repeated header/footer markup each static page carries its own copy of.
- **New page `billing/portal.html`** — "Buying, or selling?" — two side-by-side sections, **Buyer** and **Seller**, each listing only that role's own links (Buyer: My Sellers, Place Order, Label-Based Auto Order, Buyer SKU Master, My Orders. Seller: GST Billing, Purchase Entry, Order Receive). This page itself doesn't gate on login — each link it points to already has its own auth guard, exactly like every other link on the site — but if you are logged in, the usual account menu shows in the top-right.
- `free-services.html`'s **"GST Billing" card now opens `billing/portal.html`** instead of jumping straight into the seller's billing app, since a person clicking it could be a buyer, a seller, or both.
- The **account dropdown menu** (used everywhere via `user-menu.js`) now has one **"Business Portal (Buyer/Seller)"** link instead of the six separate buyer/seller links that had accumulated there across the phases above — same destinations, just gathered under the one hub page.

These are all reasonable next steps if this proves useful — just flag it and we can build any of them in.
