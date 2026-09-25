/**
 * Assistant Portal API (Firestore edition)
 * Works as a Vercel serverless function (api/index.js) and as a local server (server.js).
 *
 * Firestore collections:
 *   settings/creator      the creator (owner) account
 *   clients/{id}          one document per client
 *   activity/{auto}       sign-ins and account changes
 *   loginAttempts/{hash}  short-lived counters for rate limiting
 * Passwords are stored only as bcrypt hashes.
 */
const express = require("express");
const bcrypt = require("bcryptjs");
const crypto = require("crypto");

const COOKIE = "creator_session";
const SESSION_HOURS = 12;
const BCRYPT_ROUNDS = 11;
const WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILS = 5;

function createApp({ db: injectedDb } = {}) {
  let dbInstance = injectedDb || null;
  const db = () => dbInstance || (dbInstance = require("./firebase").getDb());

  const SECRET = process.env.SESSION_SECRET;
  const DUMMY_HASH = bcrypt.hashSync("not-a-real-password", BCRYPT_ROUNDS);

  /* ---------- Helpers ---------- */
  const normEmail = e => String(e || "").trim().toLowerCase();
  const normModel = m => String(m || "").trim().toUpperCase();
  const isEmail = e => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);
  const isModel = m => /^[A-Z0-9][A-Z0-9-]{2,31}$/.test(m);
  const clean = (s, max = 120) => String(s || "").trim().slice(0, max);
  const now = () => new Date().toISOString();

  function generatePassword() {
    const chars = "abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    const bytes = crypto.randomBytes(12);
    let out = "";
    for (let i = 0; i < 12; i++) { out += chars[bytes[i] % chars.length]; if (i === 3 || i === 7) out += "-"; }
    return out;
  }
  const publicClient = c => { const { passwordHash, ...rest } = c; return rest; };

  /* ---------- Firestore access ---------- */
  const creatorRef = () => db().collection("settings").doc("creator");
  const clientsCol = () => db().collection("clients");
  const activityCol = () => db().collection("activity");
  const attemptRef = key => db().collection("loginAttempts").doc(crypto.createHash("sha256").update(key).digest("hex"));

  async function getCreator() { const s = await creatorRef().get(); return s.exists ? s.data() : null; }
  async function listClients() { return (await clientsCol().orderBy("createdAt", "desc").get()).docs.map(d => d.data()); }
  async function getClient(id) { const s = await clientsCol().doc(id).get(); return s.exists ? s.data() : null; }
  async function findByModel(model) {
    const q = await clientsCol().where("modelNumber", "==", model).limit(1).get();
    return q.empty ? null : q.docs[0].data();
  }
  async function logActivity(type, details = {}) {
    await activityCol().add({ at: now(), type, ...details });
  }

  /* ---------- Rate limiting (shared across serverless instances) ---------- */
  async function tooMany(key) {
    const s = await attemptRef(key).get();
    if (!s.exists) return false;
    const a = s.data();
    if (Date.now() - a.first > WINDOW_MS) { await attemptRef(key).delete(); return false; }
    return a.count >= MAX_FAILS;
  }
  async function recordFail(key) {
    const ref = attemptRef(key), s = await ref.get();
    if (!s.exists || Date.now() - s.data().first > WINDOW_MS) await ref.set({ count: 1, first: Date.now() });
    else await ref.update({ count: s.data().count + 1 });
  }
  const clearFails = key => attemptRef(key).delete();

  /* ---------- Signed session tokens ---------- */
  function sign(payload) {
    const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
    return body + "." + crypto.createHmac("sha256", SECRET).update(body).digest("base64url");
  }
  function verify(token) {
    if (!token || !token.includes(".")) return null;
    const [body, sig] = token.split(".");
    const expected = crypto.createHmac("sha256", SECRET).update(body).digest("base64url");
    const a = Buffer.from(sig), b = Buffer.from(expected);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
    try { const p = JSON.parse(Buffer.from(body, "base64url").toString()); return p.exp > Date.now() ? p : null; }
    catch { return null; }
  }
  function getCookie(req, name) {
    for (const part of (req.headers.cookie || "").split(";")) {
      const [k, ...v] = part.trim().split("=");
      if (k === name) return decodeURIComponent(v.join("="));
    }
    return null;
  }
  function setSessionCookie(req, res, token, maxAgeSec) {
    const secure = req.secure || req.headers["x-forwarded-proto"] === "https";
    res.setHeader("Set-Cookie",
      `${COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAgeSec}${secure ? "; Secure" : ""}`);
  }
  const startSession = (req, res) =>
    setSessionCookie(req, res, sign({ role: "creator", exp: Date.now() + SESSION_HOURS * 3600e3 }), SESSION_HOURS * 3600);

  /* ---------- App ---------- */
  const app = express();
  app.set("trust proxy", true);
  app.use(express.json({ limit: "50kb" }));
  app.use((req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Cache-Control", "no-store");
    if (!SECRET || SECRET.length < 32)
      return res.status(500).json({ error: "Server setup incomplete: set SESSION_SECRET (at least 32 characters)." });
    next();
  });

  // Wrap async routes so errors reach the error handler
  const h = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

  const requireCreator = h(async (req, res, next) => {
    const s = verify(getCookie(req, COOKIE));
    if (!s || s.role !== "creator") return res.status(401).json({ error: "Sign in again." });
    if (["POST", "PATCH"].includes(req.method) && !req.is("application/json"))
      return res.status(415).json({ error: "Send JSON." });
    next();
  });

  /* ---- Creator account ---- */
  app.get("/api/creator/status", h(async (req, res) => {
    const creator = await getCreator();
    const s = verify(getCookie(req, COOKIE));
    const signedIn = !!(s && creator);
    res.json({ setupNeeded: !creator, signedIn, name: signedIn ? creator.name : null, email: signedIn ? creator.email : null });
  }));

  app.post("/api/creator/setup", h(async (req, res) => {
    const name = clean(req.body.name, 60), email = normEmail(req.body.email), password = String(req.body.password || "");
    if (!name) return res.status(400).json({ error: "Enter your name." });
    if (!isEmail(email)) return res.status(400).json({ error: "Enter a valid email." });
    if (password.length < 10) return res.status(400).json({ error: "Use at least 10 characters for your password." });
    try {
      // create() fails if the document already exists, so only the first setup ever succeeds
      await creatorRef().create({ name, email, passwordHash: await bcrypt.hash(password, BCRYPT_ROUNDS), createdAt: now() });
    } catch (e) {
      if (e.code === 6 || /already exists/i.test(e.message)) return res.status(409).json({ error: "The creator account already exists. Sign in instead." });
      throw e;
    }
    await logActivity("creator_setup", { email });
    startSession(req, res);
    res.json({ ok: true });
  }));

  app.post("/api/creator/login", h(async (req, res) => {
    const email = normEmail(req.body.email), password = String(req.body.password || "");
    const key = "creator:" + req.ip;
    if (await tooMany(key)) return res.status(429).json({ error: "Too many tries. Wait 15 minutes, then try again." });
    const creator = await getCreator();
    const match = creator && creator.email === email;
    const ok = await bcrypt.compare(password, match ? creator.passwordHash : DUMMY_HASH);
    if (!match || !ok) { await recordFail(key); return res.status(401).json({ error: "That email or password doesn't match." }); }
    await clearFails(key);
    startSession(req, res);
    res.json({ ok: true });
  }));

  app.post("/api/creator/logout", (req, res) => { setSessionCookie(req, res, "", 0); res.json({ ok: true }); });

  app.post("/api/creator/change-password", requireCreator, h(async (req, res) => {
    const creator = await getCreator();
    if (!(await bcrypt.compare(String(req.body.current || ""), creator.passwordHash)))
      return res.status(400).json({ error: "Your current password is wrong." });
    const next = String(req.body.next || "");
    if (next.length < 10) return res.status(400).json({ error: "Use at least 10 characters for the new password." });
    await creatorRef().update({ passwordHash: await bcrypt.hash(next, BCRYPT_ROUNDS) });
    res.json({ ok: true });
  }));

  /* ---- Clients ---- */
  app.get("/api/creator/clients", requireCreator, h(async (req, res) => {
    res.json({ clients: (await listClients()).map(publicClient) });
  }));

  app.get("/api/creator/stats", requireCreator, h(async (req, res) => {
    const clients = await listClients();
    const weekAgo = new Date(Date.now() - 7 * 864e5).toISOString();
    const recent = (await activityCol().where("at", ">", weekAgo).get()).docs.map(d => d.data());
    res.json({
      total: clients.length,
      active: clients.filter(c => c.status === "active").length,
      suspended: clients.filter(c => c.status === "suspended").length,
      signInsThisWeek: recent.filter(a => a.type === "client_login").length,
      failedThisWeek: recent.filter(a => a.type === "client_login_failed").length
    });
  }));

  async function validateClientFields(body, existingId) {
    const clientName = clean(body.clientName, 80);
    const email = normEmail(body.email);
    const modelNumber = normModel(body.modelNumber);
    const aiName = clean(body.aiName, 40) || "Caz";
    const notes = clean(body.notes, 500);
    if (!clientName) return { error: "Enter the client's name." };
    if (!isEmail(email)) return { error: "Enter a valid email." };
    if (!isModel(modelNumber)) return { error: "Model numbers use 3–32 letters, numbers and dashes." };
    const other = await findByModel(modelNumber);
    if (other && other.id !== existingId) return { error: `Model number ${modelNumber} is already assigned to another client.` };
    return { clientName, email, modelNumber, aiName, notes };
  }

  app.post("/api/creator/clients", requireCreator, h(async (req, res) => {
    const v = await validateClientFields(req.body);
    if (v.error) return res.status(400).json(v);
    const password = String(req.body.password || "") || generatePassword();
    if (password.length < 8) return res.status(400).json({ error: "Client passwords need at least 8 characters." });
    const client = {
      id: crypto.randomUUID(), ...v, status: "active",
      passwordHash: await bcrypt.hash(password, BCRYPT_ROUNDS),
      createdAt: now(), passwordSetAt: now(), lastLoginAt: null, loginCount: 0
    };
    await clientsCol().doc(client.id).set(client);
    await logActivity("client_created", { email: client.email, model: client.modelNumber });
    res.json({ client: publicClient(client), password }); // shown once, never stored in plain text
  }));

  app.patch("/api/creator/clients/:id", requireCreator, h(async (req, res) => {
    const c = await getClient(req.params.id);
    if (!c) return res.status(404).json({ error: "That client no longer exists." });
    const merged = { clientName: c.clientName, email: c.email, modelNumber: c.modelNumber, aiName: c.aiName, notes: c.notes, ...req.body };
    const v = await validateClientFields(merged, c.id);
    if (v.error) return res.status(400).json(v);
    const patch = { ...v };
    if (req.body.status !== undefined) {
      if (!["active", "suspended"].includes(req.body.status)) return res.status(400).json({ error: "Unknown status." });
      if (c.status !== req.body.status)
        await logActivity(req.body.status === "suspended" ? "client_suspended" : "client_activated", { email: c.email, model: c.modelNumber });
      patch.status = req.body.status;
    }
    await clientsCol().doc(c.id).update(patch);
    res.json({ client: publicClient({ ...c, ...patch }) });
  }));

  app.post("/api/creator/clients/:id/reset-password", requireCreator, h(async (req, res) => {
    const c = await getClient(req.params.id);
    if (!c) return res.status(404).json({ error: "That client no longer exists." });
    const password = String(req.body.password || "") || generatePassword();
    if (password.length < 8) return res.status(400).json({ error: "Client passwords need at least 8 characters." });
    const patch = { passwordHash: await bcrypt.hash(password, BCRYPT_ROUNDS), passwordSetAt: now() };
    await clientsCol().doc(c.id).update(patch);
    await logActivity("client_password_reset", { email: c.email, model: c.modelNumber });
    res.json({ client: publicClient({ ...c, ...patch }), password });
  }));

  app.delete("/api/creator/clients/:id", requireCreator, h(async (req, res) => {
    const c = await getClient(req.params.id);
    if (!c) return res.status(404).json({ error: "That client no longer exists." });
    await clientsCol().doc(c.id).delete();
    await logActivity("client_deleted", { email: c.email, model: c.modelNumber });
    res.json({ ok: true });
  }));

  app.get("/api/creator/activity", requireCreator, h(async (req, res) => {
    const limit = Math.min(Number(req.query.limit) || 200, 1000);
    const snap = await activityCol().orderBy("at", "desc").limit(limit).get();
    res.json({ activity: snap.docs.map(d => ({ id: d.id, ...d.data() })) });
  }));

  app.get("/api/creator/export.csv", requireCreator, h(async (req, res) => {
    const cols = ["clientName", "email", "modelNumber", "aiName", "status", "createdAt", "lastLoginAt", "loginCount", "notes"];
    const esc = v => {
      let s = v == null ? "" : String(v);
      if (/^[=+\-@]/.test(s)) s = "'" + s; // stop spreadsheet formula injection
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const clients = await listClients();
    const csv = [cols.join(","), ...clients.map(c => cols.map(k => esc(c[k])).join(","))].join("\n");
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="clients-${now().slice(0, 10)}.csv"`);
    res.send(csv);
  }));

  /* ---- Client sign-in (used by the client portal) ---- */
  app.post("/api/client/login", h(async (req, res) => {
    const modelNumber = normModel(req.body.modelNumber);
    const email = normEmail(req.body.email);
    const password = String(req.body.password || "");
    const key = "client:" + req.ip + ":" + email;
    if (await tooMany(key)) return res.status(429).json({ error: "too_many_attempts" });

    const found = isModel(modelNumber) ? await findByModel(modelNumber) : null;
    const c = found && found.email === email ? found : null;
    const ok = await bcrypt.compare(password, c ? c.passwordHash : DUMMY_HASH);
    if (!c || !ok) {
      await recordFail(key);
      await logActivity("client_login_failed", { email, model: modelNumber, ip: req.ip });
      return res.status(401).json({ error: "invalid" });
    }
    if (c.status !== "active") {
      await logActivity("client_login_blocked", { email, model: modelNumber, ip: req.ip });
      return res.status(403).json({ error: "suspended" });
    }
    await clearFails(key);
    await clientsCol().doc(c.id).update({ lastLoginAt: now(), loginCount: (c.loginCount || 0) + 1 });
    await logActivity("client_login", { email, model: modelNumber, ip: req.ip });
    res.json({ clientName: c.clientName, aiName: c.aiName, token: sign({ role: "client", sub: c.id, exp: Date.now() + 30 * 864e5 }) });
  }));

  app.use("/api", (req, res) => res.status(404).json({ error: "Not found." }));

  // Errors (for example, Firebase not configured) come back as readable JSON
  app.use((err, req, res, next) => {
    console.error(err);
    res.status(500).json({ error: err.message && /Firebase|FIREBASE/.test(err.message) ? err.message : "Server error. Check the server logs." });
  });

  return app;
}

module.exports = { createApp };
