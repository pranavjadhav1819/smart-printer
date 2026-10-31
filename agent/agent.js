// Shop PC agent: run this on the computer connected to the printer(s).
// It asks the server for paid jobs every few seconds, prints them, and reports back.
require('dotenv').config();
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

const SERVER = process.env.SERVER_URL || 'http://localhost:3000';
const DRY_RUN = process.env.DRY_RUN === '1'; // 1 = no real printer: saves PDFs into ./printed instead
const headers = { Authorization: 'Bearer ' + (process.env.AGENT_TOKEN || 'change-me-agent-token'), 'Content-Type': 'application/json' };

let printerCache = { at: 0, list: [] };
async function listPrinters() {
  if (DRY_RUN) return ['Demo printer (dry run)'];
  if (Date.now() - printerCache.at < 30000) return printerCache.list;
  let list = [];
  if (process.platform === 'win32') list = (await require('pdf-to-printer').getPrinters()).map((p) => p.name);
  else list = await new Promise((ok) => execFile('lpstat', ['-e'], (err, out) => ok(err ? [] : out.split('\n').filter(Boolean))));
  printerCache = { at: Date.now(), list };
  return list;
}

function printFile(file, job) {
  if (DRY_RUN) {
    fs.mkdirSync('printed', { recursive: true });
    fs.copyFileSync(file, path.join('printed', job.id + '.pdf'));
    console.log(`[dry run] would print ${job.copies} copies, ${job.mode}, ${job.sides} sided on "${job.printer}" -> printed/${job.id}.pdf`);
    return Promise.resolve();
  }
  if (process.platform === 'win32') {
    return require('pdf-to-printer').print(file, {
      printer: job.printer, copies: job.copies,
      side: job.sides === 'double' ? 'duplexlong' : 'simplex',
      monochrome: job.mode === 'bw',
    });
  }
  const args = ['-d', job.printer, '-n', String(job.copies), '-o', 'sides=' + (job.sides === 'double' ? 'two-sided-long-edge' : 'one-sided')];
  if (job.mode === 'bw') args.push('-o', 'print-color-mode=monochrome');
  return new Promise((ok, no) => execFile('lp', [...args, file], (err) => (err ? no(err) : ok())));
}

const report = (id, body) => fetch(`${SERVER}/api/agent/done/${id}`, { method: 'POST', headers, body: JSON.stringify(body) });

async function handle(job) {
  const tmp = path.join(os.tmpdir(), job.id + '.pdf');
  try {
    const f = await fetch(`${SERVER}/api/agent/file/${job.id}`, { headers });
    if (!f.ok) throw new Error('Could not download the file');
    fs.writeFileSync(tmp, Buffer.from(await f.arrayBuffer()));
    await printFile(tmp, job);
    await report(job.id, { ok: true });
    console.log('Printed job', job.id.slice(0, 6));
  } catch (e) {
    console.error('Print failed:', e.message);
    await report(job.id, { ok: false, error: e.message });
  } finally { fs.rmSync(tmp, { force: true }); }
}

async function tick() {
  try {
    const r = await fetch(SERVER + '/api/agent/heartbeat', { method: 'POST', headers, body: JSON.stringify({ printers: await listPrinters() }) });
    if (!r.ok) throw new Error('Server replied ' + r.status + ' (check AGENT_TOKEN)');
    const { job } = await r.json();
    if (job) await handle(job);
  } catch (e) { console.error('[agent]', e.message); }
}

console.log(`Agent started. Server: ${SERVER}${DRY_RUN ? ' (dry run)' : ''}`);
(async () => { for (;;) { await tick(); await new Promise((r) => setTimeout(r, 3000)); } })();
