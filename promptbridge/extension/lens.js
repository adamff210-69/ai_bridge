/* PromptBridge — loaded as a plain script, no bundler. */
(function (PB) {
'use strict';
const { lastMessageEl, messageEls } = PB.adapters;
const { splitSentences, extractiveSummary, escapeHtml } = PB.SHARED;

/**
 * Output Lens + Reading Mode + Auto-continue.
 *
 * These are the three engines that turn "we took control of the page" into
 * "we made the page better". They touch the host document, so all three are
 * opt-in, reversible, and clean up after themselves.
 */

/* ================================================================== *
 * Output Lens — reformat an answer without spending another token
 * ================================================================== */

const LENS_MODES = [
  { id: 'tldr', label: 'TL;DR', hint: 'three sentences that matter' },
  { id: 'bullets', label: 'Bullets', hint: 'one idea per line' },
  { id: 'table', label: 'Table', hint: 'structure, or tell it to' },
  { id: 'code', label: 'Code only', hint: 'strip the prose' },
  { id: 'json', label: 'JSON', hint: 'machine-readable' },
  { id: 'email', label: 'Email-ready', hint: 'subject, body, sign-off' },
  { id: 'translate', label: 'Translate', hint: 'needs a model' },
];

function applyLens(text = '', mode = 'tldr') {
  const sents = splitSentences(text);
  switch (mode) {
    case 'bullets':
      return sents.filter((s) => s.length > 3).map((s) => `- ${s}`).join('\n') || text;
    case 'tldr':
      return extractiveSummary(text, 3) || text;
    case 'code': {
      const blocks = text.match(/```[\s\S]*?```/g);
      return blocks?.length ? blocks.join('\n\n') : '_no code blocks in this answer_';
    }
    case 'table': {
      const t = text.match(/(?:^\|.*\|$\n?){2,}/m);
      if (t) return t[0].trim();
      const rows = sents.map((l) => l.split(/[,—:;]/).map((c) => c.trim()));
      const w = Math.max(...rows.map((r) => r.length), 2);
      if (w > 6) return '_no clean tabular structure here — "Bullets" is the better lens._';
      const pad = (r) => [...r, ...Array(w - r.length).fill('')];
      const head = pad(rows[0] || []);
      const line = `| ${head.join(' | ')} |`;
      return [line, `| ${head.map(() => '---').join(' | ')} |`, ...rows.slice(1).map((r) => `| ${pad(r).join(' | ')} |`)].join('\n');
    }
    case 'json':
      return JSON.stringify({ points: sents, count: sents.length }, null, 2);
    case 'email':
      return ['Subject: ' + (sents[0] || '').slice(0, 62), '', 'Hi,', '', sents.slice(0, 3).join(' '), '', 'Best,'].join('\n');
    default:
      return text;
  }
}

const LENS_STYLE = 'pb-lens-style';
let openPanel = null;

/** Render the transformed answer inline, under the original. Non-destructive. */
function showLensInPlace(adapter, mode) {
  clearLensInPlace();
  const host = lastMessageEl(adapter);
  if (!host) return { ok: false, reason: 'no-message' };

  const original = host.innerText;
  const out = applyLens(original, mode);
  if (out.trim() === original.trim()) return { ok: false, reason: 'no-change' };

  if (!document.getElementById(LENS_STYLE)) {
    const s = document.createElement('style');
    s.id = LENS_STYLE;
    s.textContent = `
      .pb-lens{position:relative;margin:14px 0;padding:14px 16px 14px 20px;border-radius:12px;
        background:rgba(124,140,255,.07);border:1px solid rgba(124,140,255,.34);
        color:#e6edf3;font:13.5px/1.65 ui-monospace,SFMono-Regular,Menlo,monospace;
        white-space:pre-wrap;word-break:break-word;max-height:46vh;overflow:auto}
      .pb-lens::before{content:"";position:absolute;left:0;top:0;bottom:0;width:3px;border-radius:3px;background:#7c8cff}
      .pb-lens-bar{display:flex;gap:8px;align-items:center;margin-top:11px;font:12px ui-sans-serif,system-ui}
      .pb-lens-bar b{color:#7c8cff;font-weight:600}
      .pb-lens-bar button{background:rgba(255,255,255,.06);color:#e6edf3;border:1px solid rgba(255,255,255,.16);
        border-radius:7px;padding:4px 9px;cursor:pointer;font:inherit}
      .pb-lens-bar button:hover{border-color:#7c8cff}
      .pb-lens-bar .sp{flex:1}`;
    document.head.appendChild(s);
  }

  const el = document.createElement('div');
  el.className = 'pb-lens';
  el.innerHTML = `<div>${escapeHtml(out)}</div>
    <div class="pb-lens-bar">
      <b>${mode.toUpperCase()}</b><span class="sp"></span>
      <button data-a="copy">Copy</button>
      <button data-a="replace">Replace original</button>
      <button data-a="close">Close</button>
    </div>`;
  el.querySelector('[data-a="copy"]').onclick = () => {
    navigator.clipboard?.writeText(out);
    flash(el, 'Copied');
  };
  el.querySelector('[data-a="replace"]').onclick = () => {
    host.innerText = out;
    clearLensInPlace();
  };
  el.querySelector('[data-a="close"]').onclick = () => clearLensInPlace();

  host.after(el);
  openPanel = el;
  return { ok: true, text: out, el };
}

function flash(el, msg) {
  const b = el.querySelector('[data-a="copy"]');
  const was = b.textContent;
  b.textContent = msg;
  setTimeout(() => (b.textContent = was), 1200);
}

function clearLensInPlace() {
  openPanel?.remove();
  openPanel = null;
}

/* ================================================================== *
 * Reading Mode — the page, but quieter
 * ================================================================== */

const RM_ID = 'pb-reading-style';
const RM_KEY = 'pb-reading-on';

const READING_CSS = (msgSel) => `
  html.pb-reading body{--pb-rm:1}
  html.pb-reading ${msgSel}{transition:opacity .18s ease,filter .18s ease}
  html.pb-reading ${msgSel}{opacity:.28;filter:saturate(.4)}
  html.pb-reading ${msgSel}:nth-last-of-type(-n+4){opacity:1;filter:none}
  html.pb-reading ${msgSel}:hover{opacity:1;filter:none}
  html.pb-reading ${msgSel} p,html.pb-reading ${msgSel} li{font-size:16.5px;line-height:1.78;max-width:72ch}
  html.pb-reading pre{font-size:13.5px;line-height:1.6}
  html.pb-reading ${msgSel}:nth-last-of-type(-n+4){border-left:2px solid #7c8cff;padding-left:14px;margin-left:-16px}
  @media (prefers-reduced-motion:reduce){html.pb-reading ${msgSel}{transition:none}}`;

/**
 * localStorage throws, rather than returning null, on a file:// or sandboxed
 * origin. Reading mode is a nicety; a thrown SecurityError in a content script
 * takes the whole extension down with it, so every access goes through here.
 */
function rememberReading(on) {
  try { localStorage.setItem(RM_KEY, on ? '1' : '0'); } catch { /* not available */ }
  return on;
}
const recallReading = () => {
  try { return localStorage.getItem(RM_KEY) === '1'; } catch { return false; }
};

function setReadingMode(adapter, on) {
  const html = document.documentElement;
  if (!on) {
    html.classList.remove('pb-reading');
    document.getElementById(RM_ID)?.remove();
    return rememberReading(false);
  }
  const s = document.createElement('style');
  s.id = RM_ID;
  s.textContent = READING_CSS(adapter.messageSel || '*');
  document.head.appendChild(s);
  html.classList.add('pb-reading');
  return rememberReading(true);
}

const readingModeOn = () => recallReading();

function restoreReadingMode(adapter) {
  if (readingModeOn()) setReadingMode(adapter, true);
}

/* ================================================================== *
 * Auto-continue — the answer stopped, so draft what comes next
 * ================================================================== */

const CUTOFF = [
  /\b(?:let me know if|would you like|i can also|if you (?:want|need)|shall i|next,? i)\b[^.!?]*$/i,
  /(?:\n|^)\s*[-*]\s*[^\n]*$/, // trailing unfinished bullet
  /```\s*$/, // unclosed code fence
  /:\s*$/, // trailing colon -> a list was about to start
];

function looksTruncated(text = '') {
  if (!text.trim()) return false;
  return CUTOFF.some((re) => re.test(text.trim()));
}

function draftFollowUp(pack, answerText = '') {
  const open = pack?.openThreads?.[0] || '';
  const artifact = pack?.artifacts?.[0];
  if (/test|verify|check/i.test(answerText) && /success|green|pass/i.test(answerText))
    return 'Run the test suite now and show me the actual output, including any failures in full. If something fails, diagnose the cause before proposing another change.';
  if (artifact?.kind === 'code')
    return 'Apply this change to the codebase now. Then show me a diff, a test that would have failed before the change, and the result of running it.';
  if (open)
    return 'Address that directly: ' + open.replace(/^(?:let me know if|would you like|i can also)\s*/i, '').replace(/\s*\?+$/, '') + '. Show the concrete change, not a plan.';
  if (/\bnext step|next up|remaining/i.test(answerText))
    return 'Do the next step you just described, all the way to completion, and show the result.';
  return 'Continue from exactly where that stopped. Do not recap what you already said.';
}

PB.lens = { messageEls, LENS_MODES, applyLens, showLensInPlace, clearLensInPlace, setReadingMode, readingModeOn, restoreReadingMode, looksTruncated, draftFollowUp };

})(globalThis.PB = globalThis.PB || {});
