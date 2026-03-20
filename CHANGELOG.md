# Changelog

## [0.9.15] — 2026-03-05

### Added
- **New commands (aligned with IntelliJ):** Restore/Remove Git Hook, Attach Git Note for Current Commit, Attach Git Note for Commit SHA… All Blamely commands now appear under the "Blamely" category.
- **Status bar format:** AI & Human summary now shows chars (ⓒ) and lines (≡) with percentage by characters, matching the IntelliJ plugin.
- **Sidebar file descriptions:** Per-file "AI: X ⓒ Y ≡ Z% | Human: …" breakdown in the Blamely tree view.
- **BlameMap.getSummary():** Now returns `aiChars` and `humanChars` for UI and report metrics.

### Changed
- **Generate Report:** Writes to `.git/ai-trace/report.yml`; success message aligned with IntelliJ.
- **Show Blame / Install Hook / Show Commit Report:** User-facing messages use "Blamely" and match IntelliJ action text.
- **Restore Hook:** `GitHookInstaller.uninstall()` now returns a result (restored / removed / none) for accurate feedback.

## [0.9.14] — 2026-03-05

### Added
- **Network response logging:** Console logs for AI provider responses in addition to requests. HTTPS/HTTP responses (status, headers, body), HTTP/2 stream responses, and `fetch()` responses are now logged to the Developer Console with `[AI-Trace]` prefixes for easier debugging.

## [0.9.13] — 2026-03-05

### Added
- **Aggressive Network Interception:** Added native overrides for `require('node:https')`, standard `http.request` (for local AI proxy daemons), and `http2.connect` (for HTTP/2 multiplexing streams commonly used by Copilot). This guarantees prompt capture regardless of whether the AI extension uses legacy Node modules, local loopback agents, or next-generation HTTP/2 streams.

## [0.9.12] — 2026-03-05

### Added
- **Deep Prompt Extraction:** The `NetworkInterceptor` can now recursively search `system` messages and nested identifiers like `custom_instructions` to find accurate conversational streams across obscure Claude and Cursor payload variants.
- **Developer Debug Logs:** Added exhaustive `[AI-Trace]` lifecycle logging to the VS Code Developer Console to help users diagnose unrecorded Prompts or misattributed Network configurations.

## [0.9.11] — 2026-03-05

### Fixed
- **UI State Isolation:** Fixed an issue where historical AI `BlameMap` entries lingered on screen. The UI (`SidebarProvider` & `BlameDecorations`) now strictly filters and renders only *uncommitted* active changes.
- **Formatter False-Positives:** Added strict limits to the heuristic fallback. Massive multi-line document replacements (e.g. Prettier formatting or `git checkout`) no longer inaccurately trigger AI blame.
- **UI Crash Debouncing:** Fixed VS Code exception ("Make sure the ref is set before accessing the element") by wrapping rapidly-firing `setDecorations` ranges inside a 100ms Debouncer with `try-catch` isolation.
- **Empty File UI Bug:** Files whose lines are fully committed are now properly swept from the active Blamely sidebar entirely.

## [0.9.0] — 2026-03-05

### Added
- **Network Interceptor:** Automatically captures the exact user prompt and AI model name by intercepting Copilot/Cursor HTTP requests (`https.request` + `fetch()`) — no `@blamely` prefix needed.
- **Chat Participant (`@blamely`):** Register as a VS Code Chat Participant for full prompt and model capture in Copilot Chat sessions (sticky mode enabled).
- **Agent Info in Report:** New `agent_info` section in `report.yml` with IDE name, detected models, and interaction types.
- **Model & Prompt in Blame UI:** Hover tooltips now show Model and Prompt for AI-attributed lines. Sidebar tree items display model name.

### Changed
- **95% AI Dominance Rule:** Line ownership threshold changed from 75% to 95% — a line stays AI unless the user rewrites more than 5% of total characters.
- **Accurate Model Detection:** Prioritizes Cursor IDE detection before Copilot extension check. Real model name sourced from HTTP request body instead of `vscode.lm.selectChatModels()`.
- **Prompt Extraction Improved:** Filters out decorative comment separators (`──`, `===`, `---`). Shows `null` instead of fake placeholders when prompt is unavailable.
- **Node.js 20 for CI:** GitHub Actions updated to Node 20 for `@vscode/vsce` compatibility.
- **VS Code Engine:** Bumped to `^1.109.0` for Chat Participant API support.

## [0.8.2] — 2026-03-05

### Changed
- **Rebranded to Blamely:** Unveiled the new Blamely plugin identity across the application, replacing AI Trace. 
- **Data Persistence:** History tracking moved from the workspace root into the hidden `.git/ai-trace` directory.
- **CI/CD:** Automated `.vsix` packaging and GitHub Release creation via `action-gh-release` tagging pipeline.
- **Batched Tracking:** Improved heuristic fallback grouping to perfectly trace asynchronous multi-part code generation blocks.

## [0.7.3] — 2026-03-05

### Added
- **AI Model & Prompt Logging:** Added inference heuristics to automatically track which AI model (e.g. `github-copilot` vs `cursor-ai`) generated the code, and extracts the contextual comment above the insertion to serve as the prompt. This data is now embedded directly in the YAML reports!

## [0.7.2] — 2026-03-05

### Added
- **Clipboard-Aware Heuristic Fallback:** Effectively detects Copilot Chat "Accept" clicks and large automated code insertions that bypass VS Code `Tab` keybindings without falsely attributing standard pasting.

## [0.7.0] — 2026-03-05

### Changed
- **Git Notes Architecture:** Working session data is now persisted in `.ai-trace/` in the workspace root. The YAML report and blame snapshot are natively attached directly to Git commits using `git notes --ref=ai-trace` and automatically pushed to remotes.
- Active AI-inserted text tracking via `Tab` interception for a high-accuracy attribution model.
- Removed legacy `.git/ai-trace/` report persistence.

### Added
- Native VS Code Command to view the AI trace report note for the latest commit (`git log -1 --show-notes=ai-trace`).

## [0.1.0] — 2025-03-01

### Added
- AI suggestion interception for GitHub Copilot and Cursor AI
- Accept/reject tracking with fuzzy text matching
- Line-level blame (`BlameMap`, `BlameIndex`, `BlameSerializer`)
- `detector.ai` file generation with line-range grouping and summary header
- `ai-trace-report.md` Markdown report generation
- Git pre-commit hook installer (cross-platform)
- Post-commit listener with snapshot creation
- Status bar item showing AI% vs Human%
- Sidebar tree view with per-file AI & Human
- Gutter decorations with hover tooltips
- Commands: Generate Report, Show Blame, Install Hook, Open detector.ai
- Configurable suggestion timeout, exclude patterns, report-on-save
