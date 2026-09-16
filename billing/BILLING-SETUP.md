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

**If you're updating rules on a project that's already live** (not a fresh setup): this block now also includes rules for `sellerLinks` and `buyerDirectory` (new, from the Buyer/Seller linking feature — see below) plus `orders` (from the existing "Order to Supplier" feature, which was missing from this doc even though it was already live — this replacement also fixes that drift). Paste the whole block above over whatever is currently in your Rules tab; nothing here removes access your existing data relies on.

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
- **Ordering from a linked seller's visible catalog** — the buyer/seller linking and product visibility above is the foundation; picking products from that catalog and sending an order (with SKU mapping, automatic GST invoicing, inventory deduction, etc.) is a later phase, not built yet.

These are all reasonable next steps if this proves useful — just flag it and we can build any of them in.
