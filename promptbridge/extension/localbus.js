/* PromptBridge — loaded as a plain script, no bundler. */
(function (PB) {
'use strict';
const { getPacks, getRuns, getSettings, saveRun, estimateTokens, DESTINATIONS } = PB.SHARED;

/**
 * Preview message handler.
 *
 * When the code runs in a plain browser tab (no `chrome.*`), env.js routes
 * runtime messages here so the UI still exercises real behaviour — storing
 * packs, simulating a fan-out run, writing to the in-memory store — instead
 * of dead-ending on "this only works when installed".
 */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const SAMPLE = {
  claude: "I'd go one step further than the jitter fix: cap concurrent in-flight uploads per worker, otherwise the pool cap just moves the queue pressure downstream.\n\n```ts\nconst limiter = new Bottleneck({ maxConcurrent: 16, minTime: 25 });\n```\n\nThe regression test should assert on attempts, not just absence of ECONNRESET — a test that only checks 'no error' passes trivially today.",
  gemini: 'The 3% drop is consistent with a retry storm. Two things not in your notes: (1) whether keepAlive is disabled on the upstream agent, and (2) whether the BullMQ stalled-check interval (default 30s) is shorter than your longest job.\n\nI would instrument before changing anything — a per-attempt histogram settles it in minutes.',
  perplexity: 'Socket timeouts racing retry backoff is a well-documented failure class. Current guidance favours jittered exponential backoff with a circuit breaker over fixed retries. Note that 2023-era advice to raise socket timeouts alone is now considered insufficient — it masks the race rather than resolving it.',
  chatgpt: 'Your diagnosis is right. The next thing to verify is whether the retry is actually being scheduled on the same event loop that owns the socket — if it is, the backoff delay is the fix; if it is not, you need a worker boundary.\n\nI would add a metric for attempts-per-upload before shipping the fix, so a regression is visible in week one rather than quarter two.',
  copilot: 'Looks like a race between the socket timeout and the retry backoff. Consider also bumping the connection pool cap and adding a stalled-job listener if the queue supports it.',
};

async function handleLocal(msg) {
  if (!msg?.type) return;

  switch (msg.type) {
    case 'pb:get-state': {
      const [packs, runs, settings] = await Promise.all([getPacks(), getRuns(), getSettings()]);
      return { ok: true, packs, runs, settings };
    }

    case 'pb:save-pack':
      return { ok: true };

    case 'pb:open-page':
      return { ok: true, note: 'Extension pages are unavailable in preview mode' };

    case 'pb:open-popup':
      return { ok: true };

    case 'pb:clear-all': {
      await PB.env.storage.remove(['pb.packs', 'pb.runs', 'pb.dna']);
      return { ok: true };
    }

    /* Simulate a fan-out so the compare board can be reviewed without
       five real tabs and five real subscriptions. */
    case 'pb:send-pack': {
      const dests = msg.dest ? [msg.dest] : DESTINATIONS.map((d) => d.id);
      let run = (await getRuns()).find((r) => r.id === msg.runId);
      if (!run) run = { id: msg.runId, created: Date.now(), packTitle: msg.packTitle || '', status: 'running', answers: [] };
      for (const d of dests) {
        const a = run.answers.find((x) => x.dest === d);
        if (a) a.state = 'running';
        else run.answers.push({ dest: d, state: 'running', ms: 0, text: '' });
      }
      await saveRun(run);

      for (const d of dests) {
        await sleep(400 + Math.round(estimateTokens(msg.text) % 5) * 260);
        const fresh = await getRuns();
        const r = fresh.find((x) => x.id === msg.runId);
        const a = r?.answers.find((x) => x.dest === d);
        if (a) {
          a.state = 'done';
          a.ms = 5200 + Math.round(Math.random() * 6000);
          a.text = SAMPLE[d] || '(no sample for this model)';
        }
        await saveRun(r);
      }
      return { ok: true, runId: msg.runId, simulated: true };
    }

    case 'pb:run-started':
    case 'pb:run-answer':
      return { ok: true };

    case 'pb:ping-tab':
      return { ok: true, result: { adapter: 'generic', label: 'Preview', healthy: true } };

    default:
      return { ok: false, reason: 'unhandled: ' + msg.type };
  }
}

PB.localbus = { handleLocal };

})(globalThis.PB = globalThis.PB || {});
