(function (PB) {
'use strict';

/**
 * Dev preview driver.
 *
 * Mounts the REAL Focus Shell (`createShell`) over a mock AI host page, driven
 * by the REAL pack / promptsmith / lens modules. Only storage and tab
 * orchestration are stubbed, so what you see here is the shipped component.
 *
 * Bundled to a classic IIFE because the browser cannot import the shell's
 * `.css` import directly.
 */




const TURNS = [
  {
    role: 'user',
    text: 'Our Node ingest service drops about 3% of uploads under load. Logs show occasional ECONNRESET from the upstream provider.\n\nConstraints: must stay on the current BullMQ queue library, no new infra, and the fix has to ship this week.',
  },
  {
    role: 'assistant',
    text: "The 5s `socketTimeout` races the 5s retry backoff, so a retry can fire while the original socket is still half-open.\n\n- Decision: exponential backoff with jitter, 100ms base, 8 attempts\n- Decision: set `socketTimeout` to 20s, pool cap of 64\n- Decision: keep BullMQ, add a `stalled` event listener\n\n```js\nconst delay = (n) => 100 * 2 ** n + Math.random() * 100;\n```\n\nNext step: wire the stalled-event listener and re-run the load profile.",
  },
  { role: 'user', text: 'Make the change and add a regression test that would have caught this.' },
  {
    role: 'assistant',
    text: 'Applied. The test fakes a socket that resets mid-flight and asserts we exhaust the backoff schedule instead of surfacing ECONNRESET.\n\nSuccess = `npm test -- ingest` stays green under `--repeat 200`.\n\nLet me know if you want me to add the pool-cap metric to the dashboard too.',
  },
];

const ANSWER = 'Applied. The test fakes a socket that resets mid-flight and asserts we exhaust the backoff schedule instead of surfacing ECONNRESET.\n\nSuccess = `npm test -- ingest` stays green under `--repeat 200`.\n\nLet me know if you want me to add the pool-cap metric to the dashboard too.';

const $ = (s) => document.querySelector(s);
const el = (id) => document.getElementById(id);

let settings = {};
let dna = null;
let pack = null;
let history = [];
let recording = false;
let flow = false;
let lastHotkey = 0;
let dict = null;
let shell = null; // assigned in boot(); the api below closes over it

const { createShell } = PB.shell;
const { buildPack, packForDestination, packSummaryLine } = PB.pack;
const { analyze, enhance } = PB.promptsmith;
const { applyLens, setReadingMode, looksTruncated, clearLensInPlace } = PB.lens;
// Aliased: the api object below defines a method of the same name, and an
// object method does not shadow an outer binding for its own body.
const { draftFollowUp: buildFollowUp } = PB.lens;
const { Dictionary } = PB.dictate;
const { getSettings, setSettings, savePack, getRuns, getDNA, recordPrompt, DESTINATIONS, getDictionary, saveDictionary, escapeHtml } = PB.SHARED;
const { seedIfNeeded } = PB.env;

/* ---------- mock host page ---------- */

function paintThread(turns) {
  el('thread').innerHTML = turns
    .map(
      (t) =>
        `<article data-role="${t.role}"><span class="who">${t.role === 'user' ? 'You' : 'Assistant'}</span>${escapeHtml(t.text)
          .replace(/```([\w-]*)\n([\s\S]*?)```/g, (_, l, b) => `<pre><code>${b}</code></pre>`)
          .replace(/\n\n/g, '<br><br>')
          .replace(/\n- /g, '<br>• ')}</article>`
    )
    .join('');
}

/* ---------- the mock adapter surface the shell talks to ---------- */

const api = {
  adapterId: () => 'chatgpt',
  siteLabel: () => 'ChatGPT',
  composerText: () => el('composer').value,

  submit() {
    recordPrompt(el('composer').value).then((d) => (dna = d));
    shell.toast('Sent', 'ok');
  },
  undo() {
    const prev = history.pop();
    if (prev == null) return shell.toast('Nothing to undo', 'err');
    el('composer').value = prev;
    shell.toast('Reverted');
  },
  newline() {
    el('composer').value = el('composer').value.replace(/\s+$/, '') + '\n';
  },
  async setSetting(patch) {
    settings = await setSettings(patch);
    shell.setSettings(settings);
    return settings;
  },

  async enhance({ apply = false } = {}) {
    const raw = el('composer').value;
    if (!raw.trim()) return shell.toast('Composer is empty — nothing to enhance.', 'err');
    const before = analyze(raw);
    const r = enhance(raw, { taskType: settings.playbook, dna });
    if (apply) {
      history.push(raw);
      el('composer').value = r.enhanced;
      shell.setAnalysis(analyze(r.enhanced));
      shell.toast(`Enhanced · ${before.score} → ${analyze(r.enhanced).score}/100`, 'ok');
    } else shell.setPreview({ dest: 'preview', text: r.enhanced });
    return r;
  },

  async capture() {
    pack = buildPack(TURNS, { sourceSite: 'ChatGPT', sourceUrl: location.href });
    await savePack(pack);
    shell.setPack(pack);
    shell.toast(`Captured · ${packSummaryLine(pack)}`, 'ok');
    return pack;
  },
  async sendTo(destId) {
    const p = pack || (await api.capture());
    const { text } = packForDestination(p, destId, { fidelity: settings.fidelity, doRedact: settings.redaction });
    const dest = DESTINATIONS.find((d) => d.id === destId);
    shell.setPreview({ dest: dest.label, text });
    el('handoff').textContent = `— would open ${dest.url} with a ${text.split(/\s+/).length}-word ${dest.label}-dialect prompt —`;
    shell.toast(`Opening ${dest.label}…`, 'ok');
  },
  async fanout(ids) {
    const list = ids?.length ? ids : DESTINATIONS.map((d) => d.id);
    shell.toast(`Fanned out to ${list.length} models`, 'ok');
    el('handoff').textContent = `— would open ${list.length} tabs in parallel and collect the answers into the compare board —`;
  },
  async promoteAnswer(dest) {
    const runs = await getRuns();
    const ans = runs[0]?.answers.find((x) => x.dest === dest);
    if (!ans?.text) return shell.toast('No answer captured from that model yet.', 'err');
    await api.capture();
    shell.toast(`Promoted the ${dest} answer into a new pack`, 'ok');
  },
  toggleDictate() {
    // Mirrors createDictation().toggle(): a double-tap while still recording
    // LATCHES Flow on rather than stopping, so the key can be released.
    const now = Date.now();
    const double = settings.flowMode !== false && now - lastHotkey < 600;
    if (recording) {
      if (!flow && double) {
        lastHotkey = 0;
        flow = true;
        shell.setRecording(true, true);
        shell.toast('Flow mode on — say “send it” or “stop listening”');
        return;
      }
      recording = flow = false;
      lastHotkey = 0;
      shell.setRecording(false, false);
      shell.toast('Stopped listening', 'ok');
      return;
    }
    lastHotkey = now;
    recording = true;
    flow = false;
    shell.setRecording(true, false);
    shell.toast('Listening… double-tap for hands-free');
  },
  setFlowMode(on) {
    flow = !!on;
    shell.setRecording(recording, flow);
    return flow;
  },
  stopDictate() {
    recording = false;
    flow = false;
    shell.setRecording(false, false);
  },
  speak() {
    shell.toast('Reading the last answer aloud (TTS)');
  },
  speakComposer() {
    shell.toast('Reading your prompt back (TTS)');
  },
  lensComposer(mode) {
    const raw = el('composer').value;
    if (!raw.trim()) return shell.toast('Composer is empty.', 'err');
    history.push(raw);
    const out = applyLens(raw, mode);
    el('composer').value = out;
    shell.toast(`${mode.toUpperCase()} applied to your prompt`, 'ok');
    return out;
  },
  refineComposer(instruction) {
    const raw = el('composer').value;
    if (!raw.trim()) return shell.toast('Composer is empty.', 'err');
    history.push(raw);
    el('composer').value = raw.replace(/\s+$/, '') + '\n\n' + instruction.replace(/\.$/, '') + '.';
    shell.toast('Directive added to your prompt', 'ok');
  },
  addWord(w) {
    if (!dict.add(w)) return shell.toast(`“${w}” is not term-shaped — skipped.`, 'err');
    saveDictionary(dict.entries).then(() => shell.setDictionary(dict.list()));
    shell.toast(`Added “${w}”`, 'ok');
  },
  removeWord(w) {
    dict.remove(w);
    saveDictionary(dict.entries).then(() => shell.setDictionary(dict.list()));
  },
  clearDictionary() {
    dict.clear();
    saveDictionary(dict.entries).then(() => shell.setDictionary(dict.list()));
    shell.toast('Vocabulary cleared', 'ok');
  },
  refreshDictionary() {
    shell.setDictionary(dict.list());
  },
  lens(mode) {
    const out = applyLens(ANSWER, mode);
    clearLensInPlace();
    el('lensOut').innerHTML = `<div class="lens-label">${mode.toUpperCase()}</div><pre>${escapeHtml(out)}</pre>`;
    shell.toast(`${mode.toUpperCase()} · ${out.length} chars`, 'ok');
    return out;
  },
  toggleReading() {
    const on = setReadingMode({ messageSel: 'article[data-role]' }, !document.documentElement.classList.contains('pb-reading'));
    settings = { ...settings, readingMode: on };
    shell.setSettings(settings);
    shell.toast(on ? 'Reading mode on — older turns dimmed' : 'Reading mode off', 'ok');
    return on;
  },
  draftFollowUp() {
    const text = buildFollowUp(pack, ANSWER);
    history.push(el('composer').value);
    el('composer').value = text;
    shell.toast('Follow-up drafted', 'ok');
  },
  diagnose() {
    shell.toast('Adapter OK · composer found · 4 turns parsed', 'ok');
    shell.setHealth({ adapter: 'chatgpt', label: 'ChatGPT', ok: true, composer: true, turns: 4 });
  },
  openLibrary() {
    location.href = 'library.html';
  },
  exportPacks: () => api.openLibrary(),
  importPacks: () => api.openLibrary(),
  clearAll: () => shell.toast('Would clear local storage (see the Data tab)', 'err'),
};

/* ---------- boot ---------- */

(async function boot() {
  await seedIfNeeded();
  settings = await getSettings();
  dna = await getDNA();
  dict = new Dictionary(await getDictionary());

  paintThread(TURNS);
  el('composer').value = 'fix my upload bug';

  shell = createShell({ api });
  shell.attach();
  shell.setSettings(settings);
  shell.setAnalysis(analyze(el('composer').value));
  shell.setSite('ChatGPT', true);
  shell.setDictionary(dict.list());
  shell.setCutoff(looksTruncated(ANSWER));

  el('composer').addEventListener('input', (e) => shell.setAnalysis(analyze(e.target.value)));

  // page-level launcher buttons
  for (const btn of document.querySelectorAll('[data-open]')) btn.onclick = () => shell.openDrawer(btn.dataset.open);
  el('pal').onclick = () => shell.openPalette();

  window.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      shell.openPalette();
    }
    if (e.key === 'Escape') shell.closeAll();
  });

  window.addEventListener('beforeunload', clearLensInPlace, { once: true });
  window.__pb = { shell, api };
})();
})(globalThis.PB = globalThis.PB || {});
