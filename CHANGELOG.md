# Changelog

Notable changes to **Blamely** follow [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). This extension uses [semantic versioning](https://semver.org/).

## [Unreleased]

### Added

- **Chat Apply intercept keybindings** — Default shortcuts so Apply runs through `blamely.intercept.*`: **Ctrl/Cmd+Shift+Enter** → `github.copilot.chat.apply`, **Alt+Enter** → `workbench.action.chat.apply`. Activation emits `[Blamely][chat-panel-signal] chat-panel-intercept-hooks-installed`.
- **Streaming chat applies (Copilot)** — Accumulate insert length across rapid micro-change events (500 ms gap); open `chat_panel` AI window when burst ≥ 36 chars with a multi-character chunk. Emits `chat-panel-stream-burst-poke` + `[Blamely][chat-traffic] chat-panel AI intercept window opened` (`pokeMode: stream-burst`).

### Fixed

- **`anyAiCodingAssistantHostDetected` cache** — Negative results re-evaluated after 5 s (was up to 45 s), plus cache invalidation at activate and 2.5 s / 8 s delays so Copilot/`vscode.lm` activation is picked up after startup.
- **Pre-commit when `hookRunner.js` is missing** — Hook tries `~/.blamely/repos/<id>/hookRunner.js` then `.git/blamely/hookRunner.js`; if neither exists it exits **0** so Git commits are not blocked. Install copies the runner to **both** locations.

## [1.1.0] - 2026-04-27

### Added

- **Repo-local branch sessions** — Per-branch working state under **`.git/blamely/<sanitized-branch>/`** (open/stash/closed, trace, `report.yml`) and blame snapshots under **`.git/blamely/snapshots/<sanitized-branch>/`**. Pushable **`blamely/sessions/<id>/blamely.json`** mirrors session metadata for commits that the team can share via normal `git push`.
- **Blamely: Changes — Branch sessions** — Collapsible list: current branch badge, open session activity, stash line, recent closed commits, and **Show changes** (opens a read-only `git show` summary).
- **Release / VSIX pipeline** — `clean:out`, `compile:release` (no source maps or declarations), `javascript-obfuscator` over compiled `out/*.js` (except `hookRunner.js`), and `vsix` script aligned with `vscode:prepublish`. VSCE packaging uses **`.vscodeignore` only** (no `package.json` `files` field, which newer VSCE rejects when combined with `.vscodeignore`).

### Fixed

- **Sessions not created on edit** — `getRepoRoot` now accepts a **file path** or a directory (uses the file’s parent for Git `cwd`). Previously, resolving the repo from `document.uri.fsPath` could fail, so session folders were never written.
- **Session persistence** — Open `session.json` is written **before** stash sync; stash/git errors are logged and no longer block creating the session file. Session scheduling debounce reduced (500 ms).
- **Pre-commit hook after extension upgrade** — Hook installs **`hookRunner.js`** under **`.git/blamely/hookRunner.js`**; `.git/hooks/pre-commit` invokes that absolute path instead of the extension install path, which broke after version changes or uninstall.
- **`addGitNote`** — Returns a boolean for success; attach-note commands surface a clear error when the note is not written.

### Changed

- **Data layout** — New writes use **`.git/blamely`** + optional tracked **`blamely/sessions`**. Legacy **`~/.blamely/session/`** is still **read** for migration (override with **`BLAMELY_SESSION_HOME`** in tests). Older **`.git/blamely/snapshots/<file>`** (flat) remains readable for blame migration.
- **`tsconfig.release.json`** — Restored for production builds (extends main `tsconfig`, disables `sourceMap` / declarations for packaged output).

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
