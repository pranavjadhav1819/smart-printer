// Smart Print server: upload -> page count -> price -> pay -> verified payment -> print queue
require('dotenv').config();
const express = require('express');
const multer = require('multer');
const { PDFDocument } = require('pdf-lib');
const QRCode = require('qrcode');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const PORT = process.env.PORT || 3000;
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;
const PAYMENT_MODE = process.env.PAYMENT_MODE || 'mock'; // 'mock' (demo) or 'razorpay'
const OWNER_PIN = process.env.OWNER_PIN || '1234';
const AGENT_TOKEN = process.env.AGENT_TOKEN || 'change-me-agent-token';
const { RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET, RAZORPAY_WEBHOOK_SECRET } = process.env;
const RZP_API = process.env.RAZORPAY_API_BASE || 'https://api.razorpay.com';
const UNPAID_EXPIRY_MS = 15 * 60 * 1000; // unpaid orders expire after 15 minutes
const FILE_TTL_MS = 2 * 60 * 60 * 1000; // files are deleted at most 2 hours after upload

// ---------- tiny JSON "database" (swap for Postgres/Supabase when you go multi-shop) ----------
const DATA_DIR = path.join(__dirname, 'data');
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
const DB_FILE = path.join(DATA_DIR, 'db.json');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });
const db = fs.existsSync(DB_FILE)
  ? JSON.parse(fs.readFileSync(DB_FILE, 'utf8'))
  : { shops: { shop1: { name: 'My Print Shop', rates: { bw: 2, color: 10 } } }, uploads: {}, orders: {} };
db.shops.shop1.agentToken = AGENT_TOKEN;
const save = () => fs.writeFileSync(DB_FILE, JSON.stringify(db));
const runtime = {}; // shopId -> { printers, lastSeen } reported by the shop agent
const isOnline = (shopId) => runtime[shopId] && Date.now() - runtime[shopId].lastSeen < 15000;
const newId = () => crypto.randomBytes(12).toString('hex');
const filePath = (id) => path.join(UPLOAD_DIR, id + '.pdf');
const deleteFile = (id) => fs.rmSync(filePath(id), { force: true });
const safeEqual = (a, b) =>
  typeof b === 'string' && a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));

// ---------- file handling: everything becomes one PDF so pages can be counted exactly ----------
function convertWithLibreOffice(file) {
  return new Promise((resolve, reject) => {
    const dir = fs.mkdtempSync(path.join(DATA_DIR, 'conv-'));
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

// CORS: lets the page hosted elsewhere (for example Vercel) call this server. Set ALLOWED_ORIGIN to that page's address.
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGIN || '').split(',').map((o) => o.trim().replace(/\/$/, '')).filter(Boolean);
app.use((req, res, next) => {
  const origin = req.get('origin');
  if (origin && ALLOWED_ORIGINS.includes(origin)) {
    res.set({ 'Access-Control-Allow-Origin': origin, Vary: 'Origin', 'Access-Control-Allow-Headers': 'Content-Type, x-owner-pin', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS' });
    if (req.method === 'OPTIONS') return res.sendStatus(204);
  }
  next();
});

// Razorpay webhook must read the raw body, so it is registered before express.json()
app.post('/api/razorpay/webhook', express.raw({ type: '*/*' }), (req, res) => {
  const expected = crypto.createHmac('sha256', RAZORPAY_WEBHOOK_SECRET || '').update(req.body).digest('hex');
  if (!RAZORPAY_WEBHOOK_SECRET || !safeEqual(expected, req.get('x-razorpay-signature'))) return res.sendStatus(400);
  const evt = JSON.parse(req.body.toString());
  if (evt.event === 'payment.captured' || evt.event === 'order.paid') {
    const pay = evt.payload.payment && evt.payload.payment.entity;
    const rzpOrderId = (pay && pay.order_id) || (evt.payload.order && evt.payload.order.entity.id);
    const order = Object.values(db.orders).find((o) => o.rzpOrderId === rzpOrderId);
    if (order && pay && pay.amount === order.amount) markPaid(order, pay.id);
  }
  res.sendStatus(200);
});

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.get('/', (req, res) => res.redirect('/s/shop1'));
app.get('/s/:shopId', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.get('/api/qr/:shopId', async (req, res) => {
  if (!db.shops[req.params.shopId]) return res.sendStatus(404);
  res.type('png');
  await QRCode.toFileStream(res, `${BASE_URL}/s/${req.params.shopId}`, { width: 420, margin: 2 });
});

app.get('/api/shops/:shopId', (req, res) => {
  const shop = db.shops[req.params.shopId];
  if (!shop) return res.status(404).json({ error: 'Shop not found' });
  const rt = runtime[req.params.shopId];
  res.json({ name: shop.name, rates: shop.rates, online: !!isOnline(req.params.shopId), printers: rt ? rt.printers : [] });
});

// Step 1: upload files, get the exact page count
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024, files: 10 } });
app.post('/api/upload', upload.array('files', 10), async (req, res) => {
  try {
    const shopId = req.body.shopId;
    if (!db.shops[shopId]) return res.status(404).json({ error: 'Shop not found' });
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
    fs.writeFileSync(filePath(uploadId), await merged.save());
    db.uploads[uploadId] = { shopId, pages, createdAt: Date.now() };
    save();
    res.json({ uploadId, pages });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// Step 2: the SERVER calculates the price (never trust the browser), then creates the payment
app.post('/api/orders', async (req, res) => {
  try {
    const { uploadId, shopId, printer } = req.body;
    const shop = db.shops[shopId], up = db.uploads[uploadId];
    if (!shop || !up || up.shopId !== shopId || !fs.existsSync(filePath(uploadId))) return res.status(400).json({ error: 'Upload expired. Please add your files again.' });
    if (!isOnline(shopId)) return res.status(400).json({ error: 'This shop is offline right now. Please try again in a few minutes.' });
    let order = db.orders[uploadId];
    if (!order || order.status === 'awaiting_payment') {
      // Options (and therefore the price) may change until the customer has paid
      const mode = req.body.mode === 'color' ? 'color' : 'bw';
      const copies = Math.min(Math.max(parseInt(req.body.copies, 10) || 1, 1), 100);
      const printers = runtime[shopId].printers;
      order = order || { id: uploadId, shopId, status: 'awaiting_payment', createdAt: Date.now() };
      Object.assign(order, {
        pages: up.pages, mode, copies,
        sides: req.body.sides === 'double' ? 'double' : 'single',
        printer: printers.includes(printer) ? printer : printers[0],
        amount: Math.max(100, Math.round(up.pages * copies * shop.rates[mode] * 100)), // paise
      });
      if (PAYMENT_MODE === 'razorpay' && order.rzpAmount !== order.amount) { // new gateway order whenever the amount changes
        const r = await fetch(`${RZP_API}/v1/orders`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: 'Basic ' + Buffer.from(`${RAZORPAY_KEY_ID}:${RAZORPAY_KEY_SECRET}`).toString('base64') },
          body: JSON.stringify({ amount: order.amount, currency: 'INR', receipt: order.id }),
        });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) {
          console.error('[razorpay] create order failed:', r.status, j.error && j.error.description);
          throw Object.assign(new Error(r.status === 401 ? 'Payments are not set up correctly on the server. Please tell the shop owner.' : 'Payment could not be started. Try again.'), { status: r.status === 401 ? 401 : 500 });
        }
        order.rzpOrderId = j.id; order.rzpAmount = order.amount;
      }
      db.orders[order.id] = order; save();
    }
    res.json({ orderId: order.id, pages: order.pages, amount: order.amount, payment: PAYMENT_MODE, key: RAZORPAY_KEY_ID, rzpOrderId: order.rzpOrderId });
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// Payment confirmed -> queue for printing. Idempotent: a duplicate confirmation can never print twice.
function markPaid(order, paymentId) {
  if (!['awaiting_payment', 'expired'].includes(order.status)) return false;
  order.status = fs.existsSync(filePath(order.id)) ? 'queued' : 'paid_needs_refund';
  order.paymentId = paymentId; order.paidAt = Date.now(); save();
  return true;
}

app.get('/api/orders/:id', (req, res) => {
  const o = db.orders[req.params.id];
  if (!o) return res.status(404).json({ error: 'Order not found' });
  res.json({ status: o.status, pages: o.pages, amount: o.amount, printer: o.printer });
});

// Demo payments (PAYMENT_MODE=mock only)
app.post('/api/orders/:id/mock-pay', (req, res) => {
  const o = db.orders[req.params.id];
  if (PAYMENT_MODE !== 'mock' || !o) return res.sendStatus(404);
  if (!req.body.success) return res.json({ ok: false });
  markPaid(o, 'mock_' + newId().slice(0, 8));
  res.json({ ok: true });
});

// Razorpay Checkout success callback: verify the signature on the server
app.post('/api/orders/:id/verify', (req, res) => {
  const o = db.orders[req.params.id];
  if (!o || !o.rzpOrderId) return res.sendStatus(404);
  const { razorpay_payment_id: pid, razorpay_order_id: oid, razorpay_signature: sig } = req.body || {};
  if (!pid || !oid || !sig) return res.status(400).json({ error: 'Missing payment details' });
  const expected = crypto.createHmac('sha256', RAZORPAY_KEY_SECRET || '').update(o.rzpOrderId + '|' + pid).digest('hex');
  if (oid !== o.rzpOrderId || !safeEqual(expected, sig)) return res.status(400).json({ error: 'Payment could not be verified' });
  markPaid(o, pid);
  res.json({ ok: true });
});

// ---------- shop agent API (the program running on the shop PC) ----------
function agentAuth(req, res, next) {
  const token = (req.get('authorization') || '').replace('Bearer ', '');
  const shopId = Object.keys(db.shops).find((k) => db.shops[k].agentToken === token);
  if (!token || !shopId) return res.sendStatus(401);
  req.shopId = shopId; next();
}
app.post('/api/agent/heartbeat', agentAuth, (req, res) => {
  runtime[req.shopId] = { printers: (req.body.printers || []).slice(0, 20).map(String), lastSeen: Date.now() };
  const job = Object.values(db.orders).filter((o) => o.shopId === req.shopId && o.status === 'queued').sort((a, b) => a.paidAt - b.paidAt)[0];
  if (job) { job.status = 'printing'; job.printStartedAt = Date.now(); save(); }
  res.json({ job: job && { id: job.id, printer: job.printer, copies: job.copies, sides: job.sides, mode: job.mode } });
});
app.get('/api/agent/file/:id', agentAuth, (req, res) => {
  const o = db.orders[req.params.id];
  if (!o || o.shopId !== req.shopId || o.status !== 'printing') return res.sendStatus(404);
  res.sendFile(filePath(o.id));
});
app.post('/api/agent/done/:id', agentAuth, (req, res) => {
  const o = db.orders[req.params.id];
  if (!o || o.shopId !== req.shopId) return res.sendStatus(404);
  if (req.body.ok) { o.status = 'done'; o.doneAt = Date.now(); deleteFile(o.id); } // privacy: file removed right after printing
  else { o.status = 'print_failed'; o.error = String(req.body.error || 'Unknown printer error').slice(0, 200); }
  save(); res.sendStatus(200);
});

// ---------- owner API (protected by OWNER_PIN) ----------
const ownerAuth = (req, res, next) => (req.get('x-owner-pin') === OWNER_PIN ? next() : res.sendStatus(401));
app.get('/api/admin/summary', ownerAuth, (req, res) => {
  const shopId = 'shop1', shop = db.shops[shopId];
  const orders = Object.values(db.orders).filter((o) => o.shopId === shopId).sort((a, b) => b.createdAt - a.createdAt).slice(0, 50);
  const today = new Date().setHours(0, 0, 0, 0);
  const earned = orders.filter((o) => o.status === 'done' && o.paidAt >= today).reduce((s, o) => s + o.amount, 0);
  res.json({ shopId, name: shop.name, rates: shop.rates, online: !!isOnline(shopId), printers: runtime[shopId] ? runtime[shopId].printers : [], earnedToday: earned, orders });
});
app.post('/api/admin/rates', ownerAuth, (req, res) => {
  const bw = Number(req.body.bw), color = Number(req.body.color);
  if (!(bw >= 0) || !(color >= 0)) return res.status(400).json({ error: 'Rates must be numbers' });
  db.shops.shop1.rates = { bw, color }; save(); res.json({ ok: true });
});
app.post('/api/admin/reprint/:id', ownerAuth, (req, res) => {
  const o = db.orders[req.params.id];
  if (!o || o.status !== 'print_failed' || !fs.existsSync(filePath(o.id))) return res.status(400).json({ error: 'Cannot reprint this order' });
  o.status = 'queued'; o.paidAt = Date.now(); save(); res.json({ ok: true });
});

// ---------- housekeeping: expire unpaid orders, unstick jobs, delete old files ----------
setInterval(() => {
  const now = Date.now();
  for (const o of Object.values(db.orders)) {
    if (o.status === 'awaiting_payment' && now - o.createdAt > UNPAID_EXPIRY_MS) o.status = 'expired';
    if (o.status === 'printing' && now - o.printStartedAt > 5 * 60 * 1000) { o.status = 'print_failed'; o.error = 'Printer did not respond'; }
  }
  for (const [id, u] of Object.entries(db.uploads)) {
    const o = db.orders[id];
    if ((o && o.status === 'done') || now - u.createdAt > FILE_TTL_MS) { deleteFile(id); delete db.uploads[id]; }
  }
  save();
}, 60 * 1000).unref();

if (require.main === module) {
  if (PAYMENT_MODE === 'razorpay' && !(RAZORPAY_KEY_ID && RAZORPAY_KEY_SECRET)) {
    console.error('PAYMENT_MODE=razorpay but RAZORPAY_KEY_ID or RAZORPAY_KEY_SECRET is missing. Add both to .env (or your host\'s environment variables).');
    process.exit(1);
  }
  app.listen(PORT, () => console.log(`Smart Print running at ${BASE_URL}  (payments: ${PAYMENT_MODE})`));
}
module.exports = app;
