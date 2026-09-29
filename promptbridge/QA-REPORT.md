# PromptBridge — full QA pass, UI/UX audit & roadmap

**Scope:** the whole extension, tested three ways — as a *tester* (does it do what it claims, and
can it be broken?), as a *developer* (root causes, architecture, tests), and as a *user* (real
flows on the mock hosts, keyboard-first, "does this feel good?").

**Date:** 2026-09-29 · **Tree:** `arena/01a0eba9-ai-bridge` · **Version under test:** 0.3.0

---

## 1. Verdict in one paragraph

The engine work (structural detection, distillation, dialects, dictation) is genuinely good and its
offline-first privacy posture is real. The **presentation layer had one ship-stopping bug and
several trust-damaging ones** — and they compound: an extension that quietly rewrites the layout of
every page it touches, and a reading mode that fades the whole page with no visible way out, produce
exactly the frustration you filed: *"if we are in the AI page the extension collapses the AI page."*
Both root causes are found, fixed, and locked behind new regression tests. **305 automated checks
pass** (46 detection + 98 dictation + 116 integration + 45 new UI/UX).

---

## 2. Your reported bug: "the extension collapses the AI page"

There were **two independent root causes**, both real, both fixed.

### Root cause A (the big one): `page.css` was injected into *every* page

`manifest.json` listed `page.css` under `content_scripts.css` on `<all_urls>`. But `page.css` is the
**extension pages** stylesheet (library.html / onboarding.html `<link>` it), and it is full of bare
element selectors:

```css
:root { color-scheme: dark; --bg: #0d1117; ... }
body  { margin: 0; background: var(--bg); color: var(--fg); font: 14px/1.6 ... }
header{ position: sticky; display: flex; padding: 12px 22px; ... }
main  { max-width: 1120px; margin: 0 auto; padding: 22px; }
h1,h2 { ... } button { border-radius: 9px; ... }
```

A content-script stylesheet is author-origin CSS. On any site that doesn't explicitly set those
properties with higher specificity, **PromptBridge's rules win**. On ChatGPT/Claude/Gemini, `<main>`
*is* the app shell — so the entire AI page collapsed into a centered 1120 px column with 22 px
padding, a sticky-flex header, a forced dark `color-scheme`, restyled buttons… while the README
promised *"non-chat pages get no DOM, no styles, and no listeners."* This also silently restyled
every ordinary website on the planet.

**Fix:** a new `extension/host.css` — two rules, both scoped to PromptBridge's own classes
(`.pb-drop-target`, `html.pb-dragging`) — is the only stylesheet in the manifest. `page.css` stays
exclusively for our own pages. Verified by a fixture "innocent newspaper site": body background,
fonts, header layout, button radius all untouched with the extension loaded.

### Root cause B: reading mode generated `html.pb-reading *{opacity:.28}`

Reading mode built its CSS from `adapter.messageSel || '*'`. After the sensing-engine refactor,
**every adapter returns `messageSel: null`** (a CSS selector cannot honestly describe a list found
by walking the tree). So toggling reading mode — one click in the drawer's quick actions — dimmed
the *entire page* to 28 % opacity, desaturated it, and **persisted that state in localStorage**,
so every reload of that AI site came back "collapsed" with no on-screen hint of what happened or
how to undo it.

**Fix:** reading mode now works on the turn *elements* the engine already found — a `.pb-rm-dim`
class on everything except the newest 4 turns, hover to reveal, fully reversible. It refuses to
enable when there's no transcript. And it now always leaves a visible escape hatch: a **"📖 Reading
mode — click to exit" pill** in the shell's own shadow root (the page can't hide it), shown
immediately on load if reading mode was left on.

### Bonus fixes in the same trust category (found while reproducing yours)

| # | Severity | Bug | Root cause | Fix |
|---|----------|-----|-----------|-----|
| 1 | **P0** | Every site's layout rewritten | `page.css` in manifest `content_scripts.css` | Split into `host.css` (2 scoped rules) + `page.css` (our pages only) |
| 2 | **P0** | Whole page faded + persisted | reading mode fell back to `*` selector | Class-based dimming of engine-found turns; refuses without a transcript |
| 3 | **P1** | Popup opened → duplicate pack + "Captured" toast *every time* | popup ran a full `pb:capture` on open | New `pb:peek-pack`: builds in memory, never saves, never toasts. Explicit capture unchanged |
| 4 | **P1** | Fan-out could type the prompt **twice** on a destination (and with auto-submit, send twice) | service worker's `tabs.onUpdated` path and the 1.5 s warm-tab timer race | `injectedRuns` set in the content script — a `runId` lands once |
| 5 | **P2** | Drawer header site tag always showed "—" | `setSite()` ran before the shell surface existed | Value is kept and applied on mount |
| 6 | **P2** | `watchThread`'s MutationObserver never bound | it still queried the dead `adapter.messageSel` (always null) | Binds via `PB.adapters.messageEls()`; the interval is now only a fallback |
| 7 | **P2** | Freshly appended `<article>` turns invisible to the sensor for a while | page fingerprint only counted `<div>`s | Fingerprint counts `div,article,section,ul,ol` |
| 8 | **P2** | Onboarding's "choose your sites" toggles did nothing | nothing read `settings.sites` | `resolveAdapter(host, { disabled })` drops disabled hints (structural detection still works — the honest behaviour, now also described in the onboarding copy) |
| 9 | **P3** | Drawer footer crashed where `innerText` is undefined | `composerIO.get` assumed `innerText` | `?? textContent ?? ''` |
| 10 | **P3** | Reading-mode refresh skipped where `localStorage` throws (file://, sandboxes) | refresh guarded by the storage mirror | The live `pb-reading` class is the source of truth |
| 11 | **P3** | Copy said "45kb extension" (README says ~245 KB) | drift | Unified |

---

## 3. Test coverage — as run in this pass

```
node _dev/test-sense.mjs     46 checks  detection engine          PASS
node _dev/test-dictate.mjs   98 checks  dictation engine          PASS
node _dev/test-plain.mjs    116 checks  full stack in jsdom       PASS  (1 pre-existing failure fixed)
node _dev/test-ui.mjs        45 checks  NEW: UI/UX regressions    PASS
                            ─────────
                            305 checks
```

`npm test` runs all four. New `_dev/test-ui.mjs` exists to make sure this class of bug can never
ship silently again: it loads the *real* files into a DOM and asserts host-page safety (manifest
contents, selector audit of `host.css`, computed styles on an innocent fixture), reading-mode
behaviour (turns dimmed, page untouched, pill visible, clean teardown, growth re-dimming, refusal
with no transcript), drawer side-panel semantics (no scrim over the chat, page still receives
clicks, site tag populated, Esc closes), popup peek (no pack created, capture still works and still
announces itself), fan-out dedupe (same `runId` ignored, new one lands).

**Also new:** `_dev/e2e.mjs` + `_dev/e2e/plain-site.html` — a puppeteer harness that loads the
actual unpacked extension into real Chrome and drives it with keyboard/mouse (FAB, palette,
Cook, capture shortcut, reading mode, drawer, popup, library, service-worker liveness). It needs a
local Chrome (`npm i -D puppeteer && npx puppeteer browsers install chrome`); this sandbox blocks
all browser CDNs, so it is delivered unrun here but ready on your machine: `npm run test:e2e`.

**Tested by hand (as a user) against the mock hosts:** ChatGPT/Claude/Gemini/Perplexity/Copilot
shapes, the unknown-host page (obfuscated classes + decoy search box — composer found correctly),
the asymmetric thread, the empty page (nothing mounts — correct), the Claude-2026 dead-selector
fixture (hint discarded, structure wins — correct).

### Developer-lens notes (small, worth knowing)

- `_dev/test-plain.mjs` had a pre-existing failure: eval'ing `shell.js` leaves `currentScript`
  null, so its CSS URL resolved into `demo/` and the "no page errors" check failed. The harness now
  provides a fake `currentScript` — which is exactly what a real `<script src>` provides.
- jsdom 30 doesn't implement `innerText` and doesn't resolve `var()` in computed styles — the new
  suite asserts around both, and bug #9 above is the real-world lesson from the first.
- `ai_bridge.zip` in the repo root is a stale snapshot of the extension and will drift; it should
  be built at release time, not committed.

---

## 4. UI/UX audit (the focus)

### What already works well

- **The shell is cheap and quiet.** One button at boot, palette on first open, analysis on idle
  callbacks, toasts instead of dialogs, `prefers-reduced-motion` respected.
- **The palette is a real command palette** — grouped, searchable, arrow keys, one Tab stop.
- **The in-page bar is the right interaction** for the two things you do most (Cook, drop a pack),
  and drag-to-inject with composer highlight is the feature people will show their friends.
- **The health panel is a masterstroke of trust UX** — "here is what I found, where, how fast, and
  by what mechanism" is how you make a heuristic engine feel accountable.

### Fixed in this pass

1. **The drawer no longer takes the page hostage.** The full-screen scrim (dim + blur + click
   block) used to cover the chat whenever the drawer opened — for a *side panel* whose entire
   purpose is continuity, you constantly want to scroll/copy from the thread while choosing a
   destination. The scrim is now palette-only; the drawer behaves like a side panel (✕ / Esc / FAB
   to close). *(The single biggest "stop frustrating me" win after the collapse bug.)*
2. **Reading mode has a visible on/off pill** — a page-wide visual effect must never exist without
   a visible, one-click way out.
3. **Light scheme.** The shell, inject bar, lens panel, popup and extension pages were dark-only —
   a dark island on a light page. All now follow `prefers-color-scheme` with a tuned light palette.
4. **Focus management.** Opening the drawer moves focus into it (Esc works instantly, keyboard
   users aren't stranded behind an invisible boundary) and focus is restored on close. The palette
   traps Tab explicitly.
5. **Popup honesty.** "Capture" (which actually opened the send panel) is now "Review & send…" —
   and opening the popup no longer writes anything.
6. **Popup hint text** now says where capture really lives (the shortcut / in-page bar).

### Recommended next — ranked by expected frustration removed per hour of work

**A. Onboarding & first run**
1. **First-run "aha" on a real chat.** After install, land the user on `mock-chat`-style guided
   tour (or auto-open the palette once) — most features are invisible until you know the shortcut.
2. **Permission pre-flight screen**: explain `<all_urls>` *before* Chrome's scary prompt, not in a
   README.

**B. Day-to-day friction**
3. **Toast actions.** Every toast that results in an artifact should carry its own next step
   ("Captured · 4 msgs — **Send to…** / **Open library**"). Today they dead-end.
4. **Fan-out progress surface.** After "Fanned out to 5 models" you're sent to the compare board to
   watch spinners. Add per-destination progress chips (pending → streaming → done) with a timer.
5. **`full` fidelity token warning** (acknowledged weak point #4): show "~2.4k tokens — distilled
   is 18×" inline when picking `full`, with one-click switch.
6. **Composer highlight on drop** exists, but a **drop-zone ghost** ("release to insert *Debug
   ingest service*") would remove the last doubt from the drag.
7. **Duplicate-pack awareness** in the tray/library: same source URL + similar title → "update
   existing?" instead of a growing pile of near-identical cards.

**C. Control & comfort**
8. **Draggable / positionable FAB** (persist corner), because it *will* overlap someone's chat
   widget; plus a per-site "hide the launcher" setting.
9. **Shortcut conflict surfacing.** `Ctrl+Shift+C` collides with DevTools inspect and muscle memory
   on some sites; detect first collision, offer an alternate from the popup.
10. **Per-site settings profile** (fidelity, playbook, dictation language) instead of global-only.
11. **Escape hatch polish:** "Pause PromptBridge on this site" in the FAB context menu (the
    onboarding toggles exist, but the escape must be reachable *from the page*).

**D. Bigger bets (roadmap)**
12. **Cross-device packs** — opt-in sync via a file in the user's own drive/WebDAV, keeping the
    "no PromptBridge server" promise.
13. **Pack versioning UI** — a thread evolves; show pack history diff (decisions added/removed)
    instead of one mutable snapshot.
14. **Answer diffing on the compare board** — sentence-level side-by-side highlight of where two
    models disagree; that's the moment fan-out earns its keep.
15. **Virtualisation-aware capture** (weak point #2): scroll-and-stitch during capture when the
    transcript mounts lazily.
16. **Firefox packaging** (weak point #5) — everything but `sw.js` is already portable.

### Accessibility quick list (cheap, do with the next UI pass)

- Announce toasts via `role="status"` in addition to the `aria-live` container (already present).
- `aria-expanded` on the FAB reflecting drawer/palette state; `aria-controls`.
- The reading pill already has `title`; give it an `aria-label` without emoji.
- Verify contrast of `.pb .tag` text (10 px, `--dim` on `--bg2`) in light scheme — the smallest
  text on the least contrast; bump to 11 px while there.

---

## 5. Performance spot-checks (as a user, not a benchmark farm)

- Idle on a non-chat page: one composer scan + early exit — confirmed by `mock-empty` mounting
  nothing. With `host.css` there is now genuinely **zero** visual/CSS footprint everywhere.
- Chat page idle: composer `input` listener + 2 s identity probe + 1.5 s thread signature probe.
  `watchThread` now actually observing (fix #6) makes streaming detection event-driven instead of
  interval-only — slightly *less* work per answer than before the fix.
- The heaviest remaining repeated cost is `pageFingerprint()`'s `querySelectorAll` on every
  `turns()` revalidation; acceptable at current call sites, worth a revisit if fan-out tabs feel
  warm (see roadmap #14/#15 era).

---

## 6. Files touched in this pass

```
extension/host.css        NEW  the only stylesheet host pages ever see (2 scoped rules)
extension/manifest.json        css: ["host.css"]; page.css out of web_accessible_resources
extension/page.css             extension-pages only; light scheme; host rules removed
extension/lens.js              reading mode rewritten (element classes, refusal, refresh, light)
extension/shell.js             reading pill, focus mgmt, pending site tag, Tab trap
extension/shell.css            palette-only scrim, pill styles, light scheme
extension/inject.js            light scheme via CSS variables
extension/content.js           peek-pack, capture(save), dup-runId guard, disabled-site hints,
                               reading pill state, thread-growth re-dim, let-adapter
extension/adapters.js          resolveAdapter(host, {disabled}); composerIO innerText guard
extension/observe.js           watchThread binds via the sensing engine
extension/sense.js             pageFingerprint counts article/section/ul/ol
extension/popup.html/js        peek not capture; honest button; light scheme
extension/onboarding.html/js   honest site-toggle copy; copy fix
_dev/test-ui.mjs          NEW  45 UI/UX regression checks
_dev/e2e.mjs              NEW  real-Chrome puppeteer harness (needs local Chrome)
_dev/e2e/plain-site.html  NEW  innocent-bystander fixture
_dev/test-plain.mjs            currentScript fix for the eval-based block
README.md                      host.css in tree, honest <all_urls> claim, 305 checks
```

Nothing here changes the no-build promise: load `extension/` unpacked and it works.
