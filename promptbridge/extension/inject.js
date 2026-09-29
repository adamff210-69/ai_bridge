/* PromptBridge — loaded as a plain script, no bundler. */
(function (PB) {
'use strict';

/**
 * The in-page layer: the two affordances that have to be where the work is.
 *
 * The shell is a drawer you open. That is the wrong place for the two things
 * you do most often:
 *
 *   · COOK  — you are mid-sentence in some other site's composer, and the
 *             button that fixes your prompt should be right there, not behind
 *             a keyboard shortcut and a palette.
 *   · DROP  — you have a Context Pack saved and you want to put it into the
 *             box you are looking at. Capsule Hub's drag-to-inject is the right
 *             interaction and the reason people like it: the pack travels from
 *             the library straight into the conversation, with no dialog.
 *
 * Everything lives in a shadow root so page CSS cannot reach it and ours cannot
 * leak out. It mounts lazily on the first real prompt, so a page load on a
 * site with no composer costs one cheap query.
 */

const CSS = `
:host { all: initial; }
.bar {
  position: fixed; z-index: 2147483000; right: 18px;
  bottom: 96px; display: flex; align-items: center; gap: 6px;
  font: 500 12.5px/1 ui-sans-serif, system-ui, -apple-system, sans-serif;
  background: #14181f; color: #e6edf3; border: 1px solid #2a323d;
  border-radius: 999px; padding: 5px 5px 5px 6px;
  box-shadow: 0 8px 28px rgba(0,0,0,.42);
  opacity: 0; transform: translateY(6px); pointer-events: none;
  transition: opacity .16s ease, transform .16s ease;
}
.bar.on { opacity: 1; transform: none; pointer-events: auto; }
.bar button {
  all: unset; cursor: pointer; padding: 7px 12px; border-radius: 999px;
  color: #c9d1d9; white-space: nowrap; transition: background .12s, color .12s;
}
.bar button:hover { background: #232a34; color: #fff; }
.bar button:disabled { opacity: .45; cursor: default; }
.bar button.cook { background: #7c8cff; color: #0b0e14; font-weight: 650; }
.bar button.cook:hover { background: #93a0ff; }
.bar .sep { width: 1px; height: 18px; background: #2a323d; }
.bar .n {
  min-width: 18px; height: 18px; padding: 0 5px; border-radius: 9px;
  background: #7c8cff; color: #0b0e14; font-size: 11px; font-weight: 700;
  display: inline-flex; align-items: center; justify-content: center;
}
.badge {
  position: absolute; right: -4px; top: -4px; min-width: 17px; height: 17px;
  padding: 0 4px; border-radius: 9px; background: #3fb950; color: #05130a;
  font-size: 10.5px; font-weight: 800;
  display: inline-flex; align-items: center; justify-content: center;
}

.tray {
  position: fixed; z-index: 2147483001; right: 18px; bottom: 140px;
  width: 320px; max-height: 60vh; overflow: auto;
  background: #14181f; border: 1px solid #2a323d; border-radius: 14px;
  box-shadow: 0 18px 50px rgba(0,0,0,.55);
  font: 13px/1.5 ui-sans-serif, system-ui, sans-serif; color: #e6edf3;
  display: none; padding: 10px;
}
.tray.on { display: block; }
.tray h5 { all: unset; display: block; font-size: 11px; letter-spacing: .09em;
  text-transform: uppercase; color: #8b949e; padding: 2px 4px 8px; }
.chip {
  display: block; width: 100%; text-align: left; cursor: grab;
  background: #1b212b; border: 1px solid #2a323d; border-radius: 10px;
  padding: 9px 11px; margin-bottom: 6px; color: #e6edf3;
  font: inherit; transition: border-color .12s, background .12s;
}
.chip:hover { border-color:#3d4757; background: #212836; }
.chip:active { cursor: grabbing; }
.chip .t { font-weight: 650; display: block; }
.chip .m { font-size: 11px; color: #8b949e; display: block; margin-top: 2px; }
.chip .g { display: flex; gap: 6px; margin-top: 7px; }
.chip .g button { all: unset; cursor: pointer; font-size: 11px; color: #8b949e;
  border: 1px solid #2a323d; border-radius: 6px; padding: 3px 7px; }
.chip .g button:hover { color: #e6edf3; border-color: #3d4757; }
.empty { color: #8b949e; font-size: 12px; padding: 10px 6px 12px; line-height: 1.6; }
.empty b { color: #c9d1d9; }

.dropping .bar { outline: 2px solid #3fb950; outline-offset: 2px; }
`;

const esc = (s) =>
  String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const relative = (t) => {
  const s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return Math.round(s / 60) + 'm ago';
  if (s < 86400) return Math.round(s / 3600) + 'h ago';
  if (s < 604800) return Math.round(s / 86400) + 'd ago';
  return new Date(t).toLocaleDateString();
};

/**
 * @param {object} api  the content-script api (capture, enhance, listPacks, dropPack…)
 * @param {function} adapter
 */
function createInjectedBar(api, adapter) {
  const host = document.createElement('div');
  host.id = 'promptbridge-inject';
  // Stay out of the way of pages that hide stray fixed elements.
  host.style.cssText = 'all:initial;position:static';
  const root = host.attachShadow({ mode: 'open' });

  const style = document.createElement('style');
  style.textContent = CSS;
  root.appendChild(style);

  const bar = document.createElement('div');
  bar.className = 'bar';
  bar.innerHTML = `
    <button class="cook" data-a="cook" title="Rewrite this prompt so the model has everything it needs">Cook this prompt</button>
    <span class="sep"></span>
    <button data-a="capture" title="Distil this thread into a reusable Context Pack">Capture</button>
    <button data-a="tray" title="Drag a saved pack into any chat box">Packs <span class="n" data-n>0</span></button>`;
  root.appendChild(bar);

  const tray = document.createElement('div');
  tray.className = 'tray';
  root.appendChild(tray);

  document.documentElement.appendChild(host);

  let packs = [];
  let mounted = false;
  let dragging = false;

  const countEl = bar.querySelector('[data-n]');
  const setCount = (n) => { countEl.textContent = n > 99 ? '99+' : String(n); };

  async function refresh() {
    try { packs = (await api.listPacks()) || []; } catch { packs = []; }
    setCount(packs.length);
    if (tray.classList.contains('on')) renderTray();
    return packs;
  }

  function renderTray() {
    if (!packs.length) {
      tray.innerHTML = `<h5>Context Packs</h5>
        <div class="empty">Nothing saved yet.<br>
        Hit <b>Capture</b> on a thread you want to keep, then come back here and
        <b>drag the pack straight into any chat box</b>.</div>`;
      return;
    }
    tray.innerHTML =
      '<h5>Drag a pack into a chat box</h5>' +
      packs
        .map(
          (p) => `<div class="chip" draggable="true" data-pack="${esc(p.id)}">
            <span class="t">${esc(p.title || 'Untitled pack')}</span>
            <span class="m">${esc(p.meta?.messageCount ?? 0)} msgs · ~${esc(p.meta?.tokenEstimate ?? 0)}t · ${esc(p.intent?.taskType || 'chat')} · ${esc(relative(p.created))}</span>
            <span class="g">
              <button data-go="${esc(p.id)}">Send to…</button>
              <button data-open="${esc(p.id)}">Open</button>
              <button data-copy="${esc(p.id)}">Copy</button>
            </span>
          </div>`
        )
        .join('');
  }

  /** Only show the bar when there is a prompt to work on. */
  function sync() {
    const el = adapter.composer?.();
    const ready = !!el;
    if (ready === mounted) return;
    mounted = ready;
    bar.classList.toggle('on', ready);
  }

  /* ---------------- drag and drop ---------------- */

  tray.addEventListener('dragstart', (e) => {
    const chip = e.target.closest?.('[data-pack]');
    if (!chip) return;
    dragging = true;
    e.dataTransfer.effectAllowed = 'copy';
    e.dataTransfer.setData('text/plain', chip.dataset.pack);
    e.dataTransfer.setData('application/x-promptbridge-pack', chip.dataset.pack);
    document.documentElement.classList.add('pb-dragging');
  });

  tray.addEventListener('dragend', () => {
    dragging = false;
    document.documentElement.classList.remove('pb-dragging');
    tray.querySelectorAll('.chip').forEach((c) => c.classList.remove('over'));
  });

  const isOurDrag = (e) => Array.from(e.dataTransfer?.types || []).includes('application/x-promptbridge-pack');

  // A page-level drop target, so a drop anywhere in the conversation works and
  // not only in the exact pixel of the composer.
  document.addEventListener(
    'dragover',
    (e) => {
      if (!isOurDrag(e)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
      const el = adapter.composer?.();
      if (el) el.classList.add('pb-drop-target');
    },
    true
  );

  document.addEventListener(
    'dragleave',
    (e) => {
      if (!dragging) return;
      if (e.relatedTarget) return;
      adapter.composer?.()?.classList.remove('pb-drop-target');
    },
    true
  );

  document.addEventListener(
    'drop',
    async (e) => {
      if (!isOurDrag(e)) return;
      e.preventDefault();
      e.stopPropagation();
      const id = e.dataTransfer.getData('application/x-promptbridge-pack') || e.dataTransfer.getData('text/plain');
      adapter.composer?.()?.classList.remove('pb-drop-target');
      dragging = false;
      document.documentElement.classList.remove('pb-dragging');
      if (id) await api.dropPack(id);
    },
    true
  );

  /* ---------------- clicks ---------------- */

  bar.addEventListener('click', (e) => {
    const act = e.target.closest?.('[data-a]')?.dataset.a;
    if (act === 'cook') api.cookPrompt?.();
    else if (act === 'capture') api.capture?.();
    else if (act === 'tray') {
      const open = !tray.classList.contains('on');
      tray.classList.toggle('on', open);
      // Always re-read: a pack may have been saved from the library page or by
      // a capture on another tab since this bar was mounted.
      if (open) refresh();
    }
  });

  tray.addEventListener('click', (e) => {
    const t = e.target.closest?.('[data-go],[data-open],[data-copy]');
    if (!t) return;
    const id = t.dataset.go || t.dataset.open || t.dataset.copy;
    if (t.dataset.go) api.openPackSend?.(id);
    else if (t.dataset.open) api.openPack?.(id);
    else api.copyPack?.(id);
  });

  return {
    host,
    refresh,
    sync,
    destroy() { host.remove(); document.documentElement.classList.remove('pb-dragging'); },
  };
}

PB.inject = { createInjectedBar };

})(globalThis.PB = globalThis.PB || {});
