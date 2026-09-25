/**
 * Connects to Firestore with a Firebase service account.
 *
 * Set ONE of these in your environment (Vercel → Settings → Environment Variables, or .env locally):
 *   FIREBASE_SERVICE_ACCOUNT  = the whole service-account JSON file, pasted as-is
 * or all three of:
 *   FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY
 */
const { initializeApp, cert, getApps } = require("firebase-admin/app");
const { getFirestore } = require("firebase-admin/firestore");

let firestore = null;

function readCredentials() {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (raw) {
    let json;
    try { json = JSON.parse(raw.trim().startsWith("{") ? raw : Buffer.from(raw, "base64").toString("utf8")); }
    catch { throw new Error("FIREBASE_SERVICE_ACCOUNT isn't valid JSON. Paste the whole service-account file."); }
    return { projectId: json.project_id, clientEmail: json.client_email, privateKey: json.private_key };
  }
  const { FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY } = process.env;
  if (!FIREBASE_PROJECT_ID || !FIREBASE_CLIENT_EMAIL || !FIREBASE_PRIVATE_KEY)
    throw new Error("Firebase isn't configured. Set FIREBASE_SERVICE_ACCOUNT (see README).");
  return {
    projectId: FIREBASE_PROJECT_ID,
    clientEmail: FIREBASE_CLIENT_EMAIL,
    privateKey: FIREBASE_PRIVATE_KEY.replace(/\\n/g, "\n") // Vercel often stores newlines as \n
  };
}

function getDb() {
  if (firestore) return firestore;
  if (!getApps().length) initializeApp({ credential: cert(readCredentials()) });
  firestore = getFirestore();
  return firestore;
}

module.exports = { getDb };
