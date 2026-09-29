/* PromptBridge — loaded as a plain script, no bundler. */
(function (PB) {
'use strict';
const { storage, isExtension } = PB.env;

/**
 * PromptBridge — shared core.
 *
 * Pure logic + storage. No network. No vendor DOM. Every module here is
 * importable in a plain browser tab, which is how the UI gets reviewed
 * without loading the unpacked extension.
 */

const PACKS_KEY = 'pb.packs';
const RUNS_KEY = 'pb.runs';
const SETTINGS_KEY = 'pb.settings';
const DNA_KEY = 'pb.dna';
const DICT_KEY = 'pb.dictionary';
const SCHEMA = 1;
const MAX_PACKS = 120;
const MAX_RUNS = 25;

const DESTINATIONS = [
  { id: 'chatgpt', label: 'ChatGPT', url: 'https://chatgpt.com/', accent: '#10a37f' },
  { id: 'claude', label: 'Claude', url: 'https://claude.ai/new', accent: '#d97757' },
  { id: 'gemini', label: 'Gemini', url: 'https://gemini.google.com/app', accent: '#4285f4' },
  { id: 'perplexity', label: 'Perplexity', url: 'https://www.perplexity.ai/', accent: '#20808d' },
  { id: 'copilot', label: 'Copilot', url: 'https://copilot.microsoft.com/', accent: '#0f6cbd' },
];

const DEFAULT_SETTINGS = {
  fidelity: 'distilled', // full | distilled | atomic
  autoSubmit: false, // never press send for text the user did not write
  redaction: true,
  playbook: 'auto',
  dictateLang: 'en-IN',
  dictateTier: 'webspeech', // webspeech | whisper-local
  whisperUrl: 'http://localhost:8000/v1/audio/transcriptions',
  whisperKey: '',
  readAloudRate: 1,
  stripFillers: true,
  smartCorrections: true, // "budget 50K, actually 75K" rewrites in place
  learnDictionary: true, // learn the words you retype after dictation
  flowMode: true, // double-tap the hotkey for hands-free dictation
  readingMode: false,
  lensInPlace: true,
  collectAnswers: true,
  sites: {}, // { chatgpt: { enabled: false } }
};

/* ================================================================== *
 * Schema + migration
 * ================================================================== */

/** Bring any stored pack up to the current schema. Never throws. */
function migrate(pack) {
  if (!pack || typeof pack !== 'object') return null;
  let p = { ...pack };
  const from = Number(p.v) || 0;

  if (from < 1) {
    p.turns = Array.isArray(p.turns) ? p.turns : [];
    p.artifacts = Array.isArray(p.artifacts) ? p.artifacts : [];
    p.decisions = Array.isArray(p.decisions) ? p.decisions : [];
    p.constraints = Array.isArray(p.constraints) ? p.constraints : [];
    p.openThreads = Array.isArray(p.openThreads) ? p.openThreads : [];
    p.entities = Array.isArray(p.entities) ? p.entities : [];
    p.meta = p.meta || {};
    p.meta.redacted = Array.isArray(p.meta.redacted) ? p.meta.redacted : [];
    p.intent = p.intent || { goal: p.title || 'Continue the previous task', taskType: 'other' };
    p.status = p.status || 'active';
  }

  p.v = SCHEMA;
  p.created = p.created || Date.now();
  p.id = p.id || uid();
  if (from < SCHEMA) p.migratedFrom = from;
  return p;
}

/* ================================================================== *
 * Distillation helpers — deterministic, offline, no model.
 * ================================================================== */

/* ================================================================== *
 * Optional tier-2 providers. Pure data, shared by the panel and the pages.
 * Nothing here is contacted unless the user supplies their own key.
 * ================================================================== */

const LLM_PROVIDERS = [
  { id: 'anthropic', label: 'Anthropic', placeholder: 'sk-ant-…', url: 'https://api.anthropic.com/v1/messages', model: 'claude-sonnet-4-20250514' },
  { id: 'openai', label: 'OpenAI', placeholder: 'sk-…', url: 'https://api.openai.com/v1/chat/completions', model: 'gpt-4o-mini' },
  { id: 'google', label: 'Google', placeholder: 'AIza…', url: 'https://generativelanguage.googleapis.com/v1beta/models', model: 'gemini-2.0-flash' },
];

const PLAYBOOKS = {  debug: { label: 'Debug', format: 'explanation + code diff' },
  refactor: { label: 'Refactor', format: 'before/after code + rationale' },
  research: { label: 'Research', format: 'summary + sources' },
  write: { label: 'Write', format: 'prose, no preamble' },
  analyze: { label: 'Analyze', format: 'bullet points + a one-line takeaway' },
  plan: { label: 'Plan', format: 'numbered steps with concrete deliverables' },
  extract: { label: 'Extract', format: 'valid JSON only, no prose' },
  other: { label: 'General', format: 'a direct answer, code in fenced blocks' },
};

function classifyTask(text = '') {
  const t = text.toLowerCase();
  const has = (...w) => w.some((x) => t.includes(x));
  if (has('fix', 'bug', 'error', 'crash', 'broken', 'why does', 'stack trace', 'traceback', 'debug', 'failing', 'not working')) return 'debug';
  if (has('refactor', 'rename', 'migrate', 'clean up', 'simplify', 'restructure')) return 'refactor';
  if (has('research', 'find out', 'cite', 'sources', 'best practice', 'what are the', 'market', 'literature', 'state of')) return 'research';
  if (has('write', 'draft', 'email', 'blog', 'essay', 'copy', 'post', 'caption')) return 'write';
  if (has('analyz', 'analyse', 'insight', 'break down', 'what does this data')) return 'analyze';
  if (has('plan', 'roadmap', 'steps', 'strategy', 'how should i', 'approach to')) return 'plan';
  if (has('extract', 'json', 'parse this', 'convert to', 'list all', 'pull out')) return 'extract';
  return 'other';
}

/** Sentence splitter that survives code fences. */
function splitSentences(text = '') {
  return String(text)
    .replace(/```[\s\S]*?```/g, (m) => m.replace(/[.!?]+/g, ''))
    .split(/(?<=[.!?])\s+(?=[A-Z0-9"'(\[•\-*])/)
    .map((s) => s.trim())
    .filter(Boolean);
}

const STOP = new Set(
  'the a an and or of to in is are was were it this that for on with as by be at from we you they i not no but if then than so such can will would should could have has do does my our your their'.split(' ')
);

/** Extractive summary — position + keyword-density scoring, ~12 lines. */
function extractiveSummary(text = '', maxSentences = 5) {
  const sents = splitSentences(text);
  if (sents.length <= maxSentences) return String(text).trim();

  const freq = new Map();
  for (const w of String(text).toLowerCase().match(/[a-z0-9_]{3,}/g) || []) {
    if (!STOP.has(w)) freq.set(w, (freq.get(w) || 0) + 1);
  }

  const scored = sents.map((s, i) => {
    const words = (s.toLowerCase().match(/[a-z0-9_]{3,}/g) || []).filter((w) => !STOP.has(w));
    const base = words.reduce((a, w) => a + (freq.get(w) || 0), 0) / Math.sqrt(words.length || 1);
    const position = i === 0 ? 1.9 : i < 3 ? 1.35 : i > sents.length - 3 ? 1.15 : 1;
    return { s, i, score: base * position };
  });

  return scored
    .sort((a, b) => b.score - a.score)
    .slice(0, maxSentences)
    .sort((a, b) => a.i - b.i)
    .map((x) => x.s)
    .join(' ')
    .trim();
}

function extractArtifacts(text = '') {
  const out = [];
  const fence = /```([\w+-]*)\n([\s\S]*?)```/g;
  let m;
  while ((m = fence.exec(text))) if (m[2].trim()) out.push({ kind: 'code', lang: m[1] || 'text', body: m[2].trim() });
  const table = text.match(/(?:^\|.*\|$\n?){2,}/m);
  if (table) out.push({ kind: 'table', body: table[0].trim() });
  const list = text.match(/(?:^[-*]\s+.+\n?){3,}/m);
  if (list) out.push({ kind: 'list', body: list[0].trim() });
  return out;
}

function extractEntities(text = '') {
  const set = new Set();
  for (const m of text.matchAll(/https?:\/\/[^\s)\]"']+/g)) set.add(m[0]);
  for (const m of text.matchAll(/\b[\w.-]+\/[\w./-]+\.\w{1,5}\b/g)) set.add(m[0]);
  for (const m of text.matchAll(/\b([A-Z][a-z]+(?:[A-Z][a-z]+)+)\b/g)) set.add(m[1]);
  for (const m of text.matchAll(/\b([A-Z_]{3,})\b/g)) set.add(m[1]);
  for (const m of text.matchAll(/`([^`\n]{2,40})`/g)) set.add(m[1]);
  return [...set].slice(0, 40);
}

/* ================================================================== *
 * Redaction
 * ================================================================== */

const BUILTIN_REDACTIONS = [
  { name: 'email', re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, label: '[email]' },
  { name: 'phone', re: /(?<!\d)(?:\+?\d{1,2}[\s.-]?)?(?:\(?\d{3}\)?[\s.-]?)\d{3}[\s.-]?\d{4}(?!\d)/g, label: '[phone]' },
  { name: 'card', re: /\b(?:\d[ -]?){13,19}\b/g, label: '[card]' },
  { name: 'aws-key', re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, label: '[key]' },
  { name: 'secret', re: /\b(?:sk|pk|ghp|gho|xox[baprs])[-_][A-Za-z0-9]{16,}\b/g, label: '[secret]' },
  { name: 'long-id', re: /\b\d{9,}\b/g, label: '[id]' },
];

function redact(text = '', extra = []) {
  let out = String(text);
  const hits = [];
  for (const rule of [...BUILTIN_REDACTIONS, ...extra]) {
    if (!rule.re) continue;
    const before = out;
    out = out.replace(new RegExp(rule.re.source, rule.re.flags), rule.label || '[redacted]');
    if (out !== before) hits.push(rule.name);
  }
  return { text: out, hits: [...new Set(hits)] };
}

function redactPack(pack, extra = []) {
  const hits = new Set();
  const walk = (v) => {
    if (typeof v === 'string') {
      const r = redact(v, extra);
      r.hits.forEach((h) => hits.add(h));
      return r.text;
    }
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, val]) => [k, walk(val)]));
    return v;
  };
  const out = walk({ ...pack, meta: { ...pack.meta, redacted: [] } });
  out.meta.redacted = [...hits];
  return out;
}

/* ================================================================== *
 * The dialects — "arrives re-shaped"
 * ================================================================== */

const md = (label, body) => `**${label}**\n\n${body}`;
const tag = (label, body) => `<${label}>\n${body}\n</${label}>`;
const bullets = (a) => a.map((s) => `- ${s}`).join('\n');
const fmt = (a) => (a.kind === 'code' ? '```' + (a.lang || '') + '\n' + a.body + '\n```' : a.body);

const DIALECTS = {
  chatgpt: {
    sec: md,
    l: { summary: 'CONTEXT', decisions: 'DECISIONS ALREADY MADE', constraints: 'CONSTRAINTS (must hold)', entities: 'KEY NAMES / FILES', artifact: 'ARTIFACTS SO FAR', transcript: 'FULL TRANSCRIPT', lastExchange: 'MY LAST MESSAGE' },
    task: (p) => `I was working on this task in another tool and want to continue here.\n\n**TASK:** ${p.intent.goal}`,
    followUp: 'Continue from exactly where this left off. Do not restart or re-explain settled decisions. If something here is ambiguous, ask ONE precise question instead of guessing.',
  },
  claude: {
    sec: tag,
    l: { summary: 'context', decisions: 'decisions', constraints: 'constraints', entities: 'key_entities', artifact: 'artifacts', transcript: 'transcript', lastExchange: 'last_user_message' },
    task: (p) => `I am continuing a task in progress. Original goal: ${p.intent.goal}`,
    followUp: 'Continue the work from the exact point of interruption. Prefer finishing the open thread over summarising what already happened. Ask a single clarifying question only if the context above is genuinely insufficient.',
  },
  gemini: {
    sec: md,
    l: { summary: 'Background', decisions: 'What has already been decided', constraints: 'Requirements that must hold', entities: 'Important names to use verbatim', artifact: 'Work produced so far', transcript: 'Full conversation', lastExchange: 'My most recent message' },
    task: (p) => `I need you to pick up a task I started in another AI tool.\n\n**Goal:** ${p.intent.goal}\n**Current status:** ${p.status}`,
    followUp: '**Now:** continue from the interruption point. Do not repeat the context back to me and do not ask what the task is. Format your reply as: (1) what you do next, (2) the output itself.',
  },
  perplexity: {
    sec: md,
    l: { summary: 'Background', decisions: 'Established so far', constraints: 'Scope limits', entities: 'Entities', artifact: 'Prior material', transcript: 'Prior conversation', lastExchange: 'Last question' },
    task: (p) => `Continuing a research thread carried over from another tool. The underlying question: ${p.intent.goal}`,
    followUp: 'Use current, well-sourced information to close the remaining gap. Cite every non-obvious claim, prefer recent sources, and explicitly say which parts of the prior material are outdated.',
  },
  copilot: {
    sec: md,
    l: { summary: 'Context', decisions: 'Done', constraints: 'Rules', entities: 'Names', artifact: 'Work so far', transcript: 'Transcript', lastExchange: 'Last message' },
    task: (p) => `Picking up a task in progress. Goal: ${p.intent.goal}`,
    followUp: 'Resume from the interruption point. Be brief and concrete — no preamble.',
  },
  generic: {
    sec: md,
    l: { summary: 'CONTEXT', decisions: 'DECISIONS', constraints: 'CONSTRAINTS', entities: 'KEY NAMES', artifact: 'ARTIFACTS', transcript: 'TRANSCRIPT', lastExchange: 'LAST MESSAGE' },
    task: (p) => `Continuing a task started elsewhere.\n\nGoal: ${p.intent.goal}`,
    followUp: 'Continue from where this stopped. Do not restart.',
  },
};

function renderForDestination(pack, destId, fidelity = 'distilled') {
  const d = DIALECTS[destId] || DIALECTS.generic;
  const out = [d.task(pack)];

  if (fidelity === 'atomic') {
    if (pack.artifacts?.length) out.push(d.sec(d.l.artifact, pack.artifacts.slice(0, 4).map(fmt).join('\n\n')));
    out.push(d.followUp);
    return out.join('\n\n');
  }

  if (fidelity === 'distilled' && pack.summary) out.push(d.sec(d.l.summary, pack.summary));
  if (pack.decisions?.length) out.push(d.sec(d.l.decisions, bullets(pack.decisions)));
  if (pack.constraints?.length) out.push(d.sec(d.l.constraints, bullets(pack.constraints)));
  if (pack.entities?.length) out.push(d.sec(d.l.entities, pack.entities.slice(0, 15).join(', ')));
  if (pack.artifacts?.length) out.push(d.sec(d.l.artifact, pack.artifacts.slice(0, 3).map(fmt).join('\n\n')));

  if (fidelity === 'full' && pack.turns?.length) {
    out.push(d.sec(d.l.transcript, pack.turns.map((t) => `${t.role === 'user' ? 'User' : 'Assistant'}: ${t.text}`).join('\n\n')));
  } else if (fidelity === 'distilled' && pack.meta?.lastUser) {
    out.push(d.sec(d.l.lastExchange, `User: ${pack.meta.lastUser}`));
  }

  out.push(d.followUp);
  return out.join('\n\n');
}

/* ================================================================== *
 * Style DNA — learned locally, never leaves the device
 * ================================================================== */

const DNA_DEFAULT = { prompts: 0, withFormat: 0, terse: 0, examples: 0, avgLen: 0 };

async function getDNA() {
  const { [DNA_KEY]: d } = await storage.get(DNA_KEY);
  return { ...DNA_DEFAULT, ...(d || {}) };
}

/** Called when the user actually sends a prompt: learn preferences, not content. */
async function recordPrompt(text) {
  const dna = await getDNA();
  const len = text.length;
  dna.prompts += 1;
  dna.avgLen = Math.round((dna.avgLen * (dna.prompts - 1) + len) / dna.prompts);
  if (/\b(format|as json|bullet|table|markdown|in \d+ words|output)\b/i.test(text)) dna.withFormat += 1;
  if (len < 180) dna.terse += 1;
  if (/\b(e\.g\.|for example|example:|such as)\b/i.test(text)) dna.examples += 1;
  await storage.set({ [DNA_KEY]: dna });
  return dna;
}

/* ================================================================== * *
 * Personal dictionary — learned locally, never leaves the device
 * ================================================================== * */

/** { term: timesRetyped } — the shape Dictionary.list() expects. */
async function getDictionary() {
  const { [DICT_KEY]: d } = await storage.get(DICT_KEY);
  return d && typeof d === 'object' ? d : {};
}

async function saveDictionary(entries) {
  await storage.set({ [DICT_KEY]: entries && typeof entries === 'object' ? entries : {} });
  return entries;
}

function dnaAdvice(dna) {  const n = dna.prompts || 0;
  if (n < 5) return null;
  return {
    specifiesFormat: dna.withFormat / n > 0.5,
    terse: dna.terse / n > 0.6,
    usesExamples: dna.examples / n > 0.3,
    avgLen: dna.avgLen,
  };
}

/* ================================================================== *
 * Storage
 * ================================================================== */

async function getSettings() {
  const { [SETTINGS_KEY]: s } = await storage.get(SETTINGS_KEY);
  return { ...DEFAULT_SETTINGS, ...(s || {}) };
}

/**
 * Settings that are booleans, derived from the defaults so a new toggle cannot
 * be added without being covered.
 */
const BOOL_KEYS = new Set(
  Object.entries(DEFAULT_SETTINGS)
    .filter(([, v]) => typeof v === 'boolean')
    .map(([k]) => k)
);

async function setSettings(patch) {
  const next = { ...(await getSettings()), ...patch };
  // HTML gives `data-val` back as a string, and the string "false" is truthy —
  // so a toggle switched off that way would read as on forever. Coerce here
  // rather than at each call site, so the invariant holds for every caller.
  for (const k of BOOL_KEYS) {
    if (typeof next[k] === 'string') next[k] = next[k] !== 'false';
  }
  await storage.set({ [SETTINGS_KEY]: next });
  return next;
}

async function getPacks() {
  const { [PACKS_KEY]: p } = await storage.get(PACKS_KEY);
  return (p || []).map(migrate).filter(Boolean);
}

async function savePack(pack) {
  const p = migrate(pack);
  const packs = await getPacks();
  const i = packs.findIndex((x) => x.id === p.id);
  if (i >= 0) packs[i] = p;
  else packs.unshift(p);
  await storage.set({ [PACKS_KEY]: packs.slice(0, MAX_PACKS) });
  return p;
}

async function deletePack(id) {
  await storage.set({ [PACKS_KEY]: (await getPacks()).filter((p) => p.id !== id) });
}

async function getRuns() {
  const { [RUNS_KEY]: r } = await storage.get(RUNS_KEY);
  return r || [];
}

async function saveRun(run) {
  const runs = await getRuns();
  const i = runs.findIndex((x) => x.id === run.id);
  if (i >= 0) runs[i] = run;
  else runs.unshift(run);
  await storage.set({ [RUNS_KEY]: runs.slice(0, MAX_RUNS) });
  return run;
}

/* ================================================================== *
 * Utilities
 * ================================================================== */

const uid = () => (globalThis.crypto?.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));
const estimateTokens = (t = '') => Math.ceil(String(t).length / 3.7);
const clamp = (n, a, b) => Math.max(a, Math.min(b, n));

function escapeHtml(s = '') {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

function relativeTime(ts) {
  const s = Math.max(0, (Date.now() - ts) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 604800) return `${Math.floor(s / 86400)}d ago`;
  return new Date(ts).toLocaleDateString();
}

PB.SHARED = { isExtension, PACKS_KEY, RUNS_KEY, SETTINGS_KEY, DNA_KEY, DICT_KEY, SCHEMA, DESTINATIONS, DEFAULT_SETTINGS, migrate, LLM_PROVIDERS, PLAYBOOKS, classifyTask, splitSentences, extractiveSummary, extractArtifacts, extractEntities, BUILTIN_REDACTIONS, redact, redactPack, DIALECTS, renderForDestination, getDNA, recordPrompt, dnaAdvice, getDictionary, saveDictionary, getSettings, setSettings, getPacks, savePack, deletePack, getRuns, saveRun, uid, estimateTokens, clamp, escapeHtml, relativeTime };

})(globalThis.PB = globalThis.PB || {});
