/* PromptBridge — loaded as a plain script, no bundler. */
(function (PB) {
'use strict';
const { DESTINATIONS, escapeHtml, estimateTokens, relativeTime } = PB.SHARED;
const { LENS_MODES, analyze, LLM_PROVIDERS } = PB.promptsmith;

/**
 * Focus Shell — the UI/UX layer.
 *
 * Lightweight by construction:
 *   · only the launcher button exists at boot; the palette and drawer are
 *     built on first open, so a page that is never touched costs ~1 node
 *   · everything lives in one shadow root; the host page's DOM, styles and
 *     keyboard shortcuts are never touched (reading mode is the one
 *     deliberate, opt-in, reversible exception)
 *   · render() patches only the drawer body, and only when it is open
 */

const ICON = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M4 12h10M4 17h7"/><circle cx="18" cy="16" r="3" fill="currentColor" stroke="none"/></svg>`;

/* shell.css lives next to this file; resolve it from here so it works both
   inside the extension (chrome-extension://) and in a plain page preview. */
const CSS_URL =
  typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.getURL
    ? chrome.runtime.getURL('shell.css')
    : new URL('shell.css', (document.currentScript && document.currentScript.src) || location.href).href;

function createShell({ api }) {
  /* ---- stage 1: the launcher only ---- */
  const host = document.createElement('div');
  host.id = 'promptbridge-root';
  host.style.cssText = 'all:initial;position:static';
  const root = host.attachShadow({ mode: 'open' });
  root.innerHTML = `
    <div class="pb" id="pb">
      <button class="pb-fab" id="fab" title="PromptBridge — Ctrl+Shift+K">${ICON}</button>
    </div>`;
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = CSS_URL;
  root.appendChild(link); // must come after innerHTML, which replaces children

  // The content script now loads on every site, so the host is attached only
  // when there is something worth showing. A page that is not a chat gets no
  // DOM from us at all — not an empty shadow root, not a stylesheet request.
  let attached = false;
  const attach = () => {
    if (attached) return;
    attached = true;
    document.documentElement.appendChild(host);
  };

  const $ = (id) => root.getElementById(id);
  const wrap = $('pb');

  let mounted = false; // palette + drawer built?
  let paletteOpen = false;
  let drawerOpen = false;
  let panel = 'overview';
  let sel = 0;
  let list = [];
  let state = { pack: null, analysis: null, settings: {}, runs: [], provider: 'anthropic', preview: null, health: null, cutoff: false, dictWords: [], dictSize: 0, flow: false };

  /* ================= toasts ================= */

  function toast(msg, kind = '') {
    if (!mounted) return; // no surface yet: nothing to show a toast on
    const el = document.createElement('div');
    el.className = 'pb-toast ' + kind;
    el.textContent = msg;
    $('toasts').appendChild(el);
    setTimeout(() => el.remove(), 4200);
  }

  /* ================= stage 2: full surface ================= */

  function mount() {
    if (mounted) return;
    mounted = true;
    wrap.insertAdjacentHTML(
      'beforeend',
      `<div class="pb-scrim" data-close></div>
      <div class="pb-pal" role="dialog" aria-label="Command palette">
        <div class="pb-pal-in">
          <span class="pb-kbd">PB</span>
          <input id="palq" placeholder="Send this thread somewhere, enhance a prompt, transform an answer…" autocomplete="off" spellcheck="false" aria-label="Command">
          <span class="pb-kbd">esc</span>
        </div>
        <div class="pb-list" id="pallist" role="listbox"></div>
      </div>
      <div class="pb-drawer" role="dialog" aria-label="PromptBridge panel">
        <div class="pb-hd">
          <span class="dot" id="sitedot"></span>
          <span class="grow">PromptBridge</span>
          <span class="tag" id="sitetag">—</span>
          <button data-close aria-label="Close">✕</button>
        </div>
        <div class="pb-bd" id="drawer"></div>
        <div class="pb-ft" id="foot"></div>
      </div>
      <div class="pb-toasts" id="toasts" aria-live="polite"></div>`
    );
    wrap.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', closeAll));
    $('palq').addEventListener('input', (e) => { sel = 0; renderPalette(e.target.value); });
    $('palq').addEventListener('keydown', onPalKey);
    $('pallist').addEventListener('click', (e) => {
      const it = e.target.closest('.pb-item');
      if (it?.dataset.i != null) { list[+it.dataset.i].run(); closeAll(); }
    });
    $('fab').addEventListener('click', () => (drawerOpen && !paletteOpen ? closeAll() : openDrawer('overview')));
    api.onOpen?.();
  }

  function onPalKey(e) {
    if (e.key === 'ArrowDown') { sel = Math.min(sel + 1, list.length - 1); renderPalette($('palq').value); }
    else if (e.key === 'ArrowUp') { sel = Math.max(sel - 1, 0); renderPalette($('palq').value); }
    else if (e.key === 'Enter') { e.preventDefault(); list[sel]?.run(); closeAll(); }
    else if (e.key === 'Escape') { e.preventDefault(); closeAll(); }
    e.stopPropagation();
  }

  /* ---------------- palette ---------------- */

  function commands() {
    const c = [
      { g: 'pack', l: 'Capture this thread as a Context Pack', h: 'distil + store locally', run: () => api.capture() },
      { g: 'pack', l: 'Send this thread to…', h: 'pick a destination', run: () => openDrawer('send') },
      { g: 'pack', l: 'Open the pack library', h: 'search, export, compare', run: () => api.openLibrary() },
    ];
    for (const d of DESTINATIONS) c.push({ g: '→', l: `Send to ${d.label}`, h: d.url, run: () => api.sendTo(d.id) });
    c.push({ g: 'fanout', l: `Fan out to all ${DESTINATIONS.length} models`, h: 'parallel + compare board', run: () => api.fanout() });
    c.push(
      { g: 'prompt', l: 'Enhance the prompt in the composer', h: 'promptsmith', run: () => api.enhance({ apply: true }) },
      { g: 'prompt', l: 'Score this prompt', h: 'no edit', run: () => openDrawer('prompt') },
      { g: 'voice', l: 'Toggle voice typing', h: 'Alt+Shift+V · double-tap for Flow', run: () => api.toggleDictate() },
      { g: 'voice', l: 'Turn Flow mode on / off', h: 'hands-free, then say "send it"', run: () => api.setFlowMode() },
      { g: 'voice', l: 'Read the last answer aloud', h: 'TTS', run: () => api.speak() },
      { g: 'view', l: 'Reading mode', h: 'dim old turns, widen prose', run: () => api.toggleReading() },
      { g: 'lens', l: 'Transform the last answer…', h: 'no re-prompting', run: () => openDrawer('lens') },
      ...LENS_MODES.map((m) => ({ g: 'lens', l: `Lens: ${m.label}`, h: m.hint, run: () => api.lens(m.id) })),
      { g: 'system', l: 'Check adapter health on this site', h: 'selector drift detector', run: () => api.diagnose() },
      { g: 'system', l: 'Settings', h: 'privacy, tiers, toggles', run: () => openDrawer('settings') }
    );
    return c;
  }

  function renderPalette(q = '') {
    const all = commands();
    list = q ? all.filter((c) => (c.g + ' ' + c.l + ' ' + (c.h || '')).toLowerCase().includes(q.toLowerCase())) : all;
    if (sel >= list.length) sel = 0;
    $('pallist').innerHTML = list.length
      ? list.map((c, i) => `<div class="pb-item ${i === sel ? 'sel' : ''}" data-i="${i}" role="option"><span class="g">${escapeHtml(c.g)}</span><span class="l">${escapeHtml(c.l)}</span><span class="h">${escapeHtml(c.h || '')}</span></div>`).join('')
      : `<div class="pb-item muted">no matching command</div>`;
  }

  function openPalette() {
    attach();
    mount();
    api.onOpen?.();
    paletteOpen = true;
    drawerOpen = false;
    panel = null;
    wrap.classList.add('on', 'pal-open');
    wrap.classList.remove('drawer-open');
    const q = $('palq');
    q.value = '';
    sel = 0;
    renderPalette('');
    setTimeout(() => q.focus(), 10);
  }

  function closeAll() {
    paletteOpen = drawerOpen = false;
    wrap.classList.remove('on', 'pal-open', 'drawer-open');
  }

  /* ---------------- drawer ---------------- */

  /**
   * `data-val` arrives as a string. Coerce it, or a button that switches a
   * flag off stores the truthy string "false" and the flag never turns off.
   */
  const asSetting = (v) => (v === 'true' ? true : v === 'false' ? false : v);

  function openDrawer(p = 'overview') {
    attach();
    mount();
    api.onOpen?.();
    paletteOpen = false;
    drawerOpen = true;
    panel = p;
    wrap.classList.add('on', 'drawer-open');
    wrap.classList.remove('pal-open');
    render();
  }

  function render() {
    if (!drawerOpen) return;
    $('drawer').innerHTML = VIEWS[panel] ? VIEWS[panel]() : '';
    $('foot').innerHTML = footer();
    wire();
  }

  const a = () => state.analysis;
  const s = () => state.settings;

  const scoreCard = () => {
    const an = a();
    if (!an) return `<div class="card muted">The composer is empty. Type something and hit <b>Enhance</b>.</div>`;
    return `<div class="card">
      <div class="row"><span class="grow">Prompt strength</span><b>${an.score}/100</b></div>
      <div class="meter"><i style="width:${an.score}%;background:${an.score > 70 ? 'var(--ok)' : an.score > 40 ? 'var(--warn)' : 'var(--err)'}"></i></div>
      <div class="slots">${an.slots.map((sl) => `<span class="slot ${sl.present ? 'has' : sl.fixable ? 'miss' : ''}">${sl.present ? '✓' : '+'} ${sl.label}</span>`).join('')}</div>
      ${an.issues.length ? `<ul>${an.issues.map((i) => `<li>${escapeHtml(i)}</li>`).join('')}</ul>` : '<div class="muted" style="font-size:11.5px">Well-specified. Nothing to fix.</div>'}
      <div class="row" style="margin-top:9px;gap:6px">
        <button data-a="enhance" class="pri grow">Enhance &amp; apply</button>
        <button data-a="enhance-copy">Copy</button>
      </div>
      <div class="row" style="margin-top:6px;gap:6px">
        <button data-a="llm" class="grow" title="Uses your own provider key, from your browser">Tier 2 · ${LLM_PROVIDERS.find((p) => p.id === state.provider)?.label || 'LLM'}</button>
      </div>
      <div class="mono" id="enhprev" style="margin-top:9px;display:none"></div>
    </div>`;
  };

  const VIEWS = {
    overview: () => {
      const p = state.pack;
      return `
      <section><h4>This thread</h4>
        ${p ? `<div class="card">
            <div style="font-weight:600">${escapeHtml(p.title)}</div>
            <div class="muted" style="margin-top:3px">${p.meta.messageCount} msgs · ~${p.meta.tokenEstimate}t · ${escapeHtml(p.intent.taskType)} · ${escapeHtml(p.status)}</div>
            <div class="meter"><i style="width:${Math.min(100, p.meta.tokenEstimate / 6)}%"></i></div>
            <div class="muted" style="font-size:11px">${p.decisions.length} decisions · ${p.constraints.length} constraints · ${p.artifacts.length} artifacts · ${p.openThreads.length} open</div>
            ${p.meta.redacted?.length ? `<div class="warn" style="font-size:11px;margin-top:5px">redacted: ${p.meta.redacted.join(', ')}</div>` : ''}
          </div>
          <div class="row" style="gap:6px"><button data-go="send" class="pri grow">Send to…</button><button data-a="capture">Re-capture</button></div>`
          : `<div class="card muted">No pack yet — press <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>C</kbd> or run <i>Capture this thread</i>.</div><button data-a="capture" class="pri">Capture this thread</button>`}
      </section>
      <section><h4>Prompt in composer</h4>${scoreCard()}</section>
      <section><h4>Quick actions</h4>
        <div class="row" style="flex-wrap:wrap;gap:6px">
          <button data-a="enhance">Enhance</button>
          <button data-a="dictate">🎙 Voice</button>
          <button data-a="dict-flow" class="${state.flow ? 'on' : ''}">${state.flow ? '● Flow on' : 'Flow mode'}</button>
          <button data-a="fanout">Fan out</button>
          <button data-a="reading">${s().readingMode ? 'Reading: on' : 'Reading mode'}</button>
          <button data-a="diagnose">Check adapter</button>
          <button data-a="library">Library</button>
        </div>
        <div class="muted" style="font-size:11.5px;margin-top:7px">
          Double-tap <kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>V</kbd> to lock dictation on without holding the key.
        </div>
      </section>
      <section><h4>Voice commands</h4><div class="card muted" style="line-height:1.9">
        <b>Say it, don't type it:</b> “send it” · “press enter” · “scratch that” · “new paragraph” ·
        “stop listening”<br>
        <b>Change what you already said:</b> “bullet list” · “make it a table” · “as json” · “shorter” ·
        “the code only” · “more formal” · “translate to Spanish”<br>
        <b>Move it:</b> “send to claude” · “capture this pack” · “enhance that” · “draft the follow up”<br>
        <b>Fix it mid-sentence:</b> “budget 50K for tools, actually 75K” just works.
      </div></section>`;
    },

    prompt: () => `<section><h4>Promptsmith</h4>${scoreCard()}
      <div class="card muted">Tier 1 runs offline and costs nothing. Tier 2 uses a key <b>you</b> supply; the request goes from this browser straight to your provider — never through us.</div></section>`,

    send: () => {
      const dests = DESTINATIONS.map(
        (d) => `<div class="card row"><span class="sw" style="background:${d.accent}"></span><span class="grow">${d.label}</span>
          <button data-dest="${d.id}">Send</button><button data-fan="${d.id}">Only</button></div>`
      ).join('');
      return `
      <section><h4>Transfer fidelity</h4>
        <div class="row" style="gap:6px;flex-wrap:wrap">${['distilled', 'full', 'atomic'].map((f) => `<button data-fid="${f}" class="${s().fidelity === f ? 'on' : ''}">${f}</button>`).join('')}</div>
        <div class="muted" style="font-size:11.5px;margin-top:7px">${FIDELITY_HELP[s().fidelity] || ''}</div>
      </section>
      <section><h4>Destination</h4>${dests}
        <div class="row" style="gap:6px;margin-top:7px">
          <button data-a="fanout" class="pri grow">Fan out to all ${DESTINATIONS.length}</button>
          <button data-go="runs">Compare board</button>
        </div>
      </section>
      <section>
        <label class="row" style="gap:8px"><input type="checkbox" data-set="redaction" ${s().redaction ? 'checked' : ''}> <span>Redact secrets &amp; PII before sending</span></label>
        <label class="row" style="gap:8px;margin-top:7px"><input type="checkbox" data-set="autoSubmit" ${s().autoSubmit ? 'checked' : ''}> <span>Auto-submit on the destination</span></label>
        <label class="row" style="gap:8px;margin-top:7px"><input type="checkbox" data-set="collectAnswers" ${s().collectAnswers !== false ? 'checked' : ''}> <span>Collect answers for the compare board</span></label>
        <div class="muted" style="font-size:11.5px;margin-top:7px">Auto-submit is off by default. A prompt you did not write should never press send for you.</div>
      </section>
      ${state.preview ? `<section><h4>Preview — ${escapeHtml(state.preview.dest)}</h4><div class="card mono">${escapeHtml(state.preview.text)}</div></section>` : ''}`;
    },

    lens: () => `<section><h4>Output lens</h4>
      <div class="muted" style="margin-bottom:9px">Re-render the last answer in place. No re-prompting, no tokens spent.</div>
      ${LENS_MODES.map((m) => `<div class="card row"><span class="grow">${m.label}<div class="muted" style="font-size:11px">${m.hint}</div></span><button data-lens="${m.id}">Apply</button></div>`).join('')}
    </section>`,

    runs: () => {
      const runs = state.runs || [];
      if (!runs.length)
        return `<section><div class="card muted">No runs yet. Fan out a thread to compare answers side by side.</div>
          <button data-a="fanout" class="pri" style="width:100%">Fan out to all models</button></section>`;
      const run = runs[0];
      return `<section><div class="muted" style="margin-bottom:9px">${escapeHtml(run.packTitle || 'Run')} · ${relativeTime(run.created)}</div>
        ${run.answers.map((x) => {
          const d = DESTINATIONS.find((dd) => dd.id === x.dest);
          return `<div class="card">
            <div class="row"><span class="sw" style="background:${d?.accent}"></span><span class="grow">${d?.label || x.dest}</span>
              <span class="tag">${x.state === 'done' ? `${(x.ms / 1000).toFixed(1)}s` : escapeHtml(x.state)}</span></div>
            <div class="mono" style="margin-top:7px;max-height:170px">${x.text ? escapeHtml(x.text.slice(0, 900)) : '<span class="muted">waiting…</span>'}</div>
            <div class="row" style="gap:6px;margin-top:7px"><button data-run-copy="${x.dest}">Copy</button><button data-run-promote="${x.dest}">Use as pack</button></div>
          </div>`;
        }).join('')}
        <button data-go="library" style="width:100%;margin-top:6px">Open full library</button>
      </section>`;
    },

    health: () => {
      const h = state.health;
      const x = h?.explain || null;
      return `<section><h4>What PromptBridge found on this page</h4>
        ${h ? `<div class="card">
          <div class="row"><span class="grow">${escapeHtml(h.label)}</span><span class="tag ${h.ok ? 'ok' : 'err'}">${h.ok ? 'ready' : 'no composer here'}</span></div>
          <div class="muted" style="margin-top:5px">${escapeHtml(location.hostname)}</div>
          <ul style="margin-top:8px">
            <li>turns parsed: <b>${h.turns}</b></li>
            <li>composer found by: <b>${escapeHtml(x?.composer?.from || (h.composer ? 'hint' : 'nothing'))}</b>${x?.composer?.score != null ? ` (score ${x.composer.score})` : ''}</li>
            <li>transcript found by: <b>${escapeHtml(x?.list?.from || 'structure')}</b></li>
            <li>site hint: ${h.hint ? escapeHtml(h.hint) : '<span class="muted">none — fully sensed</span>'}</li>
            <li>profile cached: ${x?.cached ? 'yes' : 'no'}</li>
            <li>analysis time: ${h.ms ?? 0}ms</li>
          </ul>
          ${x?.composer?.path ? `<div class="mono" style="font-size:10.5px;margin-top:8px;word-break:break-all;opacity:.75">${escapeHtml(x.composer.path)}</div>` : ''}
        </div>` : ''}
        ${x?.sample?.length ? `<section><h4>Roles it assigned</h4>
          <div class="card mono" style="font-size:11px;max-height:190px;overflow:auto">${x.sample
            .map((t) => `<div><span class="tag ${t.role === 'user' ? 'ok' : ''}">${t.role}</span> ${escapeHtml(t.head.replace(/\n/g, ' '))}…</div>`)
            .join('')}</div>
          <div class="muted" style="font-size:11.5px;margin-top:7px">Checked against the page, not a list. If a role is wrong, the fix is one heuristic in <code>extension/sense.js</code> — every site benefits at once.</div>
        </section>` : ''}
        <div class="card muted">This page is <b>detected, not configured</b>. A known site is only ever a hint that the engine verifies before using; when the hint no longer matches the DOM, PromptBridge falls back to reading the page structure instead. That is why a vendor redesign degrades quality for a day rather than breaking capture.</div>
      </section>`;
    },

    settings: () => `
      <section><h4>Privacy</h4><div class="card">
        <b>Local-first.</b> Packs live in <code>chrome.storage.local</code> on this device. There is no PromptBridge server, so nothing to send to.
        Style DNA stores counters (length, format habits), never your text.</div></section>
      <section><h4>Voice tier</h4><div class="card">
        <div class="row" style="gap:6px;flex-wrap:wrap">
          <button data-set="dictateTier" data-val="webspeech" class="${s().dictateTier === 'webspeech' ? 'on' : ''}">Browser</button>
          <button data-set="dictateTier" data-val="whisper-local" class="${s().dictateTier === 'whisper-local' ? 'on' : ''}">Local Whisper</button>
        </div>
        <div class="muted" style="font-size:11.5px;margin:7px 0">
          ${s().dictateTier === 'whisper-local'
            ? 'Point at any OpenAI-compatible endpoint you run yourself (whisper.cpp, faster-whisper, LocalAI).'
            : 'Uses the browser’s own recogniser. Free and instant, but audio goes to the vendor.'}
        </div>
        <div class="muted" style="font-size:11.5px;margin:0 0 7px">
          Nothing is bundled: a 45kb extension that becomes 45MB is a different product, and most people never
          want to carry that. Whisper is yours to run.
        </div>
        ${s().dictateTier === 'whisper-local' ? `<div class="row" style="gap:6px"><input data-set="whisperUrl" value="${escapeHtml(s().whisperUrl || '')}" placeholder="http://localhost:8000/v1/audio/transcriptions" style="flex:1;min-width:0;background:var(--bg);color:var(--fg);border:1px solid var(--line);border-radius:7px;padding:5px 7px;font:inherit"></div>` : ''}
        <div class="row" style="gap:6px;margin-top:7px"><span class="muted" style="font-size:11.5px">Language</span>
          <select data-set="dictateLang" style="background:var(--bg2);color:var(--fg);border:1px solid var(--line);border-radius:7px;padding:4px">
            ${['en-IN', 'en-US', 'en-GB', 'hi-IN', 'ta-IN', 'de-DE', 'es-ES', 'fr-FR'].map((l) => `<option ${s().dictateLang === l ? 'selected' : ''}>${l}</option>`).join('')}
          </select></div>
      </div></section>
      <section><h4>Dictation</h4><div class="card">
        <label class="row" style="gap:8px"><input type="checkbox" data-set="smartCorrections" ${s().smartCorrections !== false ? 'checked' : ''}>
          <span>Self-correction<span class="muted" style="display:block;font-size:11px">“budget 50K, actually 75K” rewrites in place</span></span></label>
        <label class="row" style="gap:8px;margin-top:7px"><input type="checkbox" data-set="flowMode" ${s().flowMode !== false ? 'checked' : ''}>
          <span>Flow mode<span class="muted" style="display:block;font-size:11px">Double-tap <kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>V</kbd> to lock dictation on, then say “send it”</span></span></label>
        <label class="row" style="gap:8px;margin-top:7px"><input type="checkbox" data-set="learnDictionary" ${s().learnDictionary !== false ? 'checked' : ''}>
          <span>Learn my vocabulary<span class="muted" style="display:block;font-size:11px">Words you retype after dictation are remembered, on this device only</span></span></label>
      </div></section>
      <section><h4>Vocabulary (${state.dictSize || 0})</h4><div class="card">
        ${state.dictWords?.length
          ? `<div class="chips" style="display:flex;flex-wrap:wrap;gap:5px;margin-bottom:9px">${state.dictWords
              .map(([w, n]) => `<button data-dict="${escapeHtml(w)}" title="Seen ${n}× · click to forget" style="font-size:11.5px;padding:3px 8px">${escapeHtml(w)}</button>`)
              .join('')}</div>`
          : '<div class="muted" style="margin-bottom:9px">Nothing learned yet. Fix a word the dictation got wrong and it lands here.</div>'}
        <div class="row" style="gap:6px">
          <input id="dictadd" placeholder="Add a term…" style="flex:1;min-width:0;background:var(--bg);color:var(--fg);border:1px solid var(--line);border-radius:7px;padding:5px 7px;font:inherit">
          <button data-a="dict-add">Add</button>
          <button data-a="dict-clear">Clear</button>
        </div>
      </div></section>
      <section><h4>Behaviour</h4><div class="card">
        <label class="row" style="gap:8px"><input type="checkbox" data-set="stripFillers" ${s().stripFillers ? 'checked' : ''}> <span>Strip fillers from dictation</span></label>
        <label class="row" style="gap:8px;margin-top:7px"><input type="checkbox" data-set="lensInPlace" ${s().lensInPlace !== false ? 'checked' : ''}> <span>Show lens results inline on the page</span></label>
        <div class="row" style="gap:8px;margin-top:9px"><span class="grow muted">Playbook</span>
          <select data-set="playbook" style="background:var(--bg2);color:var(--fg);border:1px solid var(--line);border-radius:7px;padding:4px">
            ${['auto', 'debug', 'refactor', 'research', 'write', 'analyze', 'plan', 'extract'].map((p) => `<option ${s().playbook === p ? 'selected' : ''}>${p}</option>`).join('')}
          </select></div>
        <div class="row" style="gap:8px;margin-top:9px"><span class="grow muted">Read-aloud rate</span>
          <input type="range" min="0.6" max="1.8" step="0.1" value="${s().readAloudRate}" data-set="readAloudRate" style="flex:1">
          <span class="tag" id="rateval">${s().readAloudRate}×</span></div>
      </div></section>
      <section><h4>Data</h4><div class="row" style="gap:6px;flex-wrap:wrap">
        <button data-a="export">Export packs</button>
        <button data-a="import">Import</button>
        <button data-a="library">Library</button>
        <button data-a="clear">Clear everything</button>
      </div></section>`,
  };

  const FIDELITY_HELP = {
    distilled: 'A short brief: goal, decisions, constraints, artifacts. The default — it is what a new model can actually read.',
    full: 'Verbatim transcript. Use when nuance matters more than token cost.',
    atomic: 'Artifacts only. Use to carry a code block or table and nothing else.',
  };

  function footer() {
    const cut = state.cutoff;
    return `${cut ? `<div class="row" style="width:100%;margin-bottom:8px"><span class="tag warn">looks cut off</span>
        <button data-a="followup" class="grow">Draft the follow-up</button></div>` : ''}
      <span class="grow muted" style="font-size:11px;align-self:center">${escapeHtml(location.hostname)}</span>
      <span class="muted" style="font-size:11px;align-self:center">composer ~${estimateTokens(api.composerText())}t</span>`;
  }

  /* ---------------- wiring ---------------- */

  function wire() {
    const d = $('drawer');
    if (!d) return;

    d.querySelectorAll('[data-go]').forEach((b) => b.addEventListener('click', () => {
      const t = b.dataset.go;
      if (t === 'send' || t === 'runs' || t === 'library') t === 'library' ? api.openLibrary() : openDrawer(t);
      else openDrawer(t);
    }));

    d.querySelectorAll('[data-a]').forEach((b) => b.addEventListener('click', () => {
      const act = b.dataset.a;
      if (act === 'enhance') api.enhance({ apply: true });
      else if (act === 'enhance-copy') previewEnhance(true);
      else if (act === 'llm') previewEnhance(false, true);
      else if (act === 'capture') api.capture();
      else if (act === 'fanout') api.fanout();
      else if (act === 'dictate') api.toggleDictate();
      else if (act === 'dict-flow') api.setFlowMode(!state.flow);
      else if (act === 'dict-add') { const i = $('dictadd'); if (i?.value.trim()) { api.addWord(i.value.trim()); i.value = ''; } }
      else if (act === 'dict-clear') api.clearDictionary();
      else if (act === 'reading') api.toggleReading();
      else if (act === 'diagnose') api.diagnose();
      else if (act === 'library') api.openLibrary();
      else if (act === 'followup') api.draftFollowUp();
      else if (act === 'export') api.exportPacks();
      else if (act === 'import') api.importPacks();
      else if (act === 'clear') api.clearAll();
    }));

    d.querySelectorAll('[data-dest]').forEach((b) => b.addEventListener('click', () => api.sendTo(b.dataset.dest)));
    d.querySelectorAll('[data-fan]').forEach((b) => b.addEventListener('click', () => api.fanout([b.dataset.fan])));
    d.querySelectorAll('[data-lens]').forEach((b) => b.addEventListener('click', () => api.lens(b.dataset.lens)));
    d.querySelectorAll('[data-fid]').forEach((b) => b.addEventListener('click', () => api.setSetting({ fidelity: b.dataset.fid })));
    d.querySelectorAll('[data-dict]').forEach((b) => b.addEventListener('click', () => api.removeWord(b.dataset.dict)));

    d.querySelectorAll('[data-run-copy]').forEach((b) =>
      b.addEventListener('click', () => {
        const run = (state.runs || [])[0];
        const ans = run?.answers.find((x) => x.dest === b.dataset.runCopy);
        navigator.clipboard?.writeText(ans?.text || '').then(() => toast('Copied', 'ok'));
      }));
    d.querySelectorAll('[data-run-promote]').forEach((b) =>
      b.addEventListener('click', () => api.promoteAnswer(b.dataset.runPromote)));

    d.querySelectorAll('[data-set]').forEach((el) => {
      const ev = el.tagName === 'INPUT' && el.type === 'checkbox' ? 'change' : el.tagName === 'INPUT' && el.type === 'range' ? 'input' : 'change';
      el.addEventListener(ev, () => {
        const v = el.type === 'checkbox' ? el.checked : el.type === 'range' ? Number(el.value) : el.value;
        api.setSetting({ [el.dataset.set]: v });
        if (el.dataset.set === 'readAloudRate') { const t = $('rateval'); if (t) t.textContent = v + '×'; }
      });
      el.addEventListener('change', () => el.tagName === 'SELECT' || el.dataset.val ? render() : null);
    });
    d.querySelectorAll('[data-set][data-val]').forEach((b) =>
      b.addEventListener('click', () => api.setSetting({ [b.dataset.set]: asSetting(b.dataset.val) }).then(() => render())));

    d.querySelectorAll('.slot.miss').forEach((s) =>
      s.addEventListener('click', () => {
        toast(`Missing: ${s.textContent.replace(/^\+\s*/, '')} — Enhance adds it`);
      }));
  }

  async function previewEnhance(copy, llm = false) {
    const r = await (llm ? api.enhance({ apply: false, llm: true }) : api.enhance({ apply: false }));
    if (!r?.enhanced) return;
    const box = $('enhprev');
    if (copy) navigator.clipboard?.writeText(r.enhanced);
    if (box) { box.style.display = 'block'; box.textContent = r.enhanced; }
    toast(copy ? 'Enhanced prompt copied' : 'Preview generated', 'ok');
  }

  /* ---------------- keyboard ---------------- */

  // Alt+Shift+V is deliberately absent. Chrome treats a declared shortcut as
  // reserved and never delivers it to the page, so a listener for it here would
  // be dead code in the extension while working in the demo — which is worse
  // than no listener, because the demo would lie. It routes through the
  // service worker instead (see sw.js -> content.js `pb:dictate`).
  function onKey(e) {
    const k = e.key.toLowerCase();
    const combo = (e.ctrlKey || e.metaKey) && e.shiftKey;
    if (combo && k === 'k') { e.preventDefault(); paletteOpen ? closeAll() : openPalette(); }
    else if (combo && k === 'c') { e.preventDefault(); api.capture(); }
    else if (combo && k === 's') { e.preventDefault(); openDrawer('send'); }
    else if (e.key === 'Escape' && (paletteOpen || drawerOpen)) { e.preventDefault(); closeAll(); }
  }
  window.addEventListener('keydown', onKey, true);

  /* ---------------- public surface ---------------- */

  let lastFrame = 0;
  return {
    host, root, toast,
    openPalette,
    openDrawer,
    closeAll,
    isOpen: () => paletteOpen || drawerOpen,
    setSite: (label, healthy) => { if (mounted) { $('sitetag').textContent = label; $('sitedot').style.background = healthy ? 'var(--ok)' : 'var(--err)'; } },
    setRecording(on, flow) {
      state.flow = !!flow;
      $('fab').classList.toggle('rec', !!on);
      $('fab').classList.toggle('flow', !!flow);
      $('fab').title = on ? (flow ? 'Flow mode — say "stop listening"' : 'Stop dictation') : 'PromptBridge — Ctrl+Shift+K';
    },
    setDictionary(words) {
      state.dictWords = (words || []).slice(0, 60);
      state.dictSize = (words || []).length;
      // The vocabulary list only exists on the settings panel, so re-render
      // only when that is what is actually on screen.
      if (drawerOpen && panel === 'settings') render();
    },
    setPack(p) { state.pack = p; render(); },
    setAnalysis(an) {
      // cheap guard: don't re-render the DOM 10x/second while typing
      if (an && state.analysis && an.score === state.analysis.score && an.chars === state.analysis.chars) return;
      state.analysis = an;
      render();
    },
    setSettings(x) { state.settings = x; render(); },
    setPreview(x) { state.preview = x; render(); },
    setRuns(r) { state.runs = r; if (panel === 'runs') render(); },
    setHealth(h) { state.health = h; if (panel === 'health') render(); },
    setCutoff(on) {
      if (state.cutoff === on) return;
      state.cutoff = on;
      if (drawerOpen) { const t = Date.now(); if (t - lastFrame > 200) { lastFrame = t; render(); } }
    },
    get provider() { return state.provider; },
    set provider(p) { state.provider = p; },
    get flow() { return state.flow; },
    /**
     * Show the launcher button on a page we detected a chat on. The palette and
     * drawer are still built on first open — attaching costs one empty wrapper
     * and a button, nothing more.
     */
    attach() { attach(); },
    actions: {
      // Spoken commands always act on the COMPOSER — the thing you just
      // dictated — so these point at the composer, not the last answer.
      send: () => api.submit(),
      undo: () => api.undo(),
      newline: () => api.newline(),
      enhance: () => api.enhance({ apply: true }),
      speak: () => api.speakComposer(),
      followup: () => api.draftFollowUp(),
      stop: () => api.stopDictate(),
      capture: () => api.capture(),
      sendTo: (d) => api.sendTo(d),
      lens: (m) => api.lensComposer(m),
      refine: (i) => api.refineComposer(i),
    },
    destroy() { window.removeEventListener('keydown', onKey, true); host.remove(); },
  };
}

PB.shell = { createShell };

})(globalThis.PB = globalThis.PB || {});
