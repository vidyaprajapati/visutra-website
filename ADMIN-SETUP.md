# VISUTRA Admin Product Panel — Setup Guide

This adds a password-protected admin page (`admin.html`) where you can add,
edit, hide, or delete products. Products are stored in a Google Sheet and
served to the live site through a small Apps Script API — the same stack
you already use for the SPR tools.

Nothing in this changes your GitHub Pages hosting. You're adding one Google
Sheet + one Apps Script deployment, and pointing the website at it.

## 1. Create the Google Sheet + Apps Script

1. Go to sheets.google.com → **Blank spreadsheet**. Name it e.g. `VISUTRA Products`.
2. **Extensions → Apps Script**.
3. Delete the default code, and paste in the contents of `apps-script/Code.gs`
   (included in this package).
4. In the `setAdminPassword` function near the top, replace
   `'CHANGE-THIS-PASSWORD'` with a real password you'll remember.
5. Run that function once: select `setAdminPassword` from the function
   dropdown at the top, click **Run**. Approve the permission prompts
   (it's your own script, acting on your own sheet).
6. You can now change the placeholder text back if you like — the password
   is already saved. (Optional: delete the plaintext line afterward so it's
   not sitting in the script; the password is stored separately in Script
   Properties either way.)

## 2. Deploy the web app

1. In the Apps Script editor: **Deploy → New deployment**.
2. Click the gear icon next to "Select type" → **Web app**.
3. Settings:
   - **Execute as:** Me
   - **Who has access:** Anyone
4. Click **Deploy**, authorize again if asked.
5. Copy the **Web app URL** it gives you — looks like
   `https://script.google.com/macros/s/AKfycb.../exec`.

## 3. Connect the website

1. Open `assets/config.js` in the website files.
2. Replace `PASTE_YOUR_APPS_SCRIPT_WEB_APP_URL_HERE` with the URL from step 2.
3. Push/upload the updated files to your GitHub Pages repo as usual.

That's it. `index.html` and `products.html` will now try to load live
products from the Sheet; until you add any, or if the connection ever
fails, they safely show the original static product cards instead — the
site never breaks because of this.

## 4. Using the admin panel

1. Go to `https://visutra.in/admin.html`.
2. Log in with the password you set in step 1.
3. **Add a Product**: fill in Name, Category, Tag, Description, Price
   (optional), and an **Image URL** (a direct link to an image you've
   hosted — e.g. upload it to a public Google Drive folder or Imgur and
   use the direct image link, not a page link).
4. Tick **Featured** to have it show on the homepage (top 4 featured
   products are shown there); leave it unticked and it will still appear
   on the full Products page.
5. Untick **Active** to hide a product from the site without deleting it
   (useful when you're out of stock).
6. Products appear on the live site within a few seconds of saving —
   just refresh the page.

## Notes on security

- The admin password is checked **server-side** in Apps Script — it's
  never exposed in the website's HTML/JS, so viewing page source won't
  reveal it.
- Login sessions last 6 hours, then you'll need to log in again.
- `admin.html` isn't linked from the site's navigation and has a
  "noindex" tag so search engines won't list it, but the URL itself
  is not secret — anyone who knows/guesses it can reach the login
  screen (they just can't get in without the password). If you want
  extra obscurity, you can rename the file to something less guessable
  (e.g. `visutra-admin-9k2.html`) before uploading.
- Use a strong, unique password — this is the only thing standing
  between the public and your product catalog.

## Sheet columns (created automatically on first save)

| ID | Name | Category | Tag | Description | Price | ImageURL | Featured | Active | SortOrder | DateAdded |

You generally shouldn't need to edit the sheet by hand — use the admin
panel — but it's a normal Google Sheet, so you can open it any time to
review or bulk-edit if needed.
