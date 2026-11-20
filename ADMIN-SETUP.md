# VISUTRA admin — no Google Script

Everything runs on Supabase. The Apps Script / password panel is not used any more.

## One-time setup
1. Supabase → SQL Editor → run `supabase/schema.sql` (only if you haven't since this update), then `supabase/supplier-access.sql`, then `supabase/admin-setup.sql` after changing `support@visutra.in` in its first line to YOUR admin email.
2. Sign up at `https://visutra.in/billing/login.html` with that email (confirm the email link). If you already signed up earlier and were stuck "waiting for approval", just run admin-setup.sql — it approves you.
3. Sign in. Open `https://visutra.in/billing/admin-approvals.html`.

## Daily use
- **Approve / reject accounts:** `/billing/admin-approvals.html` (new sign-ups wait under "Waiting").
- **Add or remove other admins:** "Admins" box on the same page.
- **Shop products:** `/admin.html`, sign in with the same email and password.

Admins are never blocked by approval. Supplier-invited emails still auto-approve.
