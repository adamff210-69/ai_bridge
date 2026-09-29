/* PromptBridge — loaded as a plain script, no bundler. */
(function (PB) {
'use strict';

/**
 * Site adapters — the only DOM-coupled code in the product.
 *
 * Everything else is pure and offline-testable. Adapters rot when a vendor
 * ships a redesign, so they stay dumb, declarative, and individually
 * health-checkable (`diagnose()` from the palette).
 *
 * Contract:
 *   detect(host)     -> is this adapter for the page?
 *   composer()       -> the input element
 *   messageSel       -> CSS selector matching one message, for reading mode + lens
 *   getText/setText  -> read + write the composer
 *   submit(el)       -> send
 *   turns()          -> [{ role, text }]      (cached; cheap signature check)
 *   isStreaming()    -> is an answer still being written?
 */

const tryQuery = (sel) => { try { return document.querySelector(sel); } catch { return null; } };

const text = (el) => (el?.innerText || el?.textContent || '').replace(/\u00a0/g, ' ').replace(/\n{3,}/g, '\n\n').trim();

/* ---------------- composer read/write ---------------- */

function setNativeValue(el, value) {
  const proto =
    el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : el instanceof HTMLInputElement ? HTMLInputElement.prototype : null;
  const desc = proto && Object.getOwnPropertyDescriptor(proto, 'value');
  if (desc?.set) desc.set.call(el, value);
  else el.value = value;
  el.dispatchEvent(new Event('input', { bubbles: true }));
}

/**
 * Drive the real editing command so host frameworks (ProseMirror on Claude,
 * Quill on Gemini, Lexical on ChatGPT) keep their internal state in sync.
 * Falls back to direct mutation + InputEvent for anything exotic.
 */
function setEditableText(el, value) {
  el.focus();
  let inserted = false;
  try {
    document.execCommand?.('selectAll', false, undefined);
    inserted = document.execCommand?.('insertText', false, value) ?? false;
  } catch {
    inserted = false;
  }
  if (!inserted) {
    el.textContent = value;
    el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: value }));
  }
  el.dispatchEvent(new Event('change', { bubbles: true }));
}

function composerIO(el) {
  if (!el) return { get: () => '', set: () => false };
  const editable = el.isContentEditable || el.getAttribute?.('contenteditable') === 'true';
  return {
    // `?? textContent` : innerText is missing in exotic embedders (and jsdom);
    // a hard crash here took out the drawer footer, of all things.
    get: () => (editable ? (el.innerText ?? el.textContent ?? '').replace(/\u00a0/g, ' ') : el.value || ''),
    set: (v) => {
      if (editable) setEditableText(el, v);
      else setNativeValue(el, v);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    },
  };
}

const pressEnter = (el) => {
  for (const type of ['keydown', 'keypress', 'keyup'])
    el.dispatchEvent(new KeyboardEvent(type, { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true }));
};

const SEND_BTN =
  'button[data-testid="send-button"], button[aria-label*="Send" i], button[aria-label*="Submit" i], button[aria-label*="Send message" i], form button[type="submit"]';

function clickSend() {
  const btn = document.querySelector(SEND_BTN);
  if (btn && !btn.disabled) { btn.click(); return true; }
  return false;
}

/**
 * Site adapters are now HINTS, not implementations.
 *
 * A hint is a suggestion: "on this hostname, the composer is usually this
 * selector, turns are usually that one". `resolveAdapter` seeds the sensing
 * engine (sense.js) with the hint, and the engine keeps whichever answer it
 * can actually verify on screen. A hint that no longer matches the live DOM is
 * discarded silently, which is what makes a vendor redesign survivable.
 *
 * `composerHint` is a selector STRING (or a function returning an element).
 * `turnSelector` is a selector string; `roleOf` maps a turn element to a role.
 */
const base = (o) => ({
  isStreaming: () =>
    !!document.querySelector('[data-is-streaming="true"], .result-streaming, [data-testid="stop-generating-button"], .stop-button, button[aria-label*="Stop" i]'),
  submit: (el) => clickSend() || pressEnter(el),
  diagnose: () => {
    const c = !!o.composer?.();
    let t = 0;
    try { t = o.turns?.().length ?? 0; } catch {}
    return { ok: c, composer: c, turns: t };
  },
  ...o,
});

/* ---------------- ChatGPT ---------------- */

const chatgpt = base({
  id: 'chatgpt',
  label: 'ChatGPT',
  hosts: ['chatgpt.com', 'chat.openai.com'],
  detect: (h) => /(^|\.)chat\.openai\.com$|(^|\.)chatgpt\.com$/.test(h),
  composerSelector: '#prompt-textarea, div[contenteditable="true"][id="prompt-textarea"], main form div[contenteditable="true"], textarea[data-testid="prompt-textarea"]',
  composer: () => tryQuery('#prompt-textarea') || tryQuery('div[contenteditable="true"][id="prompt-textarea"]') || tryQuery('main form div[contenteditable="true"]'),
  turnSelector: 'article[data-message-author-role]',
  roleOf: (el) => (el.getAttribute('data-message-author-role') === 'user' ? 'user' : 'assistant'),
});

/* ---------------- Claude ---------------- *
 * These are HINTS, not the implementation. `resolveAdapter` hands them to the
 * sensing engine, which keeps whichever it can actually see on screen.
 *
 * Verified against claude.ai in 2026: `[data-testid="user-message"]` is the hook
 * that survives, and `data-user-message-bubble` / `div.mb-1.mt-6.group` are
 * gone — an exporter shipping the old chain parses every conversation to zero
 * pairs without warning. That is exactly the failure this architecture removes.  */

const claude = base({
  id: 'claude',
  label: 'Claude',
  hosts: ['claude.ai'],
  detect: (h) => /(^|\.)claude\.ai$/.test(h),
  composerSelector: 'div[contenteditable="true"][role="textbox"], div[contenteditable="true"].ProseMirror, [data-testid="chat-input"] [contenteditable="true"], form [contenteditable="true"]',
  composer: () => tryQuery('div[contenteditable="true"][role="textbox"]') || tryQuery('div[contenteditable="true"].ProseMirror') || tryQuery('[data-testid="chat-input"] [contenteditable="true"]'),
  turnSelector: '[data-testid="user-message"], [data-testid="assistant-message"]',
  listSelector: '[data-testid="chat-messages-list"], main [data-testid="user-message"]',
  roleOf: (el) => (/assistant/i.test(el.getAttribute('data-testid') || '') ? 'assistant' : 'user'),
  modelSel: 'button[data-testid="model-selector"], button[data-testid="model-switcher"]',
  submit: (el) => clickSend() || pressEnter(el),
});

/* ---------------- Gemini ---------------- */

const gemini = base({
  id: 'gemini',
  label: 'Gemini',
  hosts: ['gemini.google.com'],
  detect: (h) => /(^|\.)gemini\.google\.com$/.test(h),
  composerSelector: 'rich-textarea .ql-editor[contenteditable="true"], rich-textarea [contenteditable="true"], div[contenteditable="true"][role="textbox"]',
  composer: () => tryQuery('rich-textarea .ql-editor[contenteditable="true"]') || tryQuery('rich-textarea [contenteditable="true"]'),
  turnSelector: 'user-query, model-response',
  roleOf: (el) => (el.tagName.toLowerCase() === 'user-query' ? 'user' : 'assistant'),
});

/* ---------------- Perplexity ---------------- */

const perplexity = base({
  id: 'perplexity',
  label: 'Perplexity',
  hosts: ['perplexity.ai'],
  detect: (h) => /(^|\.)perplexity\.ai$/.test(h),
  composerSelector: '#ask-input, [data-testid="ask-input"], textarea[name="ask-input"]',
  composer: () => tryQuery('#ask-input') || tryQuery('[data-testid="ask-input"]'),
  turnSelector: '[data-testid="conversation-turn"], .prose',
  roleOf: (el) => (/user|ask|question/i.test(String(el.className)) || /user/i.test(el.getAttribute('data-testid') || '')) ? 'user' : 'assistant',
});

/* ---------------- Copilot ---------------- */

const copilot = base({
  id: 'copilot',
  label: 'Copilot',
  hosts: ['copilot.microsoft.com'],
  detect: (h) => /(^|\.)copilot\.microsoft\.com$/.test(h),
  composerSelector: '#prompt-texteditor, #composer-input, textarea#input, [contenteditable="true"][role="textbox"]',
  composer: () => tryQuery('#prompt-texteditor') || tryQuery('#composer-input') || tryQuery('textarea#input'),
  turnSelector: '.response-message, [data-testid="chat-turn"]',
  roleOf: (el) => (/user|request/i.test(String(el.className)) ? 'user' : 'assistant'),
});

/* ---------------- DeepSeek / Kimi / Mistral (ChatGPT-like) ---------------- */

const clonish = (id, label, hostRe, sel) =>
  base({
    id,
    label,
    hosts: [hostRe],
    detect: (h) => hostRe.test(h),
    composerSelector: 'main textarea, main [contenteditable="true"]',
    composer: () => tryQuery('main textarea') || tryQuery('main [contenteditable="true"]'),
    turnSelector: sel,
    roleOf: (el, i) => (/user|human|me\b|question/i.test(String(el.className)) ? 'user' : i % 2 === 0 ? 'user' : 'assistant'),
  });

const deepseek = clonish('deepseek', 'DeepSeek', /(^|\.)chat\.deepseek\.com$/, '[data-message-author-role], .fbb737a4, [class*="message"]');
const kimi = clonish('kimi', 'Kimi', /(^|\.)kimi\.moonshot\.cn$/, '[data-message-author-role], [class*="message"]');
const mistral = clonish('mistral', 'Mistral', /(^|\.)mistral\.ai$/, '[data-message-author-role], [class*="message"]');

const HINTS = [chatgpt, claude, gemini, perplexity, copilot, deepseek, kimi, mistral];

/**
 * Build the real adapter.
 *
 * The site's hint is a starting point; the sensing engine (sense.js) decides
 * what is actually true, and its answer wins. Three outcomes are possible and
 * all of them are fine:
 *
 *   - the hint is visible  -> used, because a verified selector is cheap
 *   - the hint is stale    -> discarded, structural detection takes over
 *   - no hint matched      -> pure structural detection, which is the point
 *
 * `messageSel` stays null for sensed pages because a CSS selector cannot
 * honestly describe a list we found by walking the tree. Callers that need the
 * elements use `turnElements()` instead.
 */
function tryHint(sel) {
  if (typeof sel !== 'string') return null;
  try { return document.querySelector(sel); } catch { return null; }
}

function buildAdapter(hint, { label } = {}) {
  // The site's selectors go IN as a hint. The engine verifies them against the
  // live DOM and uses them only if they actually resolve.
  const engine = PB.sense.derivedAdapter(
    hint && {
      id: hint.id,
      label: hint.label,
      hosts: hint.hosts,
      composerSelector: hint.composerSelector,
      turnSelector: hint.turnSelector,
      listSelector: hint.listSelector,
      roleOf: hint.roleOf,
    }
  );
  const hintComposer = typeof hint?.composer === 'function' ? hint.composer() : tryHint(hint?.composerSelector);
  const id = hint?.id || 'sensed';

  const api = {
    id,
    label: label || hint?.label || 'This page',
    hosts: hint?.hosts || ['*'],
    sensed: !hint,
    hintId: hint?.id || null,

    composer() {
      if (hintComposer && document.contains(hintComposer)) return hintComposer;
      return engine.composer;
    },
    messageSel: null,
    turnElements() { return engine.turnEls.map((n) => n.el).filter(Boolean); },
    turns() { return engine.turns(); },
    isStreaming:
      hint?.isStreaming ||
      (() => !!document.querySelector('[data-is-streaming="true"], button[aria-label*="Stop" i], [aria-label*="Stop generating" i]')),
    submit(el) {
      const target = el || api.composer();
      if (hint?.submit) return hint.submit(target);
      return clickSend() || pressEnter(target);
    },
    diagnose() {
      const d = engine.diagnose();
      return { ...d, adapter: id, label: api.label, engine: 'sense', hint: hint?.id || null };
    },
    explain() {
      return { ...engine.explain(), hint: hint?.id || null, adapter: id, label: api.label };
    },
  };
  return api;
}

/**
 * @param {string} host
 * @param {{disabled?: string[]}} opts  site ids the user switched off in
 *        onboarding. A disabled site loses only its HINT — structural
 *        detection still applies, because that is the architecture.
 */
function resolveAdapter(host = location.hostname, { disabled = [] } = {}) {
  const off = new Set(disabled);
  const hint = HINTS.find((h) => h.detect(host) && !off.has(h.id)) || null;
  return buildAdapter(hint);
}

/** Every known hint, for the health panel's "what did we match?" readout. */
const knownSites = () => HINTS.map((h) => ({ id: h.id, label: h.label, hosts: h.hosts }));

/* ---------------- public helpers ---------------- */

function patchComposer(adapter) {
  const el = adapter.composer();
  return el ? composerIO(el) : null;
}

const readComposer = (adapter) => adapter.composer() ? composerIO(adapter.composer()).get() : '';
const writeComposer = (adapter, v) => patchComposer(adapter)?.set(v) ?? false;

function submitComposer(adapter) {
  const el = adapter.composer();
  if (!el) return { ok: false, reason: 'no-composer' };
  adapter.submit(el);
  return { ok: true };
}

/** SPAs mount late — poll briefly, cheaply, until a composer exists. */
function waitForComposer(adapter, { timeout = 12000, step = 250 } = {}) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    (function poll() {
      const el = adapter.composer();
      if (el) return resolve(el);
      if (Date.now() - t0 > timeout) return resolve(null);
      setTimeout(poll, step);
    })();
  });
}

/**
 * Turn elements for reading mode and the in-place lens. Prefers the adapter's
 * own selector when a hand-written one is still in play, and otherwise asks
 * the engine for the elements it found by walking the tree.
 */
const messageEls = (adapter) => {
  if (adapter.turnElements) {
    const els = adapter.turnElements();
    if (els.length) return els;
  }
  return adapter.messageSel ? [...document.querySelectorAll(adapter.messageSel)] : [];
};
const lastMessageEl = (adapter) => messageEls(adapter).at(-1) || null;

PB.adapters = { composerIO, clickSend, text, HINTS, knownSites, resolveAdapter, buildAdapter, patchComposer, readComposer, writeComposer, submitComposer, waitForComposer, messageEls, lastMessageEl };

})(globalThis.PB = globalThis.PB || {});
