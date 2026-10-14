/*
 * Background service worker.
 * Owns the email queue: crawls each business website for emails and social
 * links, then writes the result to storage under `email:<placeKey>`.
 * The queue lives in storage, so work survives worker restarts and page reloads.
 */
importScripts('shared/leads-core.js');

const Core = self.ZexCore;

const QUEUE_KEY = 'emailQueue';
const CONCURRENCY = 6; // websites checked at the same time
const PAGE_TIMEOUT_MS = 6000; // one page
const SITE_BUDGET_MS = 15000; // all static pages of one site
const MAX_EXTRA_PAGES = 5;
const MAX_HTML_BYTES = 1500000;
const FALLBACK_PATHS = ['/contact', '/contact-us', '/about', '/about-us'];
const RENDER_SLOTS = 2; // minimized windows open at the same time
const RENDER_MAX_MS = 10000;
const RENDER_SETTLE_MS = 2500; // wait after load when no email shows up
const DOMAIN_CACHE_SIZE = 500;

const active = new Set();
let queueLock = Promise.resolve();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Serializes read-modify-write cycles on the queue.
function withQueueLock(fn) {
  const run = queueLock.then(fn, fn);
  queueLock = run.catch(() => {});
  return run;
}

async function getQueue() {
  const o = await chrome.storage.local.get(QUEUE_KEY);
  return Array.isArray(o[QUEUE_KEY]) ? o[QUEUE_KEY] : [];
}

async function enqueue(items) {
  await withQueueLock(async () => {
    const queue = await getQueue();
    const have = new Set(queue.map((i) => i.key));
    for (const item of items || []) {
      if (item && item.key && item.website && !have.has(item.key)) {
        queue.push({ key: item.key, website: item.website });
        have.add(item.key);
      }
    }
    await chrome.storage.local.set({ [QUEUE_KEY]: queue });
  });
  pump();
}

async function pump() {
  const queue = await getQueue();
  for (const item of queue) {
    if (active.size >= CONCURRENCY) break;
    if (active.has(item.key)) continue;
    active.add(item.key);
    processItem(item).finally(() => {
      active.delete(item.key);
      pump();
    });
  }
}

async function processItem(item) {
  let result;
  try {
    const { settings } = await chrome.storage.local.get('settings');
    const deep = !settings || settings.deepEmail !== false;
    result = await crawlWebsite(item.website, deep);
  } catch (e) {
    result = { emails: [], bestEmail: '', socials: {}, error: String((e && e.message) || e) };
  }
  // Skip the write if the user cleared data while this crawl ran.
  const stillQueued = (await getQueue()).some((i) => i.key === item.key);
  if (stillQueued) {
    await chrome.storage.local.set({ ['email:' + item.key]: Object.assign(result, { checkedAt: Date.now() }) });
  }
  await withQueueLock(async () => {
    const queue = await getQueue();
    await chrome.storage.local.set({ [QUEUE_KEY]: queue.filter((i) => i.key !== item.key) });
  });
}

// Returns { url, status, html } for any HTTP response (html is '' on errors),
// or null when the site is unreachable or too slow.
async function fetchPage(url, siteSignal) {
  if (/\.(pdf|jpe?g|png|gif|zip|mp4)(\?|$)/i.test(url)) return null;
  const ctrl = new AbortController();
  const abort = () => ctrl.abort();
  const timer = setTimeout(abort, PAGE_TIMEOUT_MS);
  if (siteSignal) {
    if (siteSignal.aborted) return null;
    siteSignal.addEventListener('abort', abort, { once: true });
  }
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      redirect: 'follow',
      credentials: 'omit',
      headers: { Accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8' },
    });
    const page = { url: res.url || url, status: res.status, html: '' };
    const type = res.headers.get('content-type') || '';
    if (!res.ok || (type && !/html|text|xml/i.test(type)) || !res.body) {
      res.body && res.body.cancel().catch(() => {});
      return page;
    }
    // Stream the body and stop at the size cap.
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let bytes = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.length;
      page.html += decoder.decode(value, { stream: true });
      if (bytes >= MAX_HTML_BYTES) {
        reader.cancel().catch(() => {});
        break;
      }
    }
    return page;
  } catch (e) {
    return null;
  } finally {
    clearTimeout(timer);
    if (siteSignal) siteSignal.removeEventListener('abort', abort);
  }
}

// ---------- JavaScript-rendered sites ----------

let renderFree = RENDER_SLOTS;
const renderWaiters = [];

async function renderPage(url) {
  if (renderFree > 0) renderFree--;
  else await new Promise((r) => renderWaiters.push(r));
  try {
    return await renderPageNow(url);
  } finally {
    const next = renderWaiters.shift();
    if (next) next();
    else renderFree++;
  }
}

async function snapshot(tabId) {
  try {
    const [res] = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => ({ url: location.href, html: document.documentElement.outerHTML }),
    });
    return res && res.result ? res.result : null;
  } catch (e) {
    return null; // page still navigating
  }
}

// Opens the page in a minimized window and returns its HTML as soon as an
// email shows up, or a moment after the page finishes loading.
async function renderPageNow(url) {
  let win = null;
  try {
    win = await chrome.windows.create({ url, focused: false, state: 'minimized' });
    const tab = win.tabs && win.tabs[0];
    if (!tab) return null;
    const deadline = Date.now() + RENDER_MAX_MS;
    let last = null;
    let loadedAt = 0;
    while (Date.now() < deadline) {
      await sleep(600);
      const info = await chrome.tabs.get(tab.id).catch(() => null);
      if (!info) break;
      if (info.status === 'complete' && !loadedAt) loadedAt = Date.now();
      const snap = await snapshot(tab.id);
      if (snap) {
        last = snap;
        if (Core.extractEmails(snap.html).length) break;
      }
      if (loadedAt && Date.now() - loadedAt >= RENDER_SETTLE_MS) break;
    }
    return last;
  } catch (e) {
    return null;
  } finally {
    if (win) chrome.windows.remove(win.id).catch(() => {});
  }
}

// ---------- crawler ----------

// Businesses on one domain (chain locations) share a single crawl.
const domainCache = new Map();

async function crawlWebsite(rawUrl, deep) {
  const start = Core.normalizeWebsite(rawUrl);
  if (!start) return { emails: [], bestEmail: '', socials: {}, error: 'Invalid website URL' };
  const host = Core.hostOf(start);

  // Some businesses list a social profile as their website. Those pages need a login to read.
  const social = Core.extractSocialLinks('<a href="' + start.replace(/"/g, '%22') + '">');
  if (Object.keys(social).length || /(^|\.)(facebook|instagram|linktr|yelp)\.[a-z.]+$/.test(host)) {
    return { emails: [], bestEmail: '', socials: social, error: '' };
  }

  const cacheKey = Core.rootDomain(host) + (deep ? '|deep' : '');
  if (!domainCache.has(cacheKey)) {
    if (domainCache.size >= DOMAIN_CACHE_SIZE) domainCache.delete(domainCache.keys().next().value);
    domainCache.set(cacheKey, crawlSite(start, host, deep));
  }
  const result = await domainCache.get(cacheKey);
  return Object.assign({}, result, { emails: result.emails.slice(), socials: Object.assign({}, result.socials) });
}

async function crawlSite(start, host, deep) {
  const found = new Map();
  const socials = {};
  let loadedAny = false;

  const addPage = (page) => {
    if (!page || !page.html) return;
    loadedAny = true;
    for (const e of Core.extractEmails(page.html)) {
      const prev = found.get(e.email);
      found.set(e.email, {
        email: e.email,
        mailto: e.mailto || (prev ? prev.mailto : false),
        hits: (prev ? prev.hits : 0) + 1,
      });
    }
    const s = Core.extractSocialLinks(page.html);
    for (const k of Object.keys(s)) if (!socials[k]) socials[k] = s[k];
  };
  const hasDomainEmail = () => Array.from(found.keys()).some((e) => Core.sameSite(e.split('@')[1], host));

  const site = new AbortController();
  const budget = setTimeout(() => site.abort(), SITE_BUDGET_MS);
  try {
    let home = await fetchPage(start, site.signal);
    if (!home && start.startsWith('https://')) home = await fetchPage('http://' + start.slice(8), site.signal);

    // Unreachable or hanging site: rendering would fail too, so stop here.
    if (!home) return finish();
    addPage(home);

    if (home.html && !hasDomainEmail()) {
      const visited = new Set([start, home.url]);
      const urls = [];
      const push = (u) => {
        if (u && !visited.has(u) && urls.length < MAX_EXTRA_PAGES) {
          visited.add(u);
          urls.push(u);
        }
      };
      const links = Core.findContactLinks(home.html, home.url, 3);
      links.forEach(push);
      if (links.length < 2) {
        for (const p of FALLBACK_PATHS) {
          try {
            push(new URL(p, home.url).href);
          } catch (e) {
            /* ignore */
          }
        }
      }
      // Fetch all candidate pages at once. Stop the rest when one shows a domain email.
      await Promise.all(
        urls.map((u) =>
          fetchPage(u, site.signal).then((page) => {
            addPage(page);
            if (hasDomainEmail()) site.abort();
          }),
        ),
      );
    }
  } finally {
    clearTimeout(budget);
  }

  // Sites built with JavaScript frameworks only show emails after rendering.
  // Rendering opens a minimized window, so only do it when nothing was found.
  if (deep && found.size === 0) {
    const rendered = await renderPage(start);
    addPage(rendered);
    if (rendered && rendered.html && found.size === 0) {
      const contact = Core.findContactLinks(rendered.html, rendered.url, 1)[0];
      if (contact) addPage(await renderPage(contact));
    }
  }
  return finish();

  function finish() {
    const emails = Core.rankEmails(Array.from(found.values()), host);
    return { emails, bestEmail: emails[0] || '', socials, error: loadedAny ? '' : 'Website did not load' };
  }
}

// ---------- wiring ----------

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg.type !== 'string') return false;
  if (msg.type === 'enqueueEmails') {
    enqueue(msg.items).then(
      () => sendResponse({ ok: true }),
      (e) => sendResponse({ ok: false, error: String(e) }),
    );
    return true;
  }
  if (msg.type === 'pumpEmails') {
    pump();
    sendResponse({ ok: true });
    return false;
  }
  return false;
});

chrome.runtime.onStartup.addListener(() => pump());
chrome.runtime.onInstalled.addListener(() => pump());
pump();

// Exposed for tests.
self.crawlWebsite = crawlWebsite;
