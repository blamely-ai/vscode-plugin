# Changelog

Notable changes to **Blamely** follow [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). This extension uses [semantic versioning](https://semver.org/).

## [Unreleased]

## [1.6.7] - 2026-07-06

### Fixed

- **The gutter only highlights lines you've actually changed.** Attribution now reflects your uncommitted changes, so old edits from a previous branch no longer linger on lines that already match your latest commit.
- **Switching branches keeps your attribution intact.** Creating or switching to a branch no longer loses track of your in-progress changes.
- **Files deleted by the Cursor agent on Windows are credited to AI** (requires the 1.6.7 CLI).

## [1.6.0] - 2026-06-15

### Added

- **Antigravity (Gemini) inline completions attributed as AI** — accepting an inline ("implicit") Gemini suggestion in the Antigravity IDE is now recorded as `gemini` / `completion` instead of falling through to Human. Antigravity applies completions via `applyEdit` with no command, so neither the inline-suggest command nor the multi-line agent-apply path caught them; a single non-paste insert of ≥ 8 non-whitespace characters on the Antigravity host (where Gemini is the only assistant) is now recognized as a completion accept. Gated to the Antigravity host, so VS Code and Cursor are unaffected.

### Fixed

- **Status bar count now matches the gutter** — the AI/Human status bar counted every blame entry across the whole workspace, including blank lines, while the gutter shows only the active file and skips blanks. The status bar now reports the **active file only** (`getSummaryForFile`, sharing the gutter's path resolution and per-line dedup), and blank-line blame is stripped at map-population time so both views agree on the same set of lines.

### Changed

- **Extension install source is Open VSX** — `blamely install` now downloads the `.vsix` from Open VSX and installs it by path, which is registry-independent: it works on VS Code proper (delisted from the Microsoft Marketplace) as well as Cursor/Antigravity, and falls back to the registry id when the download is unavailable.

## [1.1.0] - 2026-05-13

### Added

- **Repo-local branch sessions** — Per-branch working state under **`.git/blamely/<sanitized-branch>/`** (open/stash/closed, trace, `report.yml`) and blame snapshots under **`.git/blamely/snapshots/<sanitized-branch>/`**. Pushable **`blamely/sessions/<id>/blamely.json`** mirrors session metadata for commits the team can share via normal `git push`.
- **Blamely: Changes — Branch sessions** — Collapsible list: current branch badge, open session activity, stash line, recent closed commits, and **Show changes** (opens a read-only `git show` summary).
- **Release / VSIX pipeline** — `clean:out`, `compile:release` (no source maps or declarations), `javascript-obfuscator` over compiled `out/*.js` (except `hookRunner.js`), and `vsix` / `vscode:prepublish` alignment. VSCE packaging uses **`.vscodeignore` only** (no conflicting `package.json` `files` field).
- **Chat Apply intercept — default keybindings** — Apply runs through `blamely.intercept.*` on **Ctrl/Cmd+Shift+Enter** → `github.copilot.chat.apply`, **Alt+Enter** → `workbench.action.chat.apply`. Activation logs **chat-panel-intercept-hooks-installed** / `[Blamely][chat-traffic]`.
- **Streaming chat applies** — Accumulates insert length across rapid micro-changes (burst gap); opens a `chat_panel` intercept window when the stream crosses burst thresholds so Copilot-style micro-chunks still attribute as AI. Signals: `chat-panel-stream-burst-poke`, `pokeMode: stream-burst`.
- **`blamely.attributeInlineGhostCompletion`** (default **true**) — When true, accepting inline **ghost** completions (grey suggestion text) is attributed as AI. Set **false** to treat those accepts like normal typing (chat / composer applies still attributed as AI where detected).
- **Reports & pre-commit hook totals** — Staged `git diff` deletions merged into report snapshots so YAML / detector lines match the commit; DELETE rows split **AI vs Human** using AI-deletion tracking (`hookTotals`, v2 detector preamble).
- **Post-commit UX hooks** — When a **Blamely git note** is written on commit: optional reset of **History** until the user refreshes; **in-memory trace** / session file cleared (git notes unchanged). Commit listener no longer forces History to open.
- **Line-touch narrowing** — Post-edit snapshot comparison (`snapshotLineTouch`, `narrowIntervalsByTouch`) so large chat/composer applies attribute **touched** lines instead of mis-labeling whole files as AI when VS Code spans are wrong.

### Changed

- **Editor gutter** — Decorations refresh across **all visible** editors when attribution or `blamely.showGutterDecorations` changes.
- **`anyAiCodingAssistantHostDetected`** — Shorter negative cache TTL (re-check ~5 s instead of up to ~45 s), plus refresh after activation with staggered delays so Copilot / `vscode.lm` activation after startup is picked up reliably.
- **`time_waiting_for_ai_ms` (report / git note metrics)** — Dedicated **chat send** anchor kept until the first AI-attributed edit; wait time is also recorded on **heuristic** and **batch finalize** paths (stock VS Code without `onDidExecuteCommand`). `markNextChangeAsAi` aligns send time for **`chat_inline`** and short **reply-window** pokes where interaction type was ambiguous. *If the host never exposes chat send and you do not use `blamely.chatSend.*` wrappers, the metric still reflects “intercept/apply → first edit”, not wall-clock HTTP wait.*
- **Data layout** — New writes use **`.git/blamely`** + optional tracked **`blamely/sessions`**. Legacy **`~/.blamely/session/`** is still **read** for migration (override with **`BLAMELY_SESSION_HOME`** in tests). Older flat **`.git/blamely/snapshots/<file>`** paths remain readable for blame migration.
- **`tsconfig.release.json`** — Production build disables `sourceMap` / declarations for packaged output.

### Fixed

- **Sessions not created on edit** — `getRepoRoot` accepts a **file** or directory path (Git `cwd` from the file’s parent) so repo resolution from `document.uri.fsPath` succeeds.
- **Session persistence** — `session.json` written before stash sync; stash/git errors logged and no longer block session creation; shorter scheduling debounce (~500 ms).
- **Pre-commit hook & `hookRunner.js`** — Runner installed under **`.git/blamely/hookRunner.js`** with pre-commit invoking that path (survives extension upgrades). **Fallback chain**: `~/.blamely/repos/<id>/hookRunner.js`, then `.git/blamely/hookRunner.js`; if missing, hook exits **0** so commits are not blocked. Install copies the runner to both locations.
- **`addGitNote`** — Returns boolean success; attach-note commands report failures clearly.
- **Undo / rollback gutter** — Multi-line deletion with **empty** insert text no longer keeps AI blame on the first removed line (`''.split('\n')` reindex parity).
- **AI context / model fields** — Safer sanitization of model strings passed into traces and reports where applicable.

## [1.0.0] - 2026-03-30

First **1.x** release for the VS Code marketplace.

### Features

- **Attribution** — Track inline AI suggestions (accept, partial accept, reject, timeout) and build a line-level blame map (AI vs human) with diff-based matching for completions and chat-applied edits.
- **Editor UX** — Gutter icons and structured hover text for attribution; ruler markers; status bar entry for the Changes view.
- **Branch-aware state** — Working data under `.git/blamely/` with per-branch snapshots; session reloads when you switch branches; in-memory state flushed on extension deactivate.
- **Reports** — Generate `report.yml` (and related outputs) on demand or on save; align with the IntelliJ Blamely reporting direction.
- **Git integration** — Optional pre-commit hook install/restore; **git notes** on `refs/notes/blamely` for commit-scoped reports; commands to generate reports, show blame, attach notes, and push notes.
- **SCM** — **Blamely: Changes** and **Blamely: History** webviews in the Source Control sidebar (current edits vs note-backed history).
- **Chat** — Chat participant `@blamely` where the VS Code Chat API is available.
- **Workspaces** — Multi-root folders supported; exclude patterns and timeouts configurable per workspace.

### Configuration

- All settings live under **`blamely.*`**: `suggestionTimeout`, `autoInstallHook`, `excludePatterns`, `reportOnSave`, `showGutterDecorations`.

### Reliability

- Safer handling when a single edit transaction mixes human-only and AI-matched chunks; fewer duplicate hovers; improved ordering when opening the AI attribution window relative to document edits.
