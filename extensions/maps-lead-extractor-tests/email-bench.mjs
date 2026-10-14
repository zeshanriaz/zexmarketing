// Email crawler benchmark: queues mock business websites with realistic
// latency, dead hosts and hanging servers, then times how long the
// background worker takes to drain the queue and checks the emails found.
//
// Run: node extensions/maps-lead-extractor-tests/email-bench.mjs
// Needs Playwright (PLAYWRIGHT_PATH overrides the module location).

import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_PATH || 'playwright');

const here = path.dirname(fileURLToPath(import.meta.url));
const EXT = process.env.EXT_DIR || path.resolve(here, '../maps-lead-extractor');
const SITES = 60;

// Site types by i % 10.
//  0 mailto on home       1 email on linked contact page   2 Cloudflare email
//  3 JavaScript-rendered  4 no email anywhere              5 slow server (1.5 s per page)
//  6 dead host            7 hangs forever                  8 no email anywhere
//  9 same domain as site 0 of its group (chain)
function expected(i) {
  const t = i % 10;
  const d = `site-${i}.test`;
  if (t === 0) return `info@${d}`;
  if (t === 1) return `office@${d}`;
  if (t === 2) return `contact@${d}`;
  if (t === 3) return `hello@${d}`;
  if (t === 5) return `sales@${d}`;
  if (t === 9) return `info@site-${i - 9}.test`;
  return '';
}

function website(i) {
  if (i % 10 === 6) return `http://dead-${i}.invalid/`;
  if (i % 10 === 9) return `http://site-${i - 9}.test/locations/${i}`;
  return `http://site-${i}.test/`;
}

const cf = (email, key = 0x33) =>
  key.toString(16) +
  Array.from(email)
    .map((c) => (c.charCodeAt(0) ^ key).toString(16).padStart(2, '0'))
    .join('');

let requests = 0;
const server = http.createServer((req, res) => {
  requests++;
  const host = (req.headers.host || '').split(':')[0];
  const m = host.match(/^site-(\d+)\.test$/);
  const p = req.url.split('?')[0];
  const send = (status, body, delay = 150) =>
    setTimeout(() => {
      res.writeHead(status, { 'content-type': 'text/html; charset=utf-8' });
      res.end(
        `<!doctype html><html><body><nav><a href="/">Home</a><a href="/services">Services</a></nav>${body}</body></html>`,
      );
    }, delay);
  if (!m) return send(404, '');
  const i = Number(m[1]);
  const d = host;
  const t = i % 10;
  if (t === 7) return; // never answers
  const filler = '<p>' + 'Professional pest control. '.repeat(400) + '</p>';
  if (p.startsWith('/locations/')) return send(200, filler + '<a href="/contact-us">Contact</a>');
  switch (t) {
    case 0:
      return p === '/'
        ? send(200, filler + `<a href="mailto:info@${d}">Mail</a>`)
        : p === '/contact-us'
          ? send(200, `info@${d}`)
          : send(404, '');
    case 1:
      if (p === '/') return send(200, filler + '<a href="/reach">Get in touch</a><a href="/about">About</a>');
      return p === '/reach' ? send(200, `office@${d}`) : send(404, '');
    case 2:
      return p === '/'
        ? send(200, filler + `<a class="__cf_email__" data-cfemail="${cf('contact@' + d)}">x</a>`)
        : send(404, '');
    case 3: {
      if (p !== '/') return send(404, '');
      const b64 = Buffer.from(`hello@${d}`).toString('base64');
      return send(
        200,
        `<div id="app"></div><script>setTimeout(function(){document.getElementById('app').innerHTML='<a href="mailto:'+atob('${b64}')+'">x</a>'},400)</script>`,
      );
    }
    case 5:
      if (p === '/') return send(200, filler + '<a href="/contact">Contact</a>', 1500);
      return p === '/contact' ? send(200, `sales@${d}`, 1500) : send(404, '', 1500);
    default:
      return p === '/'
        ? send(200, filler + '<a href="/contact">Contact</a><a href="/about-us">About us</a>')
        : p === '/contact' || p === '/about-us'
          ? send(200, '<form>Send us a message</form>')
          : send(404, '');
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;

const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zexbench-'));
const context = await chromium.launchPersistentContext(userDir, {
  headless: true,
  channel: 'chromium',
  args: [
    `--disable-extensions-except=${EXT}`,
    `--load-extension=${EXT}`,
    `--host-resolver-rules=MAP *.test 127.0.0.1:${port}`,
    '--no-proxy-server',
  ],
});

let exitCode = 0;
try {
  let [worker] = context.serviceWorkers();
  if (!worker) worker = await context.waitForEvent('serviceworker');
  const queue = Array.from({ length: SITES }, (_, i) => ({ key: 'k' + i, website: website(i) }));
  const t0 = Date.now();
  await worker.evaluate(async (q) => {
    await chrome.storage.local.set({ emailQueue: q, settings: { deepEmail: true } });
    pump();
  }, queue);
  let all;
  for (;;) {
    await new Promise((r) => setTimeout(r, 500));
    all = await worker.evaluate(() => chrome.storage.local.get(null));
    if ((all.emailQueue || []).length === 0) break;
    if (Date.now() - t0 > 15 * 60 * 1000) throw new Error('timeout');
  }
  const seconds = (Date.now() - t0) / 1000;
  const wrong = [];
  for (let i = 0; i < SITES; i++) {
    const got = (all['email:k' + i] || {}).bestEmail || '';
    if (got !== expected(i)) wrong.push(`site ${i}: got "${got}" want "${expected(i)}"`);
  }
  console.log(
    `sites=${SITES} time=${seconds.toFixed(1)}s per-site=${(seconds / SITES).toFixed(2)}s requests=${requests}`,
  );
  console.log(wrong.length ? `WRONG (${wrong.length}):\n` + wrong.join('\n') : 'all emails correct');
  if (wrong.length) exitCode = 1;
} finally {
  await context.close();
  server.close();
}
process.exit(exitCode);
