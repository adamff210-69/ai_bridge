/**
 * PromptBridge service worker — classic worker, no bundler.
 *
 * importScripts() runs before anything below, exactly like a <script> tag at the
 * top of an HTML file. PB is the same global namespace the content script uses.
 *
 * MV3 workers are killed constantly, so everything that can live in a content
 * script lives in a content script. This file owns exactly four things:
 *   1. context menus + keyboard commands  -> forward to the active tab
 *   2. transfers                          -> open a tab, wait for it, inject
 *   3. run bookkeeping                    -> collect answers for the compare board
 *   4. extension pages                    -> library, onboarding
 */

importScripts('env.js', 'lib.js');

const { getRuns, saveRun, getPacks, getSettings } = PB.SHARED;

const packs = new Map(); // tabId -> { runId, dest, text, autoSubmit, tries }

/* ================================================================== *
 * Menus + commands
 * ================================================================== */

chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  await chrome.contextMenus.removeAll();
  const menus = [
    { id: 'pb-capture', title: 'PromptBridge: capture thread as a Context Pack', contexts: ['page'] },
    { id: 'pb-send', title: 'PromptBridge: send thread to another AI…', contexts: ['page'] },
    { id: 'pb-enhance', title: 'PromptBridge: score this prompt', contexts: ['editable'] },
    { id: 'pb-lens', title: 'PromptBridge: transform the last answer…', contexts: ['page'] },
    { id: 'pb-dictate', title: 'PromptBridge: start voice typing', contexts: ['editable'] },
    { id: 'pb-cook', title: 'PromptBridge: cook this prompt', contexts: ['editable'] },
  ];
  menus.forEach((m) => chrome.contextMenus.create(m));
  if (reason === 'install') chrome.tabs.create({ url: chrome.runtime.getURL('onboarding.html') });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (!tab?.id) return;
  const map = {
    'pb-capture': { type: 'pb:capture' },
    'pb-send': { type: 'pb:open-panel', panel: 'send' },
    'pb-enhance': { type: 'pb:open-panel', panel: 'prompt' },
    'pb-lens': { type: 'pb:open-panel', panel: 'lens' },
    'pb-cook': { type: 'pb:cook' },
    'pb-dictate': { type: 'pb:dictate' },
  };
  const msg = map[info.menuItemId];
  if (msg) chrome.tabs.sendMessage(tab.id, msg).catch(() => {});
});

const COMMANDS = {
  'toggle-palette': { type: 'pb:palette' },
  'grab-pack': { type: 'pb:capture' },
  'send-to': { type: 'pb:open-panel', panel: 'send' },
  'dictate-toggle': { type: 'pb:dictate' },
};

chrome.commands.onCommand.addListener((name) => {
  const msg = COMMANDS[name];
  if (!msg) return;
  chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
    if (tab?.id) chrome.tabs.sendMessage(tab.id, msg).catch(() => {});
  });
});

/* ================================================================== *
 * Transfers
 * ================================================================== */

async function inject(tabId, job) {
  return new Promise((resolve) => {
    const attempt = (tries) => {
      chrome.tabs
        .sendMessage(tabId, { type: 'pb:inject', text: job.text, autoSubmit: job.autoSubmit, runId: job.runId, dest: job.dest })
        .then((r) => (r?.ok ? resolve(r) : retry(tries, r?.reason)))
        .catch(() => retry(tries, 'unreachable'));
    };
    const retry = (tries, reason) => (tries <= 0 ? resolve({ ok: false, reason }) : setTimeout(() => attempt(tries - 1), 600));
    attempt(14); // ~8s of SPA boot on a cold tab
  });
}

chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info.status !== 'complete') return;
  const job = packs.get(tabId);
  if (!job) return;
  inject(tabId, job);
});

chrome.tabs.onRemoved.addListener((tabId) => packs.delete(tabId));

/* ================================================================== *
 * Run bookkeeping for the compare board
 * ================================================================== */

async function touchRun(runId, fn) {
  const runs = await getRuns();
  const i = runs.findIndex((r) => r.id === runId);
  const run = i >= 0 ? runs[i] : { id: runId, created: Date.now(), packTitle: '', status: 'running', answers: [] };
  fn(run);
  run.answers = (run.answers || []).map((a) => ({ dest: a.dest, state: a.state, ms: a.ms, text: a.text }));
  if (run.answers.length && run.answers.every((a) => a.state === 'done')) run.status = 'done';
  else if (run.answers.some((a) => a.state === 'done')) run.status = 'partial';
  return saveRun(run);
}

/* ================================================================== *
 * Message router
 * ================================================================== */

chrome.runtime.onMessage.addListener((msg, sender, send) => {
  if (!msg?.type) return;
  const reply = (v) => send(v);

  switch (msg.type) {
    case 'pb:send-pack': {
      chrome.tabs.create({ url: msg.url, active: false, pinned: false }, (tab) => {
        if (!tab?.id) return reply({ ok: false, reason: 'no-tab' });
        const job = { runId: msg.runId, dest: msg.dest, text: msg.text, autoSubmit: msg.autoSubmit };
        packs.set(tab.id, job);
        touchRun(msg.runId, (r) => {
          if (msg.packTitle) r.packTitle = msg.packTitle;
          const answers = r.answers || [];
          if (!answers.some((a) => a.dest === msg.dest)) answers.push({ dest: msg.dest, state: 'pending', ms: 0, text: '' });
        });
        // also try immediately in case the tab is already warm
        setTimeout(() => { if (packs.has(tab.id)) { inject(tab.id, job); packs.delete(tab.id); } }, 1500);
        reply({ ok: true, tabId: tab.id, runId: msg.runId });
      });
      return true;
    }

    case 'pb:run-started':
      touchRun(msg.runId, (r) => {
        const a = (r.answers || []).find((x) => x.dest === msg.dest);
        if (a) a.state = 'running';
      });
      return reply({ ok: true });

    case 'pb:run-answer':
      touchRun(msg.runId, (r) => {
        const a = (r.answers || []).find((x) => x.dest === msg.dest);
        if (a) Object.assign(a, { state: msg.state, ms: msg.ms, text: msg.text });
        else r.answers.push({ dest: msg.dest, state: msg.state, ms: msg.ms, text: msg.text });
      });
      return reply({ ok: true });

    case 'pb:open-page':
      chrome.tabs.create({ url: chrome.runtime.getURL(msg.page) + (msg.hash ? '#' + msg.hash : '') });
      return reply({ ok: true });

    case 'pb:open-popup': {
      chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
        if (tab?.id) chrome.tabs.sendMessage(tab.id, { type: 'pb:open-panel', panel: msg.panel || 'send' }).catch(() => {});
      });
      return reply({ ok: true });
    }

    case 'pb:clear-all':
      chrome.storage.local.remove(['pb.packs', 'pb.runs', 'pb.dna']);
      return reply({ ok: true });

    case 'pb:get-state':
      Promise.all([getPacks(), getRuns(), getSettings()]).then(([p, r, s]) => reply({ ok: true, packs: p, runs: r, settings: s }));
      return true;

    case 'pb:ping-tab':
      chrome.tabs.sendMessage(msg.tabId, { type: 'pb:ping' }).then((r) => reply({ ok: true, result: r })).catch(() => reply({ ok: false }));
      return true;

    case 'pb:health':
      reply({ ok: true, url: sender?.tab?.url, host: sender?.tab?.url ? new URL(sender.tab.url).hostname : null });
      return true;

    default:
      return;
  }
});
