// Smart Print server: upload -> page count -> price -> pay -> verified payment -> print queue
require('dotenv').config();
const express = require('express');
const multer = require('multer');
const { PDFDocument } = require('pdf-lib');
const QRCode = require('qrcode');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const util = require('util');
const { execFile } = require('child_process');
const store = require('./db');

const PORT = process.env.PORT || 3000;
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;
const PAYMENT_MODE = process.env.PAYMENT_MODE || 'mock'; // 'mock' (demo) or 'razorpay'
const SIGNUP_CODE = process.env.SIGNUP_CODE || ''; // if set, creating a shop account needs this invitation code
const SESSION_MS = 14 * 24 * 60 * 60 * 1000; // owner logins last 14 days
const { RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET, RAZORPAY_WEBHOOK_SECRET } = process.env;
const RZP_API = process.env.RAZORPAY_API_BASE || 'https://api.razorpay.com';
const UNPAID_EXPIRY_MS = 15 * 60 * 1000; // unpaid orders expire after 15 minutes
const FILE_TTL_MS = 2 * 60 * 60 * 1000; // files are deleted at most 2 hours after upload

const runtime = {}; // shopId -> { printers, lastSeen } reported by the shop agent (live status, not stored)
const isOnline = (shopId) => runtime[shopId] && Date.now() - runtime[shopId].lastSeen < 15000;
const newId = () => crypto.randomBytes(12).toString('hex');
const safeEqual = (a, b) =>
  typeof b === 'string' && a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
const sha256 = (text) => crypto.createHash('sha256').update(text).digest('hex');
const bearer = (req) => (req.get('authorization') || '').replace(/^Bearer /, '');

// ---------- passwords (scrypt, built into Node) and login attempt limits ----------
const scrypt = util.promisify(crypto.scrypt);
async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  return `scrypt$${salt.toString('hex')}$${(await scrypt(password, salt, 64)).toString('hex')}`;
}
async function checkPassword(password, stored) {
  const [, saltHex, keyHex] = stored.split('$');
  const key = await scrypt(password, Buffer.from(saltHex, 'hex'), 64);
  return crypto.timingSafeEqual(key, Buffer.from(keyHex, 'hex'));
}
const dummyHash = hashPassword('not-a-real-password'); // used so unknown emails take as long as real ones
const attempts = new Map(); // "login:ip" -> { n, reset }
function rateLimited(key, max) {
  const now = Date.now(), a = attempts.get(key);
  if (!a || a.reset < now) { attempts.set(key, { n: 1, reset: now + 15 * 60 * 1000 }); return false; }
  return ++a.n > max;
}

// ---------- file handling: everything becomes one PDF so pages can be counted exactly ----------
function convertWithLibreOffice(file) {
  return new Promise((resolve, reject) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'conv-'));
    const ext = path.extname(file.originalname).toLowerCase();
    fs.writeFileSync(path.join(dir, 'in' + ext), file.buffer);
    execFile(process.env.SOFFICE_PATH || 'soffice',
      ['--headless', '--convert-to', 'pdf', '--outdir', dir, path.join(dir, 'in' + ext)],
      { timeout: 60000 },
      (err) => {
        try {
          if (err) throw new Error('Word/PowerPoint files need LibreOffice installed on the server. Upload a PDF instead.');
          resolve(fs.readFileSync(path.join(dir, 'in.pdf')));
        } catch (e) { reject(e); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
      });
  });
}

async function toPdfBytes(file) {
  const ext = path.extname(file.originalname).toLowerCase();
  if (ext === '.pdf') return file.buffer;
  if (['.jpg', '.jpeg', '.png'].includes(ext)) {
    const pdf = await PDFDocument.create();
    const img = ext === '.png' ? await pdf.embedPng(file.buffer) : await pdf.embedJpg(file.buffer);
    const page = pdf.addPage([595.28, 841.89]); // A4
    const s = Math.min(555 / img.width, 800 / img.height); // fit inside margins
    const w = img.width * s, h = img.height * s;
    page.drawImage(img, { x: (595.28 - w) / 2, y: (841.89 - h) / 2, width: w, height: h });
    return pdf.save();
  }
  if (['.doc', '.docx', '.ppt', '.pptx', '.odt', '.txt'].includes(ext)) return convertWithLibreOffice(file);
  throw new Error(`${ext || 'This'} file type is not supported. Use PDF, JPG, PNG, DOCX or PPTX.`);
}

// ---------- app ----------
const app = express();
app.set('trust proxy', 1); // Render and Vercel sit behind a proxy, so req.ip is the real visitor

// CORS: lets the page hosted elsewhere (for example Vercel) call this server. Set ALLOWED_ORIGIN to that page's address.
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGIN || '').split(',').map((o) => o.trim().replace(/\/$/, '')).filter(Boolean);
app.use((req, res, next) => {
  const origin = req.get('origin');
  if (origin && ALLOWED_ORIGINS.includes(origin)) {
    res.set({ 'Access-Control-Allow-Origin': origin, Vary: 'Origin', 'Access-Control-Allow-Headers': 'Content-Type, Authorization', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS' });
    if (req.method === 'OPTIONS') return res.sendStatus(204);
  }
  next();
});

// Razorpay webhook must read the raw body, so it is registered before express.json()
app.post('/api/razorpay/webhook', express.raw({ type: '*/*' }), async (req, res) => {
  const expected = crypto.createHmac('sha256', RAZORPAY_WEBHOOK_SECRET || '').update(req.body).digest('hex');
  if (!RAZORPAY_WEBHOOK_SECRET || !safeEqual(expected, req.get('x-razorpay-signature'))) return res.sendStatus(400);
  const evt = JSON.parse(req.body.toString());
  if (evt.event === 'payment.captured' || evt.event === 'order.paid') {
    const pay = evt.payload.payment && evt.payload.payment.entity;
    const rzpOrderId = (pay && pay.order_id) || (evt.payload.order && evt.payload.order.entity.id);
    const order = rzpOrderId && (await store.findOrderByRzpId(rzpOrderId));
    if (order && pay && pay.amount === order.amount) await store.markPaid(order.id, pay.id);
  }
  res.sendStatus(200);
});

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.get('/api/health', (req, res) => res.json({ ok: true }));
app.get('/s/:shopId', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.get('/api/qr/:shopId', async (req, res) => {
  if (!(await store.getShop(req.params.shopId))) return res.sendStatus(404);
  res.type('png');
  await QRCode.toFileStream(res, `${BASE_URL}/s/${req.params.shopId}`, { width: 420, margin: 2 });
});

app.get('/api/shops/:shopId', async (req, res) => {
  const shop = await store.getShop(req.params.shopId);
  if (!shop) return res.status(404).json({ error: 'Shop not found' });
  const rt = runtime[shop.id];
  res.json({ name: shop.name, rates: shop.rates, online: !!isOnline(shop.id), printers: rt ? rt.printers : [] });
});

// Step 1: upload files, get the exact page count
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024, files: 10 } });
app.post('/api/upload', upload.array('files', 10), async (req, res) => {
  try {
    const shopId = req.body.shopId;
    if (!(await store.getShop(shopId))) return res.status(404).json({ error: 'Shop not found' });
    if (!req.files || !req.files.length) return res.status(400).json({ error: 'Choose at least one file' });
    const merged = await PDFDocument.create();
    for (const f of req.files) {
      let src;
      try { src = await PDFDocument.load(await toPdfBytes(f)); }
      catch (e) { throw new Error(e.message.includes('not supported') || e.message.includes('LibreOffice') ? e.message : `Could not read "${f.originalname}". Check the file and try again.`); }
      (await merged.copyPages(src, src.getPageIndices())).forEach((p) => merged.addPage(p));
    }
    const pages = merged.getPageCount();
    if (pages > 300) throw new Error('Too many pages in one order (limit 300)');
    const uploadId = newId();
    await store.createUpload(uploadId, shopId, pages, Buffer.from(await merged.save()));
    res.json({ uploadId, pages });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// Step 2: the SERVER calculates the price (never trust the browser), then creates the payment
app.post('/api/orders', async (req, res) => {
  try {
    const { uploadId, shopId, printer } = req.body;
    const shop = await store.getShop(shopId), up = await store.getUpload(uploadId);
    if (!shop || !up || up.shopId !== shopId) return res.status(400).json({ error: 'Upload expired. Please add your files again.' });
    if (!isOnline(shopId)) return res.status(400).json({ error: 'This shop is offline right now. Please try again in a few minutes.' });
    let order = await store.getOrder(uploadId);
    if (!order || order.status === 'awaiting_payment') {
      // Options (and therefore the price) may change until the customer has paid
      const mode = req.body.mode === 'color' ? 'color' : 'bw';
      const copies = Math.min(Math.max(parseInt(req.body.copies, 10) || 1, 1), 100);
      const printers = runtime[shopId].printers;
      const o = {
        id: uploadId, shopId, pages: up.pages, mode, copies,
        sides: req.body.sides === 'double' ? 'double' : 'single',
        printer: printers.includes(printer) ? printer : printers[0] || null,
        amount: Math.max(100, Math.round(up.pages * copies * shop.rates[mode] * 100)), // paise
        rzpOrderId: order && order.rzpOrderId, rzpAmount: order && order.rzpAmount,
      };
      if (PAYMENT_MODE === 'razorpay' && o.rzpAmount !== o.amount) { // new gateway order whenever the amount changes
        const r = await fetch(`${RZP_API}/v1/orders`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: 'Basic ' + Buffer.from(`${RAZORPAY_KEY_ID}:${RAZORPAY_KEY_SECRET}`).toString('base64') },
          body: JSON.stringify({ amount: o.amount, currency: 'INR', receipt: o.id }),
        });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) {
          console.error('[razorpay] create order failed:', r.status, j.error && j.error.description);
          throw Object.assign(new Error(r.status === 401 ? 'Payments are not set up correctly on the server. Please tell the shop owner.' : 'Payment could not be started. Try again.'), { status: r.status === 401 ? 401 : 500 });
        }
        o.rzpOrderId = j.id; o.rzpAmount = o.amount;
      }
      order = await store.upsertOrder(o);
    }
    res.json({ orderId: order.id, pages: order.pages, amount: order.amount, payment: PAYMENT_MODE, key: RAZORPAY_KEY_ID, rzpOrderId: order.rzpOrderId });
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

app.get('/api/orders/:id', async (req, res) => {
  const o = await store.getOrder(req.params.id);
  if (!o) return res.status(404).json({ error: 'Order not found' });
  res.json({ status: o.status, pages: o.pages, amount: o.amount, printer: o.printer });
});

// Demo payments (PAYMENT_MODE=mock only)
app.post('/api/orders/:id/mock-pay', async (req, res) => {
  const o = await store.getOrder(req.params.id);
  if (PAYMENT_MODE !== 'mock' || !o) return res.sendStatus(404);
  if (!req.body.success) return res.json({ ok: false });
  await store.markPaid(o.id, 'mock_' + newId().slice(0, 8));
  res.json({ ok: true });
});

// Razorpay Checkout success callback: verify the signature on the server, then queue the job (idempotent)
app.post('/api/orders/:id/verify', async (req, res) => {
  const o = await store.getOrder(req.params.id);
  if (!o || !o.rzpOrderId) return res.sendStatus(404);
  const { razorpay_payment_id: pid, razorpay_order_id: oid, razorpay_signature: sig } = req.body || {};
  if (!pid || !oid || !sig) return res.status(400).json({ error: 'Missing payment details' });
  const expected = crypto.createHmac('sha256', RAZORPAY_KEY_SECRET || '').update(o.rzpOrderId + '|' + pid).digest('hex');
  if (oid !== o.rzpOrderId || !safeEqual(expected, sig)) return res.status(400).json({ error: 'Payment could not be verified' });
  await store.markPaid(o.id, pid);
  res.json({ ok: true });
});

// ---------- shop agent API (the program running on the shop PC) ----------
async function agentAuth(req, res, next) {
  const token = (req.get('authorization') || '').replace('Bearer ', '');
  const shopId = token && (await store.shopByToken(token));
  if (!shopId) return res.sendStatus(401);
  req.shopId = shopId; next();
}
app.post('/api/agent/heartbeat', agentAuth, async (req, res) => {
  runtime[req.shopId] = { printers: ((req.body && req.body.printers) || []).slice(0, 20).map(String), lastSeen: Date.now() };
  res.json({ job: await store.claimNextJob(req.shopId) });
});
app.get('/api/agent/file/:id', agentAuth, async (req, res) => {
  const o = await store.getOrder(req.params.id);
  if (!o || o.shopId !== req.shopId || o.status !== 'printing') return res.sendStatus(404);
  const data = await store.getUploadData(o.id);
  if (!data) return res.sendStatus(404);
  res.type('application/pdf').send(data);
});
app.post('/api/agent/done/:id', agentAuth, async (req, res) => {
  const o = await store.getOrder(req.params.id);
  if (!o || o.shopId !== req.shopId) return res.sendStatus(404);
  await store.finishOrder(o.id, !!req.body.ok, req.body.error);
  res.sendStatus(200);
});

// ---------- owner accounts: sign up, log in, log out ----------
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const slugify = (text) => text.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24) || 'shop';
const isDuplicate = (e) => e.code === '23505' || /duplicate key|unique constraint/i.test(e.message || '');
async function startSession(userId) {
  const token = crypto.randomBytes(32).toString('hex'); // only its hash is stored
  await store.createSession(sha256(token), userId, Date.now() + SESSION_MS);
  return token;
}

app.post('/api/auth/register', async (req, res) => {
  if (rateLimited('register:' + req.ip, 10)) return res.status(429).json({ error: 'Too many attempts. Try again in a few minutes.' });
  const body = req.body || {};
  const email = String(body.email || '').trim().toLowerCase(), password = String(body.password || ''), shopName = String(body.shopName || '').trim();
  if (SIGNUP_CODE && !safeEqual(SIGNUP_CODE, body.signupCode)) return res.status(403).json({ error: 'Invalid invitation code' });
  if (!EMAIL_RE.test(email) || email.length > 254) return res.status(400).json({ error: 'Enter a valid email address' });
  if (password.length < 8 || password.length > 200) return res.status(400).json({ error: 'Password must be at least 8 characters' });
  if (shopName.length < 2 || shopName.length > 60) return res.status(400).json({ error: 'Shop name must be 2 to 60 characters' });
  const shopId = `${slugify(shopName)}-${crypto.randomBytes(2).toString('hex')}`;
  try {
    await store.registerOwner({ userId: newId(), email, passwordHash: await hashPassword(password), shopId, shopName, agentToken: crypto.randomBytes(24).toString('hex') });
  } catch (e) {
    if (isDuplicate(e)) return res.status(409).json({ error: 'An account with this email already exists. Log in instead.' });
    throw e;
  }
  const user = await store.getUserByEmail(email);
  res.status(201).json({ token: await startSession(user.id), shop: { id: shopId, name: shopName } });
});

app.post('/api/auth/login', async (req, res) => {
  if (rateLimited('login:' + req.ip, 20)) return res.status(429).json({ error: 'Too many attempts. Try again in a few minutes.' });
  const body = req.body || {};
  const user = await store.getUserByEmail(String(body.email || '').trim().toLowerCase());
  const ok = await checkPassword(String(body.password || ''), user ? user.passwordHash : await dummyHash);
  if (!user || !ok) return res.status(401).json({ error: 'Wrong email or password' });
  res.json({ token: await startSession(user.id) });
});

app.post('/api/auth/logout', async (req, res) => {
  const token = bearer(req);
  if (token) await store.deleteSession(sha256(token));
  res.json({ ok: true });
});

async function requireOwner(req, res, next) {
  const token = bearer(req);
  const user = token && (await store.sessionUser(sha256(token)));
  if (!user) return res.sendStatus(401);
  const shop = await store.shopForOwner(user.id);
  if (!shop) return res.sendStatus(403);
  req.user = user; req.shop = shop; next();
}

// ---------- owner dashboard API (everything is limited to the logged-in owner's own shop) ----------
app.get('/api/admin/summary', requireOwner, async (req, res) => {
  const { shop } = req;
  res.json({
    email: req.user.email, shopId: shop.id, name: shop.name, rates: shop.rates, agentToken: shop.agentToken,
    customerUrl: `${BASE_URL}/s/${shop.id}`, online: !!isOnline(shop.id), printers: runtime[shop.id] ? runtime[shop.id].printers : [],
    earnedToday: await store.earnedToday(shop.id, new Date().setHours(0, 0, 0, 0)),
    orders: await store.listOrders(shop.id, 50),
  });
});
app.post('/api/admin/rates', requireOwner, async (req, res) => {
  const bw = Number(req.body.bw), color = Number(req.body.color);
  if (!(bw >= 0) || !(color >= 0)) return res.status(400).json({ error: 'Rates must be numbers' });
  await store.setRates(req.shop.id, bw, color);
  res.json({ ok: true });
});
app.post('/api/admin/reprint/:id', requireOwner, async (req, res) => {
  if (!(await store.reprint(req.params.id, req.shop.id))) return res.status(400).json({ error: 'Cannot reprint this order' });
  res.json({ ok: true });
});
app.post('/api/admin/agent-token', requireOwner, async (req, res) => { // use if the token leaks; the old one stops working at once
  const agentToken = crypto.randomBytes(24).toString('hex');
  await store.setAgentToken(req.shop.id, agentToken);
  res.json({ agentToken });
});

// ---------- errors ----------
app.use((err, req, res, next) => {
  if (err.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: 'A file is too large (limit 25 MB each)' });
  if (err.code && String(err.code).startsWith('LIMIT_')) return res.status(400).json({ error: 'Too many files in one order' });
  console.error('[error]', err);
  res.status(500).json({ error: 'Something went wrong. Please try again.' });
});

// ---------- start ----------
async function start() {
  await store.init();
  setInterval(
    () => { for (const [k, v] of attempts) if (v.reset < Date.now()) attempts.delete(k); return store.sweep({ unpaidMs: UNPAID_EXPIRY_MS, ttlMs: FILE_TTL_MS, stuckMs: 5 * 60 * 1000 }).catch((e) => console.error('[sweep]', e.message)); },
    60 * 1000).unref();
  app.listen(PORT, () => console.log(`Smart Print running at ${BASE_URL}  (payments: ${PAYMENT_MODE})`));
}

if (require.main === module) {
  if (PAYMENT_MODE === 'razorpay' && !(RAZORPAY_KEY_ID && RAZORPAY_KEY_SECRET)) {
    console.error('PAYMENT_MODE=razorpay but RAZORPAY_KEY_ID or RAZORPAY_KEY_SECRET is missing. Add both to .env (or your host\'s environment variables).');
    process.exit(1);
  }
  start().catch((e) => { console.error('Could not start:', e.message); process.exit(1); });
}
module.exports = app;
