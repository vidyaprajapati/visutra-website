# One pending order per buyer · order cost · free tools on top

## What changed
1. **One order, not many.** While a seller has not accepted/rejected an order, every further
   order from the same buyer — the same day, the next day, from *Label-Based Auto Order* or
   *Place Order* — is **added into that pending order**. The seller sees one order, accepts it
   once, and gets one invoice. If the seller accepts at the very moment the buyer sends more,
   the extra items go out as a normal new order (nothing is lost, an accepted order is never edited).
2. **Order cost** (taxable + GST at the seller's current prices; the real invoice total once accepted):
   - Seller → *Order Receive*: new "Order value" column + amount on every item line.
   - Buyer → *My Orders*: "Order value" column. *Place Order*: cost under the cart.
     *Label-Based Auto Order*: "Order cost" under each seller's summary.
3. **Free tools strip** (Label Studio · Label Cropper · GST Return Tool · All free tools) directly
   under the top bar of every Buyer and Seller page.
4. **Bug fixed — why you saw 3 separate orders on the same day.** The newer label page that
   merges labels into one draft had been uploaded to `billing/label-order.html` (wrong folder),
   so buyers kept using the old `billing/buyer/label-order.html`. It is now in the right place.
   Also: after sending, the "order sent" message used to disappear with the draft; it now stays on screen.

## Do these 4 things
1. **Supabase → SQL Editor:** paste all of `supabase/schema.sql` → Run (safe to re-run; it adds the
   rule that lets a buyer add items to their own still-pending order).
2. **GitHub:** upload the files from the zip, keeping the folders.
3. **GitHub: delete `billing/label-order.html`** (the wrong-folder copy — uploading does not remove it).
   Optional clean-up of old unused copies: `tools/label-order.html`, `billing/order-place.html`,
   `billing/order-receive.html`.
4. **Your 3 orders already waiting (VIS-ORD-…HW55NM / TIX05E / ZVIEEK):** sign in as the **buyer**
   (Visu trader) → *My Orders* → click **Combine into one order**. The oldest stays pending with all
   items added together; the other two show "Combined into …" and leave the seller's list.
   Only the buyer can do this click.

## Good to know
- Merging applies to Label Auto and Place Order orders. Orders the seller records for a buyer are unchanged.
- The seller gets an email "Order updated – more items added" on each merge.
- Order cost uses the seller's *current* Product Master price and GST; items the buyer cannot see
  in the seller's catalogue are marked "priced on acceptance".
- A seller who has the order page open must refresh to see newly added items; Accept refuses
  a stale page ("order changed — refresh") instead of accepting the wrong items.
