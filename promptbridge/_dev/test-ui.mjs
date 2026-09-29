/**
 * PromptBridge — UI & UX regression suite (the bugs users can see).
 *
 * These are the checks that exist because something shipped broken once:
 *
 *   · the manifest used to inject page.css (the extension-pages stylesheet)
 *     into EVERY site, which squeezed the host's <main> into a 1120px column
 *     and darkened its <body> — "the extension collapses the AI page"
 *   · reading mode used to generate `html.pb-reading *{opacity:.28}` on sensed
 *     adapters, fading the entire page and persisting it in localStorage
 *   · the popup used to run a full capture on every open (duplicate packs +
 *     toast spam)
 *   · fan-out could inject the same run twice (warm-tab timer racing
 *     tabs.onUpdated), double-typing and double-submitting the prompt
 *   · the drawer header never showed the detected site (setSite ran before
 *     the surface existed)
 *   · the drawer scrim blocked the whole page behind a side panel
 *
 *   node _dev/test-ui.mjs        (needs `npm i jsdom`)
 */
import { JSDOM, VirtualConsole } from 'jsdom';
import { pathToFileURL } from 'node:url';
import { resolve, dirname, join } from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const EXT = join(ROOT, 'extension');
const read = (p) => readFileSync(resolve(p), 'utf8');

let pass = 0;
let fail = 0;
const check = (n, c, x = '') => (c ? (pass++, console.log('  ✓', n)) : (fail++, console.log('  ✗', n, x)));

async function open(file) {
  const errors = [];
  const url = file.includes('?') ? pathToFileURL(resolve(file.split('?')[0])).href + '?' + file.split('?')[1] : pathToFileURL(resolve(file)).href;
  const vc = new VirtualConsole();
  vc.on('jsdomError', (e) => errors.push(e.message));
  vc.on('error', (e) => errors.push(String(e)));
  const dom = await JSDOM.fromURL(url, {
    runScripts: 'dangerously',
    resources: 'usable',
    pretendToBeVisual: true,
    virtualConsole: vc,
    beforeParse(w) {
      w.confirm = () => true;
      w.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
      w.HTMLDialogElement.prototype.close = function () { this.open = false; };
      w.URL.createObjectURL = () => 'blob:stub';
      w.URL.revokeObjectURL = () => {};
      class FakeDataTransfer {
        constructor() { this._d = {}; this.effectAllowed = 'all'; this.dropEffect = 'none'; this.types = []; }
        setData(t, v) { this._d[t] = String(v); if (!this.types.includes(t)) this.types.push(t); }
        getData(t) { return this._d[t] || ''; }
        clearData(t) { if (t) delete this._d[t]; else this._d = {}; this.types = Object.keys(this._d); }
      }
      w.DataTransfer = FakeDataTransfer;
      w.HTMLElement.prototype.getBoundingClientRect = function () {
        const label = (this.getAttribute && (this.getAttribute('placeholder') || this.getAttribute('aria-label'))) || '';
        const composer = /message|ask anything|reply|prompt|question|chat|write|tell/i.test(label);
        const top = composer ? 700 : 40;
        return { x: 0, y: top, top, left: 0, width: 640, height: composer ? 52 : 24, bottom: top + (composer ? 52 : 24), right: 640 };
      };
      w.innerHeight = 800;
      w.CSS = w.CSS || { escape: (x) => String(x).replace(/([^\w-])/g, '\\\\$1') };
    },
  });
  return { dom, w: dom.window, errors };
}
const settle = (w, ms = 350) => new Promise((r) => setTimeout(r, ms));

async function bootStack(w, pageUrl) {
  const fakeScript = w.document.createElement('script');
  Object.defineProperty(fakeScript, 'src', { value: pathToFileURL(resolve('extension/shell.js')).href });
  Object.defineProperty(w.document, 'currentScript', { configurable: true, get: () => fakeScript });
  for (const f of ['env.js', 'lib.js', 'sense.js', 'adapters.js', 'observe.js', 'lens.js', 'promptsmith.js', 'pack.js', 'dictate.js', 'shell.js', 'inject.js'])
    w.eval(read('extension/' + f));
  w.eval(read('extension/content.js'));
  delete w.document.currentScript;
  await settle(w, 500);
  return w.__promptbridge;
}

/* ================================================================== *
 * 1 · the manifest may only inject host.css into other people's pages
 * ================================================================== */
console.log('\n── host pages are off limits ─────────────────────────────');
{
  const manifest = JSON.parse(read('extension/manifest.json'));
  const css = manifest.content_scripts.flatMap((c) => c.css || []);
  check('manifest injects exactly one stylesheet', css.length === 1, JSON.stringify(css));
  check('that stylesheet is host.css', css[0] === 'host.css', css[0]);
  check('page.css is NOT injected into host pages', !css.includes('page.css'));
  check('web_accessible_resources does not expose page.css', !JSON.stringify(manifest.web_accessible_resources).includes('page.css'));

  // host.css must not contain bare element selectors — only our own classes
  const host = read('extension/host.css');
  const rules = host.replace(/\/\*[\s\S]*?\*\//g, '').split('}').map((r) => r.split('{')[0].trim()).filter(Boolean);
  const bare = rules.filter((sel) =>
    sel.split(',').map((s) => s.trim()).some(
      (s) => s && !s.startsWith('.') && !s.startsWith('#') && !s.startsWith('html.pb-') && s !== 'html.pb-dragging'
    )
  );
  check('host.css styles only PromptBridge-scoped selectors', bare.length === 0, bare.join(', '));

  // library + onboarding still get the full stylesheet via <link>
  for (const page of ['extension/library.html', 'extension/onboarding.html'])
    check(page + ' still links page.css', /href="page\.css"/.test(read(page)));
}

/* ---- dynamic proof on an innocent page: host.css changes nothing ---- */
{
  const { w } = await open('_dev/e2e/plain-site.html');
  await settle(w, 300);
  // simulate exactly what the manifest does: append the injected stylesheet
  const link = w.document.createElement('link');
  link.rel = 'stylesheet';
  link.href = pathToFileURL(resolve('extension/host.css')).href;
  w.document.head.appendChild(link);
  await settle(w, 500);

  const cs = (sel) => w.getComputedStyle(w.document.querySelector(sel));
  check('body background untouched', cs('body').backgroundColor === 'rgb(255, 255, 255)', cs('body').backgroundColor);
  check('body font untouched', /georgia/i.test(cs('body').fontFamily), cs('body').fontFamily);
  check('main not width-capped', cs('main').maxWidth === 'none', cs('main').maxWidth);
  check('header position untouched', cs('header').position === 'static', cs('header').position);
  check('button radius untouched', cs('#subscribe').borderRadius === '2px', cs('#subscribe').borderRadius);
}

/* ---- and page.css still does its real job on OUR pages ---- */
{
  const dom = new JSDOM(`<!doctype html><html><body><main><h1>x</h1></main></body></html>`, { pretendToBeVisual: true });
  const w = dom.window;
  const style = w.document.createElement('style');
  style.textContent = read('extension/page.css');
  w.document.head.appendChild(style);
  await settle(w, 200);
  // jsdom does not resolve var() in computed styles, so assert on the cascade
  // itself: page.css must style body/header/main — which is exactly why it
  // must never ride along in manifest content_scripts.css.
  const sels = new Set([...style.sheet.cssRules].map((r) => r.selectorText || r.cssText.split('{')[0].trim()));
  check('page.css themes extension pages (body rule)', [...sels].some((s) => /^body$/.test(s)));
  check('page.css declares a light scheme block', /prefers-color-scheme:\s*light/.test(read('extension/page.css')));
}

/* ================================================================== *
 * 2 · reading mode dims TURNS, never the page
 * ================================================================== */
console.log('\n── reading mode ───────────────────────────────────────────');
{
  const { w, errors } = await open('demo/mock-chat.html?site=chatgpt');
  await settle(w, 400);
  await bootStack(w, 'demo/mock-chat.html?site=chatgpt');
  const d = w.document;

  const main = d.querySelector('main');
  const before = w.getComputedStyle(main).opacity;

  // grow the thread past the "keep the last 4 readable" window first: the mock
  // ships exactly 4 turns, and with 4 nothing should dim — that is correct
  const addTurn = (role, text) => {
    const a = d.createElement('article');
    a.setAttribute('data-message-author-role', role);
    a.textContent = text;
    d.querySelector('main').appendChild(a);
  };
  addTurn('assistant', 'Added the stalled-event listener and re-ran the load profile; the retry storm is gone and the queue depth graph is flat under peak load. Here is the diff and the numbers.');
  addTurn('user', 'Great. Next, add the pool-cap metric to the dashboard and write the rollout notes for the team, keeping it under one page.');
  await settle(w, 300);

  // open the shell and toggle reading mode the way a user does (drawer button)
  const s = d.getElementById('promptbridge-root').shadowRoot;
  w.__promptbridge.shell.openDrawer('overview');
  await settle(w, 150);
  s.querySelector('[data-a="reading"]').click();
  await settle(w, 400);

  const allTurns = [...d.querySelectorAll('article')];
  const dimmed = [...d.querySelectorAll('.pb-rm-dim')];
  check('reading mode is on', d.documentElement.classList.contains('pb-reading'));
  check('older turns carry the dim class', dimmed.length === allTurns.length - 4, `dimmed=${dimmed.length} of ${allTurns.length}`);
  check('newest 4 turns stay visible', allTurns.slice(-4).every((t) => !t.classList.contains('pb-rm-dim')));
  check('the page container itself is never dimmed', !main.classList.contains('pb-rm-dim'));
  check('no wildcard selector was generated', !/html\.pb-reading \*\s*[{,]/.test(d.getElementById('pb-reading-style')?.textContent || ''));
  const mainOpacity = w.getComputedStyle(main).opacity;
  check('page opacity unchanged', mainOpacity === before || mainOpacity === '' || mainOpacity === '1', mainOpacity);
  check('a visible exit pill is shown', !!s.querySelector('.pb-reading-pill') && !s.querySelector('.pb-reading-pill').hidden);

  // and a new turn arriving re-computes the window (content.js watchThread)
  const art = d.createElement('article');
  art.setAttribute('data-message-author-role', 'user');
  art.textContent = 'one more follow-up turn to push the window along, with enough text to be counted as a real message by the engine';
  d.querySelector('main').appendChild(art);
  await settle(w, 2300);

  const dimmedAfter = [...d.querySelectorAll('.pb-rm-dim')];
  check('dimming follows the growing thread', dimmedAfter.length === dimmed.length + 1 && !dimmedAfter.includes(art), `count=${dimmedAfter.length}`);

  // exit via the pill — one click, no residue
  s.querySelector('.pb-reading-pill').click();
  await settle(w, 300);
  check('pill click exits reading mode', !d.documentElement.classList.contains('pb-reading'));
  check('no dim classes left on the page', d.querySelectorAll('.pb-rm-dim').length === 0);
  check('style element removed', !d.getElementById('pb-reading-style'));

  check('no page errors while doing all that', errors.length === 0, errors.join(' | ').slice(0, 200));
}

/* ---- a page with no conversation must refuse reading mode ---- */
{
  const { w } = await open('demo/mock-empty.html');
  await settle(w, 300);
  await bootStack(w);
  const d = w.document;
  const on = w.__promptbridge.api.toggleReading();
  await settle(w, 200);
  check('no transcript → reading mode stays off', !on && !d.documentElement.classList.contains('pb-reading'));
  check('no dimming stylesheet injected', !d.getElementById('pb-reading-style'));
}

/* ================================================================== *
 * 3 · the drawer is a side panel, not a page hijack
 * ================================================================== */
console.log('\n── drawer behaviour ───────────────────────────────────────');
{
  const { w } = await open('demo/mock-chat.html?site=chatgpt');
  await settle(w, 400);
  await bootStack(w);
  const d = w.document;
  const s = d.getElementById('promptbridge-root').shadowRoot;

  w.__promptbridge.shell.openDrawer('send');
  await settle(w, 250);

  check('drawer opens without the modal scrim', !s.getElementById('pb').classList.contains('pal-open'), s.getElementById('pb').className);
  check('shell.css scopes the scrim to the palette only', /\.pb\.pal-open \.pb-scrim\{display:block\}/.test(read('extension/shell.css')));
  // setSite() runs at boot, before the surface exists — it must survive until mount
  const expectedLabel = w.__promptbridge.adapter.label;
  check('header shows the detected site (' + expectedLabel + ')', s.getElementById('sitetag').textContent === expectedLabel && expectedLabel !== '—', s.getElementById('sitetag').textContent);
  check('health dot is green', s.querySelector('#sitedot').style.background === 'var(--ok)', s.querySelector('#sitedot').style.background);

  // the page behind must receive events
  let hits = 0;
  d.querySelector('main').addEventListener('click', () => hits++);
  d.querySelector('main').dispatchEvent(new w.Event('click', { bubbles: true }));
  check('page behind the drawer still receives clicks', hits === 1);

  // Esc closes and destinations are listed
  const dests = s.querySelectorAll('[data-dest]').length;
  check('send panel lists destinations', dests >= 5, `dests=${dests}`);
  d.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await settle(w, 150);
  check('Esc closes the drawer', !s.getElementById('pb').classList.contains('drawer-open'));
}

/* ================================================================== *
 * 4 · the popup peeks; it does not capture
 * ================================================================== */
console.log('\n── popup peek ─────────────────────────────────────────────');
{
  const { w } = await open('demo/mock-chat.html?site=claude');
  await settle(w, 400);
  await bootStack(w);
  const d = w.document;
  // give the shell a surface so capture's toast can actually render
  w.__promptbridge.shell.openDrawer('overview');
  await settle(w, 150);

  const count = async () => (await w.PB.env.storage.get('pb.packs'))['pb.packs']?.length || 0;
  const before = await count();

  // what the popup sends on open
  w.postMessage({ type: 'pb:peek-pack' }, '*');
  await settle(w, 500);
  check('peek does not create a pack', (await count()) === before, `before=${before} after=${await count()}`);

  // an explicit capture still works (context menu / shortcut)
  w.postMessage({ type: 'pb:capture' }, '*');
  await settle(w, 500);
  check('explicit capture still stores a pack', (await count()) === before + 1, `before=${before} now=${await count()}`);
  check('capture still announces itself', /captured/i.test([...d.getElementById('promptbridge-root').shadowRoot.querySelectorAll('.pb-toast')].at(-1)?.textContent || ''));
}

/* ================================================================== *
 * 5 · fan-out must never inject the same run twice
 * ================================================================== */
console.log('\n── duplicate run guard ───────────────────────────────────');
{
  const { w } = await open('demo/mock-chat.html?site=chatgpt');
  await settle(w, 400);
  await bootStack(w);
  const d = w.document;
  const composer = d.querySelector('#prompt-textarea');
  const set = (v) => { composer.value = v; composer.dispatchEvent(new w.Event('input', { bubbles: true })); };

  set('first injection');
  w.postMessage({ type: 'pb:inject', text: 'first injection', runId: 'run-1', dest: 'chatgpt' }, '*');
  await settle(w, 400);
  // same runId arrives again from the racing warm-tab timer
  w.postMessage({ type: 'pb:inject', text: 'DUPLICATED SECOND COPY', runId: 'run-1', dest: 'chatgpt' }, '*');
  await settle(w, 400);
  check('same runId ignored', composer.value === 'first injection', composer.value.slice(0, 40));

  w.postMessage({ type: 'pb:inject', text: 'a different run', runId: 'run-2', dest: 'chatgpt' }, '*');
  await settle(w, 400);
  check('a new runId still lands', composer.value === 'a different run', composer.value.slice(0, 40));
}

/* ================================================================== *
 * 6 · theme + misc regressions
 * ================================================================== */
console.log('\n── theme & affordances ───────────────────────────────────');
{
  check('shell.css has a light scheme', /prefers-color-scheme:\s*light/.test(read('extension/shell.css')));
  check('inject bar has a light scheme', /prefers-color-scheme:\s*light/.test(read('extension/inject.js')));
  check('lens panel has a light scheme', /prefers-color-scheme:\s*light/.test(read('extension/lens.js')));
  check('reading-mode pill exists in shell markup', /pb-reading-pill/.test(read('extension/shell.js')));
  check('watchThread binds via the sensing engine', /PB\.adapters\.messageEls/.test(read('extension/observe.js')));
}

console.log('\n──────────────────────────────────────────');
console.log(`  ${pass} passed, ${fail} FAILED`);
process.exit(fail ? 1 : 0);
