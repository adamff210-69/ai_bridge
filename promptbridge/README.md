# PromptBridge

**Your work should follow you, not your tab.**

A browser extension for **Chrome, Edge and Brave** that makes *any* AI chat site one continuous
workspace. It sits *on top of* the sites you already use — it is not another chatbot.

**No npm. No build step. No bundler. Plain HTML, CSS and JavaScript.**
Load the `extension/` folder and it works.

---

## Install

1. Open `chrome://extensions` (Edge: `edge://extensions`, Brave: `brave://extensions`)
2. Turn on **Developer mode** (top right)
3. Click **Load unpacked**
4. Select the **`extension`** folder

That's it. Open any AI chat, press <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>K</kbd>.

To publish: zip the `extension` folder's *contents* and upload it at the
[Chrome Web Store](https://chrome.google.com/webstore/devconsole).

---

## It detects the site. It does not know it.

This is the part that is different, so it is worth being precise about it.

Almost every extension in this category ships a list. `claude.ai` uses this selector, ChatGPT uses
that one, and when a vendor ships a redesign the extension is broken until somebody patches it. The
list is also why they only work on the sites somebody remembered to add.

PromptBridge works the other way round. `extension/sense.js` reads the page you are actually on and
works out, from structure:

| | how it decides |
|---|---|
| **where the composer is** | scores every `textarea` and `contenteditable` on the page — labelled like a prompt, docked near the bottom, wide, beside a send button, running ProseMirror / Quill / Lexical — and takes the winner. A decoy search box loses on position, not on a hardcoded exclusion. |
| **where the transcript is** | the container whose children are repeating siblings carrying real text, preferring the tightest such container so the same turn is never counted twice |
| **which blocks are turns** | leaf elements, with wrappers peeled away (a node whose text a descendant also has is a wrapper, not a message) |
| **who said each one** | speaker labels first, then explicit hooks, then a two-state Viterbi pass that assigns the whole thread at once while preferring alternation |

A site is never a *requirement*, only a *hint*. ChatGPT, Claude, Gemini, Perplexity, Copilot, DeepSeek,
Kimi and Mistral each ship a hint, because a verified selector is cheaper than re-deriving one — and
the hint is checked against the live DOM before it is used. When it no longer matches, it is discarded
and the structural read takes over. **That is why a vendor redesign degrades quality for a day instead
of breaking capture.**

You can check the claim yourself. Open `demo/mock-unknown.html`: a host the extension has never heard
of, with obfuscated class names and a decoy search box. PromptBridge captures it, finds the right
composer, and assigns the right roles.

Press <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>K</kbd> → **Check adapter health** and it will tell you
exactly what it found, where it found it, how long it took, and which roles it assigned.

---

## Cook this prompt · drop a pack

Two things you do constantly, and both belong next to the box you are typing in rather than behind a
palette. A small bar appears on any page PromptBridge detects a chat composer on:

- **Cook this prompt** — one click, deterministic, offline, free. It scores your prompt out of 100
  across 7 weighted slots and repairs what is missing. Never sends your prompt anywhere. Also on the
  right-click menu, next to any text field.
- **Packs** — opens a tray of your saved Context Packs. **Drag one straight into any chat box** and it
  lands, rendered for that site's dialect, with the composer highlighted as you drag. No dialog, no
  copy-paste. (Capsule Hub's drag-to-inject is the right interaction; this is the version of it that
  needs no account.)

Everything else — capture, send-to, fan-out, compare — is one <kbd>Ctrl</kbd><kbd>Shift</kbd><kbd>K</kbd>
away.

## The idea

The prompt enhancer, the dictation and the sidebar are all already owned by someone else. The thing
nobody owns is **continuity**: your work has to survive leaving the tab it happened in.

So the **Context Pack** is the spine. Every feature either produces one or consumes one.

```
  ChatGPT ─┐                                ┌─→ ChatGPT    markdown-bold scaffold
  Claude  ─┤  extract                        ├─→ Claude      balanced <context> XML
  Gemini  ─┼─────────→  CONTEXT PACK  ──────→┼─→ Gemini      prose + explicit "Format:"
  Perplex ─┤  distil (offline, ≤600 tok)    ├─→ Perplexity  research framing + citations
  Copilot ─┘                                 └─→ Copilot     terse
                     ▲
       promptsmith ───┴─── dictate ── focus shell ── fan-out + compare
```

Distil a thread into a short structured brief, then re-shape it into the *destination's* idiom —
not pasted as a wall of text, and not a transcript nobody can read.

## What's in it

| | |
|---|---|
| **Context Pack** | extract → distil → redact → re-shape · 3 fidelity levels · versioned schema · JSON export/import |
| **Promptsmith** | 7 weighted slots scored out of 100, deterministic repair, 7 playbooks, Style DNA, optional LLM tier via *your* key |
| **Voice** | self-correction · Flow mode · vocabulary that learns itself · command mode · browser speech + local-Whisper tier · TTS playback |
| **Focus shell** | <kbd>Ctrl</kbd><kbd>Shift</kbd><kbd>K</kbd> palette · 7 panels · in-place output lens · reading mode · auto-continue · adapter health |
| **Fan-out & compare** | one prompt → 5 models in parallel · answers collected in the background · side-by-side board · "use as pack" |

### Dictation

Most voice tools turn speech into text and make you fix the text. This one handles the four things
you actually do while talking.

**Self-correction.** Say the correction instead of editing the sentence.

> "we should budget **50K** for tools, actually **75K**"
> → "we should budget 75K for tools"

The engine finds the last *slot* — a number, money, a time with its unit, a weekday, a count word, or
a proper noun — and swaps it **in place**, so the clause around it survives. Failing a slot, it rolls
back to the last clause boundary; failing that, to the last thing you said before you paused. "wait",
"actually", "no wait", "i mean", "hold on", "scratch that" and friends are the triggers. A bare "no"
only counts as a retraction when what follows contains a slot, so "the no-code path" is never eaten.

**Flow mode.** Double-tap <kbd>Alt</kbd><kbd>Shift</kbd><kbd>V</kbd> and the mic locks on — release
the key and keep talking. Then just *say* what you want:

| say | what happens |
|---|---|
| "send it" / "press enter" | submits |
| "bullet list" · "make it a table" · "as json" · "the code only" | re-shapes your prompt in place, no tokens spent |
| "more formal" · "translate to Spanish" | appends the instruction to your prompt |
| "scratch that" · "new paragraph" · "read that back" | undo · newline · TTS |
| "send to Claude" · "capture this pack" · "draft the follow up" | transfer · distil · continue |
| "stop listening" | ends the session |

**Vocabulary that learns itself.** Fix a word the dictation got wrong and it is remembered — on this
device, in `chrome.storage.local`, capped at 300 terms. After that, `promtbridge` comes back as
`PromptBridge`. Click a term in the panel to forget it.

**Nothing is sent anywhere.** The browser tier already uses the vendor's own recogniser; the Whisper
tier points at a server *you* run. What PromptBridge adds — correction, vocabulary, command routing —
is entirely local.

## Speed, deliberately

The difference between an extension people keep and one they disable is what it does when you
*don't* touch it.

- **No polling.** One passive `input` listener on the composer, plus a 2-second `querySelector`
  identity probe to notice the framework swapping the element. The naive version polls every 900ms
  and forces a layout each tick.
- **The shell's DOM is built on first open.** At page load the whole cost is a single button in a
  shadow root. Most sessions never instantiate the palette.
- **Analysis is idle-time**, with a guard so it only re-renders when the score actually changes.
- **`turns()` is cached** behind a cheap signature, because it's called constantly while you type.
- **No dependencies at all.** 245kb of hand-written files, unminified, with the comments left in.

## Privacy & permissions

- **No PromptBridge server exists.** Packs live in `chrome.storage.local`.
- **Style DNA stores counters, not text** — how long your prompts run, whether you specify a format.
- **Redaction** scrubs emails, phones, cards, AWS/bearer keys and long numeric IDs before every
  transfer, and records what it scrubbed.
- **Tier 2 is BYO-key** and goes from your browser straight to your provider. Off by default.
- **Whisper is not bundled.** A 245kb extension that becomes 45MB is a different product. You run it.
- **`autoSubmit` is off by default.** A prompt you didn't write should never press send for you.

Declared permissions: `storage`, `activeTab`, `tabs`, `contextMenus`, plus host access to `<all_urls>`.

**On `<all_urls>`** — this is the honest cost of the novelty. Structural adaptation means PromptBridge
has to be *present* to read an arbitrary page, because it cannot know in advance which site is
structurally a chat. An extension that only runs on eight known hosts cannot adapt to the ninth.

What that permission is actually worth, so it can be judged rather than assumed:

- The content script runs everywhere, but **injects nothing** until the page is confirmed to have a
  chat composer. Non-chat pages get no DOM, no styles, and no listeners.
- `sense.js` **returns before it does any real work** on a page with no composer — the expensive
  transcript scan never runs, so a news article costs a composer scan and an early exit.
- Nothing is ever transmitted. There is no server. The read is local and in-memory.
- Analysis is ~1-4ms on a chat page, and results are cached per host so re-insertion is near-free.

If you would rather not grant blanket host access, the alternative is a hardcoded site list — which is
exactly what the product is built to be independent of. This is the trade, and it is deliberate.

---

## Files

```
extension/            ← LOAD THIS FOLDER UNPACKED
  manifest.json
  sw.js               service worker (classic — uses importScripts)
  env.js              chrome.* wrapper; falls back to memory when not in an extension
  lib.js              schema + migration, dialects, redaction, distillation, storage
  sense.js            ← THE NOVELTY. structural page detection. no site list.
  adapters.js         8 optional site *hints* — validated against the live DOM, then discarded
                      if they no longer match. Never the primary mechanism.
  inject.js           the in-page bar: Cook · Capture · Packs tray · native drag-and-drop
  observe.js          input listeners, MutationObserver, answer watcher
  lens.js             output lens, reading mode, auto-continue
  promptsmith.js      analyzer, repair, playbooks, tier 2
  pack.js             distil → Context Pack
  dictate.js          self-correction · Flow · vocabulary · commands · speech + local Whisper
  shell.js / .css     Focus Shell (shadow DOM, launcher lazy, panels built on first open)
  content.js          wiring — loaded last
  page.css            drop-target + drag-cursor feedback on the host page
  localbus.js         preview-only message handler
  popup / library / onboarding  (.html + .js)
  icons/

demo/                 open these directly, no server
  shell-preview.html  the real shell over a mock page
  mock-chat.html      adapter test bench
  mock-claude-2026.html   current Claude markup shape
  mock-unknown.html       a site the extension has never heard of
  mock-asymmetric.html    uneven turn counts — the case that breaks naive parsing
  preview.js

_dev/                 optional; ignore it
  test-plain.mjs      116 checks in jsdom, loading the real files from disk
  test-sense.mjs      46 checks on the detection engine — no jsdom needed
  test-dictate.mjs    98 checks on the dictation engine — no jsdom needed
```

### How the files connect

There is no module graph. Every file is an IIFE that hangs its exports off one global:

```js
(function (PB) {
  'use strict';
  const { DESTINATIONS, escapeHtml } = PB.SHARED;   // ← from lib.js
  function doThing() { /* ... */ }
  PB.mine = { doThing };
})(globalThis.PB = globalThis.PB || {});
```

- **Content scripts** — the `js` array in `manifest.json` loads them in order, sharing the isolated
  world, exactly like `<script>` tags. Order matters: `env` → `lib` → `adapters` → `observe` →
  `lens` → `promptsmith` → `pack` → `dictate` → `shell` → `content`.
- **Extension pages** — plain `<script src="lib.js">` tags at the bottom of the HTML.
- **Service worker** — `importScripts('env.js', 'lib.js')` on line 1.

Renaming a file means editing three places. That is the trade for having no build step.

## Testing (optional, and you can skip it)

Nothing here is needed to use the extension. If you want to run the suites, all three need one
package (the detection engine is tested against real DOM, not mocks):

```bash
npm i jsdom
node _dev/test-sense.mjs      #  46 checks — detection engine
node _dev/test-dictate.mjs    #  98 checks — dictation engine
node _dev/test-plain.mjs      # 116 checks — full stack, loads the real files from disk
```

**260 checks.** The integration suite boots the actual `sense.js` + `adapters.js` + `shell.js` +
`inject.js` stack against the mock hosts and drives the real DOM: it clicks Cook and checks the
composer text changed, drags a pack chip and checks the drop landed, asserts a non-chat page stays
invisible, and reads the health panel back out of the shadow root.

The suites earned their keep. Bugs they caught that would otherwise have shipped: a genuine
temporal-dead-zone crash in `content.js`, the shell's stylesheet `<link>` being wiped by the
`innerHTML` that followed it, `render()` never being defined in the library page, a stale packs array
that made the tray ignore newly saved packs, and a full-lazy shell that quietly hid the launcher
button on exactly the pages it was meant to appear on.

The detection suite includes `demo/mock-claude-2026.html`, built from the *live* 2026 Claude markup
including the selectors that are now dead. That distinction is deliberate: a fixture that keeps the
hook it is meant to disprove will keep passing while the real page returns zero turns. The fixtures
are built to make the old code fail.

## Known weak points

1. **Structural detection is a heuristic, and always will be.** It reads a page and infers intent from
   shape. A chat UI that is *genuinely* ambiguous — a page with two composers, a transcript that is
   virtualised and only mounts visible turns — will degrade quality rather than break. That is the
   correct failure direction: capture gets slightly worse instead of disappearing.
2. **Scrollback is not virtualisation-aware.** A transcript that lazily mounts old turns captures
   what is in the DOM, which on long threads is the recent window. Capture more to widen it.
3. **Answer collection waits for you to press send** when `autoSubmit` is off — a run can sit
   `pending` if you hand-edit a prompt instead of submitting it.
4. **`full` fidelity can exceed 2k tokens** on a long thread. It's opt-in, but the UI should warn.
5. **Firefox and Safari aren't packaged.** Everything except `sw.js` is already browser-agnostic —
   `sw.js` is a classic worker because it uses `importScripts`; converting it is a small, well-marked
   job. This pass is Chrome/Brave/Edge only, as scoped.
6. **Tier 2 prompts are sent to a third party** when you supply a key. That is the point of the tier,
   but it is worth saying plainly: Tier 1 never sends anything.
7. **Self-correction always replaces the *last* slot.** "Add three seats for Design and two for QA"
   corrected with "no two for both" replaces the two, not the three. That is the only rule that stays
   predictable without parsing the sentence, and a multi-number correction needs the cursor or an edit.
8. **"Refine" cannot rewrite or translate locally.** Shipping a model is the thing this extension
   exists to avoid, so "more formal" and "translate to Spanish" append a directive to your prompt and
   let the model you are already talking to do it. The lens commands *are* real local transforms.
