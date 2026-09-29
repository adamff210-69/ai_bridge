(function () {
'use strict';

const { getSettings, setSettings, DESTINATIONS, escapeHtml } = PB.SHARED;
const { isExtension, runtime, seedIfNeeded } = PB.env;

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];

const EXTRA_SITES = [
  { id: 'you', label: 'You.com', url: 'https://you.com/' },
  { id: 'deepseek', label: 'DeepSeek', url: 'https://chat.deepseek.com/' },
  { id: 'kimi', label: 'Kimi', url: 'https://kimi.moonshot.cn/' },
  { id: 'mistral', label: 'Mistral', url: 'https://www.mistral.ai/chat' },
];

let settings = {};
let step = 0;

const toast = (m, k = '') => {
  const t = $('#toast');
  t.textContent = m;
  t.className = 'toast on ' + k;
  setTimeout(() => (t.className = 'toast ' + k), 2600);
};

/* ---------------- navigation ---------------- */

const HELP = {
  tier: {
    webspeech: 'Uses the browser’s built-in recogniser. Free and instant. Audio is handled by whoever built your browser. Nothing is bundled: a 45kb extension that becomes 45MB is a different product, and most people would rather not carry that. Switch to Local Whisper and run the model yourself — the choice is a privacy decision, and it should be yours to make.',
    'whisper-local': 'Point at a whisper.cpp / faster-whisper / LocalAI server on your own machine. Audio never leaves your machine. Nothing is bundled — a 45kb extension that becomes 45MB is a different product.',
  },
  fid: {
    distilled: 'A short brief: goal, decisions, constraints, artifacts. This is what a fresh model can actually use.',
    full: 'The verbatim transcript. Use it when nuance matters more than token cost.',
    atomic: 'Just the artifacts — a code block, a table. Use it to carry output forward and nothing else.',
  },
};

function go(n) {
  step = n;
  $$('.step').forEach((s, i) => s.classList.toggle('on', i === n));
  $$('.steps i').forEach((s, i) => s.classList.toggle('on', i <= n));
}

/**
 * `data-val` is a string by the nature of HTML attributes. Without this, a
 * button that turns a flag off would store the string "false" — which is
 * truthy, so the flag would appear to stay on forever.
 */
const asSetting = (v) => (v === 'true' ? true : v === 'false' ? false : v);

document.addEventListener('click', async (e) => {
  const to = e.target.dataset?.go;
  if (to != null) return go(Number(to));

  const set = e.target.dataset?.set;
  if (set) {
    settings = await setSettings({ [set]: asSetting(e.target.dataset.val) });
    paintOptions();
    if (set === 'dictateTier') $('#tierhelp').textContent = HELP.tier[settings.dictateTier];
    if (set === 'fidelity') $('#fidhelp').textContent = HELP.fid[settings.fidelity];
  }
});

$('#finish').addEventListener('click', async () => {
  settings = await setSettings({ redaction: $('#redact').checked, onboarded: true });
  if (isExtension) {
    await runtime.send({ type: 'pb:open-page', page: 'library.html' }).catch(() => {});
  }
  toast('Done — press Ctrl+Shift+K on any AI site', 'ok');
  setTimeout(() => window.close(), 900);
});

/* ---------------- sites ---------------- */

function paintSites() {
  const sites = [...DESTINATIONS.map((d) => ({ id: d.id, label: d.label })), ...EXTRA_SITES];
  $('#sites').innerHTML = sites
    .map((s) => {
      const on = settings.sites?.[s.id]?.enabled !== false;
      return `<div class="site ${on ? '' : 'off'}" data-site="${s.id}">
        <input type="checkbox" ${on ? 'checked' : ''} style="pointer-events:none">
        <span>${escapeHtml(s.label)}</span></div>`;
    })
    .join('');
}

$('#sites').addEventListener('click', async (e) => {
  const el = e.target.closest('[data-site]');
  if (!el) return;
  const id = el.dataset.site;
  // flip in place — a full re-render would detach the node mid-click and lose focus
  const enabled = el.classList.contains('off');
  el.classList.toggle('off', !enabled);
  const box = el.querySelector('input');
  if (box) box.checked = enabled;
  settings = await setSettings({ sites: { ...(settings.sites || {}), [id]: { enabled } } });
});

/* ---------------- option buttons ---------------- */

function paintOptions() {
  $$('[data-set][data-val]').forEach((b) => b.classList.toggle('pri', settings[b.dataset.set] === asSetting(b.dataset.val)));
}

async function main() {
  await seedIfNeeded();
  settings = await getSettings();
  paintSites();
  paintOptions();
  $('#tierhelp').textContent = HELP.tier[settings.dictateTier] || HELP.tier.webspeech;
  $('#fidhelp').textContent = HELP.fid[settings.fidelity] || HELP.fid.distilled;
  $('#redact').checked = settings.redaction !== false;
  go(0);
}
main();
})();
