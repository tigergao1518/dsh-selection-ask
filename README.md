# dsh-selection-ask (fork)

![banner](assets/banner.png)

[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![node](https://img.shields.io/badge/node-%5E22.19%20%7C%7C%20%3E%3D24-5FA04E?logo=nodedotjs)](https://nodejs.org/)
[![dsh plugin](https://img.shields.io/badge/dsh-plugin-4d6bfe)](https://github.com/deepseek-ai/deepseek-harness)

[简体中文](README.zh.md) · [Fork & upstream](#fork--upstream) · [Features](#features) · [Install](#install) · [Usage](#usage) · [Development](#development) · [Troubleshooting](#troubleshooting) · [License](#license)

**Select it. Quote it. Ask DeepSeek — in the main thread or in a sidebar that inherits the whole context.**

---

> ### 🍴 This is a fork
>
> Built on **[lzbaclz/dsh-selection-ask](https://github.com/lzbaclz/dsh-selection-ask)** (MIT, by lzbaclz) — the original selection-quote plugin. Upstream's last release is **v0.1.1 (2026-09-17)** and it has not been updated since; this fork continues the work under the same MIT license.
>
> **What this fork adds:** sidebar conversations that inherit the main thread, read-only session review, and a set of DSH-upgrade compatibility fixes. See [What this fork adds](#what-this-fork-adds).

---

## What this fork adds

Upstream (v0.1.1) does one thing well: quote a selection into the composer. This fork keeps that and adds three capabilities.

### 1. Sidebar conversation — inherit the context, never interrupt the main thread

Select text in the main conversation, click **「开侧栏追问」**, and a new session opens in the right sidebar that **inherits the entire conversation up to now**. It has its own agent, its own message stream, and its own model route — but the main thread keeps running untouched, and nothing from the sidebar leaks back into the main model context.

The selected quote is **pre-filled into the sidebar composer but not sent** — you decide when to send it.

- **Inheritance is real, not a copy**: the child session is created with a seed built from the parent's events, so it genuinely carries the context (verified: a fresh sidebar session opens with the parent's full transcript, ~470 KB vs ~10 KB for an empty one).
- **Never interrupts**: the main session's agent is untouched. No turn is cancelled, no in-flight work is disturbed.
- **Same model**: the sidebar session reuses the parent's provider/model route, so answers stay consistent with the main thread.

### 2. Session review — diagnose a conversation instead of guessing

A **「复盘本会话」** entry in the session header opens a **read-only** review session. It does not inherit the transcript; it reads the session log from disk and distills process data — token spend per turn, error and retry clusters, context bloat composition, drifting turns — then reports what should change, grouped by priority.

It cannot write files or run commands (read-only toolset, enforced by a dedicated preset), so it can never "helpfully" start editing your workspace mid-review.

### 3. DSH-upgrade compatibility fixes

This fork was driven by real breakage after DSH upgrades. Several fixes are structural and worth knowing about if you maintain a fork too:

- **Sidebar sessions are created via `agents.create` with a hand-built seed** — not `sessions.fork`. `fork` never persists, and patching persistence separately collides with the resume path (`already exists`). `agents.create` completes store-entry + persist + write-ownership in one step.
- **`provider`/`model` must go inside `agentOptions`** — they are *not* top-level fields. Writing them at the top level fails silently; the error only surfaces when you send a message (`agent "…" has no provider/model`).
- **No `{{cwd}}` / `{{model}}` in persona templates** — `{{cwd}}` is not registered at all, and `{{model}}` only resolves when a session already has a request header (i.e. has made a model call). A brand-new sidebar session has neither, so persona assembly throws before any model request.
- **Session-scoped selection**: with a sidebar session open beside the main one, both conversations mount a selection button listening to the same global `selectionchange`. Each instance now checks that the selection belongs to *its own* conversation, so 「存入本会话」 writes to the right composer.

## Features

**From upstream (unchanged in behaviour):**

- **Button follows the selection** — positioned at the selection's screen coordinates (`position: fixed`), clamped to the viewport, hidden once the selection scrolls away.
- **Quotes conversation text only** — selections must be inside the transcript (`[data-conversation-scroll]`) or an in-app document preview; selecting inside the composer itself does nothing.
- **Quote-aware append** — every selected line gets a `> ` prefix; an empty draft is replaced, a non-empty draft gets the quote appended as its own paragraph.
- **Official integration, no hacks** — writes through the harness's `inputActions.setDraft` input-machine API, so undo history and draft persistence keep working.

**Added by this fork:**

- **Sidebar conversation** — see above. Two buttons on the compose card: 「开侧栏追问」 (secondary) and 「存入本会话」 (primary, Enter's default action).
- **Session review** — see above.
- **Sidebar start-page entry** — a 「发起旁路对话」 guide entry on the sidebar start page, so you can start a context-inheriting conversation without selecting anything first.
- **Context-composition digest** — the review reports what is actually eating the context window (system prompt, tool schemas, tool results, injected memory), sorted by share, instead of just saying "tokens are high".

## Requirements

- DeepSeek Harness **Desktop app** (this fork's sidebar and review paths need the sidebar services; the plain selection-quote also works on the `web` profile).
- DSH packages of the **0.2.1-rc.2** era or newer (tested against the 2026-10-17 Desktop build).
- Installing the prebuilt package needs nothing; building from source needs Node `^22.19.0 || >=24` and pnpm.

## Install

```bash
dsh plugin --profile desktop add github:tigergao1518/dsh-selection-ask
```

Then restart DSH — host-half changes (the RPC route and the session factories) only take effect on restart. Client-half changes need only a page refresh.

**From a local clone:**

```bash
git clone https://github.com/tigergao1518/dsh-selection-ask.git
dsh plugin --profile desktop add link:/absolute/path/to/dsh-selection-ask
```

> The compiled `lib/` is committed, so a `github:` or `link:` install fetches ready-to-load artifacts with no build step.

## Usage

### Quote into the main thread (upstream behaviour)

1. Select text in the conversation transcript.
2. Click **「询问 DeepSeek」**.
3. The quote lands in the composer (`> selected text`), the composer is focused and the caret is at the end. Type your follow-up and send — or press **Enter** (default action) to confirm 「存入本会话」.

### Ask in a sidebar without interrupting the main thread

1. Select text in the main conversation.
2. Click **「询问 DeepSeek」**, then **「开侧栏追问」** (or start from the sidebar start page's 「发起旁路对话」 entry).
3. A sidebar session opens, inheriting the full context. The quote is pre-filled into its composer — **not sent**. Review it, add your question, and send when ready.

The main session keeps running. Nothing you ask in the sidebar enters the main thread's model context.

### Review a session

Click **「复盘本会话」** in the session header. A read-only review session opens and reports on errors/retries, context bloat, drifting turns, and rewindable points.

## Uninstall

```bash
dsh plugin --profile desktop remove dsh-selection-ask
```

## Troubleshooting

| Symptom | Cause & fix |
|---|---|
| `agent "…" has no provider/model` | The sidebar session has no model route. Send one message in the **main** session first (that establishes the request header the sidebar session inherits). This fork already passes `agentOptions` through; the error means there was nothing to inherit. |
| `prompt variable "{{model}}" has no value` | A persona template still references `{{model}}`, which only resolves once a session has made a model call. Patch the preset's persona `prefix` to a variable-free string — this fork's `docs/check-persona-vars.mjs` scans for exactly this. |
| Sidebar session fails to send with `SessionPersistenceNotFoundError` | You are on an older build that used `sessions.fork` (which never persists). Use this fork's `agents.create` path. |
| Selection quote lands in the sidebar composer instead of the main one | Fixed in this fork via per-conversation selection scoping. If you still see it, the anchor check could not resolve the conversation root — report it. |
| Button never appears after selecting text | Selection is outside the transcript, the page wasn't refreshed, or the `insert` row is missing. |
| Button appears but click does nothing | Hard-refresh (Cmd/Ctrl+Shift+R) to drop a stale bundle. |

## Development

```bash
git clone https://github.com/tigergao1518/dsh-selection-ask.git
cd dsh-selection-ask
pnpm install
pnpm typecheck   # host + client tsc programs, zero errors
pnpm build       # tsc(host) + tsc(client) + tsdown bundle
```

Compatibility checks worth running after any DSH upgrade (they live in `docs/`):

```bash
node docs/check-compat.mjs            # are the services/APIs/slots/tokens this plugin uses still there?
node docs/check-persona-vars.mjs desktop docs/session-review-preset.yml   # any unresolvable {{...}} in persona templates?
node docs/check-plugin-build.mjs      # build-artifact assertions
```

### Layout

- `src/index.ts` — host half: RPC route, sidebar-session factory, review factory, `read_session_log` tool.
- `src/sideSession.ts` — the sidebar-session factory (`agents.create` + hand-built seed) and route resolution.
- `src/reviewSession.ts` — the read-only review-session assembly.
- `src/client/SelectionAskButton.tsx` — the floating button: selection detection, positioning, per-conversation scoping.
- `src/client/sideAskTab.tsx` — the sidebar tab, its start-page guide entry, and the conversation host.
- `src/client/SideDraftRestore.tsx` — pre-fills the sidebar composer without sending.
- `docs/` — DSH-upgrade compatibility check scripts and the review preset.

## Fork & upstream

| | |
|---|---|
| Upstream | [lzbaclz/dsh-selection-ask](https://github.com/lzbaclz/dsh-selection-ask) — MIT, © lzbaclz |
| Upstream last release | v0.1.1 (2026-09-17) |
| This fork | [tigergao1518/dsh-selection-ask](https://github.com/tigergao1518/dsh-selection-ask) — MIT, same license |
| Relationship | Fork; upstream is no longer actively updated, so this fork is maintained independently |

Upstream issues and PRs are still the right place for problems in the **original selection-quote** behaviour. For sidebar conversations, session review, and the DSH-compatibility fixes, file issues here.

## License

[MIT](./LICENSE) — © lzbaclz (upstream) and contributors to this fork.
