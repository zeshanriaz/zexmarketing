// End-to-end test: loads the real extension in Chromium against a mock Google
// Maps page and mock business websites, runs a 3-location job, exports the CSV
// and checks every row.
//
// Run: node extensions/maps-lead-extractor-tests/e2e.mjs
// Needs Playwright (PLAYWRIGHT_PATH overrides the module location).

import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_PATH || 'playwright');
const Core = require('../maps-lead-extractor/shared/leads-core.js');

const here = path.dirname(fileURLToPath(import.meta.url));
const EXT = path.resolve(here, '../maps-lead-extractor');

// ---------- mock data ----------

const QUERY_IDS = {
  'pest control brooklyn': range(0, 50),
  'pest control queens': range(35, 85), // overlaps Brooklyn by 15
};
const SINGLE_ID = 200;
const BROKEN_ID = 20; // details pane never opens: row must still be saved from the card
const FB_ID = 19; // website is a Facebook page

function range(a, b) {
  return Array.from({ length: b - a }, (_, i) => a + i);
}
const pad = (n, w = 4) => String(n).padStart(w, '0');
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

function biz(i) {
  const name = i === 3 ? '=HYPERLINK("http://evil")' : i === 10 || i === 11 ? 'Terminix' : `Biz ${i} Pest Control`;
  const hasReviews = i % 7 !== 0;
  const rating = hasReviews ? (3 + (i % 20) / 10).toFixed(1) : '';
  const count = hasReviews ? i * 37 + 5 : 0;
  return {
    i,
    name,
    rating,
    count,
    countText: count.toLocaleString('en-US'),
    german: i % 5 === 0,
    cardCategory: i % 9 === 0 ? '' : 'Pest control service',
    category: i % 9 === 0 ? 'Exterminator' : 'Pest control service',
    address: `${100 + i} Main St, New York, NY 1${pad(i)}`,
    phone: i % 8 === 0 ? '' : `+1 718-555-${pad(i)}`,
    phoneTel: `+1718555${pad(i)}`,
    website: i === FB_ID ? `https://www.facebook.com/biz${i}page` : i % 6 === 5 ? '' : `http://biz-${i}.test/`,
    noHeadline: i % 11 === 0,
    featureId: `0x89c2${pad(i, 6)}abc:0x${(0x1000000 + i * 7919).toString(16)}`,
    lat: (40.6 + i / 1000).toFixed(4),
    lng: (-73.9 - i / 1000).toFixed(4),
  };
}

function placeHref(b) {
  return `https://www.google.com/maps/place/${encodeURIComponent(b.name).replace(/%20/g, '+')}/data=!4m7!3m6!1s${b.featureId}!8m2!3d${b.lat}!4d${b.lng}!16s%2Fg%2F11x${b.i}`;
}

function expectedEmail(b) {
  if (!b.website) return '';
  if (b.i === 13 || b.i === FB_ID || b.i === BROKEN_ID) return ''; // broken site, social page, no details
  return ['info', 'office', 'contact', 'hello', 'sales'][b.i % 6] + `@biz-${b.i}.test`;
}

function cardHtml(b) {
  const ratingRow = b.rating
    ? `<div class="W4Efsd"><div class="AJB7ye"><span class="e4rVHe"><span role="img" class="ZkP5Je" aria-label="${b.rating} stars ${b.countText} Reviews"><span class="MW4etd" aria-hidden="true">${b.rating}</span><span class="UY7F9" aria-hidden="true">(${b.countText})</span></span></span></div></div>`
    : '';
  const cat = b.cardCategory
    ? `<span><span>${esc(b.cardCategory)}</span></span><span> <span aria-hidden="true">·</span> </span>`
    : '';
  return `<div><div class="Nv2PK" role="article" aria-label="${esc(b.name)}">
    <a class="hfpxzc" aria-label="${esc(b.name)}" href="${placeHref(b)}"></a>
    ${b.noHeadline ? '' : `<div class="qBF1Pd fontHeadlineSmall">${esc(b.name)}</div>`}
    ${ratingRow}
    <div class="W4Efsd"><div class="W4Efsd">${cat}<span>${100 + b.i} Main St</span></div><div class="W4Efsd">Open · Closes 6 PM</div></div>
  </div></div>`;
}

function paneHtml(b) {
  const L = b.german
    ? {
        address: 'Adresse',
        phone: 'Telefon',
        website: 'Website',
        rating: b.rating.replace('.', ','),
        reviews: 'Rezensionen',
      }
    : { address: 'Address', phone: 'Phone', website: 'Website', rating: b.rating, reviews: 'reviews' };
  const ratingBox = b.rating
    ? `<div class="F7nice"><span><span aria-hidden="true">${L.rating}</span><span class="ceNzKf" role="img" aria-label="${L.rating} stars"></span></span><span><span><span aria-label="${b.countText} ${L.reviews}">(${b.countText})</span></span></span></div>`
    : '';
  return `<div role="main" aria-label="${esc(b.name)}" class="m6QErb">
    <h1 class="DUwDvf">${esc(b.name)}</h1>
    ${ratingBox}
    <button class="DkEaL" jsaction="pane.rating.category">${esc(b.category)}</button>
    <button data-item-id="address" aria-label="${L.address}: ${esc(b.address)}"><div class="Io6YTe fontBodyMedium">${esc(b.address)}</div></button>
    ${b.website ? `<a data-item-id="authority" aria-label="${L.website}: biz-${b.i}.test" href="${b.website}"><div class="Io6YTe">biz-${b.i}.test</div></a>` : ''}
    ${b.phone ? `<button data-item-id="phone:tel:${b.phoneTel}" aria-label="${L.phone}: ${b.phone}"><div class="Io6YTe">${b.phone}</div></button>` : ''}
    <button data-item-id="oloc"><div class="Io6YTe">P2X4+${pad(b.i, 2)} New York</div></button>
  </div>`;
}

function mapsPage(pathname) {
  const m = pathname.match(/^\/maps\/search\/([^/]+)/);
  const query = m ? decodeURIComponent(m[1].replace(/\+/g, ' ')).toLowerCase() : '';
  const single = query === 'pest control single';
  const ids = QUERY_IDS[query] || [];
  const all = single ? [] : ids.map(biz);
  const data = {};
  for (const b of all) data[b.featureId] = { card: cardHtml(b), pane: paneHtml(b) };
  const singleBiz = single ? biz(SINGLE_ID) : null;
  return `<!doctype html><html><head><meta charset="utf-8"><title>Google Maps</title>
<style>body{margin:0;font-family:Arial} #side{width:420px;height:700px;display:flex}
 .m6QErb[role=feed]{height:650px;overflow-y:auto;width:400px} .Nv2PK{height:110px;border-bottom:1px solid #ddd;position:relative}
 a.hfpxzc{position:absolute;inset:0} #detail{width:400px}</style></head><body>
<input id="searchboxinput" value="${esc(query)}">
<div id="side">
${
  single || !query
    ? ''
    : `<div role="main" aria-label="Results for ${esc(query)}"><h1 class="fontTitleLarge">Results</h1><div class="m6QErb" role="feed" aria-label="Results for ${esc(query)}"></div></div>`
}
<div id="detail"></div></div>
<script>
const DATA = ${JSON.stringify(data)};
const ORDER = ${JSON.stringify(all.map((b) => b.featureId))};
const SINGLE = ${JSON.stringify(singleBiz ? { href: placeHref(singleBiz), pane: paneHtml(singleBiz) } : null)};
let shown = 0, loading = false;
const feed = document.querySelector('[role=feed]');
function appendBatch() {
  const next = ORDER.slice(shown, shown + 20);
  feed.insertAdjacentHTML('beforeend', next.map(id => DATA[id].card).join(''));
  shown += next.length;
  if (shown >= ORDER.length) feed.insertAdjacentHTML('beforeend', '<div class="m6QErb"><div class="PbZDve"><p class="fontBodyMedium"><span><span class="HlvSq">You\\'ve reached the end of the list.</span></span></p></div></div>');
}
if (feed) {
  setTimeout(appendBatch, 400);
  feed.addEventListener('scroll', () => {
    if (loading || shown >= ORDER.length) return;
    if (feed.scrollTop + feed.clientHeight >= feed.scrollHeight - 60) {
      loading = true;
      setTimeout(() => { appendBatch(); loading = false; }, 700);
    }
  });
  document.addEventListener('click', (e) => {
    const a = e.target.closest('a.hfpxzc');
    if (!a) return;
    e.preventDefault();
    const id = decodeURIComponent(a.href).match(/!1s(0x[0-9a-f]+:0x[0-9a-f]+)/)[1];
    history.pushState(null, '', a.href); // URL changes before the pane renders
    if (id === ${JSON.stringify(biz(BROKEN_ID).featureId)}) return;
    setTimeout(() => { document.getElementById('detail').innerHTML = DATA[id].pane; }, 250 + Math.random() * 600);
  });
}
if (SINGLE) setTimeout(() => { history.replaceState(null, '', SINGLE.href); document.getElementById('detail').innerHTML = SINGLE.pane; }, 600);
</script></body></html>`;
}

// ---------- mock business websites ----------

function cfEncode(email, key = 0x5a) {
  return (
    key.toString(16) +
    Array.from(email)
      .map((c) => (c.charCodeAt(0) ^ key).toString(16).padStart(2, '0'))
      .join('')
  );
}

function siteResponse(host, urlPath) {
  const m = host.match(/^biz-(\d+)\.test/);
  if (!m) return [404, 'not found'];
  const i = Number(m[1]);
  const d = `biz-${i}.test`;
  if (i === 13) return [500, '<h1>Server Error</h1>'];
  const page = (body) => [
    200,
    `<!doctype html><html><body><nav><a href="/">Home</a><a href="/services">Services</a></nav>${body}</body></html>`,
  ];
  switch (i % 6) {
    case 0:
      if (urlPath !== '/') return [404, 'nf'];
      return page(`<a href="mailto:info@${d}">Email us</a><footer>Site by design@webagency.com
        <a href="https://www.facebook.com/sharer/sharer.php?u=x">share</a><a href="https://www.facebook.com/biz${i}">fb</a></footer>`);
    case 1:
      if (urlPath === '/') return page(`<p>Call us today.</p><a href="/reach">Get in touch</a>`);
      if (urlPath === '/reach') return page(`<p>Email: office@${d}</p>`);
      return [404, 'nf'];
    case 2:
      if (urlPath !== '/') return [404, 'nf'];
      return page(
        `<a href="/cdn-cgi/l/email-protection" class="__cf_email__" data-cfemail="${cfEncode('contact@' + d)}">[email&#160;protected]</a>`,
      );
    case 3: {
      if (urlPath !== '/') return [404, 'nf'];
      const b64 = Buffer.from(`hello@${d}`).toString('base64');
      return page(
        `<div id="app">Loading...</div><script>setTimeout(function(){document.getElementById('app').innerHTML='<a href="mailto:'+atob('${b64}')+'">Mail</a>'},300)</script>`,
      );
    }
    case 4:
      if (urlPath === '/') {
        return page(`<script>var s="a1b2c3d4e5f6a7b8c9d0@sentry.wixpress.com"</script><img src="logo@2x.png">
          <p>Owner: owner${i}@gmail.com</p><a href="/contact">Contact</a><a href="https://www.instagram.com/biz${i}/">ig</a>`);
      }
      if (urlPath === '/contact') return page(`<p>sales@${d}</p>`);
      return [404, 'nf'];
    default:
      return [404, 'nf'];
  }
}

// ---------- helpers ----------

function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (c === '"') q = false;
      else cell += c;
    } else if (c === '"') q = true;
    else if (c === ',') {
      row.push(cell);
      cell = '';
    } else if (c === '\n') {
      row.push(cell.replace(/\r$/, ''));
      rows.push(row);
      row = [];
      cell = '';
    } else cell += c;
  }
  if (cell || row.length) rows.push([...row, cell]);
  return rows;
}

const failures = [];
function check(cond, msg) {
  if (!cond) failures.push(msg);
}

// ---------- run ----------

const server = http.createServer((req, res) => {
  const [status, body] = siteResponse(req.headers.host || '', req.url.split('?')[0]);
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8' });
  res.end(body);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;

const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zexleads-'));
const context = await chromium.launchPersistentContext(userDir, {
  headless: true,
  channel: 'chromium',
  args: [
    `--disable-extensions-except=${EXT}`,
    `--load-extension=${EXT}`,
    `--host-resolver-rules=MAP *.test 127.0.0.1:${port}`,
    '--no-proxy-server',
  ],
  viewport: { width: 1280, height: 800 },
  acceptDownloads: true,
});

const t0 = Date.now();
try {
  await context.route(/^https:\/\/www\.google\.com\/maps/, (route) => {
    const u = new URL(route.request().url());
    route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: mapsPage(u.pathname) });
  });

  let [worker] = context.serviceWorkers();
  if (!worker) worker = await context.waitForEvent('serviceworker');
  const storage = () => worker.evaluate(() => chrome.storage.local.get(null));

  const page = await context.newPage();
  page.on('dialog', (d) => d.accept());
  page.on('console', (m) => {
    if (m.type() === 'error') console.log('[page error]', m.text());
  });
  await page.goto('https://www.google.com/maps/@40.7,-73.9,12z');
  const panel = page.locator('#zexleads-host');
  await panel.locator('.panel').waitFor();

  await panel.locator('#kw').fill('pest control');
  await panel.locator('#locs').fill('brooklyn\nqueens\nsingle\nBrooklyn');
  await panel.locator('summary').click();
  await panel.locator('#min-delay').fill('0.1');
  await panel.locator('#max-delay').fill('0.2');
  await panel.locator('[data-act="start"]').click();

  // Wait for the job to finish and the email queue to drain.
  const expectedIds = [
    ...new Set([...QUERY_IDS['pest control brooklyn'], ...QUERY_IDS['pest control queens'], SINGLE_ID]),
  ];
  let all;
  for (;;) {
    await new Promise((r) => setTimeout(r, 3000));
    all = await storage();
    const rows = Object.keys(all).filter((k) => k.startsWith('row:')).length;
    const queue = (all.emailQueue || []).length;
    const status = await page
      .locator('#zexleads-host #status')
      .textContent()
      .catch(() => '(navigating)');
    console.log(`${Math.round((Date.now() - t0) / 1000)}s rows=${rows} queue=${queue} status=${status}`);
    if (all.job && !all.job.active && queue === 0 && rows > 0) break;
    if (Date.now() - t0 > 8 * 60 * 1000) throw new Error('timeout');
  }

  // The export button produces the CSV.
  const [download] = await Promise.all([page.waitForEvent('download'), panel.locator('[data-act="export"]').click()]);
  const csvText = fs.readFileSync(await download.path(), 'utf8');
  check(csvText.startsWith('﻿'), 'CSV has BOM');
  check(
    /^maps-leads-pest-control-\d{4}-\d{2}-\d{2}\.csv$/.test(download.suggestedFilename()),
    'file name: ' + download.suggestedFilename(),
  );
  const [header, ...lines] = parseCsv(csvText.slice(1)).filter((r) => r.length > 1);
  const col = (name) => header.indexOf(name);
  const rows = lines.map((r) => Object.fromEntries(header.map((h, i) => [h, r[i]])));

  check(rows.length === expectedIds.length, `row count ${rows.length} != ${expectedIds.length}`);
  const ids = new Set(rows.map((r) => r['Place ID']));
  check(ids.size === rows.length, 'place ids are unique');

  for (const id of expectedIds) {
    const b = biz(id);
    const r = rows.find((x) => x['Place ID'] === b.featureId);
    if (!r) {
      check(false, `missing business ${id}`);
      continue;
    }
    const broken = id === BROKEN_ID;
    const want = {
      'Business Name': id === 3 ? "'" + b.name : b.name,
      Category: broken ? b.cardCategory : b.category,
      Phone: b.phone && !broken ? "'" + b.phone : '',
      Address: broken ? '' : b.address,
      Website: broken ? '' : b.website,
      Email: expectedEmail(b),
      'Average Rating': b.rating,
      'Total Reviews': b.rating ? String(b.count) : '',
      Latitude: b.lat,
      Longitude: b.lng,
      CID: BigInt(b.featureId.split(':')[1]).toString(),
      'Plus Code': broken ? '' : `P2X4+${pad(id, 2)} New York`,
    };
    for (const [k, v] of Object.entries(want)) {
      check(r[k] === v, `biz ${id} ${k}: got ${JSON.stringify(r[k])} want ${JSON.stringify(v)}`);
    }
    if (b.website && id % 6 === 0)
      check(r.Facebook === `https://www.facebook.com/biz${id}`, `biz ${id} facebook ${r.Facebook}`);
    if (b.website && id % 6 === 4) {
      check(r.Instagram === `https://www.instagram.com/biz${id}/`, `biz ${id} instagram ${r.Instagram}`);
      check(r['All Emails Found'].includes(`owner${id}@gmail.com`), `biz ${id} all emails ${r['All Emails Found']}`);
      check(!r['All Emails Found'].includes('sentry'), `biz ${id} sentry leaked`);
    }
    if (id === FB_ID) check(r.Facebook === b.website, `biz ${id} facebook website ${r.Facebook}`);
    const status = !b.website || broken ? 'No website' : expectedEmail(b) ? 'Found' : 'Not found';
    check(r['Email Status'] === status, `biz ${id} status ${r['Email Status']} want ${status}`);
  }
  check(col('Business Name') === 0 && col('Total Reviews') === 7, 'core column order');

  // Second run of the same search skips everything already saved.
  const before = Object.keys(all).filter((k) => k.startsWith('row:')).length;
  await panel.locator('#locs').fill('');
  await panel.locator('#kw').fill('pest control brooklyn');
  await panel.locator('[data-act="start"]').click();
  for (;;) {
    await new Promise((r) => setTimeout(r, 2000));
    const s = await storage();
    if (s.job && !s.job.active && s.job.label === 'pest control brooklyn') {
      const status = await page.locator('#zexleads-host #status').textContent();
      check(/^Finished\./.test(status), 're-run status: ' + status);
      check(page.url().includes('/maps/search/pest+control+brooklyn'), 're-run url: ' + page.url());
      const after = Object.keys(s).filter((k) => k.startsWith('row:')).length;
      check(after === before, `re-run added duplicates: ${before} -> ${after}`);
      break;
    }
    if (Date.now() - t0 > 10 * 60 * 1000) throw new Error('timeout on re-run');
  }

  // No leftover render windows.
  const pages = context.pages().map((p) => p.url());
  check(!pages.some((u) => u.includes('.test')), 'render windows closed: ' + pages.join(', '));
} finally {
  await context.close();
  server.close();
}

console.log(`\nfinished in ${Math.round((Date.now() - t0) / 1000)}s`);
if (failures.length) {
  console.log(`FAILED (${failures.length}):\n` + failures.slice(0, 60).join('\n'));
  process.exit(1);
}
console.log('ALL E2E CHECKS PASSED');
