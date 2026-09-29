/* PromptBridge — loaded as a plain script, no bundler. */
(function (PB) {
'use strict';
const { resolveAdapter, patchComposer, submitComposer, readComposer, lastMessageEl } = PB.adapters;
const { buildPack, packForDestination, packSummaryLine } = PB.pack;
const { analyze, enhance, llmEnhance } = PB.promptsmith;
const { createDictation, runCommand, Dictionary } = PB.dictate;
const { createShell } = PB.shell;
const { applyLens, showLensInPlace, clearLensInPlace, setReadingMode, restoreReadingMode, refreshReadingMode, readingModeOn, looksTruncated, draftFollowUp } = PB.lens;
const { watchComposer, watchThread, watchAnswer, lastText, idle } = PB.observe;
const store = PB.SHARED;
const { runtime } = PB.env;

/**
 * Content script — wiring for the five engines.
 *
 * Performance rules this file follows, because they are the difference between
 * an extension people keep and one they disable:
 *   · no polling of the composer (an observer + `input` event instead)
 *   · the shell's DOM is built only when it is first opened
 *   · analysis runs inside idle callbacks
 *   · nothing is computed on page load beyond one adapter resolve
 */

const { DESTINATIONS, DEFAULT_SETTINGS, getSettings, setSettings, getDNA, recordPrompt, savePack, getPacks, getRuns, uid, getDictionary, saveDictionary } = store;

// `let`, not `const`: boot() re-resolves once settings are known, so a site
// the user disabled in onboarding genuinely loses its hint (structural
// detection still works — that is the whole architecture).
let adapter = resolveAdapter();

let settings = { ...DEFAULT_SETTINGS };
let dna = null;
let dictation = null;
let history = [];
let currentPack = null;
let lastUserCount = 0;
let dictionary = null;
let injectedBar = null;
let dictEntries = {};

let mounted = false;
let shell = null; // assigned once `api` exists — createShell touches it while building

/* ================================================================== *
 * Engine 1 — Context Pack
 * ================================================================== */

async function capture({ silent = false, save = true } = {}) {
  const turns = adapter.turns().filter((t) => t.text);
  if (!turns.length) {
    if (!silent) shell.toast('No conversation found on this page.', 'err');
    return null;
  }
  const pack = buildPack(turns, { sourceSite: adapter.label, sourceUrl: location.href });
  currentPack = pack;
  if (save) {
    injectedBar?.refresh();
    await savePack(pack).catch(() => {});
    if (mounted) shell.setPack(pack);
  }
  if (!silent) shell.toast(`Captured · ${packSummaryLine(pack)}`, 'ok');
  return pack;
}

async function sendTo(destId, opts = {}) {
  const pack = currentPack || (await capture({ silent: true }));
  if (!pack) return shell.toast('Nothing to send — this page has no conversation.', 'err');
  const dest = DESTINATIONS.find((d) => d.id === destId);
  if (!dest) return;

  const { text } = packForDestination(pack, destId, { fidelity: settings.fidelity, doRedact: settings.redaction });
  if (mounted) shell.setPreview({ dest: dest.label, text });

  const runId = opts.runId || uid();
  try {
    await storeMsg({
      type: 'pb:send-pack',
      runId,
      text,
      dest: destId,
      url: dest.url,
      autoSubmit: settings.autoSubmit,
      packTitle: pack.title,
      quiet: true,
    });
    shell.toast(`Opening ${dest.label}…`, 'ok');
  } catch (e) {
    shell.toast('Could not hand off: ' + (e?.message || 'service worker asleep'), 'err');
  }
}

async function fanout(destIds) {
  const ids = destIds?.length ? destIds : DESTINATIONS.map((d) => d.id);
  const pack = currentPack || (await capture({ silent: true }));
  if (!pack) return shell.toast('Nothing to fan out.', 'err');
  const runId = uid();

  for (const id of ids) {
    const dest = DESTINATIONS.find((d) => d.id === id);
    const { text } = packForDestination(pack, id, { fidelity: settings.fidelity, doRedact: settings.redaction });
    storeMsg({ type: 'pb:send-pack', runId, text, dest: id, url: dest.url, autoSubmit: settings.autoSubmit, packTitle: pack.title, quiet: true });
  }
  shell.toast(`Fanned out to ${ids.length} models`, 'ok');
  if (mounted) setTimeout(() => getRuns().then((r) => shell.setRuns(r)), 900);
}

/** Take a model's answer from the compare board and keep working from it. */
async function promoteAnswer(dest) {
  const runs = await getRuns();
  const run = runs[0];
  const ans = run?.answers.find((x) => x.dest === dest);
  if (!ans?.text) return shell.toast('No answer captured from that model yet.', 'err');
  const turns = [
    { role: 'user', text: `Continue this work. Previous model (${dest}) produced:\n\n${ans.text}` },
  ];
  const pack = buildPack(turns, { sourceSite: adapter.label, sourceUrl: location.href });
  currentPack = pack;
  await savePack(pack);
  if (mounted) shell.setPack(pack);
  shell.toast('Promoted to a new Context Pack', 'ok');
}

/* ================================================================== *
 * Engine 2 — Promptsmith
 * ================================================================== */

async function runEnhance({ apply = false, llm = false } = {}) {
  const io = patchComposer(adapter);
  const raw = io?.get() || '';
  if (!raw.trim()) {
    if (mounted) shell.toast('Composer is empty — nothing to enhance.', 'err');
    return { enhanced: '' };
  }

  if (llm) {
    const key = settings.llmKeys?.[mounted ? shell.provider : 'anthropic'];
    if (!key) {
      if (mounted) shell.toast('No API key — add one in the popup. Tier 2 never goes through us.', 'err');
      return { enhanced: '' };
    }
    try {
      const enhanced = await llmEnhance(raw, { provider: shell.provider, key, taskType: settings.playbook });
      if (apply && io) { history.push(raw); io.set(enhanced); }
      return { enhanced };
    } catch (e) {
      if (mounted) shell.toast(e.message, 'err');
      return { enhanced: raw };
    }
  }

  const before = analyze(raw);
  const r = enhance(raw, { taskType: settings.playbook, dna });
  const after = analyze(r.enhanced);
  if (apply && io) {
    history.push(raw);
    io.set(r.enhanced);
    if (mounted) { shell.setAnalysis(after); shell.toast(`Enhanced · ${before.score} → ${after.score}/100`, 'ok'); }
  }
  return r;
}

/**
 * "Cook this prompt" — the one-click enhancer, reachable from the page.
 *
 * Tier 1 only, on purpose: it is deterministic, costs nothing, and never sends
 * the prompt anywhere. Somebody mid-sentence in another site's composer is not
 * going to wait on a network round trip or hand over a key, so the button that
 * sits next to the box has to be the one that always works.
 */
function cookPrompt() {
  const io = patchComposer(adapter);
  const raw = io?.get() || '';
  if (!raw.trim()) {
    shell.toast('Type or dictate a prompt first.', 'err');
    return { enhanced: '' };
  }
  const before = analyze(raw);
  const r = enhance(raw, { taskType: settings.playbook, dna });
  const after = analyze(r.enhanced);
  history.push(raw);
  io.set(r.enhanced);
  shell.setAnalysis(after);
  shell.toast(before.score === after.score ? 'Prompt is already well-formed' : `Cooked · ${before.score} → ${after.score}/100`, 'ok');
  return r;
}

/* ---------------- the pack tray ---------------- */

const listPacks = () => getPacks();

async function dropPack(id, opts = {}) {
  const packs = await getPacks();
  const pack = packs.find((p) => p.id === id);
  if (!pack) return shell.toast('That pack is gone.', 'err');
  const io = patchComposer(adapter);
  if (!io) return shell.toast('No composer on this page to drop into.', 'err');

  const fidelity = opts.fidelity || settings.fidelity;
  const { text } = packForDestination(pack, adapter.id, { fidelity, doRedact: settings.redaction });
  history.push(io.get());
  io.set(text);
  currentPack = pack;
  if (mounted) shell.setPack(pack);
  shell.toast(`Dropped "${pack.title}" · ${text.length} chars · ${fidelity}`, 'ok');
  return text;
}

async function copyPack(id) {
  const packs = await getPacks();
  const pack = packs.find((p) => p.id === id);
  if (!pack) return;
  const { text } = packForDestination(pack, adapter.id, { fidelity: settings.fidelity, doRedact: settings.redaction });
  navigator.clipboard?.writeText(text).then(
    () => shell.toast('Pack copied to the clipboard', 'ok'),
    () => shell.toast('Clipboard blocked by the page', 'err')
  );
}

/** Settings that a live dictation listener captured at construction time. */
const DICTATE_KEYS = ['dictateLang', 'dictateTier', 'whisperUrl', 'whisperKey', 'stripFillers', 'smartCorrections', 'learnDictionary', 'flowMode'];

/* ================================================================== *
 * Engine 3 — Dictate
 *
 * Four capabilities, wired to one recogniser:
 *   1. self-correction   — "budget 50K, actually 75K" rewrites in place
 *   2. Flow mode         — double-tap the hotkey, then say "send it"
 *   3. vocabulary        — the words you retype get learned, locally
 *   4. command mode      — "bullet list", "more formal", "send to claude"
 * ================================================================== */

function ensureDictionary() {
  if (dictionary) return dictionary;
  dictionary = new Dictionary(dictEntries);
  return dictionary;
}

/** What dictation last wrote, so an edit can be told apart from a fresh phrase. */
let lastDictated = '';
let dictatedAt = 0;

function ensureDictation() {
  if (dictation) return dictation;
  dictation = createDictation(patchComposer(adapter), {
    lang: settings.dictateLang,
    tier: settings.dictateTier,
    whisper: { url: settings.whisperUrl, key: settings.whisperKey },
    stripFillers: settings.stripFillers,
    smartCorrections: settings.smartCorrections !== false,
    learnDictionary: settings.learnDictionary !== false,
    dictionary: ensureDictionary(),
    onState: ({ listening, flow }) => shell.setRecording(listening, flow),
    onCommand: (cmd) => handleVoiceCommand(cmd),
    onText: (text) => { lastDictated = text; dictatedAt = Date.now(); },
    onLearn: (words) => {
      saveDictionary(ensureDictionary().entries);
      shell.toast(`Learned: ${words.join(', ')}`, 'ok');
    },
    onError: (m) => shell.toast(m, 'err'),
  });
  return dictation;
}

/**
 * Spoken commands run against whatever is in the composer — the text you just
 * dictated. `shell.actions` already points every one of them at the composer.
 */
function handleVoiceCommand(cmd) {
  const label = { send: 'Sent', undo: 'Undone', stop: 'Stopped', newline: 'New line', speak: 'Reading back', enhance: 'Enhanced', followup: 'Follow-up drafted', capture: 'Pack captured', sendTo: 'Sent to ' + cmd.dest, lens: 'Re-shaped: ' + cmd.mode, refine: 'Refining' }[cmd.kind];
  const done = runCommand(cmd, shell);
  if (done && label) shell.toast(label, 'ok');
  return done;
}

/**
 * Watch for the user fixing a word we just dictated. The comparison is
 * time-boxed to 20s so ordinary typing later is never mined for vocabulary.
 */
function watchDictationEdits() {
  watchComposer(adapter, (v) => {
    // Read the setting live, not at registration: the user can turn learning
    // off mid-session and expect it to actually stop.
    if (!settings.learnDictionary) return;
    if (!lastDictated || Date.now() - dictatedAt > 20000) return;
    if (v === lastDictated || !v.startsWith(lastDictated.slice(0, 12))) return;
    const learned = dictation?.learn(lastDictated, v) || [];
    if (learned.length) lastDictated = v;
  });
}

let lastHotkey = 0;

/** Persist the dictionary and refresh the settings panel. */
const pushDictionary = () => {
  const d = ensureDictionary();
  saveDictionary(d.entries);
  shell.setDictionary(d.list());
  return d;
};

const addWord = (w) => {
  const d = ensureDictionary();
  if (!d.add(w)) return shell.toast(`“${w}” is not term-shaped — skipped.`, 'err');
  pushDictionary();
  shell.toast(`Added “${w}”`, 'ok');
  return true;
};

const removeWord = (w) => {
  const d = ensureDictionary();
  const ok = d.remove(w);
  pushDictionary();
  return ok;
};

const clearWords = () => {
  const d = ensureDictionary();
  d.clear();
  pushDictionary();
  shell.toast('Vocabulary cleared', 'ok');
};

const toggleDictate = () => {
  const d = ensureDictation();
  if (!d.supported) {
    return shell.toast(settings.dictateTier === 'whisper-local' ? 'MediaRecorder is unavailable here.' : 'Speech recognition is unavailable in this browser.', 'err');
  }
  // Double-tap within 600ms locks dictation on for hands-free use.
  const now = Date.now();
  const isDoubleTap = settings.flowMode !== false && now - lastHotkey < 600;
  lastHotkey = isDoubleTap ? 0 : now;
  d.toggle({ flow: isDoubleTap });
  shell.setRecording(d.listening, d.flow);
  if (d.listening && d.flow) shell.toast('Flow mode on — say "send it" or "stop listening"', 'ok');
};

const setFlowMode = (on) => {
  const d = ensureDictation();
  d.setFlow(on);
  shell.setRecording(d.listening, d.flow);
  return d.flow;
};

const speak = () => {
  const last = [...adapter.turns()].reverse().find((t) => t.role === 'assistant');
  if (!last) return shell.toast('No answer to read.', 'err');
  ensureDictation().speak(last.text, settings.readAloudRate);
};

/* ================================================================== *
 * Engine 4 — Lens, reading mode, auto-continue
 * ================================================================== */

function lens(mode) {
  const src = lastText(adapter);
  if (!src) return shell.toast('No answer on the page yet.', 'err');
  const out = applyLens(src, mode);
  if (settings.lensInPlace !== false) {
    const r = showLensInPlace(adapter, mode);
    if (r.ok) { shell.toast(`${mode.toUpperCase()} shown inline`, 'ok'); return out; }
  }
  navigator.clipboard?.writeText(out).then(
    () => shell.toast(`${mode.toUpperCase()} · copied (${out.length} chars)`, 'ok'),
    () => shell.toast('Clipboard blocked by the page', 'err')
  );
  return out;
}

const toggleReading = () => {
  const on = setReadingMode(adapter, !document.documentElement.classList.contains('pb-reading'));
  settings = { ...settings, readingMode: on };
  // The pill is the escape hatch: a page-wide effect must always leave a
  // visible, one-click way to undo it, even after a reload.
  shell.setReading(on);
  shell.toast(on ? 'Reading mode on — older turns dimmed' : 'Reading mode off', 'ok');
  if (mounted) shell.setSettings(settings);
  return on;
};

const doFollowUp = () => {
  const io = patchComposer(adapter);
  if (!io) return;
  const text = draftFollowUp(currentPack, lastText(adapter));
  history.push(io.get());
  io.set(text);
  shell.toast('Follow-up drafted', 'ok');
  if (mounted) shell.setCutoff(false);
};

/* ================================================================== *
 * Engine 5 — Health
 * ================================================================== */

function diagnose() {
  const h = adapter.diagnose();
  const result = { adapter: adapter.id, label: adapter.label, ...h, explain: adapter.explain?.() };
  // Opening the health panel IS the action, so this must not be gated on the
  // panel having been opened before — that would make the first check a no-op.
  shell.setHealth(result);
  shell.openDrawer('health');
  shell.toast(
    h.ok ? `Found ${h.turns} turns on ${adapter.label} · ${h.ms}ms` : 'No chat composer detected on this page.',
    h.ok ? 'ok' : 'err'
  );
  return result;
}

/* ================================================================== *
 * Shell API
 * ================================================================== */

const api = {
  adapterId: () => adapter.id,
  siteLabel: () => adapter.label,
  composerText: () => readComposer(adapter),

  submit() {
    const raw = readComposer(adapter);
    if (raw.trim()) recordPrompt(raw).then((d) => (dna = d));
    submitComposer(adapter);
    shell.toast('Sent', 'ok');
  },
  undo() {
    const prev = history.pop();
    if (prev == null) return shell.toast('Nothing to undo', 'err');
    patchComposer(adapter)?.set(prev);
    shell.toast('Reverted');
  },
  newline() {
    const io = patchComposer(adapter);
    if (io) io.set(io.get().replace(/\s+$/, '') + '\n');
  },

  /**
   * Command mode targets the composer, not the last answer. The lens transform
   * is the same local one the shell uses on answers — no tokens, no re-prompt.
   */
  lensComposer(mode) {
    const io = patchComposer(adapter);
    const raw = io?.get() || '';
    if (!raw.trim()) return shell.toast('Composer is empty.', 'err');
    history.push(raw);
    const out = applyLens(raw, mode);
    io.set(out);
    lastDictated = out;
    shell.toast(`${mode.toUpperCase()} applied to your prompt`, 'ok');
    return out;
  },

  /**
   * Refine cannot translate or de-register text locally without shipping a
   * model, so it does the honest thing: turns the spoken instruction into a
   * directive on the prompt, which the model you are already talking to obeys.
   */
  refineComposer(instruction) {
    const io = patchComposer(adapter);
    const raw = io?.get() || '';
    if (!raw.trim()) return shell.toast('Composer is empty.', 'err');
    history.push(raw);
    const out = raw.replace(/\s+$/, '') + '\n\n' + instruction.replace(/\.$/, '') + '.';
    io.set(out);
    lastDictated = out;
    shell.toast('Directive added to your prompt', 'ok');
    return out;
  },

  speakComposer() {
    const t = readComposer(adapter) || '';
    if (!t.trim()) return shell.toast('Composer is empty.', 'err');
    ensureDictation().speak(t, settings.readAloudRate);
  },

  // No argument means "flip it" — that is how the palette and the button use it.
  setFlowMode: (on) => setFlowMode(on == null ? !shell.flow : on),
  addWord: (w) => addWord(w),
  removeWord: (w) => removeWord(w),
  clearDictionary: () => clearWords(),
  refreshDictionary: () => pushDictionary(),
  async setSetting(patch) {
    settings = await setSettings(patch);
    // Dictation reads its configuration once, at construction. Rebuild it
    // rather than leaving a listener wired to a setting the user just changed.
    if (DICTATE_KEYS.some((k) => k in patch)) {
      dictation?.stop();
      dictation = null;
    }
    shell.setSettings(settings);
    return settings;
  },

  capture,
  sendTo,
  fanout,
  promoteAnswer,
  runEnhance,
  enhance: runEnhance,
  cookPrompt,
  listPacks,
  dropPack,
  copyPack,
  openPack: (id) => storeMsg({ type: 'pb:open-page', page: 'library.html', hash: 'pack:' + id }),
  async openPackSend(id) {
    const packs = await getPacks();
    currentPack = packs.find((p) => p.id === id) || currentPack;
    shell.setPack(currentPack);
    shell.openDrawer('send');
  },
  toggleDictate,
  stopDictate: () => { dictation?.stop(); shell.setRecording(false); },
  speak,
  lens,
  toggleReading,
  draftFollowUp: doFollowUp,
  diagnose,
  openLibrary: () => storeMsg({ type: 'pb:open-page', page: 'library.html' }),
  exportPacks: () => storeMsg({ type: 'pb:open-page', page: 'library.html', hash: 'data' }),
  importPacks: () => storeMsg({ type: 'pb:open-page', page: 'library.html', hash: 'data' }),
  clearAll: () => storeMsg({ type: 'pb:clear-all' }),
  onOpen: () => { mounted = true; },
};

const storeMsg = (msg) => runtime.send(msg);

shell = createShell({ api });

/* ================================================================== *
 * Boot
 * ================================================================== */

(async function boot() {
  settings = await getSettings();
  dna = await getDNA();
  if (mounted) shell.setSettings(settings);

  // Honour the onboarding site toggles. A disabled site keeps working through
  // pure structural detection — the hint is the only thing switched off.
  const disabled = Object.entries(settings.sites || {})
    .filter(([, v]) => v && v.enabled === false)
    .map(([k]) => k);
  if (disabled.length) {
    const next = resolveAdapter(location.hostname, { disabled });
    if (next.hintId !== adapter.hintId || next.id !== adapter.id) adapter = next;
  }

  // The dictionary is loaded up front, not lazily: the whole point is that the
  // very first thing you dictate already snaps to the words you use. It lives
  // in its own storage key — it is not a setting, and never rides along with
  // one into the settings blob.
  dictEntries = await getDictionary();
  ensureDictionary();
  if (mounted) shell.setDictionary(ensureDictionary().list());

  const h = adapter.diagnose();
  shell.setSite(adapter.label, h.ok);
  restoreReadingMode(adapter);

  // live prompt score, event-driven
  watchComposer(adapter, (v) => idle(() => shell.setAnalysis(analyze(v))));
  watchDictationEdits();

  // The in-page bar. Mounted only when a composer is actually on screen, so a
  // page that is not a chat costs nothing.
  if (adapter.diagnose().ok) {
    shell.attach();
    injectedBar = PB.inject.createInjectedBar(api, adapter);
    injectedBar.sync();
    injectedBar.refresh();
    watchComposer(adapter, () => injectedBar.sync());
  }

  // cutoff detection + Style DNA, event-driven
  watchThread(adapter, () => {
    const turns = adapter.turns();
    const users = turns.filter((t) => t.role === 'user');
    if (users.length > lastUserCount) {
      const fresh = users.at(-1)?.text || '';
      if (fresh) recordPrompt(fresh).then((d) => (dna = d));
    }
    lastUserCount = users.length;
    const last = [...turns].reverse().find((t) => t.role === 'assistant');
    if (last) shell.setCutoff(looksTruncated(last.text));
    // a chat that grew needs the reading-mode dimming recomputed, or the
    // "last 4 turns" window drifts out of date
    refreshReadingMode(adapter);
  });

  window.addEventListener('beforeunload', clearLensInPlace, { once: true });
})();

/* ================================================================== *
 * Messages from the background
 * ================================================================== */

/**
 * Fan-out opens background tabs and retries injection; a warm tab can be
 * injected from two paths at once (onUpdated + the 1.5s warm-tab timer). The
 * same runId must land once: twice means the prompt is typed twice and, with
 * autoSubmit, actually submitted twice on the destination.
 */
const injectedRuns = new Set();

runtime.onMessage((msg, _sender, send) => {
  if (!msg?.type) return;

  if (msg.type === 'pb:inject') {
    if (msg.runId) {
      if (injectedRuns.has(msg.runId)) return send({ ok: true, duplicate: true });
      injectedRuns.add(msg.runId);
    }
    const io = patchComposer(adapter);
    if (!io) return send({ ok: false, reason: 'no-composer' });
    const current = io.get();
    if (current) history.push(current);
    io.set(msg.text);
    shell.setAnalysis(analyze(msg.text));

    if (msg.runId) {
      storeMsg({ type: 'pb:run-started', runId: msg.runId, dest: msg.dest, tabUrl: location.href });
      if (msg.autoSubmit) {
        setTimeout(async () => {
          submitComposer(adapter);
          if (settings.collectAnswers === false) return send({ ok: true, runId: msg.runId, collect: false });
          const r = await watchAnswer(adapter).catch(() => ({ ok: false }));
          storeMsg({ type: 'pb:run-answer', runId: msg.runId, dest: msg.dest, text: r.text || lastText(adapter), ms: r.ms || 0, state: r.ok ? 'done' : 'timeout' });
          send({ ok: true, runId: msg.runId, collect: true });
        }, 450);
      } else {
        // the user must press send; watch for the answer anyway
        const started = Date.now();
        const poll = setInterval(() => {
          if (Date.now() - started > 240000) return clearInterval(poll);
          const users = adapter.turns().filter((t) => t.role === 'user').length;
          if (users >= 1) {
            clearInterval(poll);
            watchAnswer(adapter).then((r) =>
              storeMsg({ type: 'pb:run-answer', runId: msg.runId, dest: msg.dest, text: r.text || lastText(adapter), ms: r.ms || 0, state: r.ok ? 'done' : 'timeout' })
            );
          }
        }, 1500);
      }
    }
    return send({ ok: true });
  }

  if (msg.type === 'pb:ping') return send({ ok: true, adapter: adapter.id, label: adapter.label, healthy: adapter.diagnose().ok });
  /**
   * The popup calls this on every open just to render "this thread". It must
   * PEEK, not capture: an explicit capture is a user action, and the old
   * behaviour (pb:capture on popup open) saved a duplicate pack and fired a
   * toast every single time the toolbar icon was clicked.
   */
  if (msg.type === 'pb:peek-pack') {
    // build in memory if there is nothing yet — a glance at the popup must not
    // write to the library; only an explicit capture (or a transfer) does
    (currentPack ? Promise.resolve(currentPack) : capture({ silent: true, save: false }))
      .then((pack) => send({ ok: !!pack, pack }))
      .catch(() => send({ ok: false }));
    return true; // hold the channel open across the await
  }
  if (msg.type === 'pb:open-panel') { shell.openDrawer(msg.panel); return; }
  if (msg.type === 'pb:palette') { shell.openPalette(); return; }
  // Chrome does not deliver a reserved shortcut keydown to the page, so
  // Alt+Shift+V arrives here from the service worker and nowhere else. The
  // double-tap window therefore lives with this handler, not in a keydown
  // listener that would never fire.
  if (msg.type === 'pb:dictate') { toggleDictate(); return send({ ok: true, flow: dictation?.flow, listening: dictation?.listening }); }
  if (msg.type === 'pb:cook') { const r = cookPrompt(); return send({ ok: true, score: r?.score ?? null }); }
  if (msg.type === 'pb:capture') return capture().then((p) => send({ ok: !!p, pack: p }));
  if (msg.type === 'pb:health') return send({ ok: true, health: adapter.diagnose() });
});

/* For debugging from the page console. */
if (typeof window !== 'undefined') window.__promptbridge = { api, shell, adapter };


})(globalThis.PB = globalThis.PB || {});
