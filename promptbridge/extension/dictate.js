(function (PB) {
'use strict';

/**
 * Dictate Engine — speech to *intent*, not speech to text.
 *
 * Four things this does that a plain recogniser does not, and that together are
 * the difference between dictation and the "edit tax" everyone complains about:
 *
 *   1. SELF-CORRECTION  "we should budget 50K, actually 75K" -> "...75K"
 *   2. FLOW MODE        double-tap the key, talk hands-free for a whole paragraph
 *   3. VOCABULARY       learns names/jargon when you fix them, applies them next time
 *   4. COMMAND MODE     "bullet list" *after* dictating reformats what you said
 *
 * Two tiers, chosen by the user because it is a privacy decision:
 *   webspeech      the browser's own recogniser. Free, instant, audio to the vendor.
 *   whisper-local  an endpoint you run. Nothing is bundled — a 240kb extension
 *                  that becomes 45MB is a different product.
 */

// guard: this file is also loaded in a service worker by the test harness
const SR = typeof window !== 'undefined' ? window.SpeechRecognition || window.webkitSpeechRecognition : null;

const webSpeechSupported = !!SR;

const tiers = [
  { id: 'webspeech', label: 'Browser (free, instant)' },
  { id: 'whisper-local', label: 'Local Whisper (private, offline)' },
];

/* ================================================================== *
 * 1 · Self-correction
 * ================================================================== */

/**
 * Correction markers, longest first so "no wait" wins over "wait".
 * Deliberately conservative: bare "no" and "instead" are far too common in
 * ordinary speech to treat as a retraction, so they are not markers.
 */
const CORRECTION_MARKERS = [
  'no wait', 'hold on', 'hold up', 'scratch that', 'never mind', 'i mean',
  'actually', 'correction', 'sorry', 'rather', 'wait',
];

const MARKER_RE = new RegExp(`\\b(${CORRECTION_MARKERS.join('|').replace(/ /g, '\\s+')})\\b\\s*[,:—-]?\\s*`, 'i');

/**
 * Units that travel with a number. Longest-first inside the group, because
 * regex alternation is first-match-wins: "seconds" must be tried before "sec".
 */
const UNITS =
  'milliseconds?|millisecs?|millis|seconds?|secs?|minutes?|mins?|hours?|hrs?|days?|weeks?|months?|years?|yrs?|kb|mb|gb|tb|px|rem|em|ms|kg|hrs|[kKmMbB]|%|x';

/**
 * A "slot" is the thing a correction replaces: a number, money, a time, a
 * weekday, a small count, or a capitalised proper noun. Detecting these is
 * what lets "50K -> 75K" replace one word instead of destroying the sentence.
 *
 * Two details carry the whole feature:
 *  - Magnitude/unit suffixes must be inside the token. A bare `\b\d+\b` does
 *    not match "50K", so a naive pattern misses the most common correction
 *    anyone actually makes in a meeting.
 *  - Order matters. The generic number pattern eats half of "3:30" and "200ms"
 *    if it runs first, leaving a stray ":30" / "ms" behind as the "value".
 *  - No leading `\s?` on the numeric branches: a match that starts on the
 *    space reports an index one char early and welds words together.
 */
const VALUE_RE = new RegExp(
  [
    '\\b\\d{1,2}:\\d{2}\\b', // 3:30
    '[$€£₹]?\\b\\d[\\d,]*(?:\\.\\d+)?\\s?(?:' + UNITS + ')\\b', // 50K, $2000, 200ms
    '(?:[$€£₹])?\\b\\d[\\d,]*(?:\\.\\d+)?%?', // 42, $2,000, 5%
    '\\b(?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|first|second|third|fourth|fifth)\\b',
    '\\b(?:mon|tues|wednes|thurs|fri|satur|sun)(?:day|nesday|rsday|urday)?\\b',
    "\\b[A-Z][A-Za-z'’]{1,}(?:\\s+[A-Z][A-Za-z'’]+)*", // Staging, Prompt Bridge
  ].join('|'),
  'g'
);

/** Capitalised words that are not proper nouns, so never a correction target. */
const NOT_A_NAME = new Set(
  (
    'The This That These Those There Then They We You It And But So If When What Why How Where Let Please Note Use Make Send Add Write Explain Show Give Keep Change Update Return Respond Reply Output Format Ask Try Start Stop Put Set Call Turn Move Run Look Find Need Want Prefer Compare Summarise Summarize Translate Bullet Bullets List Table Json Code Email Copy Paste Open Close Save Load Fix Build Test Debug Review Check Again Wait Actually Really Right Well Yes Nope Okay Hmm Uh Um Er Like Unlike Since Until Unless Whether Either Neither Both All Some Most More Less Very Just Only Even Still Already Never Always Sometimes Often Rarely Here Now Soon Later Today Tomorrow Yesterday January February March April May June July August September October November December'
  ).split(' ')
);

const CLAUSE_BREAK = /[,;:—–\n]/;

/**
 * Every correction target in `str`, proper nouns filtered out.
 * VALUE_RE is global, so lastIndex has to be reset on every call — a stale
 * value silently skips matches and is a miserable thing to debug.
 */
function slots(str) {
  VALUE_RE.lastIndex = 0;
  return [...str.matchAll(VALUE_RE)].filter((m) => !NOT_A_NAME.has(m[0]));
}

/** A bare "no" is only a correction when it is the entire utterance. */
const BARE_NEGATION = /^(?:no|nope|nah)$/i;
/** "wait no", "actually I mean" — the marker is immediately followed by another. */
const LEADING_NEGATION = /^(?:no|nope|nah|i mean|actually|wait|instead|never mind)\b[, ]*/i;

const looksLikeCorrection = (text) => MARKER_RE.test(text);

/**
 * A revisable buffer.
 *
 * `s` is the whole utterance. `locked` is the number of leading characters a
 * correction can no longer touch — once you pause, that part is history.
 * A correction retracts backwards to the nearest *slot* (a value) and, failing
 * that, to the nearest clause boundary. That is what makes
 * "budget 50K for this, actually 75K" come out as "budget 75K for this"
 * instead of losing the whole sentence.
 */
class CorrectionBuffer {
  constructor(base = '') {
    this.s = String(base || '');
    this.locked = this.s.length;
    this.awaitingReplacement = false;
  }

  get text() {
    return normalise(this.s);
  }
  /** the part a late correction may still rewrite */
  get editable() {
    return this.s.slice(this.locked);
  }

  commit() {
    this.locked = this.s.length;
    this.awaitingReplacement = false;
  }
  reset() {
    this.s = '';
    this.locked = 0;
    this.awaitingReplacement = false;
  }

  /**
   * Feed one final phrase. Returns true if the visible text changed, so the
   * caller can decide whether to touch the DOM.
   */
  push(phrase) {
    const before = this.s;
    const raw = String(phrase || '').trim();
    if (!raw) return this.s !== before;

    if (this.awaitingReplacement) {
      // the marker arrived alone ("wait") — this phrase is the replacement
      this.s = normalise(this.s + ' ' + raw);
      this.awaitingReplacement = false;
      return this.s !== before;
    }

    const m = this.#marker(raw);
    if (!m) {
      this.s = normalise(this.s + ' ' + raw);
      return this.s !== before;
    }

    const head = raw.slice(0, m.index).trim();
    if (head) this.s = normalise(this.s + ' ' + head);

    // "wait no, Friday" is ONE correction, not "mark" followed by "no Friday".
    const tail = raw
      .slice(m.index + m[0].length)
      .replace(LEADING_NEGATION, '')
      .trim();
    this.#retract(tail);

    if (!tail) {
      // Retraction leaves a dangling comma; nobody wants "remove the header,".
      this.s = this.s.replace(/[\s,;:—–-]+$/, '');
      this.awaitingReplacement = true;
    }

    return this.s !== before;
  }

  /**
   * Decide whether a phrase is a correction, and where the correction starts.
   *
   * Precision is everything here: a false positive destroys real text. So
   * "no" is only a marker when it stands alone, or leads a phrase whose
   * remainder contains a slot ("no five things" retracts, "no changes needed"
   * does not). Embedded "no" ("the no-code path") is never a marker.
   */
  #marker(raw) {
    if (BARE_NEGATION.test(raw)) return { index: 0, 0: raw };
    const lead = raw.match(/^no\s+/i);
    if (lead && slots(raw.slice(lead[0].length)).length) return { index: 0, 0: lead[0] };
    return raw.match(MARKER_RE);
  }

  /**
   * Roll back, optionally dropping `replacement` into the hole.
   *
   * Three fallbacks, in order of precision:
   *   1. the last slot  — "budget 50K for this" -> "budget 75K for this"
   *   2. the last clause — "keep the header, drop the footer" -> "keep the header"
   *   3. everything uncommitted, keeping every committed sentence intact
   */
  #retract(replacement = '') {
    const ed = this.editable;
    if (!ed) {
      if (replacement) this.s = normalise(this.s + ' ' + replacement);
      return;
    }
    // Slice against the CURRENT string, not `locked`: text keeps growing past
    // the commit point, so `s.slice(0, locked)` would chop a live sentence.
    const prefix = this.s.slice(0, this.s.length - ed.length);

    const values = slots(ed);
    let keep = '';
    if (values.length) {
      const v = values[values.length - 1];
      // A one-word slot swaps in place, so the clause around it survives:
      //   "budget 50K for this" + "75K"  -> "budget 75K for this"
      // A longer tail is a whole re-phrase, so everything after the old slot
      // goes with it:
      //   "I need three things" + "five things" -> "I need five things"
      const bare = replacement.split(/\s+/).length === 1;
      keep = ed.slice(0, v.index) + replacement + (bare ? ed.slice(v.index + v[0].length) : '');
    } else {
      const br = [...ed].reduce((acc, ch, i) => (CLAUSE_BREAK.test(ch) ? i : acc), -1);
      keep = br >= 0 ? ed.slice(0, br + 1) : '';
      if (keep && replacement) keep = normalise(keep + ' ' + replacement);
    }
    this.s = normalise(prefix + (keep ? ' ' + keep : replacement ? ' ' + replacement : ''));
  }
}

function normalise(s) {
  return String(s)
    .replace(/\s+/g, ' ')
    .replace(/\s+([,.!?;:])/g, '$1')
    .replace(/([,.!?])(?=\S)/g, '$1 ')
    .trim();
}

/* ================================================================== *
 * 2 · Filler removal + punctuation (runs after correction)
 * ================================================================== */

const FILLERS = /\b(um+|uh+|er+|ah+|you know|basically|okay so|so yeah|at the end of the day|sort of|kind of|right\?|okay yeah)\b/gi;

/**
 * Leading discourse markers. Only stripped in *sentence-initial* position:
 * removing "so" everywhere would turn "we need it so the build passes" into
 * gibberish, which is a far worse failure than leaving a stray "so".
 */
const OPENER = /^(?:so|and|but|or|then|okay|alright|right|well|yeah|now|anyway|actually)\b[,:\s]+/i;

function clean(raw, { stripFillers = true, sentenceCase = true } = {}) {
  let t = String(raw || '').replace(/\s+/g, ' ').trim();
  if (stripFillers) {
    t = t.replace(FILLERS, ' ').replace(/\s+/g, ' ').trim();
    t = t.replace(OPENER, '');
    t = t.replace(/\s+([,.!?])/g, '$1').replace(/\s+/g, ' ').trim();
    if (sentenceCase) t = t.charAt(0).toUpperCase() + t.slice(1);
  }
  if (t && !/[.!?]$/.test(t) && t.split(' ').length > 4) t += '.';
  return t;
}

/**
 * Post-process a whole utterance: strip fillers, snap to the dictionary, case
 * it. Snapping happens BEFORE capitalisation so a learned term restores its own
 * casing rather than fighting a capital the cleaner already applied.
 */
function polish(text, { stripFillers = true, dictionary } = {}) {
  let t = clean(text, { stripFillers, sentenceCase: false });
  if (dictionary && dictionary.size) t = dictionary.snap(t);
  if (stripFillers && t) t = t.charAt(0).toUpperCase() + t.slice(1);
  return t;
}

/* ================================================================== *
 * 3 · Personal dictionary
 * ================================================================== */

function levenshtein(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) {
      row[j] = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = row;
  }
  return prev[b.length];
}

const TERMISH = /^(?:[A-Z][a-z]+(?:[A-Z][a-z]+)*|[A-Z]{2,}|[A-Za-z]*[A-Z][a-z]+[A-Za-z]*|.*\d.*)$/;

const looksLikeTerm = (w) => TERMISH.test(w) && w.length >= 2;

class Dictionary {
  constructor(entries = {}, cap = 300) {
    this.entries = { ...entries };
    this.cap = cap;
  }
  get size() {
    return Object.keys(this.entries).length;
  }
  list() {
    return Object.entries(this.entries).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  }
  add(word) {
    const w = String(word || '').trim().replace(/[^\w'’-]/g, '');
    if (!looksLikeTerm(w)) return false;
    this.entries[w] = (this.entries[w] || 0) + 1;
    if (this.size > this.cap) {
      const [worst] = Object.entries(this.entries).sort((a, b) => a[1] - b[1])[0];
      delete this.entries[worst];
    }
    return true;
  }
  remove(word) {
    if (!(word in this.entries)) return false;
    delete this.entries[word];
    return true;
  }
  clear() {
    const had = this.size > 0;
    this.entries = {};
    return had;
  }

  /**
   * Learn from an edit: the user fixed something. Tokens that are new relative
   * to what dictation produced, and term-shaped, are candidates.
   *
   * Both sides are lowercased for comparison. Without that, retyping a word the
   * dictionary already holds counts as a fresh correction and the hit counter
   * climbs every single time the user edits the box.
   */
  learnFromEdit(before, after) {
    const was = new Set(String(before).split(/\s+/).map((t) => strip(t).toLowerCase()).filter(Boolean));
    const learned = [];
    for (const w of String(after).split(/\s+/).map(strip).filter(Boolean)) {
      const key = w.toLowerCase();
      if (was.has(key)) continue;
      if (looksLikeTerm(w) || [...was].some((o) => Math.abs(o.length - key.length) <= 2 && levenshtein(o, key) <= 2)) {
        if (this.add(w)) learned.push(w);
      }
    }
    return learned;
  }

  /** Snap mangled words in `text` onto known terms, bucketed by first letter. */
  snap(text) {
    const terms = this.list().map(([w]) => w);
    if (!terms.length) return text;
    const byFirst = new Map();
    for (const t of terms) {
      const k = t[0].toLowerCase();
      if (!byFirst.has(k)) byFirst.set(k, []);
      byFirst.get(k).push(t);
    }
    return text.split(/(\b)/).map((tok) => {
      const w = strip(tok);
      if (w.length < 3 || looksLikeTerm(tok)) return tok;
      const cands = byFirst.get(w[0].toLowerCase()) || [];
      let best = null;
      let bestD = Infinity;
      for (const c of cands) {
        const d = levenshtein(w, c.toLowerCase());
        const tol = c.length > 6 ? 2 : 1;
        if (d > 0 && d <= tol && d < bestD) { bestD = d; best = c; }
      }
      return best || tok;
    }).join('');
  }
}

const strip = (s) => String(s).replace(/[^\w'’-]/g, '');

/* ================================================================== *
 * 4 · Command mode — instructions about what you already said
 * ================================================================== */

/**
 * People say these instructions a dozen different ways, so the phrasings are
 * generated rather than hand-written six times — one list to extend, no way
 * for "write it as an email" to work while "make it an email" silently fails.
 */
const VERB =
  '(?:make (?:it|this|that) |turn (?:it|this|that) into |turn this into |convert (?:it|this|that) to |' +
  'format (?:it|this|that) as |rewrite (?:it|this|that) as |write (?:it|this|that) as |' +
  'put (?:it|this|that) (?:as|in) |change (?:it|this|that) to |output (?:it|this|that) as |' +
  'give me |show me |pull out |extract |just |now |as |into )?';
const ART = '(?:a |an |the )?';
const TAIL = '(?: please| now| for me| version)?';

const lensCommand = (re, lens, label) => ({
  re: new RegExp('^' + VERB + ART + '(?:' + re + ')' + TAIL + '$', 'i'),
  lens,
  label,
});

const L = {
  tldr: lensCommand('shorter|concise|terse|tl ?;? ?dr|summary|summarise|summarize', 'tldr', 'tldr'),
  bullets: lensCommand('bullet(?:ed)? list|bullets?|list', 'bullets', 'bullets'),
  table: lensCommand('table', 'table', 'table'),
  json: lensCommand('json', 'json', 'json'),
  code: lensCommand('code(?: only)?', 'code', 'code'),
  email: lensCommand('e-?mail', 'email', 'email'),
};

/**
 * Returns { kind, ... } for a spoken phrase, or null. Ordered so the input
 * commands (send / scratch / stop) win over the softer output commands.
 */
function matchCommand(text) {
  const t = String(text || '').trim().replace(/[.!?]+$/, '');
  if (!t || t.split(' ').length > 6) return null;

  const hit = (re) => re.test(t);

  if (hit(/^(?:stop listening|stop dictating|stop)$/i)) return { kind: 'stop' };
  if (hit(/^(?:send it|send that|submit|press enter|go|send)$/i)) return { kind: 'send' };
  if (hit(/^(?:scratch that|delete that|clear that|clear it|clear|never mind)$/i)) return { kind: 'undo' };
  if (hit(/^(?:new paragraph|new line|new point)$/i)) return { kind: 'newline' };
  if (hit(/^(?:read (?:that|it) back|read back|speak)$/i)) return { kind: 'speak' };
  if (hit(/^(?:enhance that|enhance this|improve that|prompt it)$/i)) return { kind: 'enhance' };
  if (hit(/^(?:draft the follow ?up|continue this)$/i)) return { kind: 'followup' };
  if (hit(/^(?:capture|save|distil|distill|grab|store) (?:this |that |the )?(?:pack|context pack|context|session)$/i)) return { kind: 'capture' };

  let m = t.match(/^(?:send to |continue in |try )(chat ?gpt|claude|gemini|perplexity|copilot)$/i);
  if (m) return { kind: 'sendTo', dest: m[1].toLowerCase().replace(/\s/g, '') };

  m = t.match(/^translate (?:it |this |that )?to ([a-z ]+)$/i);
  if (m) return { kind: 'refine', instruction: `Translate the text to ${m[1].trim()}`, arg: m[1].trim() };

  for (const c of Object.values(L)) {
    if (c.re.test(t)) return { kind: 'lens', mode: c.lens, label: c.label };
  }
  m = t.match(/^(?:make it |rewrite (?:it|this) |)?(more formal|formal|professional)(?: please)?$/i);
  if (m) return { kind: 'refine', instruction: 'Rewrite the text to be more formal and professional', arg: 'formal' };
  m = t.match(/^(?:make it |)?(casual|friendly|informal|less formal)(?: please)?$/i);
  if (m) return { kind: 'refine', instruction: 'Rewrite the text to be more casual and friendly', arg: 'casual' };

  return null;
}

/* ================================================================== *
 * Local Whisper tier
 * ================================================================== */

let recorder = null;
let audioChunks = [];

const whisperSupported = () => !!(navigator.mediaDevices?.getUserMedia && window.MediaRecorder);

function startWhisper({ url, key, lang }, onText, onError) {
  const stream = navigator.mediaDevices.getUserMedia({ audio: true });
  const mime = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'].find((m) => MediaRecorder.isTypeSupported?.(m)) || '';
  recorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
  audioChunks = [];
  recorder.ondataavailable = (e) => e.data.size && audioChunks.push(e.data);
  recorder.onstop = async () => {
    stream.getTracks().forEach((t) => t.stop());
    try {
      const blob = new Blob(audioChunks, { type: recorder.mimeType || 'audio/webm' });
      const fd = new FormData();
      fd.append('file', blob, 'clip.webm');
      fd.append('model', 'whisper-1');
      fd.append('language', (lang || 'en').split('-')[0]);
      const r = await fetch(url, { method: 'POST', headers: key ? { Authorization: `Bearer ${key}` } : undefined, body: fd });
      if (!r.ok) throw new Error(`Whisper endpoint returned ${r.status}`);
      const j = await r.json();
      onText(j.text || '');
    } catch (e) {
      onError?.(e.message || 'Local Whisper request failed');
    }
  };
  recorder.start();
}

const stopWhisper = () => recorder && recorder.state === 'recording' && recorder.stop();

/* ================================================================== *
 * The engine
 * ================================================================== */

/**
 * @param {object} io    composer patch from adapters.patchComposer()
 * @param {object} hooks { lang, tier, whisper, stripFillers, smartCorrections,
 *                         dictionary, baseText, onState, onCommand, onError, onInterim, onText }
 */
function createDictation(io, hooks = {}) {
  let rec = null;
  let listening = false;
  let flow = false;
  let buffer = null;
  let silenceTimer = null;
  let bail = false;
  let lastWrite = 0;

  const emit = () => hooks.onState?.({ listening, flow, tier: hooks.tier || 'webspeech' });

  const write = (force = false) => {
    const t = buffer.dict ? buffer.dict.snap(buffer.text) : buffer.text;
    const now = Date.now();
    if (!force && now - lastWrite < 350) return;
    lastWrite = now;
    io?.set(t);
    hooks.onText?.(t);
  };

  if (SR) {
    rec = new SR();
    rec.continuous = true;
    rec.interimResults = true;
    rec.lang = hooks.lang || 'en-IN';

    rec.onstart = () => { listening = true; emit(); };
    // The recogniser ends on its own after a pause. In Flow mode that must not
    // end the session — "send it" may be ten seconds away.
    rec.onend = () => { listening = false; emit(); if (!bail) restart(); };
    rec.onerror = (e) => {
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
        bail = true;
        hooks.onError?.('Microphone blocked. Allow it from the address-bar icon, then retry.');
      } else if (!['aborted', 'no-speech'].includes(e.error)) hooks.onError?.('Speech recognition: ' + e.error);
    };

    rec.onresult = (ev) => {
      let interim = '';
      for (let i = ev.resultIndex; i < ev.results.length; i++) {
        const res = ev.results[i];
        const phrase = res[0].transcript;
        if (!res.isFinal) { interim += phrase; continue; }

        const trimmed = phrase.trim();

        /* a command fires on the *whole* phrase, before it becomes text */
        const cmd = matchCommand(trimmed);
        if (cmd) { hooks.onCommand?.(cmd); continue; }

        if (hooks.smartCorrections !== false) {
          const changed = buffer.push(trimmed);
          if (changed) write(true);
        } else {
          buffer.s = normalise(buffer.s + ' ' + clean(trimmed, hooks));
          write(true);
        }
      }
      if (interim) hooks.onInterim?.(interim);

      /* silence commits the spoken text: a late correction can no longer reach it */
      clearTimeout(silenceTimer);
      silenceTimer = setTimeout(() => {
        buffer.commit();
        if (!hooks.interimEcho) io?.set(buffer.text);
      }, 2200);
    };
  }

  function restart() {
    try { rec.start(); } catch { /* already running */ }
  }

  function begin({ flow: asFlow = false } = {}) {
    flow = asFlow;
    buffer = new CorrectionBuffer(hooks.baseText != null ? hooks.baseText : io?.get() || '');
    buffer.dict = hooks.dictionary || null;
    buffer.commit();
    bail = false;
  }

  return {
    supported: (hooks.tier || 'webspeech') === 'webspeech' ? webSpeechSupported : whisperSupported(),
    get listening() { return listening; },
    get flow() { return flow; },
    get text() { return buffer?.text || ''; },
    get speaking() { return typeof speechSynthesis !== 'undefined' && speechSynthesis.speaking; },

    /**
     * Start listening. `{flow:true}` is hands-free: the session stays locked
     * open until "stop listening", which is what makes "send it" possible.
     * Flow is a MODE, not a tier — it works on the free browser recogniser too.
     */
    async start({ flow: asFlow = false } = {}) {
      begin({ flow: asFlow });
      if (hooks.tier === 'whisper-local') {
        try {
          startWhisper(
            hooks.whisper || {},
            (text) => { if (buffer) buffer.s = normalise(buffer.text + ' ' + text); write(true); },
            hooks.onError
          );
          listening = true;
          emit();
          return;
        } catch (e) {
          hooks.onError?.('Could not open the microphone: ' + (e.message || e.name));
          return;
        }
      }
      if (!SR) return hooks.onError?.('Speech recognition is unavailable in this browser.');
      restart();
    },

    stop({ keepText = true } = {}) {
      listening = false;
      bail = true; // stop the onend handler from restarting the recogniser
      clearTimeout(silenceTimer);
      try { rec?.stop(); } catch {}
      if (hooks.tier === 'whisper-local') stopWhisper();
      if (keepText) { buffer?.commit(); io?.set(buffer?.text || ''); }
      flow = false;
      emit();
    },

    /** Double-tap the hotkey: press-to-talk -> hands-free, and back. */
    async toggle({ flow: asFlow = false } = {}) {
      if (this.listening) {
        if (!this.flow && asFlow) { this.setFlow(true); return; }
        return this.stop();
      }
      return this.start({ flow: asFlow });
    },

    /** Command Mode: act on what you already said. */
    transform(fn) {
      const before = io?.get() || '';
      const after = fn(before);
      if (after != null && after !== before) { if (buffer) buffer.s = after; io?.set(after); hooks.onText?.(after); }
      return after;
    },

    setFlow(on) { flow = !!on; emit(); return flow; },

    /**
     * Vocabulary learning. The caller diffs what dictation produced against
     * what the user actually left in the box, and hands both strings here.
     */
    learn(before, after) {
      if (hooks.learnDictionary === false) return [];
      const learned = hooks.dictionary?.learnFromEdit(before, after) || [];
      if (learned.length) hooks.onLearn?.(learned);
      return learned;
    },
    get dictionary() { return hooks.dictionary || null; },

    speak(text, rate = 1) {
      if (!('speechSynthesis' in window)) return false;
      speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(text);
      u.rate = rate;
      speechSynthesis.speak(u);
      return true;
    },
  };
}

/** Map a matched command onto a shell action. */
function runCommand(cmd, shell) {
  const c = typeof cmd === 'string' ? { kind: cmd } : cmd;
  const a = shell.actions || {};
  switch (c.kind) {
    case 'stop': return a.stop?.();
    case 'send': return a.send?.();
    case 'undo': return a.undo?.();
    case 'newline': return a.newline?.();
    case 'speak': return a.speak?.();
    case 'enhance': return a.enhance?.();
    case 'followup': return a.followup?.();
    case 'capture': return a.capture?.();
    case 'sendTo': return a.sendTo?.(c.dest);
    // Lens and refine act on the composed text, so the shell needs to know
    // which one was asked for — the command carries the argument.
    case 'lens': return a.lens?.(c.mode);
    case 'refine': return a.refine?.(c.instruction);
    default: return false;
  }
}

PB.dictate = { webSpeechSupported, tiers, CORRECTION_MARKERS, looksLikeCorrection, CorrectionBuffer, clean, polish, levenshtein, looksLikeTerm, Dictionary, matchCommand, whisperSupported, createDictation, runCommand };

})(globalThis.PB = globalThis.PB || {});
