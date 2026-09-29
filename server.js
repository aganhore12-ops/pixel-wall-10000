import express from "express";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import multer from "multer";
import crypto from "crypto";
import path from "path";
import pg from "pg";
import midtransClient from "midtrans-client";
import { createClient } from "@supabase/supabase-js";
import { fileURLToPath } from "url";

const { Pool } = pg;
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const app = express();
const PORT = Number(process.env.PORT || 3000);
const PRICE = Math.max(1, Number(process.env.PIXEL_PRICE_IDR || 1000));
const TOTAL_PIXELS = 10000;
const MAX_UPLOAD = 3 * 1024 * 1024;
const RESERVATION_MINUTES = 15;
const ADMIN_SESSION_MS = 12 * 60 * 60 * 1000;
const ADMIN = process.env.ADMIN_PASSWORD || "";
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || "").replace(/\/$/, "");

if (!process.env.DATABASE_URL) console.warn("WARNING: DATABASE_URL is not configured.");
if (!process.env.MIDTRANS_SERVER_KEY) console.warn("WARNING: MIDTRANS_SERVER_KEY is not configured.");
if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SECRET_KEY) console.warn("WARNING: Supabase Storage is not configured.");
if (!ADMIN) console.warn("WARNING: ADMIN_PASSWORD is not configured.");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes("supabase") ? { rejectUnauthorized: false } : undefined,
  max: Number(process.env.DB_POOL_MAX || 10),
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000
});

const sb = process.env.SUPABASE_URL && process.env.SUPABASE_SECRET_KEY
  ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SECRET_KEY, { auth: { persistSession: false } })
  : null;
const bucket = process.env.SUPABASE_BUCKET || "pixel-assets";
const production = process.env.MIDTRANS_IS_PRODUCTION === "true";
const snap = new midtransClient.Snap({ isProduction: production, serverKey: process.env.MIDTRANS_SERVER_KEY || "" });
const sessions = new Map();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD, files: 1 },
  fileFilter: (_req, file, cb) => cb(
    ["image/png", "image/jpeg", "image/webp"].includes(file.mimetype)
      ? null
      : new Error("Format gambar harus PNG, JPG, atau WEBP.")
  )
});

const origin = PUBLIC_BASE_URL || undefined;
app.disable("x-powered-by");
app.set("trust proxy", 1);
app.use(helmet({
  crossOriginResourcePolicy: { policy: "cross-origin" },
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "https://app.sandbox.midtrans.com", "https://app.midtrans.com"],
      frameSrc: ["'self'", "https://app.sandbox.midtrans.com", "https://app.midtrans.com"],
      imgSrc: ["'self'", "data:", "https:"]
    }
  }
}));
app.use(cors(origin ? { origin } : undefined));
app.use(express.json({ limit: "256kb" }));
app.use(express.urlencoded({ extended: false, limit: "32kb" }));
app.use(express.static(path.join(__dirname, "public"), { maxAge: "1h" }));

const loginLimit = rateLimit({ windowMs: 15 * 60 * 1000, limit: 10, standardHeaders: "draft-8", legacyHeaders: false });
const checkoutLimit = rateLimit({ windowMs: 10 * 60 * 1000, limit: 30, standardHeaders: "draft-8", legacyHeaders: false });
const uploadLimit = rateLimit({ windowMs: 10 * 60 * 1000, limit: 30, standardHeaders: "draft-8", legacyHeaders: false });

const cleanText = (v, max) => String(v ?? "").trim().slice(0, max);
const safeUrl = (value) => {
  const v = cleanText(value, 300);
  if (!v) return "";
  try {
    const u = new URL(v);
    return ["http:", "https:"].includes(u.protocol) ? u.toString() : "";
  } catch { return ""; }
};
const colorValue = (value) => /^#[0-9a-fA-F]{6}$/.test(String(value || "")) ? value : "#d8ff38";
const publicAssetUrl = (objectPath) => {
  if (!sb) return "";
  return sb.storage.from(bucket).getPublicUrl(objectPath).data.publicUrl;
};

async function init() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS orders(
      id TEXT PRIMARY KEY,
      status TEXT NOT NULL CHECK(status IN ('pending','paid','failed','expired')),
      buyer_name TEXT NOT NULL,
      message TEXT DEFAULT '',
      website TEXT DEFAULT '',
      color TEXT DEFAULT '#d8ff38',
      image_url TEXT DEFAULT '',
      amount BIGINT NOT NULL CHECK(amount > 0),
      created_at TIMESTAMPTZ DEFAULT NOW(),
      expires_at TIMESTAMPTZ NOT NULL,
      paid_at TIMESTAMPTZ,
      payment_type TEXT DEFAULT '',
      moderation_status TEXT NOT NULL DEFAULT 'visible' CHECK(moderation_status IN ('visible','hidden'))
    );
    CREATE TABLE IF NOT EXISTS order_pixels(
      order_id TEXT REFERENCES orders(id) ON DELETE CASCADE,
      pixel_id SMALLINT NOT NULL CHECK(pixel_id BETWEEN 0 AND 9999),
      PRIMARY KEY(order_id,pixel_id)
    );
    CREATE TABLE IF NOT EXISTS pixel_claims(
      pixel_id SMALLINT PRIMARY KEY CHECK(pixel_id BETWEEN 0 AND 9999),
      order_id TEXT UNIQUE REFERENCES orders(id) ON DELETE CASCADE,
      expires_at TIMESTAMPTZ NOT NULL
    );
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS moderation_status TEXT NOT NULL DEFAULT 'visible';
    CREATE INDEX IF NOT EXISTS idx_order_pixels_pixel_id ON order_pixels(pixel_id);
    CREATE INDEX IF NOT EXISTS idx_orders_status_expires ON orders(status,expires_at);
    CREATE INDEX IF NOT EXISTS idx_orders_paid_at ON orders(status,paid_at DESC);
    CREATE INDEX IF NOT EXISTS idx_pixel_claims_expires ON pixel_claims(expires_at);
  `);
  if (sb) {
    const { error } = await sb.storage.createBucket(bucket, {
      public: true,
      fileSizeLimit: MAX_UPLOAD,
      allowedMimeTypes: ["image/png", "image/jpeg", "image/webp"]
    });
    if (error && !/already exists|duplicate/i.test(error.message)) console.warn("Storage bucket setup:", error.message);
  }
}

async function clean() {
  await pool.query("UPDATE orders SET status='expired' WHERE status='pending' AND expires_at < NOW()");
  await pool.query("DELETE FROM pixel_claims WHERE expires_at < NOW() OR order_id IN (SELECT id FROM orders WHERE status IN ('failed','expired'))");
}

function admin(req, res, next) {
  const token = req.headers["x-admin-session"];
  const created = token ? sessions.get(token) : null;
  if (!ADMIN || !token || !created || Date.now() - created > ADMIN_SESSION_MS) {
    if (token) sessions.delete(token);
    return res.status(401).json({ error: "Sesi admin tidak valid atau sudah habis." });
  }
  next();
}

app.get("/health", async (_req, res) => {
  try {
    await pool.query("SELECT 1");
    res.json({ ok: true, service: "pixel-wall-10000", version: "7.0.0" });
  } catch { res.status(503).json({ ok: false }); }
});

app.get("/api/config", (_req, res) => res.json({
  clientKey: process.env.MIDTRANS_CLIENT_KEY || "",
  enabled: !!process.env.MIDTRANS_SERVER_KEY,
  production,
  pricePerPixel: PRICE,
  totalPixels: TOTAL_PIXELS,
  reservationMinutes: RESERVATION_MINUTES
}));

app.get("/api/pixels", async (_req, res) => {
  await clean();
  const { rows } = await pool.query(`
    SELECT op.pixel_id,o.color,o.buyer_name
    FROM order_pixels op JOIN orders o ON o.id=op.order_id
    WHERE o.status='paid' AND o.moderation_status='visible'
  `);
  const out = {};
  rows.forEach(x => { out[String(x.pixel_id).padStart(4, "0")] = { status: "sold", color: x.color, buyerName: x.buyer_name }; });
  res.json(out);
});

app.get("/api/stats", async (_req, res) => {
  await clean();
  const { rows: [x] } = await pool.query(`
    SELECT COUNT(*) FILTER(WHERE status='paid') sold,
           COALESCE(SUM(amount) FILTER(WHERE status='paid'),0) revenue
    FROM orders
  `);
  const sold = Number(x.sold) || 0;
  res.json({ total: TOTAL_PIXELS, sold, available: TOTAL_PIXELS - sold, progress: (sold / TOTAL_PIXELS) * 100, revenue: Number(x.revenue) || 0, pricePerPixel: PRICE });
});

app.get("/api/listings", async (_req, res) => {
  const { rows } = await pool.query(`
    SELECT o.id,o.buyer_name AS "buyerName",o.message,o.website,o.image_url AS "imageUrl",o.color,
           COUNT(op.pixel_id)::int AS "pixelCount"
    FROM orders o JOIN order_pixels op ON op.order_id=o.id
    WHERE o.status='paid' AND o.moderation_status='visible'
    GROUP BY o.id ORDER BY o.paid_at DESC LIMIT 50
  `);
  res.json(rows);
});

app.post("/api/upload", uploadLimit, upload.single("image"), async (req, res) => {
  try {
    if (!req.file || !sb) throw Error(!req.file ? "Gambar belum dipilih." : "Supabase Storage belum dikonfigurasi.");
    const ext = req.file.mimetype === "image/png" ? "png" : req.file.mimetype === "image/webp" ? "webp" : "jpg";
    const objectPath = `listings/${Date.now()}-${crypto.randomBytes(8).toString("hex")}.${ext}`;
    const { error } = await sb.storage.from(bucket).upload(objectPath, req.file.buffer, {
      contentType: req.file.mimetype, cacheControl: "31536000", upsert: false
    });
    if (error) throw error;
    res.json({ url: publicAssetUrl(objectPath), path: objectPath });
  } catch (e) { res.status(400).json({ error: e.message || "Upload gagal." }); }
});

app.post("/api/checkout", checkoutLimit, async (req, res) => {
  const c = await pool.connect();
  try {
    const rawIds = req.body?.pixelIds;
    if (!Array.isArray(rawIds) || !rawIds.length || rawIds.length > 2500) throw Error("Area pixel tidak valid.");
    const ids = [...new Set(rawIds.map(Number))];
    if (ids.length !== rawIds.length || ids.some(x => !Number.isInteger(x) || x < 0 || x >= TOTAL_PIXELS)) throw Error("Pixel tidak valid.");
    const buyerName = cleanText(req.body?.buyerName, 80);
    const message = cleanText(req.body?.message, 180);
    const website = safeUrl(req.body?.website);
    const color = colorValue(req.body?.color);
    const imageUrl = cleanText(req.body?.imageUrl, 500);
    if (!buyerName) throw Error("Nama / brand wajib diisi.");
    if (!process.env.MIDTRANS_SERVER_KEY) throw Error("Midtrans belum dikonfigurasi.");
    if (imageUrl && (!sb || !imageUrl.startsWith(publicAssetUrl("")))) throw Error("URL gambar tidak valid.");

    await c.query("BEGIN");
    await c.query("DELETE FROM pixel_claims WHERE expires_at < NOW() OR order_id IN (SELECT id FROM orders WHERE status IN ('failed','expired'))");
    const id = "PW-" + Date.now() + "-" + crypto.randomBytes(4).toString("hex");
    const amount = ids.length * PRICE;
    const expiresAt = new Date(Date.now() + RESERVATION_MINUTES * 60 * 1000);
    await c.query(`INSERT INTO orders(id,status,buyer_name,message,website,color,image_url,amount,expires_at)
      VALUES($1,'pending',$2,$3,$4,$5,$6,$7,$8,$9)`,
      [id, buyerName, message, website, color, imageUrl, amount, expiresAt]);
    for (const n of ids) await c.query("INSERT INTO order_pixels(order_id,pixel_id) VALUES($1,$2)", [id, n]);
    const claimed = await c.query(`
      INSERT INTO pixel_claims(pixel_id,order_id,expires_at)
      SELECT unnest($1::smallint[]),$2,$3
      ON CONFLICT (pixel_id) DO NOTHING
      RETURNING pixel_id
    `, [ids, id, expiresAt]);
    if (claimed.rows.length !== ids.length) {
      const busy = ids.filter(n => !claimed.rows.some(r => Number(r.pixel_id) === n))[0];
      throw Error("Pixel " + String(busy).padStart(4, "0") + " baru saja dipilih orang lain.");
    }
    await c.query("COMMIT");

    try {
      const t = await snap.createTransaction({
        transaction_details: { order_id: id, gross_amount: amount },
        customer_details: { first_name: buyerName }
      });
      res.json({ orderId: id, token: t.token, redirect_url: t.redirect_url });
    } catch (paymentError) {
      await pool.query("UPDATE orders SET status='failed' WHERE id=$1 AND status='pending'", [id]);
      await pool.query("DELETE FROM pixel_claims WHERE order_id=$1", [id]);
      throw paymentError;
    }
  } catch (e) {
    try { await c.query("ROLLBACK"); } catch {}
    res.status(400).json({ error: e.message || "Checkout gagal." });
  } finally { c.release(); }
});

app.post("/api/midtrans/webhook", async (req, res) => {
  try {
    const n = req.body || {};
    const raw = (n.order_id || "") + (n.status_code || "") + (n.gross_amount || "") + (process.env.MIDTRANS_SERVER_KEY || "");
    const expected = crypto.createHash("sha512").update(raw).digest("hex");
    const provided = String(n.signature_key || "");
    if (provided.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(provided))) return res.status(401).json({ error: "Invalid signature" });
    const { rows } = await pool.query("SELECT amount,status FROM orders WHERE id=$1", [n.order_id]);
    if (!rows.length) return res.status(404).json({ error: "Order tidak ditemukan" });
    if (String(rows[0].amount) !== String(n.gross_amount)) return res.status(400).json({ error: "Gross amount mismatch" });

    const paid = ["settlement", "capture"].includes(n.transaction_status) && n.fraud_status !== "deny";
    const failed = ["expire", "cancel", "deny"].includes(n.transaction_status);
    if (paid) await pool.query("UPDATE orders SET status='paid',paid_at=COALESCE(paid_at,NOW()),payment_type=$2 WHERE id=$1 AND status<>'paid'", [n.order_id, cleanText(n.payment_type, 50)]);
    else if (failed) {
      await pool.query("UPDATE orders SET status='failed',payment_type=$2 WHERE id=$1 AND status='pending'", [n.order_id, cleanText(n.payment_type, 50)]);
      await pool.query("DELETE FROM pixel_claims WHERE order_id=$1", [n.order_id]);
    }
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message || "Webhook error" }); }
});

app.get("/api/order/:id", async (req, res) => {
  await clean();
  const id = cleanText(req.params.id, 80);
  const { rows } = await pool.query("SELECT id,status,amount,expires_at FROM orders WHERE id=$1", [id]);
  if (!rows.length) return res.status(404).json({ error: "Order tidak ditemukan" });
  res.json({ ...rows[0], amount: Number(rows[0].amount) });
});

app.post("/api/admin/login", loginLimit, (req, res) => {
  const providedPassword = String(req.body?.password || "");
  const passwordOk = ADMIN && providedPassword.length === ADMIN.length && crypto.timingSafeEqual(Buffer.from(ADMIN), Buffer.from(providedPassword));
  if (!passwordOk) return res.status(401).json({ error: "Password salah" });
  const session = crypto.randomBytes(32).toString("hex");
  sessions.set(session, Date.now());
  res.json({ session, expiresIn: ADMIN_SESSION_MS });
});

app.post("/api/admin/logout", admin, (req, res) => {
  sessions.delete(req.headers["x-admin-session"]);
  res.json({ ok: true });
});

app.get("/api/admin/summary", admin, async (_req, res) => {
  const { rows: [x] } = await pool.query(`SELECT COUNT(*)FILTER(WHERE status='paid')paid_orders,COUNT(*)FILTER(WHERE status='pending')pending_orders,COALESCE(SUM(amount)FILTER(WHERE status='paid'),0)revenue,COUNT(*)FILTER(WHERE status='paid' AND moderation_status='hidden')hidden FROM orders`);
  res.json({ paid: Number(x.paid_orders), pending: Number(x.pending_orders), revenue: Number(x.revenue), hidden: Number(x.hidden) });
});

app.get("/api/admin/orders", admin, async (_req, res) => {
  const { rows } = await pool.query(`SELECT o.id,o.status,o.buyer_name AS "buyerName",o.amount,o.image_url AS "imageUrl",o.moderation_status AS moderation,COUNT(op.pixel_id)::int pixels,o.created_at "createdAt" FROM orders o LEFT JOIN order_pixels op ON op.order_id=o.id GROUP BY o.id ORDER BY o.created_at DESC LIMIT 200`);
  res.json(rows.map(x => ({ ...x, amount: Number(x.amount) })));
});

app.post("/api/admin/order/:id/moderate", admin, async (req, res) => {
  const status = req.body?.status;
  if (!["visible", "hidden"].includes(status)) return res.status(400).json({ error: "Status moderasi invalid" });
  await pool.query("UPDATE orders SET moderation_status=$2 WHERE id=$1 AND status='paid'", [cleanText(req.params.id, 80), status]);
  res.json({ ok: true });
});

app.get("/admin", (_req, res) => res.sendFile(path.join(__dirname, "public/admin.html")));
app.get("/*splat", (_req, res) => res.sendFile(path.join(__dirname, "public/index.html")));

setInterval(() => {
  const now = Date.now();
  for (const [token, created] of sessions) if (now - created > ADMIN_SESSION_MS) sessions.delete(token);
}, 60 * 60 * 1000).unref();

init().then(() => app.listen(PORT, () => console.log(`Pixel Wall 10K Final listening on ${PORT}`))).catch(e => { console.error(e); process.exit(1); });
