/* PromptBridge — loaded as a plain script, no bundler. */
(function (PB) {
'use strict';

/**
 * Environment shim.
 *
 * Every module talks to `api` instead of reaching for `chrome.*` directly, so
 * the same code powers the extension pages *and* a plain browser tab during
 * development. If `chrome` is missing we fall back to an in-memory store
 * seeded with a realistic demo pack, which is how the UI can be reviewed
 * without loading the unpacked extension.
 */

const hasChrome = typeof chrome !== 'undefined' && !!chrome.storage?.local;

const memory = new Map();

const isExtension = hasChrome;

/* ---------------- storage ---------------- */

const localArea = hasChrome
  ? {
      get: (keys) => chrome.storage.local.get(keys),
      set: (o) => chrome.storage.local.set(o),
      remove: (k) => chrome.storage.local.remove(k),
    }
  : {
      async get(keys) {
        if (keys == null) return Object.fromEntries(memory);
        const list = Array.isArray(keys) ? keys : typeof keys === 'string' ? [keys] : Object.keys(keys);
        const out = {};
        for (const k of list) if (memory.has(k)) out[k] = memory.get(k);
        return out;
      },
      async set(o) {
        for (const [k, v] of Object.entries(o)) memory.set(k, v);
      },
      async remove(k) {
        (Array.isArray(k) ? k : [k]).forEach((x) => memory.delete(x));
      },
    };

const storage = {
  get: (k) => localArea.get(k),
  set: (o) => localArea.set(o),
  remove: (k) => localArea.remove(k),

  async onChanged(cb) {
    if (hasChrome && chrome.storage.onChanged) chrome.storage.onChanged.addListener(cb);
  },
};

/* ---------------- messaging ---------------- */

const runtime = {
  send: (msg) =>
    hasChrome
      ? chrome.runtime.sendMessage(msg)
      // in a plain tab, handle it locally so the UI still does something real
      : (PB.localbus ? PB.localbus.handleLocal(msg) : Promise.resolve({ ok: false, reason: 'no local bus' })),

  onMessage(cb) {
    if (hasChrome && chrome.runtime.onMessage) chrome.runtime.onMessage.addListener(cb);
    else window.addEventListener('message', (e) => cb(e.data, null, () => {}));
  },

  getURL: (p) => (hasChrome ? chrome.runtime.getURL(p) : p),
  id: hasChrome ? chrome.runtime.id : 'local-preview',
};

/* ---------------- tabs ---------------- */

const tabs = {
  async active() {
    if (hasChrome) {
      const [t] = await chrome.tabs.query({ active: true, currentWindow: true });
      return t;
    }
    return { id: 1, url: location.href };
  },
  async create(o) {
    if (hasChrome) return chrome.tabs.create(o);
    // preview: no new tabs, just record it
    toast('(preview) would open ' + o.url);
    return { id: 2, url: o.url };
  },
  async send(tabId, msg) {
    if (hasChrome) return chrome.tabs.sendMessage(tabId, msg);
    return PB.localbus ? PB.localbus.handleLocal(msg) : { ok: false };
  },
};

/* ---------------- demo seed (only used outside the extension) ---------------- */

const DEMO_PACK = {
  v: 1,
  id: 'demo-pack',
  created: Date.now() - 1000 * 60 * 42,
  title: 'Our Node ingest service drops about 3% of uploads under load.',
  intent: { goal: 'Our Node ingest service drops about 3% of uploads under load.', taskType: 'debug' },
  status: 'active',
  summary:
    'Our Node ingest service drops about 3% of uploads under load. The 5s socketTimeout races the 5s retry backoff. Most recent state: regression test fakes a mid-flight reset and asserts the backoff schedule is exhausted instead of surfacing ECONNRESET.',
  decisions: [
    'exponential backoff with jitter, 100ms base, 8 attempts',
    'set `socketTimeout` to 20s, add a connection pool cap of 64',
    'keep BullMQ, add a `stalled` event listener',
  ],
  openThreads: ['Let me know if you want me to add the pool-cap metric to the dashboard too.'],
  constraints: ['must stay on the current BullMQ queue library, no new infra, and the fix has to ship this week.'],
  artifacts: [{ kind: 'code', lang: 'js', body: 'const delay = (n) => 100 * 2 ** n + Math.random() * 100;' }],
  entities: ['ECONNRESET', 'BullMQ', 'socketTimeout', 'npm test -- ingest'],
  turns: [],
  meta: {
    sourceSite: 'ChatGPT',
    sourceUrl: 'https://chatgpt.com/',
    messageCount: 4,
    lastUser: 'Make the change and add a regression test that would have caught this.',
    tokenEstimate: 318,
    redacted: [],
  },
};

const DEMO_RUN = {
  id: 'demo-run',
  created: Date.now() - 1000 * 60 * 9,
  packTitle: DEMO_PACK.title,
  status: 'done',
  answers: [
    {
      dest: 'claude',
      state: 'done',
      ms: 7400,
      text: "Root cause confirmed. I'd go one step further than the jitter fix: cap concurrent in-flight uploads per worker, otherwise the pool cap just moves the queue pressure downstream.\n\n```ts\nconst limiter = new Bottleneck({ maxConcurrent: 16, minTime: 25 });\n```\n\nThe regression test should assert on attempts, not just absence of ECONNRESET — a test that only checks 'no error' passes trivially today.",
    },
    {
      dest: 'gemini',
      state: 'done',
      ms: 9100,
      text: 'The 3% drop is consistent with a retry storm. Two things worth checking that are not in your current notes: (1) whether `keepAlive` is disabled on the upstream agent, and (2) whether the BullMQ stalled-check interval (default 30s) is shorter than your longest job.\n\nI would instrument before changing anything — a per-attempt histogram will tell you in minutes which hypothesis is right.',
    },
    {
      dest: 'perplexity',
      state: 'done',
      ms: 11200,
      text: 'Socket timeouts racing retry backoff is a well-documented class of failure. Current guidance (2024+) favours jittered exponential backoff with a circuit breaker over fixed retries. Node 20+ `http.Agent` now exposes `keepAlive` with `keepAliveMsecs` defaults that may interact with your upstream gateway.\n\nNote: the 2023-era advice to raise socket timeouts alone is now considered insufficient — it masks the race rather than resolving it.',
    },
    { dest: 'chatgpt', state: 'pending', ms: 0, text: '' },
  ],
};

async function seedIfNeeded() {
  if (hasChrome) return;
  if (!memory.has('pb.packs')) memory.set('pb.packs', [DEMO_PACK]);
  if (!memory.has('pb.runs')) memory.set('pb.runs', [DEMO_RUN]);
  if (!memory.has('pb.settings')) memory.set('pb.settings', { fidelity: 'distilled', redaction: true, autoSubmit: false, stripFillers: true, playbook: 'auto' });
  if (!memory.has('pb.dna')) memory.set('pb.dna', { prompts: 12, withFormat: 8, terse: 6, examples: 1, avgLen: 320 });
}

let toastEl = null;
function toast(text) {
  if (!toastEl) {
    toastEl = document.createElement('div');
    Object.assign(toastEl.style, {
      position: 'fixed', bottom: '18px', left: '50%', transform: 'translateX(-50%)',
      background: '#1c2230', color: '#e6edf3', border: '1px solid #2f3a4d', borderRadius: '9px',
      padding: '8px 14px', font: '12px system-ui', zIndex: 99999, boxShadow: '0 8px 30px rgba(0,0,0,.5)',
    });
    document.body.appendChild(toastEl);
  }
  toastEl.textContent = text;
  setTimeout(() => (toastEl.style.opacity = '0'), 2600);
}

PB.env = { isExtension, storage, runtime, tabs, seedIfNeeded };

})(globalThis.PB = globalThis.PB || {});
