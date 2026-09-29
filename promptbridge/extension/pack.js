/* PromptBridge — loaded as a plain script, no bundler. */
(function (PB) {
'use strict';
const { extractArtifacts, extractEntities, extractiveSummary, classifyTask, renderForDestination, redactPack, estimateTokens, uid, splitSentences } = PB.SHARED;

/**
 * Context Pack — the spine of the product.
 *
 *   turns  ->  distil  ->  ContextPack  ->  redact  ->  renderForDestination()
 *
 * Distillation is deterministic and offline. That is a deliberate product
 * decision: it is instant, free, private, and diffable — and an LLM tier can
 * be layered on top later without changing the format.
 */

/* ---------------- distillation ---------------- */

const DECISION_RE = /^\s*(?:[-*•]\s*)?(?:\*\*)?(?:decision|we(?:'ll| will) use|i(?:'ll| will) use|decided|going with|approach|chose|the plan is)(?:\*\*)?[:\s]/i;
const NEXT_RE = /\b(next step|next steps|follow[- ]?up|to do|todo|remaining|open question|would you like|shall i|let me know if|if you (?:want|need)|note that i (?:can|could))\b/i;
const CONSTRAINT_RE = /\b(must|must not|mustn't|should(?:n't)?|do not|don't|never|only|always|required?|constraint|ensure|make sure|without)\b/i;

/** Strip the label the model used so the list reads cleanly in the pack. */
const stripLabel = (s) =>
  s
    .replace(/^\s*(?:[-*•]|\d+[.)])\s*/, '')
    .replace(/\*\*/g, '')
    .replace(/^(?:decision|constraints?|requirements?|note|so|and)\s*:\s*/i, '')
    .replace(/^(?:we(?:'ll| will) use|i(?:'ll| will) use|going with|decided to|chose to|use)\s+/i, '')
    .trim();

function distil(turns) {
  const users = turns.filter((t) => t.role === 'user');
  const assistants = turns.filter((t) => t.role === 'assistant');
  const userText = users.map((t) => t.text).join('\n\n');
  const asstText = assistants.map((t) => t.text).join('\n\n');

  /* intent: the opening ask is usually the truest statement of the goal */
  const opening = users[0]?.text || '';
  const goalSentence = splitSentences(opening)[0] || opening.slice(0, 240);
  const goal = (goalSentence.length > 220 ? goalSentence.slice(0, 220).trim() + '…' : goalSentence) || 'Continue the previous task';

  const decisions = [];
  for (const t of assistants) {
    for (const line of t.text.split('\n')) {
      if (DECISION_RE.test(line) || (line.trim().startsWith('-') && /use|with|via|based on|instead of|approach/i.test(line))) {
        const clean = stripLabel(line);
        if (clean.length > 8 && !decisions.includes(clean)) decisions.push(clean);
      }
    }
  }

  const constraints = [];
  for (const t of users) {
    for (const line of t.text.split('\n')) {
      if (CONSTRAINT_RE.test(line)) {
        const clean = stripLabel(line);
        if (clean.length > 8 && clean.length < 300 && !constraints.includes(clean)) constraints.push(clean);
      }
    }
  }

  const last = assistants[assistants.length - 1]?.text || '';
  const openThreads = [];
  const tail = splitSentences(last).slice(-2).join(' ');
  if (NEXT_RE.test(tail)) openThreads.push(tail.slice(0, 300));
  if (/\b(TODO|FIXME|still need to|remaining work|next up)\b/i.test(last)) {
    const m = last.match(/(?:^|\n)\s*(?:[-*•]|\d+[.)])\s*[^\n]*(?:TODO|FIXME|next|remaining)[^\n]*/gi) || [];
    openThreads.push(...m.map((s) => s.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, '').trim()));
  }
  if (/```/.test(last) && !/```\s*$/.test(last.trim())) openThreads.push('The last code block may be truncated.');

  const truncated = /(?:^|\n)(?:Would you like|Let me know if|I can also|Here's|Continue)\b[^.!?]*$/.test(last.trim());

  const status = openThreads.length ? 'active' : /done|complete|finished|that'?s (?:it|all)/i.test(last) ? 'complete' : 'active';

  const artifacts = [...extractArtifacts(last), ...extractArtifacts(assistants[assistants.length - 2]?.text || '')]
    // a bullet list that we already promoted to `decisions` must not be repeated
    .filter((a) => !(a.kind === 'list' && a.body.split('\n').every((l) => decisions.some((d) => d && l.includes(d.slice(0, 25))))))
    .slice(0, 6);

  /* the summary is the whole point — keep it under budget.
     Decisions live in their own section, so they are not repeated here. */
  const summary = extractiveSummary(
    [goal, tail ? `Most recent state: ${tail}` : ''].filter(Boolean).join(' '),
    6
  );

  return {
    intent: { goal, taskType: classifyTask(userText) },
    status: truncated ? 'active' : status,
    summary,
    decisions: decisions.slice(0, 8),
    openThreads: [...new Set(openThreads)].slice(0, 6),
    constraints: constraints.slice(0, 8),
    artifacts,
    entities: extractEntities(userText + '\n' + last),
  };
}

function buildPack(turns, { sourceSite, sourceUrl } = {}) {
  const d = distil(turns);
  const clean = turns.filter((t) => t.text);
  const lastUser = [...clean].reverse().find((t) => t.role === 'user');

  const pack = {
    v: 1,
    id: uid(),
    created: Date.now(),
    title: d.intent.goal.slice(0, 70) || `Pack from ${sourceSite}`,
    ...d,
    // keep the whole thread on the pack; fidelity is a *rendering* choice,
    // so switching to "full" later must not need a re-capture
    turns: clean.slice(-100),
    meta: {
      sourceSite: sourceSite || 'unknown',
      sourceUrl: sourceUrl || '',
      messageCount: clean.length,
      lastUser: lastUser?.text?.slice(0, 600) || '',
      tokenEstimate: 0,
      redacted: [],
    },
  };
  // the number that matters is the size of what we actually SEND
  pack.meta.tokenEstimate = estimateTokens(renderForDestination(pack, 'generic', 'distilled'));
  return pack;
}

/* ---------------- send ---------------- */

function packForDestination(pack, destId, { fidelity, doRedact }) {
  const p = doRedact ? redactPack(pack) : pack;
  return { pack: p, text: renderForDestination(p, destId, fidelity) };
}

function packSummaryLine(pack) {
  return `${pack.title} · ${pack.meta.messageCount} msgs · ~${pack.meta.tokenEstimate}t · ${pack.intent.taskType}`;
}

PB.pack = { distil, buildPack, packForDestination, packSummaryLine };

})(globalThis.PB = globalThis.PB || {});
