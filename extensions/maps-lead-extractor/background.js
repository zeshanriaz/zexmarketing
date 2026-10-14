/*
 * Background service worker.
 * Owns the email queue: crawls each business website for emails and social
 * links, then writes the result to storage under `email:<placeKey>`.
 * The queue lives in storage, so work survives worker restarts and page reloads.
 */
importScripts('shared/leads-core.js');

const Core = self.ZexCore;

const QUEUE_KEY = 'emailQueue';
const CONCURRENCY = 3;
const FETCH_TIMEOUT_MS = 12000;
const MAX_EXTRA_PAGES = 5;
const MAX_HTML_CHARS = 3000000;
const FALLBACK_PATHS = ['/contact', '/contact-us', '/about', '/about-us'];

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

async function fetchPage(url) {
  if (/\.(pdf|jpe?g|png|gif|zip|mp4)(\?|$)/i.test(url)) return null;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      redirect: 'follow',
      credentials: 'omit',
      headers: { Accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8' },
    });
    if (!res.ok) return null;
    const type = res.headers.get('content-type') || '';
    if (type && !/html|text|xml/i.test(type)) return null;
    let html = await res.text();
    if (html.length > MAX_HTML_CHARS) html = html.slice(0, MAX_HTML_CHARS);
    return { url: res.url || url, html };
  } catch (e) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// ---------- JavaScript-rendered sites ----------

let renderChain = Promise.resolve();

// One rendered page at a time, in a minimized window that closes itself.
function renderPage(url) {
  const run = renderChain.then(() => renderPageNow(url));
  renderChain = run.catch(() => {});
  return run;
}

function waitForTabComplete(tabId, timeoutMs) {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      chrome.tabs.onUpdated.removeListener(onUpdated);
      clearTimeout(timer);
      resolve();
    };
    const onUpdated = (id, info) => {
      if (id === tabId && info.status === 'complete') finish();
    };
    const timer = setTimeout(finish, timeoutMs);
    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.tabs.get(tabId).then(
      (tab) => tab && tab.status === 'complete' && finish(),
      () => finish(),
    );
  });
}

async function renderPageNow(url) {
  let win = null;
  try {
    win = await chrome.windows.create({ url, focused: false, state: 'minimized' });
    const tab = win.tabs && win.tabs[0];
    if (!tab) return null;
    await waitForTabComplete(tab.id, 15000);
    await sleep(2500); // let client-side frameworks render
    const [res] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => ({ url: location.href, html: document.documentElement.outerHTML }),
    });
    return res && res.result ? res.result : null;
  } catch (e) {
    return null;
  } finally {
    if (win) chrome.windows.remove(win.id).catch(() => {});
  }
}

// ---------- crawler ----------

async function crawlWebsite(rawUrl, deep) {
  const start = Core.normalizeWebsite(rawUrl);
  if (!start) return { emails: [], bestEmail: '', socials: {}, error: 'Invalid website URL' };

  const host = Core.hostOf(start);

  // Some businesses list a social profile as their website. Those pages need a login to read.
  const social = Core.extractSocialLinks('<a href="' + start.replace(/"/g, '%22') + '">');
  const socialKey = Object.keys(social)[0];
  if (socialKey || /(^|\.)(facebook|instagram|linktr|yelp)\.[a-z.]+$/.test(host)) {
    return { emails: [], bestEmail: '', socials: social, error: '' };
  }
  const found = new Map();
  const socials = {};
  const visited = new Set();
  let loadedAny = false;

  const addPage = (page) => {
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

  let home = await fetchPage(start);
  if (!home && start.startsWith('https://')) home = await fetchPage('http://' + start.slice(8));

  let candidates = [];
  if (home) {
    visited.add(home.url);
    visited.add(start);
    addPage(home);
    candidates = Core.findContactLinks(home.html, home.url);
  }
  const base = home ? home.url : start;
  for (const p of FALLBACK_PATHS) {
    try {
      candidates.push(new URL(p, base).href);
    } catch (e) {
      /* ignore */
    }
  }

  let extra = 0;
  for (const url of candidates) {
    if (hasDomainEmail() || extra >= MAX_EXTRA_PAGES) break;
    if (visited.has(url)) continue;
    visited.add(url);
    extra++;
    const page = await fetchPage(url);
    if (page) addPage(page);
  }

  // Sites built with JavaScript frameworks only show emails after rendering.
  // Rendering opens a minimized window, so only do it when nothing was found.
  if (deep && found.size === 0) {
    const rendered = await renderPage(base);
    if (rendered && rendered.html) {
      addPage(rendered);
      if (!hasDomainEmail()) {
        const contact = Core.findContactLinks(rendered.html, rendered.url, 1)[0];
        if (contact && !visited.has(contact)) {
          const r2 = await renderPage(contact);
          if (r2 && r2.html) addPage(r2);
        }
      }
    }
  }

  const emails = Core.rankEmails(Array.from(found.values()), host);
  return {
    emails,
    bestEmail: emails[0] || '',
    socials,
    error: loadedAny ? '' : 'Website did not load',
  };
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
