# Fix: buyer stock not updating after order acceptance

## Root cause

The code that turns an accepted order into a Purchase Entry + stock-in
(`ensureBuyerPurchaseForOrder`) only ran client-side, and only on two pages:

- `dashboard.html` — but only for the off-platform "Orders to Confirm" flow
- `my-orders.html` — a background sweep, but only when that page loads

For a normal Place Order → seller accepts, nothing ran that sweep unless the
buyer happened to open **My Orders**. Dashboard and Stock only *display*
Firestore data — they never triggered the update themselves.

There's also a silent second failure mode: stock only attaches if the
seller's item name matches (exact, case/whitespace-insensitive) a product
already in the buyer's own Products list. If it doesn't match, no error was
shown anywhere except in `dashboard.html`'s one code path.

## Fix 1 — quick patch: `billing/assets/user-menu.js`

Replace your existing file with the updated one here. It adds the same
sweep logic directly into `renderBuyerSidebar()`, which every `buyer/*.html`
page already calls — so it now runs no matter which buyer page loads after
an acceptance, not just My Orders. It also shows a small dismissible
on-page banner if any item couldn't be matched to a product (previously
silent on this codepath).

**Deploy:** just overwrite `billing/assets/user-menu.js` in your hosting
and redeploy (`firebase deploy --only hosting`, or however you currently
publish). No other file needs to change — `my-orders.html` and
`dashboard.html` keep their own copies of this logic exactly as they are.

This is a safety net, not a real fix — it still depends on the buyer's
browser being open on *some* buyer page. It closes the "never visited My
Orders" gap immediately with a one-file change.

## Fix 2 — real fix: Cloud Function

`functions/index.js` + `functions/package.json` here add a Cloud Function
(`onOrderAccepted`) that does the same Purchase Entry + stock-in work
**server-side**, the instant `marketplaceOrders/{orderId}.status` flips to
`ACCEPTED` — with zero dependence on any browser tab being open.

### Deploy steps

1. If you haven't used Cloud Functions on this project before, your Firebase
   project needs to be on the **Blaze (pay-as-you-go)** plan — Spark (free)
   doesn't support Cloud Functions with outbound calls. Firestore reads/writes
   from a function this small cost fractions of a cent per invocation.
2. In your project folder (wherever `firebase.json` / `.firebaserc` live, or
   run `firebase init` first if this project doesn't have one yet):
   ```
   firebase init functions
   ```
   When it asks to overwrite `functions/index.js` and `functions/package.json`,
   say no if you already copied these files in — or just copy these files
   into the `functions/` folder it creates.
3. Make sure `functions/package.json`'s `engines.node` matches what your
   Firebase CLI expects (20 is current as of writing — check
   `firebase --version` / the CLI's own prompt if it complains).
4. Install dependencies and deploy:
   ```
   cd functions
   npm install
   cd ..
   firebase deploy --only functions
   ```
5. Test: place an order as a buyer, accept it as the seller, and check the
   Firebase Console → Functions → Logs for `onOrderAccepted` — then check
   the buyer's Stock page. It should already show the new stock without
   opening My Orders first.

### Notes

- This function uses the **Admin SDK**, which bypasses Firestore security
  rules entirely — you do not need to change `firestore.rules` for this.
- It only acts on the normal PENDING → ACCEPTED transition. The off-platform
  "Orders to Confirm" flow (`dashboard.html`) still creates its purchase
  client-side in the same click as before — this function's
  `buyerPurchaseId` check makes sure it won't create a second, duplicate
  purchase if the buyer's page and this function both fire on the same order.
- Once this is deployed and confirmed working, `my-orders.html`'s own sweep
  and Fix 1's `user-menu.js` sweep both become redundant safety nets (they
  no-op immediately since `buyerPurchaseId` will already be set) — you can
  leave them in place with no downside, or remove them later once you trust
  the function.
