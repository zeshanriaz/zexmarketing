/*
 * On-page control panel, rendered inside a shadow root so Google Maps
 * styles never leak in or out.
 */
(function (root) {
  'use strict';

  if (window.top !== window || document.getElementById('zexleads-host')) return;

  const Core = root.ZexCore;
  const Dom = root.ZexMapsDom;
  const Runner = root.ZexRunner;
  const S = Runner.state;

  const CSS = `
    :host { all: initial; }
    * { box-sizing: border-box; font-family: Roboto, Arial, sans-serif; }
    .panel { position: fixed; top: 76px; right: 16px; width: 330px; max-height: calc(100vh - 96px);
      overflow: auto; background: #fff; color: #1f2933; border-radius: 12px; z-index: 2147483000;
      box-shadow: 0 8px 28px rgba(0,0,0,.25); border-top: 5px solid #0b6bcb; font-size: 13px; }
    .head { display: flex; align-items: center; justify-content: space-between; padding: 10px 12px;
      cursor: move; user-select: none; background: #f5f8fc; }
    .title { font-weight: 700; font-size: 14px; }
    .icon-btn { border: 0; background: transparent; cursor: pointer; font-size: 16px; padding: 2px 6px; color: #52606d; }
    .body { padding: 12px; }
    .min .body { display: none; }
    label { display: block; font-weight: 600; margin: 8px 0 4px; }
    .hint { font-weight: 400; color: #7b8794; font-size: 11px; }
    input[type=text], input[type=number], textarea { width: 100%; padding: 7px 8px; border: 1px solid #cbd2d9;
      border-radius: 6px; font-size: 13px; color: #1f2933; background: #fff; }
    textarea { height: 70px; resize: vertical; }
    .row { display: flex; gap: 8px; margin-top: 10px; }
    .row > * { flex: 1; }
    button.btn { padding: 8px 10px; border-radius: 6px; border: 1px solid #0b6bcb; background: #0b6bcb; color: #fff;
      font-weight: 600; cursor: pointer; font-size: 13px; }
    button.btn.secondary { background: #fff; color: #0b6bcb; }
    button.btn.danger { background: #fff; color: #c92a2a; border-color: #c92a2a; }
    button.btn:disabled { opacity: .45; cursor: default; }
    .status { margin-top: 10px; padding: 8px; background: #f0f4f8; border-radius: 6px; min-height: 34px; }
    .stats { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; margin-top: 8px; }
    .stat { background: #f9fafb; border: 1px solid #e4e7eb; border-radius: 6px; padding: 6px 8px; }
    .stat b { display: block; font-size: 16px; }
    .stat span { color: #7b8794; font-size: 11px; }
    details { margin-top: 10px; }
    summary { cursor: pointer; font-weight: 600; }
    .check { display: flex; align-items: center; gap: 6px; margin-top: 8px; font-weight: 400; }
    .delays { display: flex; gap: 8px; }
  `;

  const HTML = `
    <div class="panel" part="panel">
      <div class="head">
        <span class="title">ZexLeads Maps Extractor</span>
        <button class="icon-btn" data-act="min" title="Minimize">–</button>
      </div>
      <div class="body">
        <label for="kw">Search keyword</label>
        <input id="kw" type="text" placeholder="pest control new york">
        <label for="locs">Locations <span class="hint">(optional, one per line)</span></label>
        <textarea id="locs" placeholder="Brooklyn&#10;Queens&#10;10001"></textarea>
        <div class="hint">Google Maps shows up to about 120 results per search. Add neighborhoods or ZIP codes to collect every business in a city. Duplicates are removed.</div>
        <div class="row">
          <button class="btn" data-act="start">Start</button>
          <button class="btn secondary" data-act="pause" disabled>Pause</button>
          <button class="btn danger" data-act="stop" disabled>Stop</button>
        </div>
        <div class="status" id="status">Ready.</div>
        <div class="stats">
          <div class="stat"><b id="s-query">-</b><span>Search</span></div>
          <div class="stat"><b id="s-listed">0</b><span>In this list</span></div>
          <div class="stat"><b id="s-saved">0</b><span>Businesses saved</span></div>
          <div class="stat"><b id="s-emails">0</b><span>Emails found</span></div>
          <div class="stat"><b id="s-pending">0</b><span>Email checks left</span></div>
          <div class="stat"><b id="s-web">0</b><span>With website</span></div>
        </div>
        <label class="check"><input type="checkbox" id="only-email"> Export only rows with an email</label>
        <div class="row">
          <button class="btn" data-act="export">Export CSV</button>
          <button class="btn danger" data-act="clear">Clear data</button>
        </div>
        <details>
          <summary>Settings</summary>
          <label>Delay between businesses (seconds)</label>
          <div class="delays">
            <input id="min-delay" type="number" min="0" step="0.5" title="Minimum">
            <input id="max-delay" type="number" min="0" step="0.5" title="Maximum">
          </div>
          <label class="check"><input type="checkbox" id="deep-email"> Render JavaScript websites for emails (opens a minimized window)</label>
        </details>
      </div>
    </div>`;

  const host = document.createElement('div');
  host.id = 'zexleads-host';
  const shadow = host.attachShadow({ mode: 'open' });
  shadow.innerHTML = '<style>' + CSS + '</style>' + HTML;
  document.documentElement.appendChild(host);

  const $ = (sel) => shadow.querySelector(sel);
  const panel = $('.panel');
  const kw = $('#kw');
  const locs = $('#locs');
  const minDelay = $('#min-delay');
  const maxDelay = $('#max-delay');
  const deepEmail = $('#deep-email');
  const onlyEmail = $('#only-email');

  // Keep Maps keyboard shortcuts from firing while typing in the panel.
  for (const type of ['keydown', 'keyup', 'keypress']) {
    panel.addEventListener(type, (e) => e.stopPropagation());
  }

  // ---------- form persistence ----------

  async function loadForm() {
    const { panelForm, settings } = await chrome.storage.local.get(['panelForm', 'settings']);
    const s = Object.assign({}, Runner.DEFAULT_SETTINGS, settings || {});
    kw.value = (panelForm && panelForm.keyword) || Dom.searchBoxValue() || '';
    locs.value = (panelForm && panelForm.locations) || '';
    onlyEmail.checked = !!(panelForm && panelForm.onlyEmail);
    minDelay.value = s.minDelay;
    maxDelay.value = s.maxDelay;
    deepEmail.checked = s.deepEmail !== false;
    if (panelForm && panelForm.minimized) panel.classList.add('min');
  }

  function readSettings() {
    const min = Math.max(0, parseFloat(minDelay.value) || 0);
    const max = Math.max(min, parseFloat(maxDelay.value) || 0);
    return { minDelay: min, maxDelay: max, deepEmail: deepEmail.checked };
  }

  async function saveForm() {
    await chrome.storage.local.set({
      panelForm: {
        keyword: kw.value,
        locations: locs.value,
        onlyEmail: onlyEmail.checked,
        minimized: panel.classList.contains('min'),
      },
      settings: readSettings(),
    });
  }

  for (const el of [kw, locs, minDelay, maxDelay, deepEmail, onlyEmail]) el.addEventListener('change', saveForm);

  // ---------- actions ----------

  async function exportCsv() {
    const all = await chrome.storage.local.get(null);
    let rows = Core.mergeRecords(all);
    if (!rows.length) {
      S.status = 'Nothing to export yet.';
      return;
    }
    const pending = rows.filter((r) => r.emailStatus === 'Pending').length;
    if (
      pending &&
      !window.confirm(
        pending + ' email checks are still running. Export now? Those rows will have an empty Email column.',
      )
    ) {
      return;
    }
    if (onlyEmail.checked) rows = rows.filter((r) => r.email);
    const csv = Core.buildCsv(rows);
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = Core.csvFileName((all.job && all.job.label) || kw.value);
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
    S.status = 'Exported ' + rows.length + ' rows.';
  }

  async function clearData() {
    if (S.running) {
      S.status = 'Stop the run before clearing data.';
      return;
    }
    if (!window.confirm('Delete all saved businesses and emails?')) return;
    const all = await chrome.storage.local.get(null);
    const keys = Object.keys(all).filter((k) => k.startsWith('row:') || k.startsWith('email:'));
    keys.push('emailQueue', 'job');
    await chrome.storage.local.remove(keys);
    S.status = 'Data cleared.';
    refreshStats();
  }

  shadow.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-act]');
    if (!btn) return;
    const act = btn.getAttribute('data-act');
    if (act === 'min') {
      panel.classList.toggle('min');
      saveForm();
    } else if (act === 'start') {
      await saveForm();
      Runner.start({ keyword: kw.value, locations: locs.value.split('\n'), settings: readSettings() });
    } else if (act === 'pause') {
      if (S.running && !S.paused) Runner.pause();
      else Runner.resume();
    } else if (act === 'stop') {
      Runner.stop();
    } else if (act === 'export') {
      exportCsv();
    } else if (act === 'clear') {
      clearData();
    }
    renderState();
  });

  // ---------- dragging ----------

  (function enableDrag() {
    const head = $('.head');
    let start = null;
    head.addEventListener('mousedown', (e) => {
      if (e.target.closest('button')) return;
      const r = panel.getBoundingClientRect();
      start = { x: e.clientX, y: e.clientY, left: r.left, top: r.top };
      e.preventDefault();
    });
    window.addEventListener('mousemove', (e) => {
      if (!start) return;
      const left = Math.min(Math.max(0, start.left + e.clientX - start.x), window.innerWidth - 60);
      const top = Math.min(Math.max(0, start.top + e.clientY - start.y), window.innerHeight - 40);
      panel.style.left = left + 'px';
      panel.style.top = top + 'px';
      panel.style.right = 'auto';
    });
    window.addEventListener('mouseup', () => (start = null));
  })();

  // ---------- rendering ----------

  function renderState() {
    $('#status').textContent = S.status;
    $('#s-query').textContent = S.queryTotal ? S.queryIndex + 1 + ' / ' + S.queryTotal : '-';
    $('#s-listed').textContent = String(S.listed);
    $('[data-act="start"]').disabled = S.running;
    const pauseBtn = $('[data-act="pause"]');
    pauseBtn.disabled = !S.running && !S.pendingResume;
    pauseBtn.textContent = S.running && !S.paused ? 'Pause' : 'Resume';
    $('[data-act="stop"]').disabled = !S.running && !S.pendingResume;
    $('[data-act="clear"]').disabled = S.running;
  }

  let statsBusy = false;
  async function refreshStats() {
    if (statsBusy) return;
    statsBusy = true;
    try {
      const all = await chrome.storage.local.get(null);
      const rows = Core.mergeRecords(all);
      $('#s-saved').textContent = String(rows.length);
      $('#s-emails').textContent = String(rows.filter((r) => r.email).length);
      $('#s-pending').textContent = String((all.emailQueue || []).length);
      $('#s-web').textContent = String(rows.filter((r) => r.website).length);
    } catch (e) {
      /* extension reloaded */
    } finally {
      statsBusy = false;
    }
  }

  setInterval(renderState, 400);
  setInterval(refreshStats, 1500);

  loadForm().then(() => {
    renderState();
    refreshStats();
    Runner.resumeIfNeeded();
  });
})(globalThis);
