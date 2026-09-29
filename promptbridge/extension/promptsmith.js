/* PromptBridge — loaded as a plain script, no bundler. */
(function (PB) {
'use strict';
const { PLAYBOOKS, classifyTask, extractiveSummary, splitSentences, estimateTokens, clamp, dnaAdvice, LLM_PROVIDERS } = PB.SHARED;
const { LENS_MODES, applyLens } = PB.lens;

/**
 * Promptsmith — tier 1 (deterministic, offline, instant) and tier 2 (BYO key).
 *
 * Tier 1 covers the 80% people actually complain about: a prompt with no
 * role, no format, or no success criterion. It scores seven slots, weighted
 * by how much each one changes the answer, and repairs the ones it can prove
 * are missing — without inventing requirements the user never asked for.
 *
 * Style DNA lets it stay out of the way of someone who already writes
 * well-specified prompts. That preference data never leaves the device.
 */

const SLOTS = [
  { key: 'role', label: 'Role', w: 0.8, fix: true, re: /\b(you are|act as|you're a|expert in|specialist in|senior|principal|as a[n]? [a-z]+ (engineer|analyst|editor|writer))\b/i },
  { key: 'goal', label: 'Goal', w: 2, fix: true, re: /\b(goal|objective|i want|i need|i'd like|please|build|create|write|make|generate|explain|fix|refactor|analyz|compare|plan|implement|add)\b/i },
  { key: 'context', label: 'Context', w: 1.6, fix: false, re: /\b(context|background|given|here'?s|i'?m working|the code|the file|below|attached|stack trace|error|log|schema|payload|repo)\b/i },
  { key: 'constraints', label: 'Constraints', w: 1.4, fix: true, re: /\b(must\b|mustn'?t|should\b|shouldn'?t|do not|don'?t|never|only\b|always|required?|requirements?\b|constraints?\b|limitation|no more than|at most|ensure|make sure|without|keep it|bounded|scope)\b/i },
  { key: 'format', label: 'Output format', w: 1.8, fix: true, re: /\b(format|output|respond|reply|return|as a|as json|markdown|table|bullet|list|code block|in \d+ (?:words|lines|paragraphs)|tone|structure)\b/i },
  { key: 'examples', label: 'Examples', w: 0.7, fix: false, re: /\b(e\.g\.|for example|example:|sample|such as|like this|reference)\b/i },
  { key: 'criteria', label: 'Success criteria', w: 1.1, fix: true, re: /\b(success|so that|so i can|until|acceptance|passes|tests?\b|verify|validat|done when)\b/i },
];

const TOTAL_W = SLOTS.reduce((a, s) => a + s.w, 0);

function analyze(text = '') {
  const t = String(text).trim();
  const slots = SLOTS.map((s) => ({ key: s.key, label: s.label, present: s.re.test(t), fixable: s.fix }));
  const got = slots.filter((s) => s.present).reduce((a, s) => a + SLOTS.find((x) => x.key === s.key).w, 0);
  const score = Math.round((got / TOTAL_W) * 100);

  const issues = [];
  if (!slots.find((s) => s.key === 'format').present) issues.push('No output format — the model will guess the shape of the answer.');
  if (!slots.find((s) => s.key === 'constraints').present) issues.push('No constraints — nothing bounds scope, length, or technology.');
  if (!slots.find((s) => s.key === 'criteria').present) issues.push('No success criteria — you will not be able to tell if it worked.');
  if (!slots.find((s) => s.key === 'context').present) issues.push('No context — the model is guessing what you are working with.');
  if (t.length < 25) issues.push('Very short — add the specifics you are currently holding in your head.');
  if (t.length > 4000) issues.push('Very long — the important instruction may be lost in the middle.');

  return { score: clamp(score, 0, 100), slots, issues, tokens: estimateTokens(t), taskType: classifyTask(t), chars: t.length };
}

/* ---------------- repair ---------------- */

const ROLE_BY_TASK = {
  debug: 'You are a senior engineer debugging a production issue.',
  refactor: 'You are a staff engineer focused on clean, behaviour-preserving refactors.',
  research: 'You are a research analyst who cites every non-obvious claim.',
  write: 'You are an experienced editor with a strong sense of rhythm.',
  analyze: 'You are a data analyst who works only from what is in the input.',
  plan: 'You are a pragmatic technical lead who plans for one team.',
  extract: 'You are a precise extraction tool. You never add prose.',
  other: 'You are a senior expert in the subject at hand.',
};

const FORMAT_BY_TASK = {
  debug: '(1) root cause in one sentence, (2) the evidence that proves it, (3) the minimal fix as a diff, (4) how to verify it.',
  refactor: 'before/after code, then a two-line rationale per change.',
  research: 'a 3-bullet summary, then the detail, then a sources list.',
  write: 'the finished prose only — no preamble, no meta-commentary.',
  analyze: 'bullet points, then a one-line takeaway at the end.',
  plan: 'a numbered list of steps, each with a concrete deliverable and an estimate.',
  extract: 'valid JSON only. No prose, no code fences, no explanation.',
  other: 'a direct answer, with any code in fenced blocks.',
};

const CRITERIA_BY_TASK = {
  debug: 'Success = a test that fails before the fix and passes after it.',
  refactor: 'Success = behaviour is unchanged and the existing test suite still passes.',
  research: 'Success = every non-obvious claim has a source.',
  write: 'Success = every sentence earns its place and the voice stays consistent.',
  analyze: 'Success = every bullet is traceable to something in the input.',
  plan: 'Success = step 1 is actionable today with no further decisions.',
  extract: 'Success = the JSON parses and contains no field absent from the input.',
  other: 'Success = I can act on the answer without asking a follow-up question.',
};

const NOISE = 'no preamble, no restating my request, no asking whether you want to continue';

/**
 * @param {string} text
 * @param {{ additions?:string[], taskType?:string, dna?:object }} opts
 * @returns {{ enhanced, before, analysis, added, notes }}
 */
function enhance(text = '', { additions, taskType, dna } = {}) {
  const a = analyze(text);
  const type = taskType && taskType !== 'auto' ? taskType : a.taskType;
  const advice = dnaAdvice(dna || {});
  const notes = [];

  // If the user consistently writes their own format instruction, adding ours
  // is noise. Respect that.
  if (advice?.specifiesFormat && !SLOTS.find((s) => s.key === 'format').present) {
    notes.push('skipped format line — you usually specify one yourself');
  }
  const add = new Set(
    additions ??
      SLOTS.filter((s) => !s.present && s.fix)
        .map((s) => s.key)
        .filter((k) => !(k === 'format' && advice?.specifiesFormat))
  );

  const parts = [];
  if (add.has('role')) parts.push(ROLE_BY_TASK[type] || ROLE_BY_TASK.other);
  parts.push(String(text).trim());

  if (add.has('constraints')) {
    parts.push(
      type === 'extract'
        ? 'Constraints: do not invent, infer, or fill in any value that is not present in the input.'
        : `Constraints: ${NOISE}. If a decision is genuinely mine to make, ask exactly one question, then continue.`
    );
  }
  if (add.has('format')) parts.push(`Format: ${(PLAYBOOKS[type] || PLAYBOOKS.other).format || FORMAT_BY_TASK[type]}`);
  if (add.has('criteria')) parts.push(CRITERIA_BY_TASK[type] || CRITERIA_BY_TASK.other);

  return { enhanced: parts.join('\n\n'), before: text, analysis: { ...a, taskType: type }, added: [...add], notes };
}

/* ================================================================== *
 * Output lens re-export — the implementation lives in lens.js
 * ================================================================== */

/* re-exported */
/* ================================================================== *
 * Tier 2 — BYO key. The request goes from this browser straight to the
 * provider. PromptBridge never sees it, which is why this is opt-in only.
 * ================================================================== */

const TIER2_SYSTEM = `You rewrite rough user prompts into precise, well-structured prompts.
Preserve the user's intent exactly. Add only what is missing: a role, hard constraints, an output format, and a success criterion.
Never invent requirements, technologies, or context the user did not imply. Never answer the prompt yourself.
Reply with the rewritten prompt only — no preamble, no commentary, no code fence.`;

async function llmEnhance(text, { provider, key, taskType }) {
  const p = LLM_PROVIDERS.find((x) => x.id === provider);
  if (!p || !key) throw new Error('No provider key configured. Add one in the PromptBridge popup to enable tier 2.');

  const system = taskType && taskType !== 'auto' ? `${TIER2_SYSTEM}\nThis is a ${taskType} task.` : TIER2_SYSTEM;

  if (p.id === 'anthropic') {
    const r = await fetch(p.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: p.model, max_tokens: 1500, system, messages: [{ role: 'user', content: text }] }),
    });
    const j = await r.json();
    if (!r.ok) throw new Error(j?.error?.message || `Anthropic ${r.status}`);
    return (j.content?.[0]?.text || '').trim();
  }
  if (p.id === 'openai') {
    const r = await fetch(p.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify({ model: p.model, messages: [{ role: 'system', content: system }, { role: 'user', content: text }] }),
    });
    const j = await r.json();
    if (!r.ok) throw new Error(j?.error?.message || `OpenAI ${r.status}`);
    return (j.choices?.[0]?.message?.content || '').trim();
  }
  const r = await fetch(`${p.url}/${p.model}:generateContent?key=${encodeURIComponent(key)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ system_instruction: { parts: [{ text: system }] }, contents: [{ parts: [{ text }] }] }),
  });
  const j = await r.json();
  if (!r.ok) throw new Error(j?.error?.message || `Google ${r.status}`);
  return (j.candidates?.[0]?.content?.parts?.[0]?.text || '').trim();
}

PB.promptsmith = { LLM_PROVIDERS, LENS_MODES, applyLens, analyze, enhance, llmEnhance };

})(globalThis.PB = globalThis.PB || {});
