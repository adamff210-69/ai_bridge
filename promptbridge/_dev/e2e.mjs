/**
 * PromptBridge — real-browser E2E.
 *
 * Loads the ACTUAL unpacked extension into real Chrome (puppeteer), serves the
 * repo over http, and drives the shipped UI the way a user would: keyboard,
 * clicks, drags. Run:
 *
 *   node _dev/e2e.mjs
 *
 * Exits non-zero if any check fails.
 */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, extname } from 'node:path';
import puppeteer from 'puppeteer';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const EXT = join(ROOT, 'extension');
const PORT = 8899;
const BASE = `http://127.0.0.1:${PORT}`;

/* ---------------- tiny static server ---------------- */
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.json': 'application/json' };
const server = createServer(async (req, res) => {
  const path = req.url.split('?')[0].split('#')[0];
  const rel = path === '/' ? '/demo/shell-preview.html' : path;
  try {
    const data = await readFile(join(ROOT, rel));
    res.writeHead(200, { 'content-type': MIME[extname(rel)] || 'application/octet-stream' });
    res.end(data);
  } catch {
    res.writeHead(404); res.end('nope');
  }
});
await new Promise((r) => server.listen(PORT, '127.0.0.1', r));

/* ---------------- launch chrome with the extension ---------------- */
const browser = await puppeteer.launch({
  headless: 'new',
  args: [
    `--disable-extensions-except=${EXT}`,
    `--load-extension=${EXT}`,
    '--no-first-run', '--no-default-browser-check',
    '--window-size=1280,900',
  ],
});

let pass = 0, fail = 0;
const fails = [];
const check = (n, ok, x = '') => {
  if (ok) { pass++; console.log('  ✓', n); }
  else { fail++; fails.push(n + (x ? ` — ${x}` : '')); console.log('  ✗', n, x); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function newPage({ url, collectErrors = true } = {}) {
  const page = await browser.newPage();
  const errors = [];
  if (collectErrors) {
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
    page.on('pageerror', (e) => errors.push(String(e)));
  }
  if (url) await page.goto(url, { waitUntil: 'load' });
  await sleep(900); // content scripts run at document_idle; let them boot
  return { page, errors };
}

/** Click something inside the shell's shadow root (real DOM event). */
const shellClick = (page, sel) => page.evaluate((s) => {
  const el = document.querySelector('#promptbridge-root').shadowRoot.querySelector(s);
  if (!el) throw new Error('missing: ' + s);
  el.click();
}, sel);
const shellText = (page, sel) => page.evaluate((s) => document.querySelector('#promptbridge-root')?.shadowRoot.querySelector(s)?.textContent ?? null, sel);

/** Count saved packs by opening the library page (an extension page: chrome.storage is directly readable there). */
async function packCount(browser) {
  const p = await browser.newPage();
  await p.goto(await swURL(browser, 'library.html'), { waitUntil: 'load' });
  await sleep(500);
  const n = await p.evaluate(async () => (await chrome.storage.local.get('pb.packs'))['pb.packs']?.length || 0);
  await p.close();
  return n;
}
async function swURL(browser, file) {
  const t = browser.targets().find((x) => x.type() === 'service_worker');
  return new URL(file, (await t.worker().evaluate(() => location.href))).href;
}

/* ================================================================== */
console.log('\n── A · an innocent page must be untouched ──');
{
  const { page, errors } = await newPage({ url: `${BASE}/_dev/e2e/plain-site.html` });

  const styles = await page.evaluate(() => {
    const cs = (el) => getComputedStyle(el);
    return {
      bodyBg: cs(document.body).backgroundColor,
      bodyFont: cs(document.body).fontFamily,
      mainMax: cs(document.querySelector('main')).maxWidth,
      mainPad: cs(document.querySelector('main')).padding,
      headerPos: cs(document.querySelector('header')).position,
      headerDisplay: cs(document.querySelector('header')).display,
      btnRadius: cs(document.querySelector('button.cta')).borderRadius,
      btnFont: cs(document.querySelector('button.cta')).fontFamily,
      colorScheme: cs(document.documentElement).colorScheme,
      pbDom: !!document.querySelector('#promptbridge-root, #promptbridge-inject'),
    };
  });
  check('A1 innocent page keeps its own background', styles.bodyBg === 'rgb(255, 255, 255)', styles.bodyBg);
  check('A2 innocent page keeps its own font', /georgia/i.test(styles.bodyFont), styles.bodyFont);
  check('A3 innocent <main> is not squeezed into a 1120px column', styles.mainMax === 'none', styles.mainMax);
  check('A4 innocent <main> keeps its own padding', styles.mainPad === '0px', styles.mainPad);
  check('A5 innocent <header> is not re-laid-out (position)', styles.headerPos === 'static', styles.headerPos);
  check('A6 innocent <header> is not re-laid-out (display)', styles.headerDisplay === 'block', styles.headerDisplay);
  check('A7 innocent buttons keep their own radius', styles.btnRadius === '2px', styles.btnRadius);
  check('A8 innocent buttons keep their own font', /georgia/i.test(styles.btnFont), styles.btnFont);
  check('A9 no PromptBridge DOM on a non-chat page', !styles.pbDom);
  check('A10 no console errors on the innocent page', errors.length === 0, errors.join(' | ').slice(0, 300));
  await page.close();
}

/* ================================================================== */
console.log('\n── B · chat page: shell, palette, cook, capture ──');
{
  const { page, errors } = await newPage({ url: `${BASE}/demo/mock-chat.html?site=chatgpt` });

  const fabVisible = await page.evaluate(() => {
    const s = document.querySelector('#promptbridge-root')?.shadowRoot;
    const fab = s?.querySelector('.pb-fab');
    return !!fab && getComputedStyle(fab).display !== 'none';
  });
  check('B1 launcher button appears on a detected chat', fabVisible);
  const barOn = await page.evaluate(() => document.querySelector('#promptbridge-inject')?.shadowRoot.querySelector('.bar')?.classList.contains('on'));
  check('B2 in-page bar appears', !!barOn);

  await page.keyboard.down('Control'); await page.keyboard.down('Shift');
  await page.keyboard.press('KeyK');
  await page.keyboard.up('Shift'); await page.keyboard.up('Control');
  await sleep(350);
  const palOpen = await page.evaluate(() => document.querySelector('#promptbridge-root').shadowRoot.getElementById('pb').classList.contains('pal-open'));
  check('B3 Ctrl+Shift+K opens the command palette', palOpen);

  await page.keyboard.press('Escape');
  await sleep(250);
  const palClosed = await page.evaluate(() => !document.querySelector('#promptbridge-root').shadowRoot.getElementById('pb').classList.contains('pal-open'));
  check('B4 Esc closes the palette', palClosed);

  // Cook via the in-page bar
  await page.type('#prompt-textarea', 'fix my upload bug');
  await sleep(300);
  await page.evaluate(() => document.querySelector('#promptbridge-inject').shadowRoot.querySelector('[data-a=cook]').click());
  await sleep(500);
  const cooked = await page.evaluate(() => document.querySelector('#prompt-textarea').value);
  check('B5 Cook rewrites the prompt in the composer', /root cause|Format|Success/i.test(cooked), cooked.slice(0, 60));

  // Capture via the real shortcut handled in-page (Ctrl+Shift+C)
  await page.evaluate(() => (document.querySelector('#prompt-textarea').value = 'hello'));
  const before = await packCount(browser);
  await page.keyboard.down('Control'); await page.keyboard.down('Shift');
  await page.keyboard.press('KeyC');
  await page.keyboard.up('Shift'); await page.keyboard.up('Control');
  await sleep(900);
  const after = await packCount(browser);
  check('B6 capture shortcut stores a pack', after === before + 1, `before=${before} after=${after}`);

  // toast confirms
  const toastText = await shellText(page, '.pb-toast');
  check('B7 capture confirms itself with a toast', !!toastText && /captured/i.test(toastText), toastText || 'no toast');

  check('B8 no console errors on the chat page', errors.length === 0, errors.join(' | ').slice(0, 300));

  /* ---- reading mode: the reported "extension collapses the AI page" ---- */
  console.log('  ┈ reading mode on this chat…');
  const rm = await page.evaluate(() => {
    const s = document.querySelector('#promptbridge-root').shadowRoot;
    // open palette and click the Reading mode command, like a user would
    s.getElementById('fab').click();           // opens overview drawer
    const items = [...s.querySelectorAll('#pallist .pb-item')];
    return items.length;
  });
  // use the drawer's quick action instead: open overview → Reading mode button
  await page.keyboard.down('Control'); await page.keyboard.down('Shift');
  await page.keyboard.press('KeyK');
  await page.keyboard.up('Shift'); await page.keyboard.up('Control');
  await sleep(300);
  await page.evaluate(() => {
    const s = document.querySelector('#promptbridge-root').shadowRoot;
    const item = [...s.querySelectorAll('#pallist .pb-item')].find((i) => /reading mode/i.test(i.textContent));
    item.click();
  });
  await sleep(450);
  const rmState = await page.evaluate(() => {
    const app = document.querySelector('main'); // the host page's own app container
    const appOpacity = getComputedStyle(app).opacity;
    const dimmed = [...document.querySelectorAll('.pb-rm-dim')].length;
    const styleEl = document.getElementById('pb-reading-style');
    const css = styleEl ? styleEl.textContent : '';
    const starSelector = /(^|})\s*html\.pb-reading \*\s*[{,]/m.test(css); // literal * selector = everything
    return {
      appOpacity, dimmed, starSelector,
      on: document.documentElement.classList.contains('pb-reading'),
      pill: (() => { const p = document.querySelector('#promptbridge-root').shadowRoot.querySelector('.pb-reading-pill'); return p && getComputedStyle(p).display !== 'none'; })(),
    };
  });
  check('C1 reading mode does not fade the whole page', rmState.on && rmState.appOpacity === '1', `on=${rmState.on} main opacity=${rmState.appOpacity}`);
  check('C2 reading mode dims only conversation turns, via a real selector', rmState.dimmed > 0 && !rmState.starSelector, `dimmed=${rmState.dimmed} starSel=${rmState.starSelector}`);
  check('C3 a visible “reading mode is on” indicator exists', rmState.pill);

  // turn it off from the pill and verify clean teardown
  await shellClick(page, '.pb-reading-pill');
  await sleep(350);
  const rmOff = await page.evaluate(() => ({
    off: !document.documentElement.classList.contains('pb-reading'),
    dims: document.querySelectorAll('.pb-rm-dim').length,
    style: !!document.getElementById('pb-reading-style'),
  }));
  check('C4 pill click turns reading mode off, nothing left behind', rmOff.off && rmOff.dims === 0 && !rmOff.style);
  await page.close();
}

/* ================================================================== */
console.log('\n── D · the drawer must not take the page hostage ──');
{
  const { page } = await newPage({ url: `${BASE}/demo/mock-chat.html?site=chatgpt` });
  await page.keyboard.down('Control'); await page.keyboard.down('Shift');
  await page.keyboard.press('KeyS');
  await page.keyboard.up('Shift'); await page.keyboard.up('Control');
  await sleep(450);

  const drawer = await page.evaluate(() => {
    const s = document.querySelector('#promptbridge-root').shadowRoot;
    const scrim = s.querySelector('.pb-scrim');
    const scrimShown = !!scrim && getComputedStyle(scrim).display !== 'none';
    return { scrimShown, tag: s.getElementById('sitetag').textContent, dot: s.querySelector('#sitedot').style.background };
  });
  check('D1 page stays visible and clickable while the drawer is open', !drawer.scrimShown, drawer.scrimShown ? 'full-screen scrim blocks the chat' : '');
  check('D2 drawer header shows the site it detected', drawer.tag === 'ChatGPT', `tag="${drawer.tag}"`);
  check('D3 health dot is green on a healthy page', /rgb\(63, 185, 80\)|#3fb950/i.test(drawer.dot), drawer.dot);

  await page.evaluate(() => { window.__pbClick = 0; document.querySelector('main').addEventListener('click', () => window.__pbClick++); });
  await page.mouse.click(300, 300);
  const clicked = await page.evaluate(() => window.__pbClick);
  check('D4 a click on the chat lands while the drawer is open', clicked === 1, `clicks=${clicked}`);

  const dests = await page.evaluate(() => document.querySelector('#promptbridge-root').shadowRoot.querySelectorAll('[data-dest]').length);
  check('D5 send panel lists destinations', dests >= 5, `dests=${dests}`);
  await page.close();
}

/* ================================================================== */
console.log('\n── E · popup: opens often, must not spam packs ──');
{
  const { page } = await newPage({ url: `${BASE}/demo/mock-chat.html?site=claude` });
  await page.keyboard.down('Control'); await page.keyboard.down('Shift');
  await page.keyboard.press('KeyC');
  await page.keyboard.up('Shift'); await page.keyboard.up('Control');
  await sleep(800);
  const before = await packCount(browser);

  const extUrl = await swURL(browser, 'popup.html');
  const { page: pop } = await newPage({ url: extUrl });
  await sleep(700);
  const renders = await pop.evaluate(() => document.querySelector('#dests')?.children.length || 0);
  check('E1 popup renders destinations', renders >= 5, `dests=${renders}`);
  const mid = await packCount(browser);
  check('E2 opening the popup does not create a pack', mid === before, `before=${before} after=${mid}`);
  await pop.close();
  const { page: pop2 } = await newPage({ url: extUrl });
  await sleep(700);
  const after = await packCount(browser);
  check('E3 opening the popup twice still does not create packs', after === before, `before=${before} after=${after}`);
  await pop2.close();
  await page.close();
}

/* ================================================================== */
console.log('\n── F · empty pages & service worker ──');
{
  const { page } = await newPage({ url: `${BASE}/demo/mock-empty.html` });
  const quiet = await page.evaluate(() => !!document.querySelector('#promptbridge-root'));
  check('F1 no shell on a page with no chat', !quiet);
  await page.close();

  const swTarget = browser.targets().find((t) => t.type() === 'service_worker');
  check('F2 service worker is alive', !!swTarget);
}

/* ================================================================== */
console.log('\n── G · library page ──');
{
  const { page } = await newPage({ url: `${BASE}/demo/mock-empty.html` });
  const url = await page.evaluate(() => chrome.runtime.getURL('library.html'));
  await page.goto(url, { waitUntil: 'load' });
  await sleep(700);
  const lib = await page.evaluate(() => ({
    cards: document.querySelectorAll('#packs .card').length,
    bg: getComputedStyle(document.body).backgroundColor,
  }));
  check('G1 library renders packs', lib.cards >= 1, `cards=${lib.cards}`);
  check('G2 library page keeps its dark theme', lib.bg === 'rgb(13, 17, 23)', lib.bg);
  await page.close();
}

await browser.close();
server.close();

console.log('\n──────────────────────────────────────────');
console.log(`  E2E: ${pass} passed, ${fail} FAILED`);
if (fails.length) { console.log('\nFailures:'); fails.forEach((f) => console.log('  ·', f)); }
process.exit(fail ? 1 : 0);
