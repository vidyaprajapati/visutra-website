# VISUTRA Android app — step by step (no coding)

The app is a **TWA (Trusted Web Activity)**: a real Play Store app that shows
visutra.in using Chrome itself. So Google Sign-in, PDF uploads (Label Cropper)
and downloads all work, and every website update reaches the app instantly —
you never rebuild the app for website changes.

The website side is ready in this folder:

| File | What it does |
|---|---|
| `manifest.webmanifest` | App name, icon, colours, start page (Billing Portal), long-press shortcuts (Label Cropper, Billing, Buyer Dashboard) |
| `sw.js` + `pwa.js` | Service worker — required for an app; pages & data always load fresh, shows `offline.html` only when there's no internet |
| `offline.html` | Friendly "You're offline" screen |
| `assets/app-icons/` | App icons (normal + Android round "maskable") |
| `.nojekyll` | Lets GitHub Pages publish the `.well-known` folder |
| `.well-known/assetlinks.json` | Proves the app belongs to visutra.in — **replaced in step 4** |
| every page's `<head>` | 4 lines linking the above |

---

## Step 1 — Upload the website
Upload this folder to GitHub as usual. **Important:** `.nojekyll` and
`.well-known` start with a dot — on GitHub's web uploader, drag the files in;
if you use a zip/Explorer, make sure hidden files are included.

Check (on a computer, in Chrome):
- `https://visutra.in/manifest.webmanifest` opens and shows the JSON.
- `https://visutra.in/.well-known/assetlinks.json` opens (not a 404).
- Open `https://visutra.in/billing/portal.html` → Chrome shows an **Install app**
  icon in the address bar. That means the site passes.

## Step 2 — Build the app on PWABuilder
1. Go to **https://www.pwabuilder.com** → enter `https://visutra.in/billing/portal.html` → **Start**.
2. It scores the site — Manifest and Service Worker should both be green.
3. Click **Package For Stores → Android → Generate Package**, then **Options**:
   - **Package ID:** `in.visutra.app`  ← permanent once published; keep this exact one
     (it matches `assetlinks.json`)
   - **App name:** `VISUTRA`  ·  **Launcher name:** `VISUTRA`
   - **App version:** `1.0.0`  ·  **Version code:** `1`
   - **Host:** `visutra.in`  ·  **Start URL:** `/billing/portal.html?source=app`
   - **Theme / status bar colour:** `#FF5A00`  ·  **Background / splash colour:** `#FFFFFF`
   - **Display mode:** Standalone  ·  **Notifications:** off (not used)
   - **Signing key:** *Create new*  (fill your name/organisation; choose a strong password)
4. **Download** the zip.

## Step 3 — ⚠ Back up the signing key
The downloaded zip contains `signing.keystore` and `signing-key-info.txt`
(passwords). **Save both in two safe places** (e.g. Google Drive + a pen drive).
Without them you can **never update** the app on the Play Store.

## Step 4 — Replace assetlinks.json
The downloaded zip contains its own `assetlinks.json` with your real key
fingerprint. **Replace** `.well-known/assetlinks.json` in this website with that
file, and upload to GitHub again.

> If you later publish on the Play Store with **Play App Signing** (default), Play
> re-signs the app with its own key. Then also copy the SHA-256 shown in
> Play Console → *Test and release → App integrity → App signing* and **add** it to
> the `sha256_cert_fingerprints` list in `assetlinks.json` (keep both). Without it
> the Play Store version shows a browser address bar at the top.

## Step 5 — Test on your phone
1. Copy the `.apk` from the zip to your phone and open it (allow "install unknown apps").
2. Open the app and check:
   - [ ] Opens on Billing Portal, **no browser address bar** at the top
         (if a bar shows: step 4 isn't live yet — wait a few minutes after uploading)
   - [ ] **Sign in with Google** works
   - [ ] Label Cropper: choose a PDF, crop & download → file is saved
   - [ ] Invoice PDF / Excel export downloads
   - [ ] Long-press the app icon → shortcuts: Label Cropper, Billing, Buyer Dashboard
   - [ ] Airplane mode → "You're offline" screen, then **Try again** after reconnecting

## Step 6 — Publish on Google Play (optional)
1. Create a **Google Play Console** developer account (one-time US$25).
2. **Create app** → upload the **`.aab`** from the zip.
3. Store listing: short & full description, the 512×512 icon
   (`assets/app-icons/icon-512.png`), a 1024×500 feature graphic, and at least
   2 phone screenshots.
4. Privacy policy URL: `https://visutra.in/privacy.html`.
5. Complete the content questionnaires (target audience, data safety — the app
   uses Google sign-in and stores business data in Firebase).
6. New personal developer accounts must run a **closed test (usually 12+ testers
   for 14 days)** before production — add friends/staff as testers.
7. Then add the Play signing fingerprint (Step 4 note) and roll out.

## Later updates
- **Website changes** → just upload to GitHub. The app shows them immediately.
- **App changes** (name, icon, colours) → rebuild on PWABuilder with the **same
  package ID and the same signing key**, increase the version code (2, 3…).

## Changing the start page
Edit `start_url` (and `id`) in `manifest.webmanifest`, e.g.
`/billing/buyer/dashboard.html`, then rebuild on PWABuilder.
