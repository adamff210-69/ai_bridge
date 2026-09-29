/**
 * Tests for the sensing engine — the part that is supposed to replace
 * hardcoded per-site selectors.
 *
 * Run:  node _dev/test-sense.mjs      (needs jsdom, same as test-plain.mjs)
 *
 * The important test is `demo/mock-unknown.html`: a host the extension has
 * never heard of, with obfuscated class names and a decoy search box. If that
 * one works, a vendor redesign cannot break capture.
 */
import { JSDOM, VirtualConsole } from 'jsdom';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';

let pass = 0;
const fails = [];
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fails.push([name, got, want]);
  console.log((ok ? '  ✓ ' : '  ✗ ') + name + (ok ? '' : `\n      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`));
};
const section = (t) => console.log('\n\x1b[1m' + t + '\x1b[0m');

async function open(file) {
  const errors = [];
  const url = file.includes('?')
    ? pathToFileURL(resolve(file.split('?')[0])).href + '?' + file.split('?')[1]
    : pathToFileURL(resolve(file)).href;
  const vc = new VirtualConsole();
  vc.on('jsdomError', (e) => errors.push(e.message));
  const dom = await JSDOM.fromURL(url, {
    runScripts: 'dangerously',
    resources: 'usable',
    pretendToBeVisual: true,
    virtualConsole: vc,
    beforeParse(w) {
      // jsdom has no layout, so give every element a box. The engine scores
      // candidates partly on geometry; without this everything measures 0x0 and
      // we would be testing a different algorithm than the one that ships.
      const proto = w.HTMLElement.prototype;
      Object.defineProperty(proto, 'offsetWidth', { get() { return 640; } });
      Object.defineProperty(proto, 'offsetHeight', { get() { return this.tagName === 'TEXTAREA' || this.isContentEditable ? 52 : 24; } });
      proto.getBoundingClientRect = function () {
        const label = (this.getAttribute && (this.getAttribute('placeholder') || this.getAttribute('aria-label'))) || '';
        const isComposer = /message|ask anything|reply|prompt/i.test(label);
        const vh = w.innerHeight;
        const top = isComposer ? vh - 90 : 40;
        return { x: 0, y: top, top, left: 0, width: 640, height: isComposer ? 52 : 24, bottom: top + (isComposer ? 52 : 24), right: 640 };
      };
      w.innerHeight = 800;
      w.__vh = 800;
      w.scrollY = 0;
      w.pageYOffset = 0;
      w.CSS = w.CSS || { escape: (s) => String(s).replace(/([^\w-])/g, '\\$1') };
    },
  });
  return { dom, w: dom.window, errors };
}

const settle = (w, ms = 250) => new Promise((r) => setTimeout(r, ms));

/** Load the real engine + adapters into a page, in manifest order. */
async function loadEngine(w) {
  w.eval(readFileSync(resolve('extension/env.js'), 'utf8'));
  w.eval(readFileSync(resolve('extension/lib.js'), 'utf8'));
  w.eval(readFileSync(resolve('extension/sense.js'), 'utf8'));
  w.eval(readFileSync(resolve('extension/adapters.js'), 'utf8'));
  await settle(w, 80);
}

/* ================================================================== */
section('1 · an unknown host, with hostile markup');

{
  const { w, errors } = await open('demo/mock-unknown.html');
  await settle(w, 300);
  await loadEngine(w);

  check('page loaded clean', errors, []);

  const a = w.PB.adapters.resolveAdapter('quill.example');
  check('no hint matched, so it is fully sensed', a.hintId, null);
  check('adapter is marked sensed', a.sensed, true);

  const composer = a.composer();
  check('found the real composer', !!composer, true);
  check('and not the decoy search box', composer?.tagName, 'TEXTAREA');
  check('composer carries the right placeholder', composer?.getAttribute('placeholder'), 'Message quill');

  const turns = a.turns();
  check('parsed all four turns', turns.length, 4);
  check('roles came out u,a,u,a', turns.map((t) => t.role[0]).join(''), 'uaua');
  check('kept the first question', /ECONNRESET/.test(turns[0]?.text || ''), true);
  check('kept the code block', /```|delay/.test(turns[1]?.text || ''), true);

  const ex = a.explain();
  check('composer was found by scoring, not by name', ex.composer.from, 'sensed');
  check('the list was found by structure', ['sensed', 'ancestor', 'hint'].includes(ex.list?.from), true);
  check('analysis is fast', ex.ms < 400, true);
}

/* ================================================================== */
section('2 · the dead-selector case (Claude 2026)');

{
  // The old hint chain — data-user-message-bubble, div.mb-1.mt-6.group — is
  // gone from claude.ai. A hardcoded list would parse this to zero turns.
  const { w } = await open('demo/mock-claude-2026.html');
  await settle(w, 300);
  await loadEngine(w);

  const a = w.PB.adapters.resolveAdapter('claude.ai');
  check('recognised the host', a.hintId, 'claude');
  check('found the composer', !!a.composer(), true);

  const deadSelectorMatches = document_stub_check(w);
  check('the old dead selectors really are absent', deadSelectorMatches, 0);

  const turns = a.turns();
  // The site's own turn selector is used, so the tool-call card between the
  // assistant turns is excluded — the same answer a selector-based extractor
  // gives, and the right one for this markup.
  check('four turns via the site hint', turns.length, 4);
  check('roles are right', turns.map((t) => t.role).join(','), 'user,assistant,user,assistant');

  // Now the same page with the hint removed: pure structural detection. It
  // finds the tool card too, and knows the card is model-side.
  const sensed = w.PB.sense.probe({});
  check('structural detection finds the tool card', sensed.turns.length, 5);
  check('and marks it assistant', sensed.turns.map((t) => t.role).join(','), 'user,assistant,assistant,user,assistant');
  check('sidebar conversation titles were not captured', turns.some((t) => /Quarterly board numbers/.test(t.text)), false);
}

function document_stub_check(w) {
  return (
    w.document.querySelectorAll('[data-user-message-bubble]').length +
    w.document.querySelectorAll('div.mb-1.mt-6.group').length
  );
}

/* ================================================================== */
section('3 · hints are preferred, but only when true');

{
  const { w } = await open('demo/mock-chat.html?site=chatgpt');
  await settle(w, 300);
  await loadEngine(w);

  const a = w.PB.adapters.resolveAdapter('chatgpt.com');
  check('chatgpt hint matched', a.hintId, 'chatgpt');
  const ex = a.explain();
  check('but the composer came from the verified hint', ex.composer.from, 'hint');
  check('four turns parsed', a.turns().length, 4);
  check('roles alternate correctly', a.turns().map((t) => t.role).join(','), 'user,assistant,user,assistant');
}

{
  // Every known vendor shape, driven by the same engine.
  const { HINTS } = { HINTS: null };
  for (const site of ['chatgpt', 'claude', 'gemini', 'perplexity', 'copilot']) {
    const { w } = await open('demo/mock-chat.html?site=' + site);
    await settle(w, 250);
    await loadEngine(w);
    const a = w.PB.adapters.resolveAdapter({ chatgpt: 'chatgpt.com', claude: 'claude.ai', gemini: 'gemini.google.com', perplexity: 'www.perplexity.ai', copilot: 'copilot.microsoft.com' }[site]);
    const turns = a.turns();
    check(site.padEnd(11) + ' composer found', !!a.composer(), true);
    check(site.padEnd(11) + ' four turns', turns.length, 4, 4);
    check(site.padEnd(11) + ' roles u,a,u,a', turns.map((t) => t.role[0]).join(''), 'uaua');
  }
}

/* ================================================================== */
section('4 · role inference survives asymmetric threads');

{
  const { w } = await open('demo/mock-asymmetric.html');
  await settle(w, 250);
  await loadEngine(w);
  const a = w.PB.adapters.resolveAdapter('quill.example');
  const roles = a.turns().map((t) => t.role);
  // H A H A [A] H — a model that sent two in a row, which breaks naive parity.
  check('extra assistant turn detected', roles[4], 'assistant');
  check('thread does not flip after it', roles[5], 'user');
  check('no turn lost', a.turns().length, 6);
}

/* ================================================================== */
section('5 · an empty page is not a crash');

{
  const { w } = await open('demo/mock-empty.html');
  await settle(w, 200);
  await loadEngine(w);
  const a = w.PB.adapters.resolveAdapter('nothing.example');
  check('no composer, no crash', a.composer(), null);
  check('no turns, no crash', a.turns(), []);
  const d = a.diagnose();
  check('diagnose reports unhealthy', d.ok, false);
}

console.log('\n' + '─'.repeat(58));
for (const [n, got, want] of fails) console.log(`  ✗ ${n}\n      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`);
console.log(fails.length ? `\n\x1b[31m${fails.length} failed\x1b[0m, ${pass} passed` : `\x1b[32mall ${pass} checks passed\x1b[0m`);
process.exit(fails.length ? 1 : 0);
