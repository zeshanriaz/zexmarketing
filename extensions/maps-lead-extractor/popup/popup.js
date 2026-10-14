(function () {
  'use strict';

  const Core = globalThis.ZexCore;
  const $ = (id) => document.getElementById(id);

  async function refresh() {
    const all = await chrome.storage.local.get(null);
    const rows = Core.mergeRecords(all);
    $('saved').textContent = String(rows.length);
    $('emails').textContent = String(rows.filter((r) => r.email).length);
    $('pending').textContent = String((all.emailQueue || []).length);
  }

  $('open').addEventListener('click', () => {
    chrome.tabs.create({ url: 'https://www.google.com/maps' });
  });

  $('export').addEventListener('click', async () => {
    const all = await chrome.storage.local.get(null);
    let rows = Core.mergeRecords(all);
    if (!rows.length) {
      $('msg').textContent = 'Nothing to export yet.';
      return;
    }
    if (all.panelForm && all.panelForm.onlyEmail) rows = rows.filter((r) => r.email);
    const blob = new Blob([Core.buildCsv(rows)], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = Core.csvFileName(all.job && all.job.label);
    a.click();
    const pending = rows.filter((r) => r.emailStatus === 'Pending').length;
    $('msg').textContent =
      'Exported ' + rows.length + ' rows.' + (pending ? ' ' + pending + ' emails still pending.' : '');
  });

  refresh();
  setInterval(refresh, 1500);
})();
