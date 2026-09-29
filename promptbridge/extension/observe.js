/* PromptBridge — loaded as a plain script, no bundler. */
(function (PB) {
'use strict';

/**
 * Observation — the difference between "snappy" and "laggy".
 *
 * Naive implementations poll `setInterval(readComposer, 900)`, which costs a
 * forced layout every tick and, on these SPAs, still misses fast typing.
 * Here: one passive `input` listener on the composer, a cheap 2s identity
 * check to notice the composer being swapped by a re-render, and a
 * MutationObserver for the thread. Analysis is deferred to idle time.
 */

const idle = (fn, timeout = 250) =>
  'requestIdleCallback' in window ? requestIdleCallback(fn, { timeout }) : setTimeout(fn, 1);

function debounce(fn, ms) {
  let t;
  return (...a) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...a), ms);
  };
}

/**
 * Watch the composer. Fires only when the text actually changes.
 * Re-attaches if the framework replaces the element.
 */
function watchComposer(adapter, onChange, { identityMs = 2000 } = {}) {
  let el = null;
  let stopped = false;

  const attach = () => {
    const next = adapter.composer();
    if (next === el) return false;
    el?.removeEventListener('input', onInput, true);
    el = next;
    if (el) el.addEventListener('input', onInput, true);
    return true;
  };

  let last = null;
  function onInput(e) {
    const v = e.target?.isContentEditable ? e.target.innerText : e.target?.value;
    if (v === last) return;
    last = v;
    idle(() => onChange(v));
  }

  attach();
  last = adapter.composer() ? (adapter.composer().isContentEditable ? adapter.composer().innerText : adapter.composer().value) : null;

  // cheap identity probe: one querySelector, no layout reads
  const timer = setInterval(() => !stopped && attach(), identityMs);

  return () => {
    stopped = true;
    clearInterval(timer);
    el?.removeEventListener('input', onInput, true);
  };
}

/**
 * Watch the tail of the thread. Fires when the last assistant message's text
 * changes (streaming) or when the message count changes.
 */
function watchThread(adapter, onChange, { signal } = {}) {
  let observer = null;
  let lastSig = signature(adapter);

  const bind = () => {
    observer?.disconnect();
    const els = adapter.messageSel ? [...document.querySelectorAll(adapter.messageSel)] : [];
    const target = els.at(-1);
    if (!target) return;
    observer = new MutationObserver(() => {
      const s = signature(adapter);
      if (s !== lastSig) { lastSig = s; idle(() => onChange(s)); }
    });
    observer.observe(target, { childList: true, subtree: true, characterData: true });
  };

  bind();
  const rebind = setInterval(() => {
    if (signal?.aborted) return;
    const s = signature(adapter);
    if (s !== lastSig) { lastSig = s; bind(); onChange(s); }
  }, 1500);

  return () => {
    observer?.disconnect();
    clearInterval(rebind);
  };
}

const signature = (adapter) => {
  let t = [];
  try { t = adapter.turns(); } catch { return 'err'; }
  const last = t.at(-1);
  return `${t.length}:${last ? last.text.length : 0}`;
};

/**
 * Resolve once the last assistant answer looks finished.
 * Combines the vendor's streaming markers with a text-stability check,
 * because not every vendor exposes a reliable "done" signal.
 */
function watchAnswer(adapter, { timeout = 240000, poll = 1200, stableChecks = 2, onTick } = {}) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    let stable = 0;
    let lastLen = -1;

    const tick = () => {
      if (Date.now() - t0 > timeout) return resolve({ ok: false, reason: 'timeout', text: lastText(adapter) });

      const streaming = adapter.isStreaming();
      const text = lastText(adapter);
      onTick?.({ streaming, len: text.length });

      if (!streaming) {
        stable = text.length === lastLen && text.length > 0 ? stable + 1 : 0;
        lastLen = text.length;
        if (stable >= stableChecks) return resolve({ ok: true, text, ms: Date.now() - t0 });
      } else {
        stable = 0;
        lastLen = text.length;
      }
      setTimeout(tick, poll);
    };
    setTimeout(tick, 1200);
  });
}

function lastText(adapter) {
  try {
    return [...adapter.turns()].reverse().find((t) => t.role === 'assistant')?.text || '';
  } catch {
    return '';
  }
}

PB.observe = { idle, debounce, watchComposer, watchThread, signature, watchAnswer, lastText };

})(globalThis.PB = globalThis.PB || {});
