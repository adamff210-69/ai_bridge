/* PromptBridge — loaded as a plain script, no bundler. */
(function (PB) {
'use strict';

/**
 * Page sensing — the part that is actually novel.
 *
 * Every other extension ships a list: "claude.ai uses this selector, chatgpt
 * uses that one", and quietly breaks the day a vendor ships a redesign. Those
 * lists are also why they only work on the sites somebody remembered to add.
 *
 * This module does the opposite. It looks at the page you are actually on and
 * works out, from structure alone:
 *
 *   1. where the composer is        — scored candidates, not a selector
 *   2. where the message list is    — the container of repeated siblings
 *   3. which elements are the turns — leaf blocks, de-duplicated
 *   4. who said each one            — explicit hooks, else a Viterbi pass that
 *                                    assigns roles while preferring alternation
 *
 * A site adapter is then only a set of *hints*. A right hint is cheaper; a
 * wrong one is ignored. That is the whole point, and it is why a Claude
 * redesign cannot break capture.
 */

const PROFILE_KEY = 'pb.profiles';

/* ================================================================== *
 * cheap DOM helpers
 * ================================================================== */

const visible = (el) => {
  if (!el || !el.getBoundingClientRect) return false;
  const r = el.getBoundingClientRect();
  if (r.width < 2 || r.height < 2) return false;
  const st = getComputedStyle(el);
  return st.visibility !== 'hidden' && st.display !== 'none' && st.opacity !== '0';
};

const ownText = (el) =>
  (el.innerText || el.textContent || '').replace(/\u00a0/g, ' ').replace(/\n{3,}/g, '\n\n').trim();

/** Everything that could identify this element, lowercased, for role hints. */
function signature(el) {
  if (!el || el.nodeType !== 1) return '';
  return [
    el.tagName,
    el.id || '',
    el.getAttribute?.('class') || '',
    el.getAttribute?.('data-testid') || '',
    el.getAttribute?.('data-role') || '',
    el.getAttribute?.('data-message-author-role') || '',
    el.getAttribute?.('aria-label') || '',
    el.getAttribute?.('data-author') || '',
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
}

/** A short, stable, re-findable CSS path, for the cached profile. */
function cssPath(el) {
  if (!el || el.nodeType !== 1) return '';
  if (el.id) return '#' + CSS.escape(el.id);
  const parts = [];
  let node = el;
  for (let i = 0; node && node.nodeType === 1 && parts.length < 6; i++) {
    let part = node.tagName.toLowerCase();
    if (node.id) { parts.unshift('#' + CSS.escape(node.id)); break; }
    const cls = (node.getAttribute('class') || '').trim().split(/\s+/).filter(Boolean).slice(0, 2);
    if (cls.length) part += '.' + cls.map((c) => CSS.escape(c)).join('.');
    const parent = node.parentElement;
    if (parent) {
      const same = [...parent.children].filter((c) => c.tagName === node.tagName);
      if (same.length > 1) part += `:nth-of-type(${same.indexOf(node) + 1})`;
    }
    parts.unshift(part);
    node = node.parentElement;
  }
  return parts.join(' > ');
}

const tryQuery = (sel) => {
  try { return document.querySelector(sel); } catch { return null; }
};

/* ================================================================== *
 * 1 · the composer
 * ================================================================== */

const PROMPT_WORDS = /(^|\b)(message|send|ask|prompt|chat|reply|respond|write|tell|query|question|composer|anything)\b/i;
const HIDE_WORDS = /search|filter|find|password|e-?mail|login|sign ?in|address|card|your name|comment|subject|otp|verify|zip|phone/i;
const SEND_HINT = /(send|submit|voice|attach)/i;

/**
 * Chat composers are recognisable without knowing the site: big, visible,
 * docked near the bottom, labelled like a prompt, usually beside a send button.
 */
function findComposer() {
  const vh = window.innerHeight || 800;
  let best = null;
  let bestScore = -Infinity;

  const candidates = [
    ...document.querySelectorAll('textarea:not([type="hidden"]):not([readonly])'),
    ...document.querySelectorAll('[contenteditable="true"]:not([aria-readonly="true"])'),
  ];

  for (const el of candidates) {
    if (!visible(el)) continue;
    const r = el.getBoundingClientRect();
    if (r.width < 80) continue;

    let score = 0;
    const sig = signature(el);
    const label = [el.getAttribute?.('placeholder'), el.getAttribute?.('aria-label'), el.getAttribute?.('data-placeholder'), el.getAttribute?.('name'), el.id]
      .filter(Boolean)
      .join(' ');

    if (PROMPT_WORDS.test(label)) score += 40;
    if (HIDE_WORDS.test(label)) score -= 50;
    score += el.tagName === 'TEXTAREA' ? 8 : el.isContentEditable ? 6 : 0;
    score += Math.min(20, r.width / 60);
    if (r.height >= 24) score += 8;

    // Docked near the bottom of the viewport is the strongest single signal.
    const fromBottom = vh - r.bottom;
    if (fromBottom < 220) score += 30;
    else if (fromBottom < 420) score += 12;
    if (r.top > vh) score -= 60;

    // A send button in the same form or scroll region is close to proof.
    const scope = el.closest('form') || el.parentElement?.parentElement || document;
    const btn = [...scope.querySelectorAll('button, [role="button"]')].find((b) => {
      if (!visible(b)) return false;
      const s = (b.getAttribute('aria-label') || b.getAttribute('data-testid') || b.textContent || '').trim();
      return SEND_HINT.test(s);
    });
    if (btn) {
      score += 35;
      if (Math.abs(btn.getBoundingClientRect().bottom - r.bottom) < 80) score += 10;
    }

    // ProseMirror / Quill / Lexical are what AI chat UIs actually run on.
    if (/prosemirror|ql-editor|lexical|cm-content|monaco/.test(sig)) score += 22;
    if (el.isContentEditable && el.closest('[class*="ProseMirror"],[class*="composer" i],[class*="inputbox" i],[class*="inputarea" i]')) score += 12;

    if (el.disabled || el.getAttribute('aria-disabled') === 'true') score -= 50;

    if (score > bestScore) { bestScore = score; best = el; }
  }

  return best ? { el: best, score: bestScore } : null;
}

/* ================================================================== *
 * 2 + 3 · the message list and its turns
 * ================================================================== */

/**
 * Find the element whose children are the conversation: a container with
 * several element children that share a class signature and carry real text.
 * A repeating sibling set is the fingerprint of a transcript.
 */
function findMessageList() {
  const all = document.querySelectorAll('div, section, main, article, ul, ol, form');
  let best = null;
  let bestScore = 0;
  let bestChildren = 0;

  for (const box of all) {
    if (!visible(box)) continue;
    const kids = [...box.children].filter((c) => c.nodeType === 1 && !/^(SCRIPT|STYLE|NOSCRIPT)$/.test(c.tagName));
    if (kids.length < 2) continue;

    let useful = 0;
    let longest = 0;
    let signatureRepeats = 0;
    const seen = new Map();

    for (const k of kids) {
      const t = ownText(k);
      if (t.length < 12) continue;
      useful++;
      longest = Math.max(longest, t.length);
      const s = signature(k).slice(0, 90);
      if (s) seen.set(s, (seen.get(s) || 0) + 1);
    }
    if (useful < 2) continue;
    for (const n of seen.values()) if (n > signatureRepeats) signatureRepeats = n;

    const homogeneity = signatureRepeats / useful;
    let score = useful * 4 + signatureRepeats * 10 + homogeneity * 30;
    if (longest > 120) score += 25;
    if (longest > 400) score += 10;

    // Prefer the tightest container that still holds the repeats — an outer
    // wrapper would count the same turns again and inflate the count.
    if (best && box.contains(best) && useful >= bestChildren) continue;
    if (best && best.contains(box)) continue;

    best = box;
    bestScore = score;
    bestChildren = useful;
  }

  return best ? { el: best, score: bestScore, childCount: bestChildren } : null;
}

/**
 * Within the list, keep only elements that are self-contained blocks: a node
 * whose text is identical to one of its descendants is a wrapper, not a turn.
 */
function collectTurns(listEl) {
  const out = [];
  const seenText = new Set();

  const visit = (el) => {
    for (const c of el.children) {
      if (!visible(c)) continue;
      const t = ownText(c);
      if (t.length < 2) continue;

      // A wrapper: some descendant holds exactly this text.
      let isWrapper = false;
      for (const d of c.querySelectorAll('*')) {
        if (d === c) continue;
        if (ownText(d) === t) { isWrapper = true; break; }
      }
      if (!isWrapper) { out.push({ el: c, text: t }); continue; }
      visit(c);
    }
  };

  // Start from the list's children, but also consider the list itself if the
  // children turned out to be one giant app shell.
  visit(listEl);
  if (!out.length) { const t = ownText(listEl); if (t) out.push({ el: listEl, text: t }); }

  // Keep document order, drop exact repeats (sticky headers, "copy" duplicates).
  return out.filter((n, i) => {
    if (seenText.has(n.text)) return false;
    seenText.add(n.text);
    return i >= 0;
  });
}

/* ================================================================== *
 * 4 · who said it
 * ================================================================== */

const USER_HINT = /\b(user|human|me\b|my |question|ask|asked|prompt|query|input|request)\b/;
const AI_HINT = /\b(assistant|ai|bot|model|answer|claude|gpt|gemini|copilot|llama)\b/;

/**
 * A visible speaker label. Chat UIs constantly render "You" / "Claude" /
 * "ChatGPT" as a short line above the message, and it is the single most
 * reliable role signal on the page when it is present — far more reliable
 * than guessing from prose, and it costs one cheap DOM read.
 */
const SPEAKER_NAMES = /^(you|me|my ?messages?|user|human|assistant|ai|chatgpt|claude|gemini|copilot|perplexity|deepseek|bot|model|chatbot|qwen|llama|mistral|grok)$/i;
const LABEL_USER = /^(you|me|my ?messages?|user|human)$/;
const LABEL_AI = /^(assistant|ai|bot|model|chatbot|chatgpt|claude|gemini|copilot|perplexity|deepseek|qwen|llama|mistral|grok)$/;

/**
 * Find a speaker label structurally, not from a vocabulary.
 *
 * A label is a short first block with more content after it — "You" above a
 * bubble, an avatar, a product name. Asking "is this string a known assistant
 * name" cannot work, because the model is called Claude, ChatGPT, quill, Lumi,
 * or whatever the product shipped last quarter.
 */
function speakerLabel(el) {
  if (!el) return null;
  const kids = [...(el.children || [])];
  if (kids.length < 2) return null;
  const label = ownText(kids[0]).split('\n')[0].trim().replace(/[:：]$/, '');
  if (!label || label.length > 24) return null;
  if (label === ownText(el).trim()) return null; // that was the whole message
  return label.toLowerCase();
}

const labelRole = (label) => (!label ? null : LABEL_USER.test(label) ? 'user' : LABEL_AI.test(label) ? 'assistant' : null);

/**
 * Resolve speaker labels positionally.
 *
 * A chat that labels its turns at all almost always labels the human first, so
 * the first label belongs to the user, the same label is the user again, and
 * any other label is the model. A known name still wins where we have one.
 * Fewer than two distinct labels is not evidence of anything.
 */
function labelsToRoles(turnEls) {
  const labels = turnEls.map((n) => speakerLabel(n.el));
  const found = labels.filter(Boolean);
  if (!found.length) return null;
  if (new Set(found).size < 2) return null;

  const firstIdx = labels.findIndex(Boolean);
  const anchor = labels[firstIdx];
  const anchorRole = labelRole(anchor) || 'user';
  const otherRole = anchorRole === 'user' ? 'assistant' : 'user';

  return labels.map((l) => {
    if (!l) return null;
    return labelRole(l) || (l === anchor ? anchorRole : otherRole);
  });
}

/** Explicit hooks beat every heuristic. */
function explicitRole(el, text) {
  const byLabel = labelRole(speakerLabel(el));
  if (byLabel) return byLabel;

  const bits = [
    el.getAttribute?.('data-message-author-role'),
    el.getAttribute?.('data-role'),
    el.getAttribute?.('data-author'),
    el.getAttribute?.('data-testid'),
    el.getAttribute?.('aria-label'),
    el.className,
    el.id,
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();

  // User is checked FIRST, and "response" is deliberately not a marker: a
  // Copilot turn reads "response-message user-request", and an assistant-first
  // check calls all four of them assistant because "response" is on every turn.
  if (/user|human|question|ask|request|prompt/.test(bits)) return 'user';
  if (/assistant|ai-message|model-response|chatgpt|claude|gemini/.test(bits)) return 'assistant';

  // A tool call is model-side activity: real context worth capturing, but it
  // belongs to the model — and a live Claude thread puts these between two
  // assistant turns.
  if (/tool[-_]?call|tool[-_]?card|tool[-_]?result|function[-_]?call|tool_use|tool-output|artifact[-_]?card/.test(bits)) return 'assistant';

  const t = (text || '').toLowerCase();
  if (t.length > 200 && /```|^\s*[-*\d]|^\s*#{1,4}\s/m.test(t)) return 'assistant';
  if (USER_HINT.test(bits)) return 'user';
  if (AI_HINT.test(bits) && text && text.length > 80) return 'assistant';
  return null;
}

/** What the text alone suggests. Used as a soft signal, never as truth. */
function contentLikelihood(text) {
  const t = text || '';
  const long = Math.min(1, t.length / 700);
  const structured = /```|^\s*[-*]\s|^\s*\d+\.\s|^\s*#{1,4}\s|\|.*\|/m.test(t) ? 1 : 0;
  const chatty = /\b(thanks|thank you|can you|could you|please|help me|i need|i want|how do|what is|why)\b/i.test(t) ? 1 : 0;
  return {
    user: chatty * 0.6 + (1 - long) * 0.2,
    assistant: long * 0.7 + structured * 0.5,
  };
}

/**
 * Assign roles across the whole thread at once.
 *
 * A turn-by-turn guess is wrong the moment a thread is asymmetric (a model
 * that sent two messages, a tool result, a regenerated answer). Instead this
 * runs a two-state Viterbi: switching roles is cheap, staying the same role is
 * cheap only if the content agrees, and the thread is anchored on the fact
 * that the first meaningful turn of a chat is the user.
 */
function assignRoles(turns) {
  const n = turns.length;
  if (!n) return [];
  if (n === 1) return [explicitRole(turns[0].el, turns[0].text) || 'user'];

  // Costs: [prevRole][curRole]
  const SWITCH = 0.0;   // alternation is the norm, so switching is free
  const STAY_USER = 1.6;
  const STAY_ASSISTANT = 1.1;

  const rows = turns.map((t) => {
    const explicit = explicitRole(t.el, t.text);
    if (explicit) return { forced: explicit, like: { user: 0, assistant: 0 } };
    const l = contentLikelihood(t.text);
    return { forced: null, like: l };
  });

  const ROLES = ['user', 'assistant'];
  const cost = (i, prev, cur) => {
    const row = rows[i];
    if (row.forced) return row.forced === cur ? 0 : 999;
    let c = prev === cur ? (cur === 'user' ? STAY_USER : STAY_ASSISTANT) : SWITCH;
    c -= row.like[cur] * 0.9;
    return c;
  };

  let dp = [cost(0, 'assistant', 'user'), cost(0, 'assistant', 'assistant')];
  const back = [[]];
  for (let i = 1; i < n; i++) {
    const next = [Infinity, Infinity];
    const from = [null, null];
    for (let c = 0; c < 2; c++) {
      for (let p = 0; p < 2; p++) {
        const v = dp[p] + cost(i, ROLES[p], ROLES[c]);
        if (v < next[c]) { next[c] = v; from[c] = p; }
      }
    }
    dp = next;
    back.push(from);
  }

  let cur = dp[0] <= dp[1] ? 0 : 1;
  const out = new Array(n);
  for (let i = n - 1; i >= 0; i--) { out[i] = ROLES[cur]; cur = back[i][cur]; }
  // Anchor: a chat starts with the human. Nudge the first turn if the
  // optimiser made it the model, unless the site told us otherwise.
  if (!rows[0].forced && out[0] === 'assistant') out[0] = 'user';
  return out;
}

/* ================================================================== *
 * the derived adapter
 * ================================================================== */

let cache = null;

/** Cheap identity of "the page we already analysed".
 *  Counts the container-ish tags a chat can mount turns into — divs alone
 *  miss `<article>`-based transcripts (ChatGPT) and `<section>` lists, and a
 *  stale fingerprint meant freshly appended turns were invisible until some
 *  unrelated div changed. */
function pageFingerprint() {
  return [
    location.pathname.slice(0, 60),
    document.querySelectorAll('div,article,section,ul,ol').length,
    document.body?.children.length || 0,
  ].join('|');
}

function analyse({ hint = null } = {}) {
  const t0 = performance.now();

  // A hint is a head start, never a dependency.
  let composer = null;
  const hinted = hint?.composer ? tryQuery(hint.composer) : null;
  if (hinted && visible(hinted)) composer = { el: hinted, score: 100, from: 'hint' };
  const sensed = findComposer();
  if (!composer && sensed) composer = { ...sensed, from: 'sensed' };
  if (composer && sensed && sensed.el !== composer.el && sensed.score > composer.score) {
    composer = { ...sensed, from: 'sensed' };
  }

  // No input box means this is not a chat, it is a page that happens to have
  // repeated blocks — an article, a comment thread, a settings screen.
  //
  // This gate is also the performance story. Now that the content script loads
  // on every site, the expensive half (walking the DOM for a message list) only
  // ever runs on pages that actually have a chat composer in them, which is a
  // small fraction of the web. On everything else the whole analysis is one
  // pass over the handful of textareas and contenteditable nodes.
  if (!composer?.el) {
    return {
      id: hint?.id || 'sensed', label: hint?.label || 'This page', origin: location.hostname,
      composer: null, list: null, listFrom: 'no-composer', turnEls: [], turns: [],
      ms: Math.round(performance.now() - t0),
    };
  }

  let list = null;
  const hintedList = hint?.list ? tryQuery(hint.list) : null;
  if (hintedList && visible(hintedList)) list = { el: hintedList, from: 'hint' };
  if (!list) {
    const found = findMessageList();
    if (found) list = { el: found.el, score: found.score, from: 'sensed' };
  }

  // If we have a composer but no list, walk up from the composer: a
  // transcript is almost always an ancestor region.
  if (!list && composer?.el) {
    let node = composer.el.parentElement;
    for (let i = 0; i < 10 && node && node !== document.body; i++) {
      const t = ownText(node);
      if (t.length > 160) { list = { el: node, from: 'ancestor' }; break; }
      node = node.parentElement;
    }
  }

  // A turn selector, if the hint has one and it really matches, is cheaper and
  // more precise than walking the tree. It must produce a list — a hint that
  // matches nothing is discarded rather than half-applied.
  let turnEls = [];
  if (hint?.turns) {
    const els = [...document.querySelectorAll(hint.turns)].filter(visible);
    if (els.length) turnEls = els.map((el) => ({ el, text: ownText(el) }));
  }
  if (!turnEls.length) turnEls = list ? collectTurns(list.el) : [];

  // Priority: a site hint that knows its own markup > speaker labels on the
  // page > content inference with alternation as the prior.
  const byLabel = labelsToRoles(turnEls);
  const inferred = assignRoles(turnEls);
  const roles = turnEls.map((n, i) => {
    let hinted = null;
    if (typeof hint?.roleOf === 'function') {
      try { hinted = hint.roleOf(n.el, i); } catch { hinted = null; }
    }
    if (hinted === 'user' || hinted === 'assistant') return hinted;
    if (byLabel && byLabel[i]) return byLabel[i];
    return inferred[i] || 'user';
  });
  const turns = turnEls.map((n, i) => ({ role: roles[i] || 'user', text: n.text, el: n.el }));

  return {
    id: hint?.id || 'sensed',
    label: hint?.label || 'This page',
    origin: location.hostname,
    composer,
    list: list?.el || null,
    listFrom: list?.from || 'none',
    turnEls,
    turns,
    ms: Math.round(performance.now() - t0),
  };
}

/* ================================================================== *
 * profile cache — remember what worked, re-validate every time
 * ================================================================== */

const profiles = new Map();

async function loadProfiles() {
  try {
    const { [PROFILE_KEY]: p } = await PB.env.storage.get(PROFILE_KEY);
    for (const [k, v] of Object.entries(p || {})) profiles.set(k, v);
  } catch { /* storage unavailable; sensing still works, just re-derives */ }
}

async function saveProfile(origin, profile) {
  profiles.set(origin, profile);
  try {
    await PB.env.storage.set({ [PROFILE_KEY]: { ...Object.fromEntries(profiles) } });
  } catch { /* a profile we cannot persist is a performance nit, not a bug */ }
}

const forgetProfile = (origin) => {
  profiles.delete(origin);
  return PB.env.storage.remove(PROFILE_KEY);
};

/* ================================================================== *
 * public surface
 * ================================================================== */

let booted = null;
const boot = () => (booted ||= loadProfiles());

/**
 * The adapter other modules consume. Same contract as a hand-written one, but
 * every field is derived — and re-derived whenever the page stops matching
 * what we cached.
 */
function derivedAdapter(siteHint, onChange) {
  const origin = location.hostname;
  let current = null;
  let fingerprint = '';

  /**
   * Two kinds of prior knowledge, in priority order:
   *   · a site hint   — a selector a human wrote for this hostname
   *   · a cached profile — what we found last time, on this exact host
   * Both are hints. Both are verified before use and dropped if stale.
   */
  const mergedHint = () => {
    const cached = profiles.get(origin);
    const seed = {
      composer: siteHint?.composerSelector || cached?.composer || '',
      list: siteHint?.listSelector || cached?.list || '',
      turns: siteHint?.turnSelector || '',
      roleOf: siteHint?.roleOf || null,
      label: siteHint?.label || cached?.label,
      id: siteHint?.id,
    };
    return seed;
  };

  const revalidate = () => {
    boot();
    const fp = pageFingerprint();
    if (current && fp === fingerprint) return current;
    fingerprint = fp;

    const next = analyse({ hint: mergedHint() });
    current = next;
    // Only persist a profile that actually found something, and never overwrite
    // a good one with a worse read of a half-loaded page.
    const cached = profiles.get(origin);
    if (next.composer && next.turns.length && (!cached || cached.turnCount < next.turns.length)) {
      saveProfile(origin, {
        composer: cssPath(next.composer.el),
        list: next.list ? cssPath(next.list) : '',
        turnCount: next.turns.length,
        at: Date.now(),
      });
    }
    onChange?.(next);
    return next;
  };

  const turnsCached = () => {
    const a = revalidate();
    const sig = a.turns.length + ':' + (a.turns.at(-1)?.text.length || 0);
    if (turnsCached._sig !== sig) { turnsCached._sig = sig; turnsCached._val = a.turns.map((t) => ({ role: t.role, text: t.text })); }
    return turnsCached._val;
  };

  return {
    id: siteHint?.id || 'sensed',
    label: siteHint?.label || 'This page',
    hosts: siteHint?.hosts || ['*'],
    detect: () => true,
    sensed: true,
    get composer() { return revalidate().composer?.el || null; },
    get messageSel() { return null; },
    get turnEls() { return revalidate().turnEls || []; },
    // Cached: turns() is called on every keystroke for scoring, and re-deriving
    // roles is far too expensive to do that often.
    turns: turnsCached,
    isStreaming: () => !!document.querySelector('[data-is-streaming="true"], button[aria-label*="Stop" i], [aria-label*="Stop generating" i]'),
    submit: () => { PB.adapters.clickSend(); },
    diagnose() {
      const a = revalidate();
      return {
        ok: !!a.composer,
        composer: !!a.composer,
        turns: a.turns.length,
        composerScore: a.composer?.score ?? 0,
        composerFrom: a.composer?.from || 'none',
        listFrom: a.listFrom,
        ms: a.ms,
      };
    },
    explain: () => {
      const a = revalidate();
      return {
        origin,
        composer: a.composer ? { from: a.composer.from, score: a.composer.score, path: cssPath(a.composer.el), tag: a.composer.el.tagName } : null,
        list: a.list ? { from: a.listFrom, path: cssPath(a.list) } : null,
        turns: a.turns.length,
        sample: a.turns.slice(0, 6).map((t) => ({ role: t.role, len: t.text.length, head: t.text.slice(0, 60) })),
        ms: a.ms,
        cached: profiles.has(origin),
      };
    },
  };
}

/** One-shot analysis for the health panel. */
const probe = (hint) => {
  boot();
  const a = analyse({ hint: hint || profiles.get(location.hostname) });
  return {
    ...a,
    explain: {
      composer: a.composer ? { from: a.composer.from, score: a.composer.score, path: cssPath(a.composer.el) } : null,
      list: a.list ? { from: a.listFrom, path: cssPath(a.list) } : null,
      turns: a.turns.length,
      ms: a.ms,
    },
  };
};

PB.sense = { analyse, probe, derivedAdapter, findComposer, findMessageList, collectTurns, assignRoles, explicitRole, cssPath, loadProfiles, forgetProfile, PROFILE_KEY };

})(globalThis.PB = globalThis.PB || {});
