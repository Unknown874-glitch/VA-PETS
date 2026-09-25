# Assistant Portal — Vercel + Firebase

- **Vercel** hosts both websites and runs the sign-in API.
- **Firebase Firestore** stores the creator account, clients (with hashed passwords only) and activity.

When it's live:

- Creator dashboard: `https://YOUR-APP.vercel.app/creator/`
- Client portal: `https://YOUR-APP.vercel.app/client/`

Both Firebase (Spark plan) and Vercel (Hobby plan) are free for this.

---

## Part 1: Firebase

1. Go to https://console.firebase.google.com and choose **Create a project**. Name it (for example, `assistant-portal`). Google Analytics is optional; you can turn it off.
2. In the left menu open **Build → Firestore Database** and choose **Create database**.
   - Location: pick one close to you and your clients (for example `asia-southeast1 (Singapore)`). This can't be changed later.
   - Start in **production mode**.
3. Open the **Rules** tab, replace everything with the contents of `firestore.rules` from this folder, and choose **Publish**. This blocks browsers from touching the database; only your server can.
4. Open **Project settings** (gear icon) → **Service accounts** → **Generate new private key** → **Generate key**. A `.json` file downloads.
   - Treat this file like a password. Don't email it, and don't upload it to GitHub.

## Part 2: Put the code on GitHub

1. Create a new **private** repository on https://github.com.
2. Upload the contents of this folder (not the zip itself). The `.gitignore` already keeps `.env`, `node_modules` and key files out.
   - Easiest way: on the new repo page choose **uploading an existing file**, drag the files in, then **Commit changes**.

## Part 3: Vercel

1. Go to https://vercel.com, sign in with GitHub, choose **Add New → Project**, and import your repository.
2. On the setup screen:
   - Framework Preset: **Other**
   - Leave Build Command and Output Directory as they are (`vercel.json` sets them).
3. Open **Environment Variables** and add two:

   | Name | Value |
   |---|---|
   | `FIREBASE_SERVICE_ACCOUNT` | Open the `.json` key from Part 1 in a text editor, copy **everything**, and paste it in. |
   | `SESSION_SECRET` | Any random text, at least 32 characters. See below. |

   To make a random secret, run this in a terminal:
   `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`
   or use a password generator set to 40+ characters.

4. Choose **Deploy**. When it finishes, open `https://YOUR-APP.vercel.app/creator/` and create your creator account. The first person to open that page becomes the owner, so do this right away.

## Part 4: Check it works

1. In the dashboard, add a test client and copy the sign-in details.
2. Open `https://YOUR-APP.vercel.app/client/` on your phone, sign in, and choose **Yes, download it**. Because Vercel uses HTTPS, the web app install works here.
3. Back in Firebase → Firestore → **Data**, you'll see `settings`, `clients` and `activity` appear. Passwords show only as `$2a$…` hashes.

## Optional: your own domain

In Vercel open your project → **Settings → Domains**, add the domain, and follow the DNS steps it shows. Update the portal link you send clients.

## Updating later

Change files in GitHub (or push from your computer). Vercel redeploys automatically. If you change an environment variable, redeploy from **Deployments → ⋯ → Redeploy** so it takes effect.

## Test on your own computer (optional)

Needs Node.js 20 or newer.

1. Copy `.env.example` to `.env` and fill in both values (the service-account JSON must be on one line).
2. Run `npm install`, then `npm run dev`.
3. Open http://localhost:3000/creator/

This uses your real Firestore database, so test clients will show up online too.

## Troubleshooting

| What you see | Fix |
|---|---|
| "Server setup incomplete: set SESSION_SECRET" | Add `SESSION_SECRET` in Vercel (32+ characters), then redeploy. |
| "Firebase isn't configured" or "isn't valid JSON" | Re-paste the entire service-account file into `FIREBASE_SERVICE_ACCOUNT`, then redeploy. |
| "Server error. Check the server logs." | In Vercel open **Logs**. A `PERMISSION_DENIED` or `NOT_FOUND` error usually means Firestore wasn't created (Part 1, step 2) or the key is from a different project. |
| Client page has no install option | Open it through the `https://` Vercel address in Chrome, Edge or Safari, not inside another app's browser. |
| Forgot the creator password | In Firestore → Data, delete the `settings/creator` document, then open `/creator/` and set up again. Your clients stay. |

## How it's protected

- Passwords are stored only as bcrypt hashes. You can reset them, never read them.
- 5 wrong tries locks that email for 15 minutes (tracked in Firestore, so it works across Vercel's servers).
- The creator session is an HttpOnly, SameSite=Strict, Secure cookie lasting 12 hours.
- Firestore rules deny all browser access; only the server's service account can read or write.
- The CSV export never includes passwords.

## Files

- `api/index.js` — the Vercel function that handles every `/api/...` request
- `lib/app.js` — all API logic
- `lib/firebase.js` — connects to Firestore using your environment variables
- `public/creator/` — creator dashboard
- `public/client/` — client portal and web app files
- `vercel.json` — routing and headers for Vercel
- `firestore.rules` — database security rules to paste into Firebase
- `server.js` — only for testing on your own computer
