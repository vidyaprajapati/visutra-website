# VISUTRA — deploy, reset, and test (Supabase version)

## 1. Set up Supabase first
Follow **SUPABASE-SETUP.md** (database, login settings, email, shop admin).

## 2. Upload the website
Upload this folder to GitHub, replacing what's there. Uploading does NOT delete
old files — delete these by hand (unused leftovers / old Firebase files):

- billing/buyer/app.html
- billing/assets/app.html
- billing/order-place.html
- billing/order-receive.html
- tools/label-order.html
- tools/tools-home.htm
- firestore.rules            (old Firebase rules — replaced by supabase/schema.sql)

The files starting with a dot (`.nojekyll`, `.well-known/`) must be uploaded too.

## 3. Reset / clear data (whenever you want a clean slate)
Supabase → SQL Editor → run:

```sql
truncate public.docs;              -- all billing, stock, buyer/seller data
-- truncate public.store_products; -- shop catalogue too (optional)
```

Login accounts stay (Authentication → Users). To remove an account: Authentication
→ Users → ⋯ → Delete user.

## 4. Test checklist
Login
- [ ] Create account → confirmation email arrives from support@visutra.in → click it
      → you land signed in; profile has your name, business type and username.
- [ ] Sign out, sign in with **username** and with **email**.
- [ ] Forgot password → email → reset page → new password works.
- [ ] My Account → change password; Backup downloads a .json file.

Section separation
- [ ] Buyer pages stay in Buyer; Billing pages never open a Buyer page.
- [ ] Label Cropper from Billing opens as Seller; from Buyer SKU Master as Buyer.

Label Cropper — Seller
- [ ] Settings: activate 4×6, add label stock, add a packing size + stock.
- [ ] Upload labels → map an unmapped SKU in the Seller Stock box; pick packing/label size.
- [ ] Print → product −qty, packing −1 per label, 4×6 −1 per label. Reprint → only label.
- [ ] Amazon file with 2+ orders of the SAME SKU → product down once PER ORDER.
- [ ] Unmapped SKU printed → Billing → Stock Management → Unmapped Label SKUs → Map & Deduct.
- [ ] Low stock → "Print anyway?"; Undo last print; Returns box; Stock history.

Buyer
- [ ] Buyer SKU Master: add a product (name only), map SKUs, link a seller product.
- [ ] Seller links you (My Sellers) → Place Order → seller accepts → buyer stock goes up.
- [ ] Label Cropper (Buyer) → print → buyer stock down once per shipment.

Reconciliation & reports
- [ ] Billing → Stock → Monthly Reconciliation: upload the Meesho payment file
      (Order Payments sheet) → sold / returned / cancelled counts; upload again → no change.
- [ ] Reorder suggestions, "SKUs need mapping" banner / dashboard card.

Shop
- [ ] admin.html: sign in → add a product → it appears on the home page and Products page.
- [ ] A product marked hidden does not appear to visitors.

Android app (optional)
- [ ] See ANDROID-APP-GUIDE.md.
