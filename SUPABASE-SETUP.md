# VISUTRA on Supabase — setup (about 30 minutes)

The website no longer uses Firebase or any Google backend service. Everything
(login, billing, stock, buyer/seller data, shop products) runs on your Supabase
project:

- **Project URL:** `https://mxannyoulyhenvmrpzfr.supabase.co`
- **Publishable key:** already filled in (`billing/assets/firebase-config.js`
  and `assets/config.js`). It is public by design — your data is protected by
  the database security rules, not by hiding this key.

> **Fresh start.** Nothing is copied from Firebase: everyone (you included)
> signs up again, and shop products are re-added in `admin.html`. You were
> clearing the demo data anyway.

---

## 1. Create the database (5 min)
1. Supabase dashboard → your project → **SQL Editor** → **New query**.
2. Open `supabase/schema.sql` from this folder, copy **all** of it, paste, click **Run**.
3. It should finish with "Success. No rows returned". Running it again later is safe.

What it creates:
- `docs` — every record the website stores, with **Row Level Security**: each
  user reaches only their own data, plus the shared buyer/seller records
  they're a party to (a line-by-line copy of the old Firestore rules).
- `vt_commit()` — all saves go through it, all-or-nothing, so "count once"
  stock rules still can't double-count from two devices.
- `store_products` + `store_admins` — the shop catalogue and who may edit it.

## 2. Login settings (5 min)
**Authentication → Sign In / Providers → Email:**
- **Enable Email provider:** ON
- **Confirm email:** ON  (people must click the link before they can sign in)
- Minimum password length: 6 (or more)
- Leave Google and every other provider **off**.

**Authentication → URL Configuration:**
- **Site URL:** `https://visutra.in`
- **Redirect URLs** — add both:
  - `https://visutra.in/billing/login.html`
  - `https://visutra.in/billing/reset-password.html`

## 3. Send emails from support@visutra.in (10 min) — important
Supabase's built-in email is for testing only: it sends just a few emails per
hour, so sign-up confirmations and password resets would soon stop arriving.
Use your GoDaddy mailbox instead:

**Project Settings → Authentication → SMTP Settings → Enable custom SMTP:**

| Setting | GoDaddy Professional Email | GoDaddy Microsoft 365 email |
|---|---|---|
| Host | `smtpout.secureserver.net` | `smtp.office365.com` |
| Port | `465` | `587` |
| Username | `support@visutra.in` | `support@visutra.in` |
| Password | the mailbox password | the mailbox password |
| Sender email | `support@visutra.in` | `support@visutra.in` |
| Sender name | `VISUTRA` | `VISUTRA` |

Not sure which one you have? Log in to webmail: if it's **email.secureserver.net**
it's Professional Email; if it's **outlook.office.com** it's Microsoft 365.

Then **Authentication → Rate Limits → emails sent per hour:** raise to e.g. `30`.

Optional: **Authentication → Emails → Templates** — reword the "Confirm signup"
and "Reset password" emails (keep the `{{ .ConfirmationURL }}` link in them).

## 4. Make yourself shop admin (1 min)
SQL Editor → New query → run (use the email you'll sign up with):

```sql
insert into public.store_admins(email) values ('support@visutra.in');
```

Add a line per extra admin. Only these emails can add/edit products in `admin.html`.

## 5. Invoice & order emails (EmailJS) off Gmail (5 min)
The site sends invoice/order emails through EmailJS, which is currently connected
to a Gmail account. In the EmailJS dashboard → **Email Services** → open service
`service_1g6knan` (or add a new one) → choose **SMTP server** and enter the same
GoDaddy details as step 3. If you create a new service, put its ID in
`billing/assets/firebase-config.js` → `EMAILJS_SERVICE_ID`.

## 6. Upload the website
Upload this folder to GitHub (replace everything). Then delete the old files
listed in `RESET-AND-TEST.md` by hand — uploading doesn't remove files.

## 7. First sign-in
1. Open `https://visutra.in/billing/login.html` → **Create account**.
2. Click the link in the confirmation email → you land signed in, your profile
   (name, business type, username) is created automatically.
3. Sign in to `admin.html` with the same email/password → add your shop products.

---

## Keeping it healthy on the free plan
- **Pauses after 7 days without use.** With daily use it won't. If it ever does,
  Supabase dashboard → **Restore project** (data is kept).
- **No automatic backups.** Use **My Account → Backup — Export All My Data**
  about once a week and keep the file safe.
- **Limits:** 500 MB database (years of your orders), 5 GB data transfer a month.
  Watch **Project → Usage** occasionally.

## If something doesn't work
| Symptom | Fix |
|---|---|
| "Missing or insufficient permissions" | Step 1 wasn't run completely — run `schema.sql` again. |
| Confirmation / reset email never arrives | Step 3 (custom SMTP) and check spam. |
| Confirmation link opens but says error | Step 2 redirect URLs, exactly as written. |
| "Could not reach the server" | Project paused — restore it in the dashboard. |
| admin.html: "not a shop admin" | Step 4 with the exact email you sign in with. |
