// End-to-end check: starts the server + agent (dry run), uploads files, pays (mock), waits for the print.
const { spawn } = require('child_process');
const { PDFDocument } = require('pdf-lib');
const fs = require('fs');
const assert = require('assert');
const env = { ...process.env, PORT: '3111', BASE_URL: 'http://localhost:3111', SERVER_URL: 'http://localhost:3111', PAYMENT_MODE: 'mock', DRY_RUN: '1', AGENT_TOKEN: 'test-token', ALLOWED_ORIGIN: 'https://shop.example.app', OWNER_PIN: '9999' };
const B = 'http://localhost:3111';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const post = (u, json, h = {}) => fetch(B + u, { method: 'POST', headers: { 'Content-Type': 'application/json', ...h }, body: JSON.stringify(json) });
(async () => {
  fs.rmSync('data', { recursive: true, force: true }); fs.rmSync('printed', { recursive: true, force: true });
  const server = spawn('node', ['server.js'], { env, stdio: 'inherit' });
  const agent = spawn('node', ['agent/agent.js'], { env, stdio: 'inherit' });
  try {
    for (let i = 0; i < 30; i++) { try { if ((await (await fetch(B + '/api/shops/shop1')).json()).online) break; } catch (e) {} await sleep(500); }
    const pdf = await PDFDocument.create(); for (let i = 0; i < 3; i++) pdf.addPage();
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
    const fd = new FormData(); fd.append('shopId', 'shop1');
    fd.append('files', new Blob([await pdf.save()]), 'a.pdf'); fd.append('files', new Blob([png]), 'b.png');
    const up = await (await fetch(B + '/api/upload', { method: 'POST', body: fd })).json();
    assert.equal(up.pages, 4, 'page count (3 pdf pages + 1 image)');
    const o = await (await post('/api/orders', { uploadId: up.uploadId, shopId: 'shop1', mode: 'color', sides: 'single', copies: 2 })).json();
    assert.equal(o.amount, 4 * 2 * 10 * 100, 'server price: 8 pages x Rs10');
    const bw = await (await post('/api/orders', { uploadId: up.uploadId, shopId: 'shop1', mode: 'bw', sides: 'single', copies: 1 })).json();
    assert.equal(bw.amount, 4 * 1 * 2 * 100, 'changing to black and white re-prices: 4 pages x Rs2');
    const col = await (await post('/api/orders', { uploadId: up.uploadId, shopId: 'shop1', mode: 'color', sides: 'single', copies: 2 })).json();
    assert.equal(col.amount, 8000, 'changing back to colour re-prices');
    assert.equal((await post(`/api/orders/${o.orderId}/mock-pay`, { success: false })).status, 200);
    assert.equal((await (await fetch(`${B}/api/orders/${o.orderId}`)).json()).status, 'awaiting_payment', 'failed payment must not queue a job');
    await post(`/api/orders/${o.orderId}/mock-pay`, { success: true });
    await post(`/api/orders/${o.orderId}/mock-pay`, { success: true }); // duplicate confirmation
    let st; for (let i = 0; i < 20; i++) { st = (await (await fetch(`${B}/api/orders/${o.orderId}`)).json()).status; if (st === 'done') break; await sleep(500); }
    assert.equal(st, 'done', 'job should be printed');
    assert.equal(fs.readdirSync('printed').length, 1, 'printed exactly once');
    assert.equal(fs.existsSync(`data/uploads/${o.orderId}.pdf`), false, 'file deleted after printing');
    assert.equal((await fetch(B + '/api/admin/summary')).status, 401, 'dashboard needs PIN');
    const s = await (await fetch(B + '/api/admin/summary', { headers: { 'x-owner-pin': '9999' } })).json();
    assert.equal(s.earnedToday, 8000, 'earnings');
    const pre = await fetch(B + '/api/orders', { method: 'OPTIONS', headers: { Origin: 'https://shop.example.app', 'Access-Control-Request-Method': 'POST' } });
    assert.equal(pre.status, 204); assert.equal(pre.headers.get('access-control-allow-origin'), 'https://shop.example.app', 'allowed origin gets CORS');
    const bad = await fetch(B + '/api/shops/shop1', { headers: { Origin: 'https://evil.example' } });
    assert.equal(bad.headers.get('access-control-allow-origin'), null, 'other origins get no CORS header');
    console.log('\nALL CHECKS PASSED');
  } catch (e) { console.error('\nFAILED:', e.message); process.exitCode = 1; }
  finally { server.kill(); agent.kill(); }
})();
