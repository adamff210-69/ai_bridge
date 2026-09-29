/**
 * Verifies the no-build layout by loading the actual HTML files in jsdom with
 * real <script src> resolution from disk — no bundler, no module graph, exactly
 * what Chrome does when you click "Load unpacked".
 *
 * Optional. Needs `npm i jsdom`. Nothing in the extension depends on it.
 *
 *   node _dev/test-plain.mjs
 */
import { JSDOM, VirtualConsole } from 'jsdom';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';

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
      // jsdom has no DataTransfer constructor; drag and drop is central to the
      // pack tray, so the harness needs a working one.
      class FakeDataTransfer {
        constructor() { this._d = {}; this.effectAllowed = 'all'; this.dropEffect = 'none'; this.types = []; }
        setData(t, v) { this._d[t] = String(v); if (!this.types.includes(t)) this.types.push(t); }
        getData(t) { return this._d[t] || ''; }
        clearData(t) { if (t) delete this._d[t]; else this._d = {}; this.types = Object.keys(this._d); }
      }
      w.DataTransfer = FakeDataTransfer;
      // jsdom has no layout engine, so every element measures 0x0. The sensing
      // engine scores candidates partly on geometry, so without this we would be
      // testing a different algorithm than the one that ships.
      w.HTMLElement.prototype.getBoundingClientRect = function () {
        const label = (this.getAttribute && (this.getAttribute('placeholder') || this.getAttribute('aria-label'))) || '';
        const composer = /message|ask anything|reply|prompt|question|chat|write|tell/i.test(label);
        const top = composer ? 700 : 40;
        return { x: 0, y: top, top, left: 0, width: 640, height: composer ? 52 : 24, bottom: top + (composer ? 52 : 24), right: 640 };
      };
      w.innerHeight = 800;
      w.CSS = w.CSS || { escape: (x) => String(x).replace(/([^\w-])/g, '\\\\$1') };
      w.URL.revokeObjectURL = () => {};
    },
  });
  return { dom, w: dom.window, errors };
}
const settle = (w, ms = 350) => new Promise((r) => setTimeout(r, ms));
const click = (el) => el && el.dispatchEvent(new el.ownerDocument.defaultView.Event('click', { bubbles: true }));

/* ---------------- the extension's own pages ---------------- */
console.log('\n── extension/library.html ────────────────────────────────');
{
  const { w, errors } = await open('extension/library.html');
  await settle(w, 500);
  const d = w.document;
  check('scripts loaded and ran', d.querySelectorAll('#packs .card').length >= 1, errors.join(' | '));
  check('no page errors', errors.length === 0, errors.join(' | '));
  check('PB global present', !!w.PB && !!w.PB.SHARED && !!w.PB.env);
  check('preview badge (no chrome.*)', /preview/i.test(d.querySelector('#mode').textContent));
  click(d.querySelector('[data-tab=compare]'));
  await settle(w, 150);
  check('compare board renders', d.querySelectorAll('#runs .card').length >= 4);
  click(d.querySelector('[data-tab=data]'));
  await settle(w, 150);
  check('data tab renders', /Storage/.test(d.querySelector('#stats').textContent));
  click(d.querySelector('[data-tab=packs]'));
  await settle(w, 100);
  click(d.querySelector('#packs [data-view]'));
  await settle(w, 200);
  const body = d.querySelector('#dlg-body').textContent;
  check('claude dialect balanced', (body.match(/<context>/g) || []).length === 1 && (body.match(/<\/context>/g) || []).length === 1);
  const sel = d.querySelector('#dlg-foot [data-dest]');
  sel.value = 'gemini';
  sel.dispatchEvent(new w.Event('change', { bubbles: true }));
  await settle(w, 150);
  check('dialect switch works', /\*\*Background\*\*/.test(d.querySelector('#dlg-body').textContent));
}

console.log('\n── extension/onboarding.html ─────────────────────────────');
{
  const { w, errors } = await open('extension/onboarding.html');
  await settle(w, 400);
  const d = w.document;
  check('no page errors', errors.length === 0, errors.join(' | '));
  check('site toggles rendered', d.querySelectorAll('#sites .site').length >= 8);
  click(d.querySelector('[data-go="1"]'));
  await settle(w, 150);
  const site = d.querySelector('#sites .site');
  click(site);
  await settle(w, 200);
  check('site toggle flips in place', site.classList.contains('off'));
  click(d.querySelector('[data-go="2"]'));
  await settle(w, 150);
  check('tier copy explains no bundling', /45MB/.test(d.querySelector('#tierhelp').textContent));
  click(d.querySelector('[data-go="3"]'));
  await settle(w, 150);
  check('privacy step', /no server/i.test(d.querySelectorAll('.step')[3].textContent));
}

console.log('\n── extension/popup.html ──────────────────────────────────');
{
  const { w, errors } = await open('extension/popup.html');
  await settle(w, 500);
  const d = w.document;
  check('no page errors', errors.length === 0, errors.join(' | '));
  check('destinations rendered', d.querySelectorAll('#dests .dest').length === 5);
  check('redaction on by default', d.querySelector('#redact').checked === true);
  check('auto-submit off by default', d.querySelector('#autosub').checked === false);
}

/* ---------------- the in-page shell, from a file:// URL ---------------- */
console.log('\n── demo/shell-preview.html (real createShell) ────────────');
{
  const { w, errors } = await open('demo/shell-preview.html');
  await settle(w, 600);
  const d = w.document;
  const root = d.getElementById('promptbridge-root');
  check('no page errors', errors.length === 0, errors.join(' | '));
  check('shell mounted a shadow root', !!root && !!root.shadowRoot);
  if (root && root.shadowRoot) {
    const s = root.shadowRoot;
    const q = (sel) => s.querySelector(sel);
    check('launcher present at boot', !!q('.pb-fab'));
    check('drawer built lazily', !q('.pb-drawer'));

    click(d.getElementById('pal'));
    await settle(w, 200);
    check('palette opens', s.getElementById('pb').classList.contains('pal-open'));
    check('commands listed', s.querySelectorAll('#pallist .pb-item').length > 15);

    click(d.querySelector('[data-open=prompt]'));
    await settle(w, 250);
    check('drawer opens', s.getElementById('pb').classList.contains('drawer-open'));
    check('7 slot chips', s.querySelectorAll('#drawer .slot').length === 7);
    const score = Number((s.getElementById('drawer').textContent.match(/(\d+)\/100/) || [])[1]);
    check('weak prompt scores low', score > 0 && score < 40, 'score ' + score);

    click(s.querySelector('[data-a=enhance]'));
    await settle(w, 300);
    check('enhance rewrote the composer', /Success =/.test(d.getElementById('composer').value));

    click(d.querySelector('[data-open=send]'));
    await settle(w, 250);
    click(s.querySelector('[data-dest=claude]'));
    await settle(w, 300);
    check('claude dialect preview rendered', /<context>/.test(s.getElementById('drawer').textContent));
    check('handoff line updated', /would open/.test(d.getElementById('handoff').textContent));

    click(d.querySelector('[data-open=lens]'));
    await settle(w, 200);
    click(s.querySelector('[data-lens=tldr]'));
    await settle(w, 200);
    check('lens produced output', d.getElementById('lensOut').textContent.length > 20);

    check('shell.css resolved from ../extension', !!q('link') && /extension\/shell\.css|shell\.css$/.test(q('link').getAttribute('href')));
  }
}

/* ---------------- dictation: shell UI, Flow, vocabulary ---------------- */
console.log('\n── dictate UI over the real shell ──────────────────────');
{
  const { w, errors } = await open('demo/shell-preview.html');
  await settle(w, 600);
  const d = w.document;
  const s = d.getElementById('promptbridge-root').shadowRoot;
  const { api } = w.__pb;

  check('demo booted with no errors', errors.length === 0, errors.join(' | '));

  // --- Flow mode: the FAB must switch to the locked-on state
  const fab = s.querySelector('.pb-fab');
  api.toggleDictate();
  await settle(w, 120);
  check('voice tap starts recording', fab.classList.contains('rec'));
  check('single tap is not Flow', !fab.classList.contains('flow'));

  api.toggleDictate(); // immediately again = double-tap
  await settle(w, 120);
  check('double-tap keeps listening (key already released)', fab.classList.contains('rec'));
  check('double-tap latches Flow', fab.classList.contains('flow'));
  check('Flow title explains itself', /stop listening/i.test(fab.title), fab.title);

  api.toggleDictate(); // a third tap stops
  await settle(w, 120);
  check('third tap stops and clears Flow', !fab.classList.contains('rec') && !fab.classList.contains('flow'));

  api.toggleDictate();
  await settle(w, 80);
  api.setFlowMode(true);
  await settle(w, 120);
  check('Flow can be switched on directly', fab.classList.contains('flow'));
  api.setFlowMode(false);
  await settle(w, 120);
  check('Flow can be switched off', !fab.classList.contains('flow'));
  api.toggleDictate();
  await settle(w, 80);

  // --- the settings view must expose all three new controls
  api.setSetting({ smartCorrections: true, learnDictionary: true, flowMode: true });
  await settle(w, 200);
  click(d.querySelector('[data-open=settings]'));
  await settle(w, 250);
  for (const key of ['smartCorrections', 'flowMode', 'learnDictionary']) {
    check('settings has a ' + key + ' toggle', !!s.querySelector(`[data-set="${key}"]`));
  }
  check('vocabulary panel rendered', /Vocabulary/.test(s.getElementById('drawer').textContent));

  // A "false" string is truthy — a flag saved that way can never be turned off.
  const readSetting = async (k) => (await w.PB.env.storage.get('pb.settings'))['pb.settings'][k];
  await api.setSetting({ smartCorrections: 'false' });
  check('boolean-ish settings stay booleans', (await readSetting('smartCorrections')) === false, JSON.stringify(await readSetting('smartCorrections')));
  await api.setSetting({ smartCorrections: true });
  check('flag turns back on', (await readSetting('smartCorrections')) === true);

  // --- learning a word puts it in the panel, and clicking it forgets it
  api.addWord('PromptBridge');
  await settle(w, 250);
  check('learned term is listed', !!s.querySelector('[data-dict="PromptBridge"]'));
  click(s.querySelector('[data-dict="PromptBridge"]'));
  await settle(w, 250);
  check('clicking a term forgets it', !s.querySelector('[data-dict="PromptBridge"]'));

  // --- command mode acts on the COMPOSER, not the last answer
  d.getElementById('composer').value = 'the upload bug drops three percent of files under load and the log shows econnreset from the provider';
  api.lensComposer('bullets');
  await settle(w, 150);
  const lensed = d.getElementById('composer').value;
  check('lens restructures the composer', /^\s*[-*]/.test(lensed), lensed.slice(0, 60));
  check('lens kept the substance', /econnreset/i.test(lensed) || /ECONNRESET/i.test(lensed));

  api.undo();
  await settle(w, 150);
  check('command-mode edits are undoable', !/^\s*[-*]/.test(d.getElementById('composer').value));

  d.getElementById('composer').value = 'write a migration plan';
  api.refineComposer('Translate the text to Spanish');
  await settle(w, 150);
  check('refine appends a directive', /Translate the text to Spanish\.$/.test(d.getElementById('composer').value));
}

/* ---------------- the in-page bar: cook + drop ---------------- */
console.log('\n── injected bar: cook this prompt, drop a pack ───────');
{
  const { w, errors } = await open('demo/mock-unknown.html');
  await settle(w, 400);
  // real content-script stack, in manifest order
  for (const f of ['env.js', 'lib.js', 'sense.js', 'adapters.js', 'observe.js', 'lens.js', 'promptsmith.js', 'pack.js', 'dictate.js', 'shell.js', 'inject.js'])
    w.eval(readFileSync(resolve('extension/' + f), 'utf8'));
  w.eval(readFileSync(resolve('extension/content.js'), 'utf8'));
  await settle(w, 400);

  const d = w.document;
  const host = d.getElementById('promptbridge-inject');
  check('in-page bar mounted on an unknown host', !!host, 'no #promptbridge-inject');
  check('no page errors from the whole stack', errors.length === 0, errors.join(' | '));

  const bar = host.shadowRoot.querySelector('.bar');
  check('bar is visible on a page with a composer', bar.classList.contains('on'), bar.className);

  // --- Cook this prompt
  d.querySelector('.m1').value = 'fix my upload bug';
  await settle(w, 60);
  const cookBtn = bar.querySelector('[data-a=cook]');
  check('the cook button is labelled for humans', /cook this prompt/i.test(cookBtn.textContent), cookBtn.textContent);
  click(cookBtn);
  await settle(w, 250);
  const cooked = d.querySelector('.m1').value;
  check('cook rewrote the composer', cooked.length > 'fix my upload bug'.length, cooked.slice(0, 50));
  check('cook output is undoable', typeof w.__promptbridge === 'object');

  // --- Packs tray
  click(bar.querySelector('[data-a=tray]'));
  await settle(w, 200);
  const tray = host.shadowRoot.querySelector('.tray');
  check('tray opens', tray.classList.contains('on'));
  check('tray explains itself when empty', /nothing saved yet/i.test(tray.textContent), tray.textContent.slice(0, 60));

  // seed a pack, then confirm it is draggable and drops into the composer
  const { buildPack } = w.PB.pack;
  const { savePack } = w.PB.SHARED;
  const turns = [
    { role: 'user', text: 'Our ingest drops 3% of uploads under load. Logs show ECONNRESET from the upstream provider.' },
    { role: 'assistant', text: 'The 5s socketTimeout races the 5s retry backoff.\n\n- Decision: exponential backoff with jitter\n- Decision: socketTimeout to 20s' },
  ];
  const pack = buildPack(turns, { sourceSite: 'quill', sourceUrl: 'https://quill.example/c/1' });
  await savePack(pack);
  await settle(w, 150);
  click(bar.querySelector('[data-a=tray]'));   // close
  await settle(w, 120);
  click(bar.querySelector('[data-a=tray]'));   // reopen — re-reads storage
  await settle(w, 350);

  const chip = host.shadowRoot.querySelector('[data-pack]');
  check('saved pack appears in the tray', !!chip, 'no chip');
  check('chip is draggable', chip?.getAttribute('draggable'), 'true');
  check('chip shows the pack title', /ECONNRESET|ingest/i.test(chip?.textContent || ''), chip?.textContent.slice(0, 60));

  // simulate the drop: dragstart on the chip, then drop on the document
  const dt = new w.DataTransfer();
  dt.setData('text/plain', pack.id);
  dt.setData('application/x-promptbridge-pack', pack.id);
  const ev = (type) => { const e = new w.Event(type, { bubbles: true, cancelable: true }); e.dataTransfer = dt; return e; };
  chip.dispatchEvent(ev('dragstart'));
  await settle(w, 80);
  check('dragging sets the page cursor class', d.documentElement.classList.contains('pb-dragging'));
  d.dispatchEvent(ev('dragover'));
  await settle(w, 60);
  check('composer is highlighted as a drop target', d.querySelector('.m1').classList.contains('pb-drop-target'));
  d.dispatchEvent(ev('drop'));
  await settle(w, 400);

  const dropped = d.querySelector('.m1').value;
  check('drop injected the pack into the composer', dropped.length > 80, String(dropped.length));
  check('injected text carries the captured context', /ECONNRESET|backoff|socketTimeout/.test(dropped), dropped.slice(0, 80));
  check('drop cleared the dragging state', !d.documentElement.classList.contains('pb-dragging'));
  check('drop target highlight removed', !d.querySelector('.m1').classList.contains('pb-drop-target'));

  // --- the health panel must explain WHAT it detected, not just "ok"
  const health = w.__promptbridge.api.diagnose();
  check('diagnose reports the composer', health.composer, true);
  check('diagnose says where the composer came from', health.explain?.composer?.from, 'sensed');
  check('diagnose lists the roles it assigned', /user/.test(JSON.stringify(health.explain?.sample || [])), true);
  const panel = d.getElementById('promptbridge-root').shadowRoot.getElementById('drawer').textContent;
  check('health panel shows the detection method', /composer found by/i.test(panel), panel.slice(0, 90));
  check('health panel says "none - fully sensed"', /fully sensed/i.test(panel));
}

/* ---------------- a page that is not a chat costs nothing ---------------- */
console.log('\n── non-chat page stays invisible ─────────────────────');
{
  const { w, errors } = await open('demo/mock-empty.html');
  await settle(w, 300);
  for (const f of ['env.js', 'lib.js', 'sense.js', 'adapters.js', 'observe.js', 'lens.js', 'promptsmith.js', 'pack.js', 'dictate.js', 'shell.js', 'inject.js'])
    w.eval(readFileSync(resolve('extension/' + f), 'utf8'));
  w.eval(readFileSync(resolve('extension/content.js'), 'utf8'));
  await settle(w, 300);
  check('no errors on a non-chat page', errors.length === 0, errors.join(' | '));
  check('no in-page bar mounted', !w.document.getElementById('promptbridge-inject'));
  check('no shadow host added to the page', !w.document.querySelector('#promptbridge-root'));
}

/* ---------------- the adapter layer, against a mock host page ---------------- */
console.log('\n── adapters.js against demo/mock-chat.html ────────────────');
{
  const { w, errors } = await open('demo/mock-chat.html?site=chatgpt');
  await settle(w, 300);
  // load the real adapter file straight into the page, the way a content script would
  w.eval(readFileSync(resolve('extension/sense.js'), 'utf8'));
  w.eval(readFileSync(resolve('extension/adapters.js'), 'utf8'));
  await settle(w, 120);

  const { HINTS, resolveAdapter, patchComposer, submitComposer } = w.PB.adapters;
  const ADAPTERS = HINTS;
  check('no page errors', errors.length === 0, errors.join(' | '));
  check('PB.adapters exposed', Array.isArray(ADAPTERS) && ADAPTERS.length === 8);
  check('PB.sense exposed', typeof w.PB.sense?.probe === 'function');

  const adapter = resolveAdapter('chatgpt.com');
  check('chatgpt adapter selected by host', adapter.id === 'chatgpt', adapter.id);
  check('claude selected by host', resolveAdapter('claude.ai').id === 'claude');
  check('gemini selected by host', resolveAdapter('gemini.google.com').id === 'gemini');
  check('unknown host is fully sensed', resolveAdapter('example.com').id === 'sensed');

  const turns = adapter.turns();
  check('turns parsed from the mock thread', turns.length >= 4, 'got ' + turns.length);
  check('roles alternate correctly', turns[0].role === 'user' && turns[1].role === 'assistant');
  check('turn text is non-empty', turns.every((t) => t.text.length > 10));
  check('code fences survive parsing', /backoff|delay/.test(turns.map((t) => t.text).join(' ')));

  const before = adapter.turns();
  const after = adapter.turns();
  check('turns() is cached (same reference)', before === after);

  check('composer found', !!adapter.composer());
  const io = patchComposer(adapter);
  check('composer read/write works', typeof io?.get === 'function');
  io.set('write test');
  check('composer write landed', io.get() === 'write test', io.get());
  check('readComposer sees the write', w.document.querySelector('#prompt-textarea').value === 'write test');

  const health = adapter.diagnose();
  check('diagnose reports healthy', health.ok === true && health.turns >= 4, JSON.stringify(health));
  check('turn elements resolve', adapter.turnElements().length >= 4, String(adapter.turnElements().length));
  check('turn elements are real nodes', adapter.turnElements().every((e) => e && e.nodeType === 1));
}

/* ---------------- every emulated site shape ---------------- */
console.log('\n── mock-chat.html across all site shapes ───────────────');
for (const site of ['chatgpt', 'claude', 'gemini', 'perplexity', 'copilot']) {
  const { w, errors } = await open('demo/mock-chat.html?site=' + site);
  await settle(w, 250);
  w.eval(readFileSync(resolve('extension/sense.js'), 'utf8'));
  w.eval(readFileSync(resolve('extension/adapters.js'), 'utf8'));
  await settle(w, 100);
  const host = { chatgpt: 'chatgpt.com', claude: 'claude.ai', gemini: 'gemini.google.com',
                 perplexity: 'www.perplexity.ai', copilot: 'copilot.microsoft.com' }[site];
  const a = w.PB.adapters.resolveAdapter(host);
  const turns = a.turns();
  const roles = turns.map((t) => t.role[0]).join('');
  check(site.padEnd(11) + ' → ' + a.id, a.id === site);
  check(site.padEnd(11) + ' parsed 4 turns', turns.length === 4, 'got ' + turns.length);
  check(site.padEnd(11) + ' roles read u,a,u,a', /^(ua){2}$/.test(roles), roles);
  check(site.padEnd(11) + ' composer found', !!a.composer());
}

console.log('\n' + '─'.repeat(58));
console.log(fail ? `  ${pass} passed, ${fail} FAILED` : `  all ${pass} checks passed`);
console.log('─'.repeat(58) + '\n');
process.exit(fail ? 1 : 0);
