(function () {
'use strict';

const { DESTINATIONS, getPacks, getRuns, getSettings, setSettings, getDNA, savePack, deletePack, renderForDestination, estimateTokens, escapeHtml, relativeTime, LLM_PROVIDERS } = PB.SHARED;
const { seedIfNeeded, runtime, isExtension, tabs } = PB.env;

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];

let packs = [];
let runs = [];
let settings = {};
let dna = {};
let tab = 'packs';

/* ---------------- toast ---------------- */
let toastT;
function toast(msg, kind = '') {
  const t = $('#toast');
  t.textContent = msg;
  t.className = 'toast on ' + kind;
  clearTimeout(toastT);
  toastT = setTimeout(() => (t.className = 'toast ' + kind), 2600);
}

/* ---------------- data ---------------- */
async function load() {
  [packs, runs, settings, dna] = await Promise.all([getPacks(), getRuns(), getSettings(), getDNA()]);
  render();
}

/** Dispatch to the active tab's renderer. */
function render() {
  if (tab === 'packs') renderPacks();
  else if (tab === 'compare') renderRuns();
  else renderData();
}

/* ---------------- tabs ---------------- */
$$('[data-tab]').forEach((b) =>
  b.addEventListener('click', () => {
    tab = b.dataset.tab;
    $$('[data-tab]').forEach((x) => x.classList.toggle('on', x === b));
    ['packs', 'compare', 'data'].forEach((t) => ($('#tab-' + t).hidden = t !== tab));
    render();
  })
);

/* ---------------- packs ---------------- */
function filtered() {
  const q = $('#q').value.trim().toLowerCase();
  let list = q
    ? packs.filter((p) =>
        [p.title, p.summary, ...(p.decisions || []), ...(p.entities || [])].join(' ').toLowerCase().includes(q)
      )
    : [...packs];
  const s = $('#sort').value;
  if (s === 'old') list.reverse();
  if (s === 'big') list.sort((a, b) => b.turns.length - a.turns.length);
  if (s === 'tokens') list.sort((a, b) => b.meta.tokenEstimate - a.meta.tokenEstimate);
  return list;
}

const renderPacks = () => {
  const list = filtered();
  const el = $('#packs');
  const empty = $('#packs-empty');
  el.innerHTML = '';
  empty.innerHTML = '';

  if (!list.length) {
    empty.innerHTML = `<div class="empty">${
      packs.length ? 'No packs match that search.' : 'No packs yet.<br>Press <b>Ctrl+Shift+C</b> on any AI site to capture one.'
    }</div>`;
    return;
  }

  for (const p of list) {
    const card = document.createElement('div');
    card.className = 'card';
    card.innerHTML = `
      <div class="ttl">${escapeHtml(p.title)}</div>
      <div class="meta">${escapeHtml(p.meta.sourceSite)} · ${p.meta.messageCount} msgs · ~${p.meta.tokenEstimate}t ·
        ${escapeHtml(p.intent.taskType)} · ${escapeHtml(p.status)} · ${relativeTime(p.created)}</div>
      <div class="meta" style="margin-top:6px">${(p.decisions || []).length} decisions · ${(p.constraints || []).length} constraints ·
        ${(p.artifacts || []).length} artifacts · ${(p.openThreads || []).length} open</div>
      ${p.meta.redacted?.length ? `<div class="tag warn" style="margin-top:7px">redacted: ${p.meta.redacted.join(', ')}</div>` : ''}
      <div class="acts">
        <button data-view="${p.id}" class="pri">View prompt</button>
        <button data-send="${p.id}">Send to…</button>
        <button data-copy="${p.id}">Copy</button>
        <button data-del="${p.id}" class="danger" style="margin-left:auto">Delete</button>
      </div>`;
    el.appendChild(card);
  }
};

$('#packs').addEventListener('click', async (e) => {
  const id = e.target.dataset?.view || e.target.dataset?.send || e.target.dataset?.copy || e.target.dataset?.del;
  if (!id) return;
  const p = packs.find((x) => x.id === id);
  if (!p) return;

  if (e.target.dataset.view) return openPrompt(p);
  if (e.target.dataset.copy) {
    await navigator.clipboard.writeText(renderForDestination(p, 'claude', settings.fidelity));
    return toast('Copied in Claude dialect', 'ok');
  }
  if (e.target.dataset.send) return openPrompt(p, true);
  if (e.target.dataset.del) {
    await deletePack(id);
    await load();
    toast('Deleted');
  }
});

function openPrompt(p, pickDest = false) {
  const dlg = $('#dlg');
  let dest = 'claude';
  let fid = settings.fidelity || 'distilled';

  const paint = () => {
    const text = renderForDestination(p, dest, fid);
    $('#dlg-title').textContent = `${DESTINATIONS.find((d) => d.id === dest).label} · ${fid} · ~${estimateTokens(text)}t`;
    $('#dlg-body').innerHTML = `<div class="mono">${escapeHtml(text)}</div>`;
    $('#dlg-foot').innerHTML =
      `<select data-dest>${DESTINATIONS.map((d) => `<option value="${d.id}" ${d.id === dest ? 'selected' : ''}>${d.label}</option>`).join('')}</select>
       <select data-fid>${['distilled', 'full', 'atomic'].map((f) => `<option ${f === fid ? 'selected' : ''}>${f}</option>`).join('')}</select>
       <button data-copy class="pri">Copy</button>
       <button data-handoff>Open ${DESTINATIONS.find((d) => d.id === dest).label}</button>
       <span class="sp"></span><button data-close>Close</button>`;

    $('#dlg-foot').querySelector('[data-dest]').onchange = (e) => { dest = e.target.value; paint(); };
    $('#dlg-foot').querySelector('[data-fid]').onchange = (e) => { fid = e.target.value; paint(); };
    $('#dlg-foot').querySelector('[data-copy]').onclick = () => navigator.clipboard.writeText(text).then(() => toast('Copied', 'ok'));
    $('#dlg-foot').querySelector('[data-handoff]').onclick = async () => {
      if (!isExtension) return toast('Transfers need the extension installed', 'err');
      const runId = crypto.randomUUID();
      await runtime.send({ type: 'pb:send-pack', runId, text, dest, url: DESTINATIONS.find((d) => d.id === dest).url, autoSubmit: settings.autoSubmit, packTitle: p.title, quiet: true });
      toast('Opening ' + DESTINATIONS.find((d) => d.id === dest).label, 'ok');
      dlg.close();
    };
  };

  paint();
  if (pickDest) $('#dlg-foot').querySelector('[data-dest]')?.focus();
  dlg.showModal();
}

$('#dlg').addEventListener('click', (e) => { if (e.target.closest('[data-close]') || e.target === $('#dlg')) $('#dlg').close(); });
$('#q').addEventListener('input', renderPacks);
$('#sort').addEventListener('change', renderPacks);

/* ---------------- compare ---------------- */
function renderRuns() {
  const sel = $('#run');
  const el = $('#runs');
  const empty = $('#runs-empty');
  el.innerHTML = '';
  empty.innerHTML = '';

  if (!runs.length) {
    empty.innerHTML = `<div class="empty">No runs yet.<br>Open any AI thread and press <b>Ctrl+Shift+S</b> → fan out to all.</div>`;
    sel.innerHTML = '';
    return;
  }
  if (!sel.options.length) sel.innerHTML = runs.map((r) => `<option value="${r.id}">${escapeHtml((r.packTitle || 'Run').slice(0, 48))} — ${relativeTime(r.created)}</option>`).join('');
  const run = runs.find((r) => r.id === sel.value) || runs[0];

  for (const ans of run.answers || []) {
    const d = DESTINATIONS.find((x) => x.id === ans.dest);
    const card = document.createElement('div');
    card.className = 'card';
    card.innerHTML = `
      <div class="row" style="margin-bottom:9px">
        <span class="sw" style="background:${d?.accent || '#555'}"></span>
        <b>${escapeHtml(d?.label || ans.dest)}</b>
        <span class="sp"></span>
        <span class="tag ${ans.state === 'done' ? 'ok' : ans.state === 'running' ? 'warn' : 'err'}">${escapeHtml(ans.state)}</span>
        ${ans.ms ? `<span class="tag">${(ans.ms / 1000).toFixed(1)}s</span>` : ''}
      </div>
      <div class="mono answer">${ans.text ? escapeHtml(ans.text) : '<span style="color:var(--dim)">waiting for this model…</span>'}</div>
      <div class="acts">
        <button data-c="${run.id}|${ans.dest}">Copy</button>
        <button data-p="${run.id}|${ans.dest}" class="pri">Use as pack</button>
      </div>`;
    el.appendChild(card);
  }
}

$('#run').addEventListener('change', renderRuns);
$('#runs').addEventListener('click', async (e) => {
  const [runId, dest] = (e.target.dataset.c || e.target.dataset.p || '').split('|');
  if (!runId) return;
  const ans = runs.find((r) => r.id === runId)?.answers.find((a) => a.dest === dest);
  if (!ans?.text) return toast('No answer captured yet', 'err');
  if (e.target.dataset.c) return navigator.clipboard.writeText(ans.text).then(() => toast('Copied', 'ok'));
  if (e.target.dataset.p) {
    const pack = {
      v: 1, id: crypto.randomUUID(), created: Date.now(),
      title: `Continue from ${dest}: ${ans.text.slice(0, 60)}…`,
      intent: { goal: `Continue the work from the ${dest} answer below.`, taskType: 'other' },
      status: 'active',
      summary: ans.text.slice(0, 1200),
      decisions: [], constraints: [], openThreads: [], artifacts: [], entities: [],
      turns: [],
      meta: { sourceSite: dest, sourceUrl: '', messageCount: 1, lastUser: ans.text.slice(0, 600), tokenEstimate: estimateTokens(ans.text), redacted: [] },
    };
    await savePack(pack);
    await load();
    toast('Saved as a new Context Pack', 'ok');
  }
});

/* ---------------- data ---------------- */
function renderData() {
  const bytes = JSON.stringify(packs).length + JSON.stringify(runs).length;
  $('#stats').innerHTML = [
    ['Packs', packs.length],
    ['Runs', runs.length],
    ['Answers collected', runs.reduce((a, r) => a + (r.answers || []).filter((x) => x.text).length, 0)],
    ['Storage', (bytes / 1024).toFixed(1) + 'kb'],
  ].map(([l, n]) => `<div class="card"><div class="n">${n}</div><div class="l">${l}</div></div>`).join('');

  const advice =
    dna.prompts < 5
      ? 'Not enough signal yet — PromptBridge is watching, but it needs about five prompts before it will adjust itself.'
      : `Based on ${dna.prompts} prompts you have sent: average ${dna.avgLen} characters, you specify your own output format ${Math.round((dna.withFormat / dna.prompts) * 100)}% of the time, and you write short prompts ${Math.round((dna.terse / dna.prompts) * 100)}% of the time. Only counters are stored — never your text.`;

  $('#dna').innerHTML = `<p style="margin:0 0 10px">${advice}</p>
    <div class="row wrap">${['prompts', 'withFormat', 'terse', 'examples', 'avgLen'].map((k) => `<span class="tag">${k}: ${dna[k] ?? 0}</span>`).join('')}</div>`;

  $('#keys').innerHTML = LLM_PROVIDERS.map((p) => {
    const key = settings.llmKeys?.[p.id] || '';
    return `<div class="row"><span class="grow">${p.label}</span>
      <input type="password" data-key="${p.id}" placeholder="${key ? '••••••••' : p.placeholder}" style="width:170px" value="${escapeHtml(key)}"></div>`;
  }).join('');
}

$('#keys').addEventListener('change', async (e) => {
  const id = e.target.dataset.key;
  if (!id) return;
  const llmKeys = { ...(settings.llmKeys || {}), [id]: e.target.value.trim() };
  if (!llmKeys[id]) delete llmKeys[id];
  settings = await setSettings({ llmKeys });
  toast('Key saved locally', 'ok');
});

/* ---------------- actions ---------------- */
document.addEventListener('click', async (e) => {
  const act = e.target.dataset?.act;
  if (!act) return;

  if (act === 'export') {
    const blob = new Blob([JSON.stringify({ v: 1, exported: Date.now(), packs }, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `promptbridge-packs-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
    toast(`Exported ${packs.length} packs`, 'ok');
  }
  if (act === 'copy-json') {
    await navigator.clipboard.writeText(JSON.stringify({ v: 1, packs }, null, 2));
    toast('Copied as JSON', 'ok');
  }
  if (act === 'import') $('#file').click();
  if (act === 'clear') {
    if (!confirm('Delete all packs, runs and style DNA on this device? This cannot be undone.')) return;
    for (const p of packs) await deletePack(p.id);
    await runtime.send({ type: 'pb:clear-all' }).catch(() => {});
    await load();
    toast('Cleared');
  }
  if (act === 'reopen' || act === 'send-panel') {
    if (!isExtension) return toast('This needs the extension installed', 'err');
    const [tab] = await tabs.active();
    chrome.tabs.sendMessage(tab.id, { type: 'pb:open-panel', panel: act === 'reopen' ? 'runs' : 'send' }).catch(() => {});
    window.close();
  }
});

$('#file').addEventListener('change', async (e) => {
  const file = e.target.files?.[0];
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    const list = Array.isArray(data) ? data : data.packs;
    if (!Array.isArray(list)) throw new Error('no packs array');
    for (const p of list) await savePack(p);
    await load();
    toast(`Imported ${list.length} packs`, 'ok');
  } catch (err) {
    toast('Could not read that file: ' + err.message, 'err');
  }
});

/* ---------------- boot ---------------- */
async function main() {
  await seedIfNeeded();
  settings = await getSettings();
  $('#mode').textContent = isExtension ? 'installed' : 'preview \u00b7 demo data';
  $('#mode').classList.toggle('live', isExtension);
  if (location.hash === 'data') $('[data-tab=data]').click();
  await load();
}
main();
})();
