(function () {
'use strict';

const { DESTINATIONS, getSettings, setSettings, escapeHtml } = PB.SHARED;
const { isExtension, runtime, tabs } = PB.env;

const $ = (s) => document.querySelector(s);
let settings = {};
let activeTab = null;

async function boot() {
  activeTab = await tabs.active();
  if (!activeTab || !/^https?:/.test(activeTab.url || '')) return void ($('#site').textContent = 'not a web page');

  $('#site').textContent = new URL(activeTab.url).hostname.replace(/^www\./, '');

  const r = await runtime.send({ type: 'pb:ping-tab', tabId: activeTab.id }).catch(() => null);
  if (r?.ok) {
    $('#health').textContent = r.result.label;
    $('#health').className = 'tag ' + (r.result.healthy ? 'ok' : 'err');
    $('#capture').disabled = false;
    await refreshPack();
  } else {
    $('#health').textContent = 'not active here';
    $('#health').className = 'tag err';
    $('#capture').disabled = true;
  }
}

async function refreshPack() {
  // PEEK, not capture. Opening the popup is a glance, not an action: the old
  // pb:capture here saved a duplicate pack and toasted the page every time
  // the toolbar icon was clicked.
  const r = await runtime.send({ type: 'pb:peek-pack' }).catch(() => null);
  if (!r?.ok || !r.pack) return;
  const pack = r.pack;
  $('#ttl').textContent = r.pack.title;
  $('#meta').textContent =
    `${r.pack.meta.messageCount} msgs · ~${r.pack.meta.tokenEstimate} tokens · ${r.pack.intent.taskType} · ` +
    `${r.pack.decisions.length} decisions · ${r.pack.openThreads.length} open`;
}

function renderDests() {
  $('#dests').innerHTML = DESTINATIONS.map(
    (d) => `<div class="dest" data-dest="${d.id}"><span class="sw" style="background:${d.accent}"></span><span class="sp">${d.label}</span></div>`
  ).join('');
  document.querySelectorAll('[data-dest]').forEach((el) =>
    el.addEventListener('click', async () => {
      // the in-page panel owns the transfer so you see the preview before it goes
      await tabs.send(activeTab.id, { type: 'pb:open-panel', panel: 'send' }).catch(() => {});
      window.close();
    })
  );
}

const ask = (msg) =>
  tabs.send(activeTab.id, { type: 'pb:open-panel', panel: msg }).then(() => window.close()).catch(() => window.close());

$('#capture').onclick = async () => {
  await runtime.send({ type: 'pb:open-popup', panel: 'send' }).catch(() => {});
  window.close();
};
$('#fanout').onclick = () => ask('send');
$('#library').onclick = () => {
  if (isExtension) chrome.tabs.create({ url: chrome.runtime.getURL('library.html') });
  window.close();
};
$('#fid').onchange = async (e) => {
  settings = await setSettings({ fidelity: e.target.value });
  await tabs.send(activeTab.id, { type: 'pb:open-panel', panel: 'send' }).catch(() => {});
};
$('#redact').onchange = (e) => setSettings({ redaction: e.target.checked });
$('#autosub').onchange = (e) => setSettings({ autoSubmit: e.target.checked });
$('#collect').onchange = (e) => setSettings({ collectAnswers: e.target.checked });

async function main() {
  settings = await getSettings();
  $('#fid').value = settings.fidelity;
  $('#redact').checked = settings.redaction !== false;
  $('#autosub').checked = !!settings.autoSubmit;
  $('#collect').checked = settings.collectAnswers !== false;
  renderDests();
  await boot();
}
main();
})();
