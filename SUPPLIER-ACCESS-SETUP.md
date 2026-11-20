# Supplier access — setup (about 10 minutes)

**What suppliers get:** when you add a supplier *with an email* in Billing → Supplier Master,
they are emailed a link. They enter that email at `/billing/supplier/login.html`, receive a
one-time login link at **that address only**, and land on their own dashboard:
purchases (with items), payments and balance — read-only, only records saved against their
email. They can also open the Free Tools. No password, no VISUTRA approval step.

## 1. Database (Supabase → SQL Editor → New query)
Paste **all** of `supabase/supplier-access.sql` and click **Run** ("Success. No rows returned").
Safe to run again. (`schema.sql` now contains the same sign-up rule, so re-running it later
does not switch supplier access off.)

## 2. Supabase login settings (Authentication)
- **Sign In / Providers → Email:** Enable Email = ON, **Confirm email = ON** (keep it ON — it is
  what proves a supplier owns the email address). Magic-link / "Enable email OTP" stays ON.
- **URL Configuration → Redirect URLs:** add
  - `https://visutra.in/billing/supplier/dashboard.html`
  - `https://visutra.in/billing/supplier/login.html`
- **Rate Limits:** "emails sent per hour" is shared by every login link — keep the custom
  SMTP from step 3 of `SUPABASE-SETUP.md` (the built-in mailer allows only a few per hour).
- Optional — **Emails → Templates → Confirm signup** and **Magic Link**: reword to
  "Click to open your VISUTRA supplier dashboard". Keep `{{ .ConfirmationURL }}` in both.
  (A supplier's very first login uses "Confirm signup"; later logins use "Magic Link".)

## 3. Upload to GitHub (replace / add these files)
| File | Change |
|---|---|
| `supabase/supplier-access.sql` | **new** (run in step 1) |
| `supabase/schema.sql` | replaced (sign-up rule only) |
| `billing/supplier/login.html` | **new** |
| `billing/supplier/dashboard.html` | **new** |
| `billing/assets/billing-app.js` | replaced (invite on save + Invite button) |
| `billing/app.html` | replaced (one hint line under the supplier Email field) |
| `billing/login.html` | replaced (one "Are you a supplier?" link) |
| `SUPABASE-SETUP.md`, `SUPPLIER-ACCESS-SETUP.md` | docs |
| `tests/supplier-access.test.js`, `tests/setup-db.js` | tests (optional but recommended) |

## 4. Try it (5 minutes)
1. Billing → Supplier Master → add a supplier with **your own second email** → "Login link emailed".
2. Record one purchase and one payment for that supplier.
3. Open `https://visutra.in/billing/supplier/login.html`, enter that email, open the emailed link.
4. You should see exactly that purchase, that payment and the balance. Try **Free Tools**.

## Good to know
- **The invite uses your existing EmailJS "order" template** (`template_r7i6awt`, the same one that
  sends you the "new sign-up" mail). Test once; if the button text looks odd, adjust that
  template's wording in EmailJS.
- **Who gets in without approval:** only an email that a seller typed on a supplier card.
  Those accounts show `auto:supplier-invite` in *Account approvals* — you can reject one any time
  and its dashboard closes. Any seller can create such an account for any email they own, so
  review that list occasionally.
- Supplier accounts are normal VISUTRA accounts under the hood (that is how the free tools
  work), so a supplier *can* also open Billing for their own business.
- Changing a supplier's email on the card sends the new address an invite; the old address
  stops seeing the records immediately.
- Some company mail scanners "click" links automatically and use up a one-time link — if a
  supplier says the link "expired", have them request a new one from the login page.
