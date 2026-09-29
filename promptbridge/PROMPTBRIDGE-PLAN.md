# PromptBridge — Enhanced Plan

**Tagline:** *Your work should follow you, not your tab.*

Extension that turns every AI website into one continuous workspace.

---

## 0. The reframe (the single biggest upgrade to your idea)

Your brief was five features: context transfer, workload reduction, UI/UX, voice typing, prompt enhancer.
Shipped as five separate tools, that's a mediocre sidebar nobody keeps past week two — and every competitor
already owns a piece of it.

**The enhancement: one spine, five engines, one artifact.**

- The **Context Pack** is the spine — a portable, structured, versioned representation of a unit of work
  that moves between any AI surface *and arrives re-shaped for that surface's architecture*.
- Voice, Promptsmith, Focus Shell, and Fan-out are **producers and consumers** of Context Packs.
- The moat isn't the prompt enhancer (trivially copied) or dictation (your OS does that). The moat is
  **portability with fidelity**. Everything else feeds it.

```
                    ┌────── voice (speech → structured intent) ──────┐
                    │                                                 │
                    ▼                                                 │
  ┌────────────┐  extract   ┌──────────────────┐  re-shape   ┌──────────────┐
  │ ChatGPT    │───────────▶│                  │─────────────▶│ Claude       │
  │ Claude     │            │  C O N T E X T   │  (adapter    │ Gemini       │
  │ Gemini     │◀───────────│      P A C K     │   profile)   │ Perplexity   │
  │ Perplexity │   inject   │   (the spine)    │              │ Copilot …    │
  └────────────┘            └────────▲─────────┘              └──────────────┘
                                 │    │
                     promptsmith ┘    └── fan-out / compare / history
                     focus shell (UI/UX, keyboard-first)
```

**North-star metric: weekly Context Pack transfers.** If that number isn't growing, portability is a gimmick
and the product has no thesis.

---

## 1. Competitive landscape — what exists, what's open

| Product | What it does | Gap we attack |
|---|---|---|
| AIPRM, MagicPrompt | Prompt libraries | Static prompts, no conversation state |
| WebChatGPT, Superpower ChatGPT | UI add-ons (export, history) | Single-site, export-to-file not export-to-other-site |
| Sider, Monica, Merlin | Sidebar assistants | They *are* another assistant, not a layer *over* yours; expensive |
| ChatHub, Poe | Multi-model fan-out | Separate product, no shared context, no fidelity |
| Voicy, Willow, Aqua Voice | Dictation | Speech→text only; no intent→prompt |
| TypingMind, LM Studio | Own-chat UIs | Requires leaving the site you're working in |

**Open space:** nobody owns *continuity across vendor UIs while you stay in them*.
Everyone either replaces the UI or copies the chat out.

---

## 2. The five engines

### Engine 1 — Context Pack (the spine)

A **Context Pack** is a structured, portable unit of work. Not a transcript dump.

**Extraction** — per-site DOM adapters read the live thread (user/assistant turns, code blocks,
attachments, sources, timestamps). Fallback ladder: adapter → generic message heuristic → selection capture.

**Distillation** — the real value. 40 messages become a ~600-token handoff brief:
intent, decisions made, artifacts produced, open threads, constraints, and the last concrete state.

**Re-shaping** — the pack is re-rendered into the *destination's dialect*:

| Destination | Re-shaping profile |
|---|---|
| ChatGPT | System-style preamble + numbered turn transcript |
| Claude | `<context>…</context>` + `<constraints>` blocks (native prompting idiom) |
| Gemini | Context paragraph + explicit "Format:" + role framing |
| Perplexity | Research framing with a "cite sources" constraint and freshness note |
| Copilot | Plain task framing, brevity-biased |

**Fidelity levels** (user-selectable per transfer):
- `full` — verbatim transcript
- `distilled` — the brief (default)
- `atomic` — just the artifacts (code block, table, file list) — for "carry over only the output"

**Continuation, not just transfer** — the #1 productivity killer in multi-model work is the new model
having zero memory. The pack auto-prepends a *"Continue from here"* scaffold so the second platform
picks up mid-thought instead of restarting.

**Privacy** — local-first by default. Optional E2E-encrypted sync. Redaction rules (regex + named
entity), PII detector, per-site "never capture" switch, one-click scrub before any send.

---

### Engine 2 — Promptsmith

Two tiers, because most of the value is free and instant.

**Tier 1 — Deterministic analyzer (offline, 0ms, no API).** Scores the prompt against 7 slots:

`Role · Goal · Context · Constraints · Output format · Examples · Success criteria`

Outputs a 0–100 score with a diff view, and *fixes deterministically*: infers a role from the site
you're on, wraps your raw text into a Goal+Format scaffold, adds a "don't ask me for permission" clause
when the prompt is imperative, flags missing constraints on code tasks.

**Tier 2 — LLM enhancer (BYO key, your provider, our adapter layer).** Handles the hard rewrites:
ambiguity resolution, decomposing compound asks, adding negative constraints, turning a wish into a spec.

**Domain playbooks** — Debug · Refactor · Research · Write · Analyze · Plan · Data-extract. Each playbook
is a slot-filling recipe, not a magic string.

**Style DNA** — learns *your* preferences locally (preferred response length, formality,
code-vs-prose ratio, whether you want examples) and bakes them into future enhancements. No training
leaves the device.

**Output lint** — catches "As an AI language model", permission-seeking ("Would you like me to…"),
unbounded scope, and answers that ignore your format instruction.

---

### Engine 3 — Dictate Engine

Layered so cost and privacy are user-chosen:

1. **Web Speech API** — free, instant, already in Chrome. Default tier.
2. **Local Whisper (WASM)** — private, offline, handles accents + technical terms better. Pro tier.
3. **BYO cloud key** — for the last 5% of accuracy.

**Speech → intent, not speech → text.** Grammar of voice commands:
`send` · `scratch that` · `new paragraph` · `enhance` · `send to Claude` · `read that back` · `stop`

**Cleanup pipeline:** filler-word removal, punctuation insertion, casing, and a prompt transform layer —
so "um write a function to uh parse this csv and make it a table" becomes a structured Promptsmith input.

**Answer playback** — TTS with "read from this point" and adjustable rate.

---

### Engine 4 — Focus Shell (UI/UX)

Non-invasive by construction: Shadow DOM, no host layout mutation, per-site toggles, respects
z-index and the vendor's own keyboard shortcuts.

- **Command palette** (`Ctrl/Cmd + Shift + K`) — one input over the current page: every action,
  every destination, every template, fuzzy-matched.
- **Output Lens** — re-render *any* answer on the page without re-prompting:
  TL;DR · table · bullets · translate · code-only · JSON · email-ready.
- **Reading mode** — collapse thread to a digest, typography + measure + theme controls.
- **Sticky prompt bar** — template slots pinned above the composer, not floating over the page.
- **Status strip** — context budget, latency, pack state, destination.

---

### Engine 5 — Fan-out & Compare (the workload killer)

- **One prompt → N destinations in parallel** (ChatGPT + Claude + Gemini + Perplexity simultaneously).
- **Compare board** — side-by-side answers, per-cell actions (keep, distill, send onward), verdict star.
- **Auto-continue** — detects a truncated answer ("Let me know if you…", a `...`, a cut-off code fence)
  and drafts the follow-up prompt before you've finished reading.
- **Batch queue** — a watch folder of prompts, run sequentially, collect everything.
- **Spend meter** — tokens/cost across the whole run (if the destination exposes it).

---

## 3. Context Pack schema (v1)

```ts
type ContextPack = {
  v: 1;                              // schema version — migrations keyed off this
  id: string; created: number;
  title: string;

  intent: { goal: string; taskType: 'debug'|'write'|'research'|'analyze'|'plan'|'extract'|'other' };
  status: 'active' | 'blocked' | 'complete';

  summary: string;                   // distilled, ≤600 tokens
  decisions: string[];               // what was settled
  openThreads: string[];             // what's still open
  constraints: string[];             // hard rules in force
  artifacts: Artifact[];             // code blocks, tables, files, citations
  entities: string[];                // files, URLs, names, tech

  turns?: Turn[];                    // present at fidelity 'full'
  meta: { sourceSite: string; sourceUrl: string; messageCount: number;
          tokenEstimate: number; redacted: string[] };
};

type Artifact = { kind: 'code'|'table'|'list'|'file'|'link'|'text';
                  lang?: string; body: string };
type Turn = { role: 'user'|'assistant'; text: string; ts: number; artifacts?: Artifact[] };
```

**Design rules:** portable (no vendor ids), diffable, redacted, migratable, and **small**. A pack that
has to be scrolled is a pack that won't be read — the 600-token budget is a hard product constraint.

---

## 4. Architecture

**Stack:** Manifest V3 · TypeScript · esbuild (or WXT/Plasmo) · Shadow DOM · zero backend required.

```
manifest
├── service worker ── message bus, context menus, commands, tab orchestration, offscreen audio
├── content script ── per-tab: adapter mount, pack extract/inject, engines
│   ├── adapters/    chatgpt · claude · gemini · perplexity · copilot · generic
│   ├── engines/     pack · promptsmith · dictate · lens · focus
│   └── shell/       shadow-DOM palette, drawer, toasts
├── popup ── packs library, destinations, settings, compare board
└── offscreen document ── Whisper WASM + TTS (no DOM in the SW)
```

**Adapter contract (the only fragile surface — everything else is testable offline):**

```ts
interface Adapter {
  id: 'chatgpt'|'claude'|'gemini'|'perplexity'|'copilot'|'generic';
  hosts: string[];
  detect(loc: Location): boolean;
  composer(): El | null;                       // the input box
  setText(el: El, text: string): void;         // must survive React/Vue re-render
  getText(el: El): string;
  submit(el: El): void;                        // click send, or synthesise Enter
  turns(): Turn[];                             // parsed thread
  isStreaming(): boolean;
}
```

**Storage:** `chrome.storage.local` for packs & settings (unlimited-ish, no sync quota pain);
`chrome.storage.sync` only for preferences; IndexedDB for large artifacts.

**Permissions rationale** (deliberately narrow — every extra permission is a review risk and an install drop):
`storage`, `activeTab`, `scripting`, `tabs` (tab orchestration), `offscreen` (audio), `contextMenus`.
Host permissions declared per-site, user-toggleable, with a "only these sites" mode.

**Security:** no prompt or context ever touches our servers — the product works fully offline. If cloud
sync ships, it is E2E-encrypted with a user-held key. The BYO-key LLM enhancer proxies the request from
the client, never through us. No analytics on prompt content, ever.

---

## 5. Roadmap — 12 weeks to a shippable beta

| Weeks | Milestone | Deliverable | Exit criteria |
|---|---|---|---|
| 1–2 | **M0 Foundations** | MV3 skeleton, adapter interface, ChatGPT + Claude adapters, pack extract→JSON, local storage, demo/mock host page | Can capture a ChatGPT thread and view it as a pack in the popup |
| 3–4 | **M1 Daily Driver** | Pack re-shaping profiles, inject-and-send to any destination, Promptsmith tier 1, command palette, dictate (Web Speech) | Full round trip ChatGPT→Claude→Gemini without copy-paste; enhancer works offline |
| 5–6 | **M1.5 Feel** | Focus Shell (reading mode, typography, sticky bar), Output Lens, onboarding, per-site toggles | 5 pilot users, 1 week, no uninstall |
| 7–9 | **M2 Power** | Distiller v2, fan-out, compare board, auto-continue, redaction rules, TTS playback | 4-way fan-out on one prompt, side-by-side, verdict capture |
| 10–12 | **M3 Beta** | Generic adapter hardening, schema migrations, Whisper WASM (tier 2), Chrome Web Store listing, crash/selector-drift monitor | 200 beta installs, 3 sites with 90% adapter success, <1% error rate |

**Post-beta:** Edge & Firefox ports, team pack sharing, MCP server so Claude Code / Cursor can consume packs,
API for the schema.

---

## 6. Scope discipline — what I deliberately cut

| Cut | Why |
|---|---|
| Our own chat UI | It's a different product. We win by *not* replacing the vendor UI. |
| A hosted assistant sidebar (Sider clone) | Commodity, high cost, kills the differentiation story. |
| Autonomous agent loops | Wayfinding risk; the fan-out + compare loop captures 80% of the value at 20% of the risk. |
| Vector memory / "chat with your history" | Nice, but it's a platform feature and requires a backend. Revisit post-beta. |
| Mobile | Zero leverage on desktop productivity; the keyboard is the product. |

---

## 7. Business model

**Free, forever:** adapters, packs (local), Promptsmith tier 1, palette, dictate tier 1, single-site transfer.
This is the whole daily-driver loop. Deleting a prompt enhancer from a free tier kills the funnel.

**Pro — $4/mo or $39/yr:** local Whisper tier, E2E-encrypted cross-device sync, unlimited fan-out, compare
history, per-site automation, advanced distiller.

**Team — $12/user/mo:** shared pack library, shared playbooks, audit log, admin policy.

**Never monetize:** the pack format. It stays open spec — that's the credibility that makes people
build adapters for you.

---

## 8. Risks & mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| **Selector drift** — vendors change DOM constantly | Adapter breakage is the product's death | Health-check command in the palette, selector config as user-editable JSON, community adapter repo, generic fallback always present |
| Manifest V3 service worker sleeps | Background features die | Do all page work in the content script; SW only routes; alarms for scheduled jobs |
| Chrome Web Store review / permissions scrutiny | Install-friction cliff | Narrow host permissions, per-site opt-in, no remote code (all logic bundled), clear privacy policy |
| Users expect *perfect* transfer | Trust loss | Be honest in UI: show fidelity level, show the generated pack before sending, one-click edit |
| Competizer ships "share chat" | Reduced moat | Theirs is a link to *their* platform. Ours is a portable, shaped artifact. Lead with the dialect re-shaping. |
| Enhancement changes user intent | Actively annoying | Diff view with per-section accept, and a "never rewrite" per-site switch |

---

## 9. Metrics

- **Activation:** ≥1 Context Pack transferred within the first session
- **North star:** weekly Context Pack transfers per active user
- **Efficiency:** median keystrokes saved on a cross-site round trip (target: from ~180 to ~8)
- **Quality:** adapter extraction success rate per site (target > 95%)
- **Retention:** D7 > 35%, D30 > 18% for a productivity extension

---

## 10. The next 72 hours

1. **Validate the spine, not the features.** Hard-code two adapters (ChatGPT, Claude). Confirm a thread
   survives the round trip as a structured pack. If extraction is unreliable, *nothing else matters* —
   the entire product is a trust layer.
2. **Ship a 150-line prototype** of extract → distill → re-shape → inject to the *other* site. Manual
   copy-paste is fine. If the round trip doesn't feel magical, stop and re-scope.
3. **Test the fan-out with 3 tabs manually.** If one prompt to four models and comparing results isn't
   a "oh, *that's* useful" moment, the workload-reduction thesis needs rethinking.
4. Only then: Promptsmith, then dictate, then the shell.

---

## Build status — v0.2.0 (what actually ships today)

The plan above is the strategy. This is the honest gap between it and the code in this repo.

| Planned | Status | Note |
|---|---|---|
| Context Pack spine (extract → distil → redact → re-shape) | **shipped** | deterministic distiller, 5 dialects, 3 fidelities, versioned schema with migration |
| Promptsmith tier 1 (7 slots, repair, playbooks) | **shipped** | weighted scoring, per-task playbooks, Style DNA so it stays out of the way |
| Promptsmith tier 2 (BYO key) | **shipped** | Anthropic / OpenAI / Google, proxied client-side only |
| Dictate (Web Speech + commands + TTS) | **shipped** | voice-command grammar: send / scratch that / enhance that / send to Claude / read back |
| Dictate tier 2 (local Whisper) | **shipped as a client** | talks to any OpenAI-compatible endpoint you run. Deliberately *not* bundled — 45kb → 45MB is a different product |
| Focus Shell (palette, drawer, lens, reading mode) | **shipped** | lazily mounted, shadow DOM, zero host-page mutation except opt-in reading mode |
| Auto-continue (detect truncation, draft the follow-up) | **shipped** | four cutoff patterns; drafts from the pack's open threads |
| Fan-out + compare board | **shipped** | SW opens N tabs, collects answers in the background, side-by-side + "use as pack" |
| Pack library, search, export/import, per-site toggles | **shipped** | own extension page, not a popup afterthought |
| Adapter health check | **shipped** | palette + onboarding, reports composer/turns per site |
| E2E-encrypted cross-device sync | **not started** | M2, and only if retention justifies the key-management burden |
| Firefox / Safari packaging | **not started** | everything except `sw.js` is already browser-agnostic; this is packaging, not a rewrite |
| Whisper in-browser (WASM) | **rejected on purpose** | see above |

**Weight: 66kb zipped, 177kb unpacked, zero runtime dependencies.**

**Bugs found and fixed by the test suite** (54 jsdom checks + a distiller/promptsmith suite), which is
the real argument for having one:

- `render()` was never defined in the library page — the page threw on first load.
- The shell's `toast()` was dropped in a rewrite — three call sites threw `ReferenceError`.
- A preview-driver closure captured `shell` before it existed.
- Onboarding re-rendered the whole site grid on every toggle, detaching the clicked node.
- `\bconstraint\b` cannot match "Constraints" — a false negative in the core prompt scorer.
- Unbalanced XML in the Claude dialect: `<context>` opened, never closed.
- `size()` is async; a `reduce` summed Promises and reported `NaNkb`.

Every one of those would have shipped.

---

## Shipping format — no build step

v0.2.0 deliberately ships as **plain HTML, CSS and JavaScript**. No npm, no bundler, no transpiler,
no `node_modules` in the folder you hand to Chrome. `extension/` is the loadable artifact; you can
read any file top to bottom and it is the file that runs.

The cost is real and worth naming: every file is an IIFE hanging its exports off one `PB` global,
load order is encoded in `manifest.json`, and renaming a file means editing three places. That is
what "no build step" costs. The benefit is that a reviewer, a contributor, or a nervous user can open
`adapters.js` and see exactly what queries ChatGPT's DOM.

`_dev/test-plain.mjs` exists because removing the toolchain also removed the safety net. It loads the
real files from disk in jsdom and runs 68 checks — every adapter against a mock host page, the real
`createShell()`, and all three pages. It needs one package (`jsdom`) and nothing else.

---

*This repo contains a working, installable MV3 extension. See `README.md` for install and architecture.*

