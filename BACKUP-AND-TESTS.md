# Nightly backup, keep-awake, and automatic tests

Two GitHub Actions (in `.github/workflows/`) run for free on GitHub:

| Workflow | When | What it does |
|---|---|---|
| **Nightly backup + keep-alive** (`backup.yml`) | every night 02:00 IST, or on demand | pings Supabase so the free project never pauses, dumps the whole database, **encrypts** it with your passphrase, keeps each night's file for 90 days |
| **Tests** (`tests.yml`) | every upload (push) to GitHub | starts a Supabase-like database, loads the real pages, runs 25 checks (stock rules, GST files, security, editing, reconciliation, login, every page loads) |

---

## ⚠ First: re-run `schema.sql` in Supabase (one time)
This update fixes a rare case where the **same label printed on two devices at the
exact same moment** could deduct stock twice. The fix is in the database function.
Supabase → **SQL Editor** → New query → paste all of `supabase/schema.sql` → **Run**.
(Safe to re-run; it only replaces functions and rules, your data is untouched.)

---

## Part 1 — Set up the nightly backup (10 minutes)

### 1a. Get your database connection string
1. Supabase dashboard → your project → click **Connect** (top bar).
2. Choose **Session pooler** (not "Direct connection" — GitHub can't reach that one).
3. Copy the URI. It looks like:
   `postgresql://postgres.mxannyoulyhenvmrpzfr:[YOUR-PASSWORD]@aws-0-ap-south-1.pooler.supabase.com:5432/postgres`
4. Replace `[YOUR-PASSWORD]` with your **database password** (the one set when the
   project was created; reset it under Project Settings → Database if forgotten).
   If the password has special characters like `@ # / :`, reset it to letters and
   numbers only — those characters break the connection string.

### 1b. Choose a backup passphrase
A long sentence only you know, e.g. `visutra covers backup 2026 muradnagar`.
**Write it down somewhere safe.** Without it the backups can never be opened —
not by you, not by anyone. That is the point: the website repository is public,
so backups are only stored encrypted.

### 1c. Add 4 secrets on GitHub
Your repository → **Settings → Secrets and variables → Actions → New repository secret**:

| Name | Value |
|---|---|
| `SUPABASE_URL` | `https://mxannyoulyhenvmrpzfr.supabase.co` |
| `SUPABASE_PUBLISHABLE_KEY` | `sb_publishable_HAS2L4NPD0u-elLamwmlww_lazuij02` |
| `SUPABASE_DB_URL` | the connection string from 1a |
| `BACKUP_PASSPHRASE` | your passphrase from 1b |

Secrets are hidden: nobody (including people who can see the repository) can read them.

### 1d. Run it once now
Repository → **Actions** → **Nightly backup + keep-alive** → **Run workflow**.
After 1–2 minutes it shows a green ✓. Open the run → at the bottom, **Artifacts** →
`visutra-backup-2026-…` — that's the encrypted backup. From now on it runs every night.

> GitHub pauses scheduled workflows in a repository with no commits for 60 days and
> emails you first — if that happens, open Actions and click **Enable workflow**.

---

## Part 2 — Restoring a backup (only if something goes wrong)

**You need:** the downloaded artifact (a `.zip` containing `visutra-backup-DATE.tar.gz.gpg`),
your passphrase, and two free tools:
- **Windows:** [Gpg4win](https://www.gpg4win.org) (to decrypt) and the PostgreSQL command-line
  tools (`psql`) — install PostgreSQL from postgresql.org and tick only "Command Line Tools".

**Steps**
1. Unzip the artifact → `visutra-backup-DATE.tar.gz.gpg`.
2. Decrypt: double-click it (Gpg4win/Kleopatra) → enter your passphrase → you get
   `visutra-backup-DATE.tar.gz`. Extract it → folder `backup` with:
   - `visutra-data-DATE.sql` — all website data
   - `visutra-logins-DATE.sql` — login accounts
3. **Restoring into the same project** (data was deleted or damaged):
   Supabase → SQL Editor → run `truncate public.docs, public.store_products, public.store_admins;`
   then in a terminal:
   `psql "YOUR_SUPABASE_DB_URL" -f visutra-data-DATE.sql`
   Messages like *"already exists"* are normal (tables and functions are already there).
   Logins are not touched, so no need for the logins file.
4. **Restoring into a brand-new project** (old project lost): create the project, run
   `supabase/schema.sql`, redo the settings in SUPABASE-SETUP.md, then run both:
   `psql "NEW_DB_URL" -f visutra-logins-DATE.sql`
   `psql "NEW_DB_URL" -f visutra-data-DATE.sql`
   and update the URL + key in `billing/assets/firebase-config.js` and `assets/config.js`.

This whole procedure was rehearsed while building it: 251 records wiped and fully
restored; a wrong passphrase cannot open the file.

---

## Part 3 — Automatic tests (nothing to set up)

After every upload, GitHub shows next to your commit:
- 🟡 running (about 2 minutes) → ✅ **all good**
- ❌ **something broke** — GitHub also emails you. Open **Actions → Tests → the red run**
  to see which check failed (the names say what, e.g. *"Edit purchase opens exactly
  as saved"*). The website still updates — the ❌ is a warning to fix or undo that change.

What is checked (25 tests, in `tests/`):
- **Security:** each user reaches only their own data; seller/buyer sharing rules;
  invoices/usernames can be opened one at a time but not listed; saves are all-or-nothing.
- **Stock:** same label on five devices at once deducts once; two Amazon orders of the
  same SKU are separate; status rules; "All platforms" SKUs.
- **Label Cropper:** print, reprint, undo, unmapped queue, mapping catch-up.
- **GST:** GSTR-1 JSON in portal format (all tables), validation, GSTR-3B, GSTR-2B matching,
  Billing monthly + quarterly files.
- **Billing:** editing keeps saved values; product edit never rewrites stock; refresh stays on the page.
- **Buyer:** Total orders − Returns = Actual sales; month-total manual update; SKU Master.
- **Login:** returning to the tab doesn't restart pages; profile created after email confirmation.
- **Pages:** all 25 pages load signed-in without errors; Excel export; Stock Analysis numbers.

Run them on your own computer (optional): install Node.js 22 and PostgreSQL, then in
the `tests` folder: `npm install` and `npm test`.
