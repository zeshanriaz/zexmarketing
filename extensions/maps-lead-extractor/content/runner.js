/*
 * Scrape job runner.
 *
 * For each search query:
 *   1. Scroll the result list until Google shows its end-of-list marker
 *      (or no new results load for ~15 seconds).
 *   2. Open each business one at a time inside the same Maps tab, wait for
 *      its details pane, read it, save it, then wait a random delay.
 *   3. Hand the website to the background worker for the email search.
 *
 * Multi-location jobs navigate to the next search URL. The job lives in
 * storage, and the tab id lives in sessionStorage, so the run resumes after
 * each page load in the same tab only.
 */
(function (root) {
  'use strict';

  const Core = root.ZexCore;
  const Dom = root.ZexMapsDom;

  const DEFAULT_SETTINGS = { minDelay: 1.5, maxDelay: 3.5, deepEmail: true };
  const STOP = new Error('stopped');
  const SESSION_KEY = 'zexLeadsJob';

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const rand = (a, b) => a + Math.random() * Math.max(0, b - a);

  const state = {
    running: false,
    paused: false,
    stopRequested: false,
    blocked: false,
    status: 'Ready.',
    query: '',
    queryIndex: 0,
    queryTotal: 0,
    listed: 0,
    toScrape: 0,
    done: 0,
    skipped: 0,
  };

  let orderSeq = 0;
  const nextOrder = () => Date.now() * 1000 + (orderSeq++ % 1000);

  function setStatus(text) {
    state.status = text;
  }

  // ---------- storage ----------

  async function getJob() {
    const { job } = await chrome.storage.local.get('job');
    return job || null;
  }

  async function saveJob(job) {
    await chrome.storage.local.set({ job });
  }

  async function savedKeys() {
    const all = await chrome.storage.local.get(null);
    return new Set(
      Object.keys(all)
        .filter((k) => k.startsWith('row:'))
        .map((k) => k.slice(4)),
    );
  }

  function sendMessage(msg) {
    try {
      return chrome.runtime.sendMessage(msg).catch(() => null);
    } catch (e) {
      // Extension was reloaded; this content script is orphaned.
      return Promise.resolve(null);
    }
  }

  // ---------- URL helpers ----------

  function searchUrl(query) {
    const hl = new URLSearchParams(location.search).get('hl');
    return (
      location.origin +
      '/maps/search/' +
      encodeURIComponent(query).replace(/%20/g, '+') +
      (hl ? '?hl=' + encodeURIComponent(hl) : '')
    );
  }

  function currentSearchQuery() {
    const m = location.pathname.match(/^\/maps\/search\/([^/]+)/);
    if (!m) return '';
    try {
      return decodeURIComponent(m[1].replace(/\+/g, ' '));
    } catch (e) {
      return m[1].replace(/\+/g, ' ');
    }
  }

  const sameQuery = (a, b) => Core.normalizeName(a) === Core.normalizeName(b);

  // ---------- waiting & control ----------

  async function waitFor(fn, timeoutMs, stepMs) {
    const end = Date.now() + timeoutMs;
    for (;;) {
      let value = null;
      try {
        value = fn();
      } catch (e) {
        value = null;
      }
      if (value) return value;
      if (Date.now() >= end || state.stopRequested) return null;
      await sleep(stepMs || 250);
    }
  }

  // Called between steps: honours pause/stop and pauses on captchas.
  async function checkpoint() {
    if (Dom.isBlocked() && !state.blocked) {
      state.blocked = true;
      state.paused = true;
      setStatus('Google asked for verification. Solve it, then press Resume.');
    }
    while (state.paused && !state.stopRequested) await sleep(300);
    if (state.stopRequested) throw STOP;
  }

  // ---------- public controls ----------

  async function start(options) {
    if (state.running) return;
    const keyword = Core.cleanText(options.keyword);
    const locations = (options.locations || []).map(Core.cleanText).filter(Boolean);
    const all = locations.length ? locations.map((l) => (keyword ? keyword + ' ' + l : l)) : keyword ? [keyword] : [];
    const queries = all.filter((q, i) => all.findIndex((x) => sameQuery(x, q)) === i);
    if (!queries.length) {
      setStatus('Type a search keyword first.');
      return;
    }
    const settings = Object.assign({}, DEFAULT_SETTINGS, options.settings || {});
    settings.minDelay = Math.max(0, Number(settings.minDelay) || 0);
    settings.maxDelay = Math.max(settings.minDelay, Number(settings.maxDelay) || 0);
    const job = {
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      label: keyword || queries[0],
      queries,
      index: 0,
      settings,
      active: true,
      navTarget: '',
    };
    sessionStorage.setItem(SESSION_KEY, job.id);
    await chrome.storage.local.set({ job, settings });
    state.stopRequested = false;
    state.paused = false;
    await goToQuery(job);
  }

  async function goToQuery(job) {
    const q = job.queries[job.index];
    if (sameQuery(currentSearchQuery(), q) && Dom.getFeed()) {
      job.navTarget = '';
      await saveJob(job);
      runJob(job);
      return;
    }
    job.navTarget = q;
    job.navAt = Date.now();
    await saveJob(job);
    setStatus('Opening search: ' + q);
    location.href = searchUrl(q);
  }

  function pause() {
    if (state.running) {
      state.paused = true;
      setStatus('Paused.');
    }
  }

  async function resume() {
    if (state.running) {
      state.blocked = Dom.isBlocked();
      state.paused = state.blocked;
      if (state.blocked) setStatus('Verification is still showing. Solve it first.');
      return;
    }
    // Job waiting in storage, for example after the user navigated away.
    const job = await getJob();
    if (job && job.active && sessionStorage.getItem(SESSION_KEY) === job.id) {
      state.paused = false;
      await goToQuery(job);
    }
  }

  async function stop() {
    state.stopRequested = true;
    state.paused = false;
    state.pendingResume = false;
    const job = await getJob();
    if (job && job.active) {
      job.active = false;
      await saveJob(job);
    }
    if (!state.running) setStatus('Stopped.');
  }

  // Runs on every page load: continues a job this tab started.
  async function resumeIfNeeded() {
    sendMessage({ type: 'pumpEmails' });
    const job = await getJob();
    if (!job || !job.active || sessionStorage.getItem(SESSION_KEY) !== job.id) return;
    const q = job.queries[job.index];
    const arrivedFromJob = job.navTarget && sameQuery(job.navTarget, q) && Date.now() - (job.navAt || 0) < 120000;
    if (arrivedFromJob || sameQuery(currentSearchQuery(), q)) {
      job.navTarget = '';
      await saveJob(job);
      runJob(job);
    } else {
      state.queryIndex = job.index;
      state.queryTotal = job.queries.length;
      state.query = q;
      setStatus('Job paused because the page changed. Press Resume to continue.');
      state.pendingResume = true;
    }
  }

  // ---------- job execution ----------

  async function runJob(job) {
    if (state.running) return;
    state.running = true;
    state.pendingResume = false;
    state.stopRequested = false;
    state.blocked = false;
    state.queryTotal = job.queries.length;
    let navigated = false;
    try {
      while (job.index < job.queries.length) {
        state.query = job.queries[job.index];
        state.queryIndex = job.index;
        await runQuery(state.query, job.settings);
        job.index++;
        if (job.index < job.queries.length) {
          await checkpoint();
          await saveJob(job);
          navigated = true;
          await goToQuery(job);
          return;
        }
      }
      job.active = false;
      await saveJob(job);
      const total = (await savedKeys()).size;
      setStatus('Finished. ' + total + ' businesses saved. Export when emails finish.');
    } catch (e) {
      if (e === STOP) {
        setStatus('Stopped. ' + (await savedKeys()).size + ' businesses saved.');
      } else {
        console.error('[ZexLeads]', e);
        setStatus('Error: ' + (e && e.message ? e.message : e) + '. Press Start to continue.');
        const latest = await getJob();
        if (latest) {
          latest.active = false;
          await saveJob(latest);
        }
      }
    } finally {
      if (!navigated) state.running = false;
    }
  }

  async function runQuery(query, settings) {
    state.listed = 0;
    state.toScrape = 0;
    state.done = 0;
    state.skipped = 0;
    setStatus('Waiting for results: ' + query);

    const ready = await waitFor(() => Dom.getFeed() || Dom.getPlacePane(), 25000, 300);
    await checkpoint();
    if (!ready) {
      setStatus('No results loaded for "' + query + '". Moving on.');
      await sleep(1500);
      return;
    }

    // A search with one match opens the place directly.
    if (!Dom.getFeed()) {
      await sleep(1500);
      const key = Core.placeKey(location.href);
      if (key && !(await savedKeys()).has(key)) {
        await saveRow(key, location.href, {}, Dom.readDetails(Dom.getPlacePane()), query);
        state.done = 1;
      }
      state.listed = 1;
      return;
    }

    await scrollToEnd();

    // Snapshot every card first, so a row is saved even if its card disappears later.
    const cards = new Map();
    for (const [key, link] of Dom.getCardLinks(Dom.getFeed()))
      cards.set(key, { href: link.href, card: Dom.readCard(link) });
    const keys = Array.from(cards.keys());
    state.listed = keys.length;
    const saved = await savedKeys();
    const todo = keys.filter((k) => !saved.has(k));
    state.skipped = keys.length - todo.length;
    state.toScrape = todo.length;

    for (const key of todo) {
      await checkpoint();
      setStatus('Reading business ' + (state.done + 1) + ' of ' + todo.length);
      const snap = cards.get(key);
      let details = null;
      for (let attempt = 0; attempt < 2 && !details; attempt++) {
        if (attempt > 0) {
          await checkpoint();
          await sleep(1000);
        }
        const link = await findCardLink(key);
        if (link) details = await openAndRead(link, key, snap.card.name);
      }
      await saveRow(key, snap.href, snap.card, details, query);
      state.done++;
      await sleep(rand(settings.minDelay, settings.maxDelay) * 1000);
    }
  }

  // Finds the card link, returning to the list first if a place page replaced it.
  async function findCardLink(key) {
    if (!Dom.getFeed()) {
      history.back();
      await waitFor(() => Dom.getFeed(), 10000, 250);
    }
    return Dom.getCardLinks(Dom.getFeed()).get(key) || null;
  }

  async function scrollToEnd() {
    let last = -1;
    let stall = 0;
    for (;;) {
      await checkpoint();
      const feed = Dom.getFeed();
      if (!feed) return;
      const links = Dom.getCardLinks(feed);
      const count = links.size;
      state.listed = count;
      setStatus('Loading full list: ' + count + ' businesses found so far');
      if (Dom.isEndOfList(feed)) return;
      if (count > last) {
        last = count;
        stall = 0;
      } else if (++stall >= 12) {
        return; // nothing new for ~15 seconds
      }
      const scroller = Dom.getScroller(feed);
      if (stall > 0 && stall % 4 === 0) {
        // Nudge up and down to re-trigger lazy loading.
        scroller.scrollTop = Math.max(0, scroller.scrollTop - 800);
        await sleep(500);
      }
      const lastLink = Array.from(links.values()).pop();
      if (lastLink) lastLink.scrollIntoView({ block: 'end' });
      scroller.scrollTop = scroller.scrollHeight;
      await sleep(rand(1000, 1500));
    }
  }

  async function openAndRead(link, key, cardName) {
    // Mark the current title so a stale pane is never mistaken for the new one.
    const beforePane = Dom.getPlacePane();
    const oldTitle = beforePane && beforePane.querySelector('h1');
    if (oldTitle) oldTitle.setAttribute('data-zex-old', '1');
    link.scrollIntoView({ block: 'center' });
    link.click();

    const wanted = Core.normalizeName(cardName);
    const clickedAt = Date.now();
    const pane = await waitFor(
      () => {
        const p = Dom.getPlacePane();
        if (!p) return null;
        const title = p.querySelector('h1');
        const fresh = !!title && !title.hasAttribute('data-zex-old');
        const nameOk = !!wanted && Core.normalizeName(Dom.paneName(p)) === wanted;
        const urlOk = Core.placeKey(location.href) === key;
        if (fresh && (nameOk || urlOk)) return p;
        // Maps sometimes reuses the title element. Accept once URL and name agree.
        if (Date.now() - clickedAt > 4000 && urlOk && (nameOk || !wanted)) return p;
        return null;
      },
      12000,
      200,
    );
    if (!pane) return null;

    // Info rows render a moment after the title.
    await waitFor(() => Dom.paneHasInfo(Dom.getPlacePane()), 3000, 200);
    await sleep(350);
    const details = Dom.readDetails(Dom.getPlacePane());
    if (wanted && details.name && Core.normalizeName(details.name) !== wanted && Core.placeKey(location.href) !== key) {
      return null; // pane switched to another place mid-read
    }
    return details;
  }

  async function saveRow(key, href, card, details, query) {
    const d = details || {};
    const c = card || {};
    const p = Core.parsePlaceUrl(href);
    const row = {
      key,
      order: nextOrder(),
      query,
      name: d.name || c.name || '',
      category: d.category || c.category || '',
      phone: d.phone || '',
      phoneRaw: d.phoneRaw || '',
      address: d.address || '',
      website: d.website || '',
      rating: d.rating || c.rating || '',
      reviewCount: d.reviewCount || c.reviewCount || '',
      plusCode: d.plusCode || '',
      latitude: p.latitude,
      longitude: p.longitude,
      placeId: p.placeId,
      cid: p.cid,
      mapsUrl: p.cid ? 'https://www.google.com/maps?cid=' + p.cid : href,
      detailsLoaded: !!details,
      scrapedAt: new Date().toISOString().replace('T', ' ').slice(0, 19),
    };
    await chrome.storage.local.set({ ['row:' + key]: row });
    if (row.website) await sendMessage({ type: 'enqueueEmails', items: [{ key, website: row.website }] });
  }

  root.ZexRunner = {
    state,
    start,
    pause,
    resume,
    stop,
    resumeIfNeeded,
    DEFAULT_SETTINGS,
  };
})(globalThis);
